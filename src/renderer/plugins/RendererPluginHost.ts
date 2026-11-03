import type {
  RendererLeaseMaterialization,
  RendererLeaseRelease,
  RendererLeaseRequest,
} from '../../shared/plugins/lifecycle';
import { validatePluginManifest, type PluginManifest } from '../../shared/plugins/manifest';
import type { NotoEditorPort } from '../editor/noto/NotoEditorPort';
import {
  rendererProofManifest,
  SemanticFocusProofPlugin,
  type SemanticFocusPort,
} from './renderer-proof';

export type RendererPluginDisposer = () => void | Promise<void>;

export interface RendererPluginContributionContext {
  readonly pluginId: string;
  readonly leaseId: string;
  readonly generation: number;
  readonly settings: Readonly<Record<string, boolean>>;
  readonly signal: AbortSignal;
  readonly port: NotoEditorPort;
  registerCommand(id: string, execute: (signal: AbortSignal) => void | Promise<void>): () => void;
  registerSetting(key: string, initial: boolean, update: (value: boolean) => void): () => void;
  registerHotkey(keys: string, execute: (signal: AbortSignal) => void | Promise<void>): () => void;
  registerEditorExtension(id: string): () => void;
  registerUiExtension(id: string): () => void;
  registerDisposer(disposer: RendererPluginDisposer): void;
  onCommand(): void;
  onSetting(value: boolean): void;
}

export interface RendererPluginContribution {
  activate(
    context: RendererPluginContributionContext,
    failureCause?: unknown,
  ): void | RendererPluginDisposer | Promise<void | RendererPluginDisposer>;
}

export interface RendererPluginSnapshot {
  commandCount: number;
  failureCode?: 'PLUGIN_FAILED' | null;
  failureDetail?: string | null;
  focusEnabled: boolean;
  lifecycle: 'inactive' | 'active' | 'failed';
  message: string;
  registrations: number;
}

interface DisposerRecord {
  disposed: boolean;
  run: RendererPluginDisposer;
}

interface LeaseRuntime {
  request: RendererLeaseRequest;
  open: boolean;
  cleanupRunning: boolean;
  disposers: DisposerRecord[];
  closing: Promise<RendererLeaseRelease> | null;
}

interface RendererPluginHostOptions {
  manifest?: PluginManifest;
  plugin?: RendererPluginContribution;
}

const UNKNOWN_ACTIVATION_FAILURE = 'Unknown activation failure';
const MAX_FAILURE_DETAIL_LENGTH = 2_048;
const MAX_FAILURE_DETAIL_INPUT_LENGTH = MAX_FAILURE_DETAIL_LENGTH * 4;
const MAX_PUBLISH_DIAGNOSTICS = 8;
/**
 * Which manifest capability each port method requires.
 *
 * The port handed to a plugin is built from this map, so a method a plugin did
 * not declare is not merely refused at call time: it is gated here and throws
 * with the capability named.
 */
const RENDERER_PORT_CAPABILITIES = Object.freeze({
  setSemanticFocus: 'editor.decorate',
  getMarkdown: 'editor.read',
  replaceMarkdown: 'editor.transform',
});

export class RendererPluginHost {
  private adapter: NotoEditorPort | null = null;
  private readonly manifest: PluginManifest;
  private readonly plugin: RendererPluginContribution;
  private readonly leases = new Map<string, LeaseRuntime>();
  private readonly closedLeaseIds = new Set<string>();
  private currentLeaseId: string | null = null;
  private readonly commands = new Map<string, {
    leaseId: string;
    execute: (signal: AbortSignal) => void | Promise<void>;
  }>();
  private readonly settings = new Map<string, { leaseId: string; update: (value: boolean) => void }>();
  private readonly hotkeys = new Map<string, {
    leaseId: string;
    execute: (signal: AbortSignal) => void | Promise<void>;
  }>();
  private readonly editorExtensions = new Map<string, string>();
  private readonly uiExtensions = new Map<string, string>();
  private readonly publishDiagnostics: string[] = [];
  private snapshot: RendererPluginSnapshot = {
    commandCount: 0,
    failureCode: null,
    failureDetail: null,
    focusEnabled: false,
    lifecycle: 'inactive',
    message: 'Editor extension inactive',
    registrations: 0,
  };

  constructor(
    private readonly publish: (snapshot: RendererPluginSnapshot) => void,
    options: RendererPluginHostOptions = {},
  ) {
    this.manifest = options.manifest ?? rendererProofManifest;
    this.plugin = options.plugin ?? new SemanticFocusProofPlugin();
  }

  /** Which plugin this host runs, so the client can route requests to it. */
  get pluginId(): string {
    return this.manifest.id;
  }

  attachAdapter(adapter: NotoEditorPort): void {
    this.adapter = adapter;
  }

  activate(adapter: NotoEditorPort): void {
    this.attachAdapter(adapter);
  }

  deactivate(): void {
    void this.disposeRenderer();
  }

  getSnapshot(): RendererPluginSnapshot {
    return { ...this.snapshot };
  }

  getDiagnostics(): readonly string[] {
    return Object.freeze([...this.publishDiagnostics]);
  }

  async openLease(request: RendererLeaseRequest): Promise<RendererLeaseMaterialization> {
    this.assertLeaseRequest(request);
    for (const priorLeaseId of [...this.leases.keys()]) {
      if (priorLeaseId === request.leaseId) continue;
      const release = await this.closeLease(priorLeaseId);
      if (!release.complete) throw new Error('PLUGIN_REPLACEMENT_CLEANUP_FAILED');
    }
    if (this.leases.has(request.leaseId) || this.closedLeaseIds.has(request.leaseId)) {
      throw new Error('PLUGIN_LEASE_REUSED');
    }

    const runtime: LeaseRuntime = {
      request,
      open: true,
      cleanupRunning: false,
      disposers: [],
      closing: null,
    };
    this.leases.set(request.leaseId, runtime);
    this.currentLeaseId = request.leaseId;
    this.snapshot = {
      ...this.snapshot,
      failureCode: null,
      failureDetail: null,
      focusEnabled: request.settings[rendererProofManifest.settings[0].key] ?? false,
      lifecycle: 'inactive',
      message: 'Editor extension materializing',
      registrations: 0,
    };

    let activation: Promise<void | RendererPluginDisposer>;
    try {
      activation = Promise.resolve(this.plugin.activate(this.activationContext(runtime)));
    } catch (cause) {
      await this.failLease(runtime, cause);
      throw cause;
    }

    try {
      const disposer = await awaitWithAbort(activation, request.signal);
      if (!runtime.open || request.signal.aborted || this.currentLeaseId !== request.leaseId) {
        if (typeof disposer === 'function') await this.runLateDisposer(disposer);
        throw new Error('PLUGIN_LEASE_CLOSED');
      }
      if (typeof disposer === 'function') runtime.disposers.push({ disposed: false, run: disposer });
      this.snapshot = {
        ...this.snapshot,
        failureCode: null,
        failureDetail: null,
        lifecycle: 'active',
        message: 'Editor extension active',
        registrations: this.registrationCount(request.leaseId),
      };
      this.publishSnapshot();
      return {
        leaseId: request.leaseId,
        generation: request.generation,
        registrations: this.snapshot.registrations,
      };
    } catch (cause) {
      if (request.signal.aborted) {
        void activation.then((lateDisposer) => {
          if (typeof lateDisposer === 'function') return this.runLateDisposer(lateDisposer);
          return undefined;
        }, () => undefined);
      }
      if (!runtime.open || request.signal.aborted || this.currentLeaseId !== request.leaseId) {
        await this.closeLease(request.leaseId);
        throw cause;
      }
      await this.failLease(runtime, cause);
      throw cause;
    }
  }

  async closeLease(leaseId: string): Promise<RendererLeaseRelease> {
    const runtime = this.leases.get(leaseId);
    if (!runtime) return { leaseId, complete: true, failures: [], registrations: 0 };
    if (runtime.closing) return runtime.closing;
    const closing = this.releaseLease(runtime);
    runtime.closing = closing;
    const release = await closing;
    if (!release.complete) runtime.closing = null;
    return release;
  }

  private async releaseLease(runtime: LeaseRuntime): Promise<RendererLeaseRelease> {
    const { leaseId } = runtime.request;

    runtime.open = false;
    if (this.currentLeaseId === leaseId) this.currentLeaseId = null;
    runtime.cleanupRunning = true;
    const failures: string[] = [];
    for (const record of [...runtime.disposers].reverse()) {
      if (record.disposed) continue;
      try {
        await record.run();
        record.disposed = true;
      } catch (cause) {
        failures.push(sanitizeActivationFailureDetail(cause));
      }
    }
    runtime.cleanupRunning = false;
    this.clearRegistrations(leaseId);
    if (this.manifest.capabilities.includes(RENDERER_PORT_CAPABILITIES.setSemanticFocus)) {
      try {
        this.adapter?.setSemanticFocus(false);
      } catch (cause) {
        failures.push(sanitizeActivationFailureDetail(cause));
      }
    }

    const complete = runtime.disposers.every((record) => record.disposed) && failures.length === 0;
    if (complete) {
      this.leases.delete(leaseId);
      this.closedLeaseIds.add(leaseId);
      if (this.closedLeaseIds.size > 2_048) {
        const oldest = this.closedLeaseIds.values().next().value;
        if (typeof oldest === 'string') this.closedLeaseIds.delete(oldest);
      }
    }
    this.snapshot = failures.length > 0
      ? {
        ...this.snapshot,
        failureCode: 'PLUGIN_FAILED',
        failureDetail: failures[0],
        focusEnabled: false,
        lifecycle: 'failed',
        message: 'Plugin cleanup did not complete. Registrations remain fenced.',
        registrations: 0,
      }
      : {
        ...this.snapshot,
        failureCode: null,
        failureDetail: null,
        focusEnabled: false,
        lifecycle: 'inactive',
        message: 'Editor extension inactive',
        registrations: 0,
      };
    this.publishSnapshot();
    return { leaseId, complete, failures, registrations: 0 };
  }

  async disposeRenderer(): Promise<void> {
    const releases = await Promise.all([...this.leases.keys()].map((leaseId) => this.closeLease(leaseId)));
    this.adapter = null;
    if (releases.some((release) => !release.complete)) throw new Error('PLUGIN_RENDERER_DISPOSAL_FAILED');
  }

  async executeLeaseCommand(leaseId: string, commandId: string, signal: AbortSignal): Promise<boolean> {
    const runtime = this.requireOpenLease(leaseId);
    if (signal.aborted || runtime.request.signal.aborted) throw new Error('PLUGIN_GENERATION_ABORTED');
    const command = this.commands.get(commandId);
    if (!command || command.leaseId !== leaseId) return false;
    await awaitWithAbort(Promise.resolve(command.execute(signal)), signal);
    this.requireOpenLease(leaseId);
    return true;
  }

  async updateLeaseSetting(
    leaseId: string,
    key: string,
    value: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const runtime = this.requireOpenLease(leaseId);
    if (typeof value !== 'boolean') throw new Error(`PLUGIN_SETTING_INVALID: ${key}`);
    if (!this.manifest.settings.some((setting) => setting.key === key)) {
      throw new Error(`PLUGIN_SETTING_UNKNOWN: ${key}`);
    }
    if (signal !== runtime.request.signal) throw new Error('PLUGIN_GENERATION_STALE');
    if (signal.aborted) throw new Error('PLUGIN_GENERATION_ABORTED');
    const setting = this.settings.get(key);
    if (!setting || setting.leaseId !== leaseId) throw new Error(`PLUGIN_SETTING_UNAVAILABLE: ${key}`);
    await awaitWithAbort(Promise.resolve(setting.update(value)), signal);
    if (signal !== runtime.request.signal) throw new Error('PLUGIN_GENERATION_STALE');
    this.requireOpenLease(leaseId);
  }

  execute(commandId: string): void {
    const leaseId = this.currentLeaseId;
    if (!leaseId) return;
    void this.executeLeaseCommand(leaseId, commandId, this.requireOpenLease(leaseId).request.signal)
      .catch(() => undefined);
  }

  executeHotkey(keys: string): void {
    const leaseId = this.currentLeaseId;
    if (!leaseId) return;
    const runtime = this.requireOpenLease(leaseId);
    const hotkey = this.hotkeys.get(keys);
    if (!hotkey || hotkey.leaseId !== leaseId || runtime.request.signal.aborted) return;
    void Promise.resolve(hotkey.execute(runtime.request.signal)).catch(() => undefined);
  }

  setSetting(enabled: boolean): void {
    const leaseId = this.currentLeaseId;
    if (!leaseId) return;
    const runtime = this.requireOpenLease(leaseId);
    void this.updateLeaseSetting(
      leaseId,
      rendererProofManifest.settings[0].key,
      enabled,
      runtime.request.signal,
    ).catch(() => undefined);
  }

  exerciseActivationFailure(cause: unknown = new Error('PLUGIN_FAILED: injected activation failure')): void {
    const leaseId = this.currentLeaseId;
    if (!leaseId) return;
    void this.closeLease(leaseId).then(() => {
      this.snapshot = {
        ...this.snapshot,
        failureCode: 'PLUGIN_FAILED',
        failureDetail: sanitizeActivationFailureDetail(cause),
        lifecycle: 'failed',
        message: 'Plugin activation failed. Main must issue a new generation to retry.',
        registrations: 0,
      };
      this.publishSnapshot();
    });
  }

  retry(): void {
    // Retry is a main-owned transition that requires a new generation and lease.
  }

  private activationContext(runtime: LeaseRuntime): RendererPluginContributionContext {
    const { request } = runtime;
    const registerMap = <T>(
      map: Map<string, { leaseId: string } & T>,
      key: string,
      value: T,
      declared: boolean,
      kind: string,
    ): (() => void) => {
      this.assertRegistrationOpen(runtime);
      if (!declared) throw new Error(`PLUGIN_REGISTRATION_UNDECLARED: ${kind}:${key}`);
      if (map.has(key)) throw new Error(`PLUGIN_REGISTRATION_DUPLICATE: ${kind}:${key}`);
      map.set(key, { leaseId: request.leaseId, ...value });
      return this.addDisposer(runtime, () => {
        const registered = map.get(key);
        if (registered?.leaseId === request.leaseId) map.delete(key);
      });
    };
    const registerExtension = (
      map: Map<string, string>,
      id: string,
      declared: boolean,
      kind: string,
    ): (() => void) => {
      this.assertRegistrationOpen(runtime);
      if (!declared) throw new Error(`PLUGIN_REGISTRATION_UNDECLARED: ${kind}:${id}`);
      if (map.has(id)) throw new Error(`PLUGIN_REGISTRATION_DUPLICATE: ${kind}:${id}`);
      map.set(id, request.leaseId);
      return this.addDisposer(runtime, () => {
        if (map.get(id) === request.leaseId) map.delete(id);
      });
    };
    const port: NotoEditorPort = Object.freeze({
      setSemanticFocus: (enabled: boolean) => {
        this.assertCapabilityLive(runtime, RENDERER_PORT_CAPABILITIES.setSemanticFocus);
        this.adapter?.setSemanticFocus(enabled);
      },
      getMarkdown: () => {
        this.assertCapabilityLive(runtime, RENDERER_PORT_CAPABILITIES.getMarkdown);
        return this.adapter?.getMarkdown() ?? '';
      },
      replaceMarkdown: (markdown: string) => {
        this.assertCapabilityLive(runtime, RENDERER_PORT_CAPABILITIES.replaceMarkdown);
        return this.adapter?.replaceMarkdown(markdown) ?? false;
      },
    });
    return Object.freeze({
      pluginId: request.pluginId,
      leaseId: request.leaseId,
      generation: request.generation,
      settings: Object.freeze({ ...request.settings }),
      signal: request.signal,
      port,
      registerCommand: (id: string, execute: (signal: AbortSignal) => void | Promise<void>) => registerMap(
        this.commands,
        id,
        { execute: this.fenceCallback(runtime, execute) },
        this.manifest.commands.some((command) => command.id === id),
        'command',
      ),
      registerSetting: (key: string, initial: boolean, update: (value: boolean) => void) => {
        const dispose = registerMap(
          this.settings,
          key,
          { update: this.fenceCallback(runtime, update) },
          this.manifest.settings.some((setting) => setting.key === key),
          'setting',
        );
        update(request.settings[key] ?? initial);
        return dispose;
      },
      registerHotkey: (keys: string, execute: (signal: AbortSignal) => void | Promise<void>) => registerMap(
        this.hotkeys,
        keys,
        { execute: this.fenceCallback(runtime, execute) },
        this.manifest.hotkeys.some((hotkey) => hotkey.keys === keys),
        'hotkey',
      ),
      registerEditorExtension: (id: string) => {
        this.assertRegistrationOpen(runtime);
        if (!this.manifest.capabilities.includes('editor.decorate')) {
          throw new Error('PLUGIN_CAPABILITY_DENIED: editor.decorate');
        }
        return registerExtension(
          this.editorExtensions,
          id,
          this.manifest.editorExtensions.includes(id),
          'editor-extension',
        );
      },
      runEditorCommand: (name: string) => {
        this.assertCapabilityLive(runtime, 'editor.transform');
        // The adapter is the editor in front; a test's fake may not run
        // commands, and then nothing happens rather than a throw.
        const runner = this.adapter as Partial<{ runCommand(command: string): boolean }> | null;
        return typeof runner?.runCommand === 'function' ? runner.runCommand(name) : false;
      },
      registerUiExtension: (id: string) => registerExtension(
        this.uiExtensions,
        id,
        this.manifest.uiExtensions.includes(id),
        'ui-extension',
      ),
      registerDisposer: (disposer: RendererPluginDisposer) => {
        this.assertRegistrationOpen(runtime);
        if (typeof disposer !== 'function') throw new Error('PLUGIN_DISPOSER_INVALID');
        this.addDisposer(runtime, disposer);
      },
      onCommand: () => {
        this.assertRegistrationOpen(runtime);
        this.snapshot = { ...this.snapshot, commandCount: this.snapshot.commandCount + 1 };
        this.publishSnapshot();
      },
      onSetting: (focusEnabled: boolean) => {
        this.assertRegistrationOpen(runtime);
        this.snapshot = { ...this.snapshot, focusEnabled };
        this.publishSnapshot();
      },
    });
  }

  private addDisposer(runtime: LeaseRuntime, disposer: RendererPluginDisposer): () => void {
    const record: DisposerRecord = { disposed: false, run: disposer };
    runtime.disposers.push(record);
    return () => {
      if (record.disposed) return;
      const result = record.run();
      if (isPromiseLike(result)) {
        void result.then(() => { record.disposed = true; });
      } else {
        record.disposed = true;
      }
    };
  }

  private fenceCallback<T extends (...args: never[]) => unknown>(runtime: LeaseRuntime, callback: T): T {
    return ((...args: never[]) => {
      this.assertRegistrationOpen(runtime);
      return callback(...args);
    }) as T;
  }

  private assertLeaseRequest(request: RendererLeaseRequest): void {
    if (!validatePluginManifest(this.manifest)) throw new Error('PLUGIN_MANIFEST_INVALID');
    if (!this.adapter) throw new Error('PLUGIN_RENDERER_UNAVAILABLE');
    if (request.pluginId !== this.manifest.id) throw new Error('PLUGIN_LEASE_PLUGIN_MISMATCH');
    if (!request.leaseId || !Number.isSafeInteger(request.generation) || request.generation <= 0) {
      throw new Error('PLUGIN_LEASE_INVALID');
    }
    if (request.signal.aborted) throw new Error('PLUGIN_GENERATION_ABORTED');
  }

  private requireOpenLease(leaseId: string): LeaseRuntime {
    const runtime = this.leases.get(leaseId);
    if (!runtime?.open || runtime.request.signal.aborted) throw new Error('PLUGIN_LEASE_CLOSED');
    return runtime;
  }

  private assertRegistrationOpen(runtime: LeaseRuntime): void {
    if (!runtime.open || runtime.request.signal.aborted || this.leases.get(runtime.request.leaseId) !== runtime) {
      throw new Error('PLUGIN_LEASE_CLOSED');
    }
  }

  private assertCapabilityLive(runtime: LeaseRuntime, capability: string): void {
    if ((!runtime.open && !runtime.cleanupRunning)
      || this.leases.get(runtime.request.leaseId) !== runtime) throw new Error('PLUGIN_LEASE_CLOSED');
    if (!this.manifest.capabilities.includes(capability)) {
      throw new Error(`PLUGIN_CAPABILITY_DENIED: ${capability}`);
    }
  }

  private clearRegistrations(leaseId: string): void {
    for (const [key, value] of this.commands) if (value.leaseId === leaseId) this.commands.delete(key);
    for (const [key, value] of this.settings) if (value.leaseId === leaseId) this.settings.delete(key);
    for (const [key, value] of this.hotkeys) if (value.leaseId === leaseId) this.hotkeys.delete(key);
    for (const [key, value] of this.editorExtensions) if (value === leaseId) this.editorExtensions.delete(key);
    for (const [key, value] of this.uiExtensions) if (value === leaseId) this.uiExtensions.delete(key);
  }

  private registrationCount(leaseId: string): number {
    return [...this.commands.values()].filter((value) => value.leaseId === leaseId).length
      + [...this.settings.values()].filter((value) => value.leaseId === leaseId).length
      + [...this.hotkeys.values()].filter((value) => value.leaseId === leaseId).length
      + [...this.editorExtensions.values()].filter((value) => value === leaseId).length
      + [...this.uiExtensions.values()].filter((value) => value === leaseId).length;
  }

  private async failLease(runtime: LeaseRuntime, cause: unknown): Promise<void> {
    const release = await this.closeLease(runtime.request.leaseId);
    this.snapshot = {
      ...this.snapshot,
      failureCode: 'PLUGIN_FAILED',
      failureDetail: sanitizeActivationFailureDetail(cause),
      focusEnabled: false,
      lifecycle: 'failed',
      message: release.complete
        ? 'Plugin activation failed. Main may issue a new generation to retry.'
        : 'Plugin activation and cleanup failed. Registrations remain fenced.',
      registrations: 0,
    };
    this.publishSnapshot();
  }

  private async runLateDisposer(disposer: RendererPluginDisposer): Promise<void> {
    try {
      await disposer();
    } catch (cause) {
      this.snapshot = {
        ...this.snapshot,
        failureCode: 'PLUGIN_FAILED',
        failureDetail: sanitizeActivationFailureDetail(cause),
        focusEnabled: false,
        lifecycle: 'failed',
        message: 'Late plugin cleanup failed after its lease closed.',
        registrations: 0,
      };
      this.publishSnapshot();
    }
  }

  private publishSnapshot(): void {
    try {
      this.publish({ ...this.snapshot });
    } catch (cause) {
      this.publishDiagnostics.push(
        `PLUGIN_PUBLISH_OBSERVER_FAILED: ${sanitizeActivationFailureDetail(cause)}`,
      );
      if (this.publishDiagnostics.length > MAX_PUBLISH_DIAGNOSTICS) {
        this.publishDiagnostics.shift();
      }
    }
  }
}

async function awaitWithAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('PLUGIN_GENERATION_ABORTED');
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('PLUGIN_GENERATION_ABORTED'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<void> {
  return typeof value === 'object'
    && value !== null
    && 'then' in value
    && typeof value.then === 'function';
}

function sanitizeActivationFailureDetail(cause: unknown): string {
  let detail = UNKNOWN_ACTIVATION_FAILURE;
  try {
    if (cause instanceof Error && typeof cause.message === 'string') {
      detail = cause.message;
    } else if (typeof cause === 'string') {
      detail = cause;
    } else if (cause !== undefined) {
      detail = `Non-Error activation failure (${cause === null ? 'null' : typeof cause})`;
    }
  } catch {
    detail = UNKNOWN_ACTIVATION_FAILURE;
  }

  const sanitized = detail
    .slice(0, MAX_FAILURE_DETAIL_INPUT_LENGTH)
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/(https?:\/\/)[^@\s/]+@/gi, '$1[REDACTED]@')
    .replace(/\b(Bearer)\s+[^\s,;]+/gi, '$1 [REDACTED]')
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret)\b(\s*[:=]\s*)(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s,;]+)/gi,
      '$1$2[REDACTED]',
    )
    .trim() || UNKNOWN_ACTIVATION_FAILURE;
  return sanitized.length <= MAX_FAILURE_DETAIL_LENGTH
    ? sanitized
    : `${sanitized.slice(0, MAX_FAILURE_DETAIL_LENGTH - 3)}...`;
}

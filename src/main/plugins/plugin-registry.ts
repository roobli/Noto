import { randomUUID } from 'node:crypto';
import { createPluginCatalog, type PluginCatalog } from '../../shared/plugins/catalog';
import { type PluginInstallPresentation,
  RENDERER_TRANSPORT_FAILURE_CODES,
  type PluginCapabilitySnapshot,
  type PluginActivationReason,
  type PluginLifecycleSnapshot,
  type PluginLifecycleState,
  type PluginPersistenceHealth,
  type RendererLeaseMaterialization,
  type RendererLeaseRelease,
  type RendererLeaseRequest,
} from '../../shared/plugins/lifecycle';
import type { ServiceReply, ServiceRequest } from '../../shared/ipc/contracts';
import type { ServiceHostEvent } from './service-host';
import type { PluginManifest } from '../../shared/plugins/manifest';
import {
  filesystemProofManifest,
  rendererProofManifest,
  titleShiftManifest,
  markdownPaddingManifest,
  sidenotesManifest,
  changesManifest,
  historyManifest,
} from '../../shared/plugins/proof-manifests';
import {
  cloneLocalPluginState,
  createDefaultLocalPluginState,
  parseLocalPluginState,
  type LocalPluginState,
} from '../../shared/plugins/state';
import type { LocalPluginStateSaveOutcome } from './local-plugin-state-store';

export interface PluginRegistryStateStore {
  load(): Promise<unknown>;
  save(state: LocalPluginState): Promise<LocalPluginStateSaveOutcome>;
}

export interface RendererLeaseHost {
  openLease(request: RendererLeaseRequest): Promise<RendererLeaseMaterialization>;
  closeLease(leaseId: string): Promise<RendererLeaseRelease>;
  executeLeaseCommand(leaseId: string, commandId: string, signal: AbortSignal): Promise<boolean>;
  updateLeaseSetting(
    leaseId: string,
    key: string,
    value: boolean,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface ServicePluginHost {
  activate(signal: AbortSignal, generation: number): Promise<number>;
  deactivate(generation: number): Promise<void>;
  executeCommand?(commandId: string, signal: AbortSignal, generation: number): Promise<boolean>;
  request?(request: ServiceRequest): Promise<ServiceReply>;
  setEventSink?(sink: (event: ServiceHostEvent) => void): void;
}

export type PluginLifecycleErrorCode =
  | 'PLUGIN_DISABLE_CLEANUP_FAILED'
  | 'PLUGIN_PERSISTED_RECONCILIATION_CLEANUP_FAILED'
  | 'PLUGIN_RENDERER_DISPOSAL_CLEANUP_FAILED'
  | 'PLUGIN_REPLACEMENT_CLEANUP_FAILED'
  | 'PLUGIN_SHUTDOWN_CLEANUP_FAILED';

export class PluginLifecycleError extends Error {
  readonly failures: readonly string[];

  constructor(readonly code: PluginLifecycleErrorCode, failures: readonly unknown[]) {
    super(code);
    this.name = 'PluginLifecycleError';
    this.failures = Object.freeze(failures.map((failure) => toPublicPluginFailure(failure)));
  }
}

interface PluginRegistryOptions {
  stateStore: PluginRegistryStateStore;
  rendererHost: RendererLeaseHost;
  serviceHost: ServicePluginHost;
  catalog?: PluginCatalog;
  publish?: (snapshot: PluginLifecycleSnapshot) => void;
  leaseId?: () => string;
  cleanupTimeoutMs?: number;
  initialDiscoveryFailure?: string;
  /** How the renderer loads a plugin the reader installed; null for a bundled one. */
  install?: (pluginId: string) => PluginInstallPresentation | null;
}

interface GenerationRuntime {
  number: number;
  controller: AbortController;
  leaseId: string | null;
  registrations: number;
  activation: Promise<PluginLifecycleSnapshot>;
  cleanupAttempt: Promise<unknown[]> | null;
  serviceGeneration: number | null;
}

type PluginTransitionPhase =
  | 'stable'
  | 'enabling'
  | 'disabling'
  | 'replacing'
  | 'renderer-disposed'
  | 'shutting-down';

interface PluginTransition {
  epoch: number;
  phase: PluginTransitionPhase;
  intentEnabled: boolean;
}

interface PluginRuntime {
  manifest: PluginManifest;
  desiredEnabled: boolean;
  settings: Record<string, boolean>;
  lifecycle: PluginLifecycleState;
  generationCounter: number;
  generation: GenerationRuntime | null;
  cleanupPending: GenerationRuntime | null;
  transition: PluginTransition;
  activationReason: PluginActivationReason | null;
  persistenceHealth: PluginPersistenceHealth;
  lastFailure: string | null;
  diagnostics: string[];
  capability: PluginCapabilitySnapshot;
}

interface PersistResult {
  state: LocalPluginState;
  outcome: LocalPluginStateSaveOutcome;
}

interface PersistedRuntimeBefore {
  desiredEnabled: boolean;
  settings: Readonly<Record<string, boolean>>;
}

const settled = Promise.resolve();
const DEFAULT_CLEANUP_TIMEOUT_MS = 1_000;
const MAX_DIAGNOSTICS = 8;

export const bundledPluginCatalog = createPluginCatalog([
  rendererProofManifest,
  titleShiftManifest,
  sidenotesManifest,
  changesManifest,
  historyManifest,
  markdownPaddingManifest,
  filesystemProofManifest,
]);

/**
 * Whether a plugin runs against the editor, through a renderer lease: a
 * bundled renderer plugin, or one the reader installed, whose worker or
 * module the renderer starts. Everything else is the filesystem service.
 */
function runsInEditor(manifest: PluginManifest): boolean {
  return manifest.runtime === 'trusted-renderer' || manifest.runtime === 'sandboxed';
}

export class PluginRegistry {
  private readonly catalog: PluginCatalog;
  private readonly runtimes = new Map<string, PluginRuntime>();
  private readonly transitionQueues = new Map<string, Promise<void>>();
  private persistenceTail: Promise<void> = Promise.resolve();
  private persistedState: LocalPluginState;
  private hydrated = false;
  private hydratePromise: Promise<void> | null = null;
  private readonly disposedRendererLeases = new Set<string>();
  private readonly createLeaseId: () => string;
  private readonly cleanupTimeoutMs: number;

  constructor(private readonly options: PluginRegistryOptions) {
    this.catalog = options.catalog ?? bundledPluginCatalog;
    this.persistedState = createDefaultLocalPluginState(this.catalog);
    this.createLeaseId = options.leaseId ?? (() => `lease:${randomUUID()}`);
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
    options.serviceHost.setEventSink?.((event) => this.adoptServiceEvent(event));
    for (const manifest of this.catalog.plugins) {
      const defaults = this.persistedState.plugins[manifest.id];
      this.runtimes.set(manifest.id, {
        manifest,
        desiredEnabled: defaults.desiredEnabled,
        settings: { ...defaults.settings },
        lifecycle: options.initialDiscoveryFailure ? 'failed' : 'discovered',
        generationCounter: 0,
        generation: null,
        cleanupPending: null,
        transition: {
          epoch: 0,
          phase: 'stable',
          intentEnabled: defaults.desiredEnabled,
        },
        activationReason: null,
        persistenceHealth: 'healthy',
        lastFailure: options.initialDiscoveryFailure
          ? toPublicPluginFailure(options.initialDiscoveryFailure, 'PLUGIN_DISCOVERY_UNAVAILABLE')
          : null,
        diagnostics: [],
        capability: { grant: null, request: null, restartRequired: false },
      });
    }
  }

  hydrate(): Promise<void> {
    this.hydratePromise ??= this.hydrateOnce();
    return this.hydratePromise;
  }

  getSnapshot(pluginId: string): PluginLifecycleSnapshot {
    return this.snapshot(this.requireRuntime(pluginId));
  }

  getSnapshots(): PluginLifecycleSnapshot[] {
    return this.catalog.plugins.map((manifest) => this.getSnapshot(manifest.id));
  }

  getDiagnostics(pluginId: string): readonly string[] {
    return Object.freeze([...this.requireRuntime(pluginId).diagnostics]);
  }

  async performServiceOperation(request: ServiceRequest): Promise<{ reply: ServiceReply; snapshot: PluginLifecycleSnapshot }> {
    this.requireHydrated();
    const runtime = this.requireRuntime(filesystemProofManifest.id);
    const generation = runtime.generation;
    if (!generation || runtime.lifecycle !== 'active' || !runtime.desiredEnabled
      || request.generation !== generation.number || generation.serviceGeneration === null) {
      throw new Error('PLUGIN_STALE: filesystem plugin generation is not current');
    }
    if (!this.options.serviceHost.request) throw new Error('SERVICE_FAILED: service operation is unavailable');
    const reply = await this.options.serviceHost.request(request);
    return { reply, snapshot: this.snapshot(runtime) };
  }

  enable(pluginId: string): Promise<PluginLifecycleSnapshot> {
    this.requireHydrated();
    const runtime = this.requireRuntime(pluginId);
    const transitionEpoch = runtime.desiredEnabled && runtime.transition.phase === 'stable'
      ? runtime.transition.epoch
      : this.beginTransition(runtime, 'enabling', true, false);
    return this.queue(pluginId, async () => {
      try {
        if (!runtime.desiredEnabled) {
          await this.persist((next) => {
            next.plugins[pluginId].desiredEnabled = true;
          });
        }
      } catch (cause) {
        this.finishTransition(runtime, transitionEpoch);
        runtime.lifecycle = 'failed';
        runtime.lastFailure = toPublicPluginFailure(cause, 'WRITE_LOCAL_PLUGIN_STATE_FAILED');
        this.publish(runtime);
        throw cause;
      }

      const mismatch = runtime.desiredEnabled !== true;
      if (this.finishTransition(runtime, transitionEpoch)) {
        if (mismatch) {
          runtime.lifecycle = 'failed';
          runtime.lastFailure = persistedIntentMismatchDetail();
        } else if (runtime.cleanupPending) {
          runtime.lifecycle = 'failed';
          runtime.lastFailure ??= 'PLUGIN_CLEANUP_FAILED';
        } else if (!runtime.generation) {
          runtime.lifecycle = 'enabled-idle';
          runtime.activationReason = null;
          runtime.lastFailure = null;
        }
        this.publish(runtime);
      }
      return this.snapshot(runtime);
    });
  }

  disable(pluginId: string): Promise<PluginLifecycleSnapshot> {
    this.requireHydrated();
    const runtime = this.requireRuntime(pluginId);
    const transitionEpoch = this.beginTransition(runtime, 'disabling', false, true);
    runtime.lifecycle = 'deactivating';
    this.publish(runtime);
    return this.queue(pluginId, async () => {
      const cleanupFailures = await this.cleanupOwnedGeneration(runtime);

      try {
        if (runtime.desiredEnabled) {
          await this.persist((next) => {
            next.plugins[pluginId].desiredEnabled = false;
          });
        }
      } catch (cause) {
        if (this.finishTransition(runtime, transitionEpoch)) {
          runtime.lifecycle = 'failed';
          runtime.lastFailure = toPublicPluginFailure(cause, 'WRITE_LOCAL_PLUGIN_STATE_FAILED');
          this.publish(runtime);
        }
        throw cause;
      }

      const mismatch = runtime.desiredEnabled !== false;
      if (this.finishTransition(runtime, transitionEpoch)) {
        runtime.activationReason = null;
        if (cleanupFailures.length > 0) {
          runtime.lifecycle = 'failed';
          runtime.lastFailure = cleanupFailureDetail('Plugin cleanup failed', cleanupFailures);
        } else if (mismatch) {
          runtime.lifecycle = 'failed';
          runtime.lastFailure = persistedIntentMismatchDetail();
        } else {
          runtime.lifecycle = 'disabled';
          runtime.lastFailure = null;
        }
        this.publish(runtime);
      }
      if (cleanupFailures.length > 0) {
        throw new PluginLifecycleError('PLUGIN_DISABLE_CLEANUP_FAILED', cleanupFailures);
      }
      return this.snapshot(runtime);
    });
  }

  setSetting(pluginId: string, key: string, value: boolean): Promise<PluginLifecycleSnapshot> {
    this.requireHydrated();
    return this.queue(pluginId, async (runtime) => {
      if (typeof value !== 'boolean') throw new Error(`PLUGIN_SETTING_INVALID: ${pluginId}:${key}`);
      if (!runtime.manifest.settings.some((setting) => setting.key === key)) {
        throw new Error(`PLUGIN_SETTING_UNKNOWN: ${pluginId}:${key}`);
      }
      if (runtime.settings[key] !== value) {
        await this.persist((next) => {
          next.plugins[pluginId].settings[key] = value;
        });
      }
      this.publish(runtime);
      return this.snapshot(runtime);
    });
  }

  triggerStartup(): Promise<void> {
    return this.triggerMatching(
      (manifest) => manifest.activation.startup,
      { type: 'startup' },
    );
  }

  triggerEvent(event: string): Promise<void> {
    return this.triggerMatching(
      (manifest) => manifest.activation.events.includes(event),
      { type: 'event', event },
    );
  }

  async triggerHotkey(keys: string): Promise<boolean> {
    this.requireHydrated();
    const matching = [...this.runtimes.values()].filter((runtime) =>
      runtime.manifest.activation.hotkeys.includes(keys)
      && runtime.manifest.hotkeys.some((hotkey) => hotkey.keys === keys));
    const results = await Promise.all(matching.map(async (runtime) => {
      if (!runtime.desiredEnabled) return false;
      await this.activateRuntime(runtime, { type: 'hotkey', keys });
      const commandId = runtime.manifest.hotkeys.find((hotkey) => hotkey.keys === keys)?.command;
      return commandId ? this.executeActiveCommand(runtime, commandId) : false;
    }));
    return results.some(Boolean);
  }

  async executeCommand(pluginId: string, commandId: string): Promise<boolean> {
    this.requireHydrated();
    const runtime = this.requireRuntime(pluginId);
    if (!runtime.manifest.commands.some((command) => command.id === commandId)) {
      throw new Error(`PLUGIN_COMMAND_UNKNOWN: ${pluginId}:${commandId}`);
    }
    if (!runtime.desiredEnabled) return false;
    if (runtime.lifecycle !== 'active') {
      await this.activateRuntime(runtime, { type: 'command', commandId });
    }
    return this.executeActiveCommand(runtime, commandId);
  }

  replaceGeneration(pluginId: string, reason: PluginActivationReason): Promise<PluginLifecycleSnapshot> {
    this.requireHydrated();
    const runtime = this.requireRuntime(pluginId);
    if (!this.activationIntentAllows(runtime)) return Promise.resolve(this.snapshot(runtime));
    const transitionEpoch = this.beginTransition(runtime, 'replacing', true, true);
    runtime.lifecycle = 'deactivating';
    this.publish(runtime);
    return this.queue(pluginId, async () => {
      const cleanupFailures = await this.cleanupOwnedGeneration(runtime);
      if (cleanupFailures.length > 0) {
        if (this.finishTransition(runtime, transitionEpoch)) {
          runtime.lifecycle = 'failed';
          runtime.lastFailure = cleanupFailureDetail('Replacement cleanup failed', cleanupFailures);
          this.publish(runtime);
        }
        throw new PluginLifecycleError('PLUGIN_REPLACEMENT_CLEANUP_FAILED', cleanupFailures);
      }
      if (!this.finishTransition(runtime, transitionEpoch)) return this.snapshot(runtime);
      if (!runtime.desiredEnabled) {
        runtime.lifecycle = 'disabled';
        runtime.activationReason = null;
        return this.snapshot(runtime);
      }
      return this.activateRuntime(runtime, reason);
    });
  }

  rendererDisposed(pluginId: string, leaseId: string, generationNumber: number): Promise<void> {
    this.requireHydrated();
    return this.queue(pluginId, async () => {
      const disposalKey = `${pluginId}\u0000${leaseId}\u0000${generationNumber}`;
      if (this.disposedRendererLeases.has(disposalKey)) return;
      const runtime = this.requireRuntime(pluginId);
      const currentOwned = runtime.generation ?? runtime.cleanupPending;
      if (!currentOwned || currentOwned.leaseId !== leaseId || currentOwned.number !== generationNumber) {
        throw new Error('PLUGIN_LEASE_STALE');
      }
      const transitionEpoch = this.beginTransition(
        runtime,
        'renderer-disposed',
        runtime.desiredEnabled,
        true,
      );
      runtime.lifecycle = 'deactivating';
      this.publish(runtime);
      const cleanupFailures = await this.cleanupOwnedGeneration(runtime);
      if (this.finishTransition(runtime, transitionEpoch)) {
        runtime.lifecycle = 'failed';
        runtime.activationReason = null;
        runtime.lastFailure = cleanupFailures.length > 0
          ? cleanupFailureDetail('Renderer disposal cleanup failed', cleanupFailures)
          : 'PLUGIN_RENDERER_DISPOSED';
        this.publish(runtime);
      }
      if (cleanupFailures.length > 0) {
        throw new PluginLifecycleError(
          'PLUGIN_RENDERER_DISPOSAL_CLEANUP_FAILED',
          cleanupFailures,
        );
      }
      this.disposedRendererLeases.add(disposalKey);
      if (this.disposedRendererLeases.size > 256) {
        const oldest = this.disposedRendererLeases.values().next().value;
        if (typeof oldest === 'string') this.disposedRendererLeases.delete(oldest);
      }
    });
  }

  shutdown(): Promise<void> {
    try {
      this.requireHydrated();
    } catch (cause) {
      return Promise.reject(cause);
    }
    const transitions = [...this.runtimes.values()].map((runtime) => {
      const epoch = this.beginTransition(
        runtime,
        'shutting-down',
        runtime.desiredEnabled,
        true,
      );
      if (runtime.generation || runtime.cleanupPending) runtime.lifecycle = 'deactivating';
      this.publish(runtime);
      return { runtime, epoch };
    });
    return Promise.allSettled(transitions.map(({ runtime, epoch }) => this.queue(
      runtime.manifest.id,
      async () => {
        const cleanupFailures = await this.cleanupOwnedGeneration(runtime);
        if (this.finishTransition(runtime, epoch)) {
          runtime.lifecycle = cleanupFailures.length > 0
            ? 'failed'
            : runtime.desiredEnabled ? 'enabled-idle' : 'disabled';
          runtime.activationReason = null;
          runtime.lastFailure = cleanupFailures.length > 0
            ? cleanupFailureDetail('Shutdown cleanup failed', cleanupFailures)
            : null;
          this.publish(runtime);
        }
        if (cleanupFailures.length > 0) {
          throw new PluginLifecycleError('PLUGIN_SHUTDOWN_CLEANUP_FAILED', cleanupFailures);
        }
      },
    ))).then((results) => {
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (failures.length > 0) throw new AggregateError(failures, 'PLUGIN_SHUTDOWN_FAILED');
    });
  }

  private async hydrateOnce(): Promise<void> {
    if (this.options.initialDiscoveryFailure) {
      const failure = toPublicPluginFailure(
        this.options.initialDiscoveryFailure,
        'PLUGIN_DISCOVERY_UNAVAILABLE',
      );
      for (const runtime of this.runtimes.values()) {
        runtime.lifecycle = 'failed';
        runtime.persistenceHealth = 'indeterminate';
        runtime.lastFailure = failure;
        this.publish(runtime);
      }
      throw new Error(failure);
    }
    let state: LocalPluginState;
    try {
      state = parseLocalPluginState(await this.options.stateStore.load(), this.catalog);
    } catch (cause) {
      for (const runtime of this.runtimes.values()) {
        runtime.lifecycle = 'failed';
        runtime.persistenceHealth = 'indeterminate';
        runtime.lastFailure = toPublicPluginFailure(cause, 'READ_LOCAL_PLUGIN_STATE_FAILED');
        this.publish(runtime);
      }
      throw cause;
    }
    this.persistedState = state;
    for (const runtime of this.runtimes.values()) {
      this.adoptPersistedRuntime(runtime, state);
      runtime.transition = {
        epoch: runtime.transition.epoch,
        phase: 'stable',
        intentEnabled: runtime.desiredEnabled,
      };
      runtime.lifecycle = runtime.desiredEnabled ? 'enabled-idle' : 'disabled';
      runtime.activationReason = null;
      runtime.lastFailure = null;
      this.publish(runtime);
    }
    this.hydrated = true;
  }

  private triggerMatching(
    predicate: (manifest: PluginManifest) => boolean,
    reason: PluginActivationReason,
  ): Promise<void> {
    this.requireHydrated();
    const activations = [...this.runtimes.values()]
      .filter((runtime) => runtime.desiredEnabled && predicate(runtime.manifest))
      .map((runtime) => this.activateRuntime(runtime, reason));
    return Promise.all(activations).then(() => undefined);
  }

  private activateRuntime(
    runtime: PluginRuntime,
    reason: PluginActivationReason,
  ): Promise<PluginLifecycleSnapshot> {
    const transitionEpoch = runtime.transition.epoch;
    if (!this.activationIntentAllows(runtime, transitionEpoch)) {
      return Promise.resolve(this.snapshot(runtime));
    }
    const current = runtime.generation;
    if (current) {
      return runtime.lifecycle === 'active'
        ? Promise.resolve(this.snapshot(runtime))
        : current.activation;
    }

    if (!this.activationIntentAllows(runtime, transitionEpoch)) {
      return Promise.resolve(this.snapshot(runtime));
    }
    const generationNumber = ++runtime.generationCounter;
    const controller = new AbortController();
    const leaseId = runsInEditor(runtime.manifest) ? this.createLeaseId() : null;
    let resolveActivation!: (snapshot: PluginLifecycleSnapshot) => void;
    let rejectActivation!: (cause: unknown) => void;
    const activation = new Promise<PluginLifecycleSnapshot>((resolve, reject) => {
      resolveActivation = resolve;
      rejectActivation = reject;
    });
    const generation: GenerationRuntime = {
      number: generationNumber,
      controller,
      leaseId,
      registrations: 0,
      activation,
      cleanupAttempt: null,
      serviceGeneration: null,
    };
    runtime.generation = generation;
    runtime.capability = { grant: null, request: null, restartRequired: false };
    runtime.lifecycle = 'activating';
    runtime.activationReason = { ...reason };
    runtime.lastFailure = null;
    this.publish(runtime);

    const work = runsInEditor(runtime.manifest)
      ? this.options.rendererHost.openLease({
        pluginId: runtime.manifest.id,
        leaseId: leaseId as string,
        generation: generationNumber,
        settings: Object.freeze({ ...runtime.settings }),
        signal: controller.signal,
      }).then((materialized) => {
        if (materialized.leaseId !== leaseId || materialized.generation !== generationNumber) {
          throw new Error('PLUGIN_LEASE_MISMATCH');
        }
        generation.registrations = materialized.registrations;
      })
      : this.options.serviceHost.activate(controller.signal, generationNumber).then((serviceGeneration) => {
        generation.serviceGeneration = serviceGeneration;
      });

    void raceWithAbort(work, controller.signal).then(() => {
      this.assertGenerationCurrent(runtime, generation, transitionEpoch);
      runtime.lifecycle = 'active';
      runtime.lastFailure = null;
      this.publish(runtime);
      resolveActivation(this.snapshot(runtime));
    }).catch(async (cause) => {
      if (!this.generationCanPublish(runtime, generation, transitionEpoch)) {
        rejectActivation(new Error('PLUGIN_GENERATION_ABORTED'));
        return;
      }
      runtime.generation = null;
      runtime.cleanupPending = generation;
      const cleanupFailures = await this.attemptGenerationCleanup(runtime, generation);
      runtime.lifecycle = 'failed';
      runtime.lastFailure = cleanupFailures.length > 0
        ? combinedFailureDetail(cause, cleanupFailures)
        : toPublicPluginFailure(cause);
      this.publish(runtime);
      rejectActivation(cause);
    });
    return activation;
  }

  private async executeActiveCommand(runtime: PluginRuntime, commandId: string): Promise<boolean> {
    const generation = runtime.generation;
    if (!generation || runtime.lifecycle !== 'active') return false;
    try {
      this.assertGenerationCurrent(runtime, generation);
    } catch {
      return false;
    }
    const work = runsInEditor(runtime.manifest)
      ? this.options.rendererHost.executeLeaseCommand(
        generation.leaseId as string,
        commandId,
        generation.controller.signal,
      )
      : this.options.serviceHost.executeCommand?.(
        commandId,
        generation.controller.signal,
        generation.number,
      ) ?? Promise.resolve(false);
    return raceWithAbort(work, generation.controller.signal);
  }

  private async cleanupOwnedGeneration(runtime: PluginRuntime): Promise<unknown[]> {
    const generation = runtime.generation;
    if (generation) {
      runtime.generation = null;
      runtime.cleanupPending = generation;
      generation.controller.abort();
      generation.registrations = 0;
    }
    const cleanup = runtime.cleanupPending;
    return cleanup ? this.attemptGenerationCleanup(runtime, cleanup) : [];
  }

  private async attemptGenerationCleanup(
    runtime: PluginRuntime,
    generation: GenerationRuntime,
  ): Promise<unknown[]> {
    if (generation.cleanupAttempt) return generation.cleanupAttempt;
    generation.controller.abort();
    generation.registrations = 0;
    const attempt = this.runGenerationCleanup(runtime, generation);
    generation.cleanupAttempt = attempt;
    try {
      const failures = await attempt;
      if (failures.length === 0 && runtime.cleanupPending === generation) {
        runtime.cleanupPending = null;
      }
      return failures;
    } finally {
      generation.cleanupAttempt = null;
    }
  }

  private async runGenerationCleanup(
    runtime: PluginRuntime,
    generation: GenerationRuntime,
  ): Promise<unknown[]> {
    const failures: unknown[] = [];
    try {
      if (runsInEditor(runtime.manifest)) {
        const release = await withTimeout(
          this.options.rendererHost.closeLease(generation.leaseId as string),
          this.cleanupTimeoutMs,
        );
        if (release.leaseId !== generation.leaseId) failures.push(new Error('PLUGIN_LEASE_MISMATCH'));
        failures.push(...release.failures);
        if (!release.complete && release.failures.length === 0) {
          failures.push(new Error('PLUGIN_RENDERER_CLEANUP_INCOMPLETE'));
        }
      } else {
        await withTimeout(
          this.options.serviceHost.deactivate(generation.number),
          this.cleanupTimeoutMs,
        );
      }
    } catch (cause) {
      failures.push(cause);
    }
    return failures;
  }

  private beginTransition(
    runtime: PluginRuntime,
    phase: Exclude<PluginTransitionPhase, 'stable'>,
    intentEnabled: boolean,
    fenceGeneration: boolean,
  ): number {
    const epoch = runtime.transition.epoch + 1;
    runtime.transition = { epoch, phase, intentEnabled };
    if (fenceGeneration) runtime.generation?.controller.abort();
    return epoch;
  }

  private finishTransition(runtime: PluginRuntime, epoch: number): boolean {
    if (runtime.transition.epoch !== epoch) return false;
    runtime.transition = {
      epoch,
      phase: 'stable',
      intentEnabled: runtime.desiredEnabled,
    };
    return true;
  }

  private activationIntentAllows(runtime: PluginRuntime, epoch = runtime.transition.epoch): boolean {
    return runtime.transition.epoch === epoch
      && runtime.transition.phase === 'stable'
      && runtime.transition.intentEnabled
      && runtime.desiredEnabled
      && runtime.cleanupPending === null;
  }

  private generationCanPublish(
    runtime: PluginRuntime,
    generation: GenerationRuntime,
    epoch = runtime.transition.epoch,
  ): boolean {
    return runtime.generation === generation
      && !generation.controller.signal.aborted
      && this.activationIntentAllows(runtime, epoch);
  }

  private assertGenerationCurrent(
    runtime: PluginRuntime,
    generation: GenerationRuntime,
    epoch = runtime.transition.epoch,
  ): void {
    if (!this.generationCanPublish(runtime, generation, epoch)) {
      throw new Error('PLUGIN_GENERATION_ABORTED');
    }
  }

  private queue<T>(
    pluginId: string,
    operation: (runtime: PluginRuntime) => Promise<T>,
  ): Promise<T> {
    const runtime = this.requireRuntime(pluginId);
    const previous = this.transitionQueues.get(pluginId) ?? settled;
    const result = previous.then(() => operation(runtime));
    this.transitionQueues.set(pluginId, result.then(() => undefined, () => undefined));
    return result;
  }

  private persist(mutate: (state: LocalPluginState) => void): Promise<PersistResult> {
    const operation = this.persistenceTail.then(async () => {
      const next = cloneLocalPluginState(this.persistedState);
      mutate(next);
      const outcome = await this.options.stateStore.save(cloneLocalPluginState(next));
      const state = parseLocalPluginState(outcome.state, this.catalog);
      const before = new Map<string, PersistedRuntimeBefore>();
      for (const runtime of this.runtimes.values()) {
        before.set(runtime.manifest.id, {
          desiredEnabled: runtime.desiredEnabled,
          settings: { ...runtime.settings },
        });
      }
      this.persistedState = state;
      for (const runtime of this.runtimes.values()) {
        runtime.persistenceHealth = outcome.health;
        this.adoptPersistedRuntime(runtime, state);
      }
      await this.reconcilePersistedOutcome(before, next);
      return { state: cloneLocalPluginState(state), outcome };
    });
    this.persistenceTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async reconcilePersistedOutcome(
    before: ReadonlyMap<string, PersistedRuntimeBefore>,
    requested: LocalPluginState,
  ): Promise<void> {
    const cleanupTasks: Array<Promise<unknown[]>> = [];
    const settingTasks: Array<Promise<unknown[]>> = [];

    for (const runtime of this.runtimes.values()) {
      const prior = before.get(runtime.manifest.id);
      const callerAlreadyOwnsDisable = runtime.transition.phase === 'disabling'
        && !runtime.transition.intentEnabled;
      if (!runtime.desiredEnabled
        && (runtime.generation || runtime.cleanupPending)
        && !callerAlreadyOwnsDisable) {
        runtime.transition = {
          epoch: runtime.transition.epoch + 1,
          phase: 'disabling',
          intentEnabled: false,
        };
        const cleanup = this.cleanupOwnedGeneration(runtime);
        runtime.lifecycle = 'deactivating';
        runtime.activationReason = null;
        this.publish(runtime);
        cleanupTasks.push(cleanup.then((failures) => {
          runtime.transition = {
            epoch: runtime.transition.epoch,
            phase: 'stable',
            intentEnabled: false,
          };
          if (failures.length > 0) {
            runtime.lifecycle = 'failed';
            runtime.lastFailure = cleanupFailureDetail(
              'Persisted outcome reconciliation cleanup failed',
              failures,
            );
          } else {
            runtime.lifecycle = 'disabled';
            runtime.lastFailure = null;
          }
          this.publish(runtime);
          return failures;
        }));
        continue;
      }

      const changedSettingKeys = prior
        ? runtime.manifest.settings
          .map((setting) => setting.key)
          .filter((key) => prior.settings[key] !== runtime.settings[key]
            || requested.plugins[runtime.manifest.id].settings[key] !== runtime.settings[key])
        : [];
      const generation = runtime.generation;
      if (runtime.desiredEnabled
        && runsInEditor(runtime.manifest)
        && generation?.leaseId
        && changedSettingKeys.length > 0) {
        settingTasks.push(this.reconcileLiveSettings(runtime, generation, changedSettingKeys));
      } else if (runtime.transition.phase === 'stable'
        && !runtime.generation
        && !runtime.cleanupPending
        && runtime.lifecycle !== 'failed') {
        runtime.transition.intentEnabled = runtime.desiredEnabled;
        runtime.lifecycle = runtime.desiredEnabled ? 'enabled-idle' : 'disabled';
      }
    }

    const [cleanupResults, settingResults] = await Promise.all([
      Promise.all(cleanupTasks),
      Promise.all(settingTasks),
    ]);
    const cleanupFailures = cleanupResults.flat();
    if (cleanupFailures.length > 0) {
      throw new PluginLifecycleError(
        'PLUGIN_PERSISTED_RECONCILIATION_CLEANUP_FAILED',
        cleanupFailures,
      );
    }
    const settingFailures = settingResults.flat();
    if (settingFailures.length > 0) throw settingFailures[0];
  }

  private async reconcileLiveSettings(
    runtime: PluginRuntime,
    generation: GenerationRuntime,
    keys: readonly string[],
  ): Promise<unknown[]> {
    const failures: unknown[] = [];
    for (const key of keys) {
      try {
        this.assertGenerationCurrent(runtime, generation);
        await raceWithAbort(this.options.rendererHost.updateLeaseSetting(
          generation.leaseId as string,
          key,
          runtime.settings[key],
          generation.controller.signal,
        ), generation.controller.signal);
        this.assertGenerationCurrent(runtime, generation);
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (failures.length > 0) {
      runtime.lifecycle = 'failed';
      runtime.lastFailure = toPublicPluginFailure(failures[0]);
    } else if (runtime.lifecycle === 'active') {
      runtime.lastFailure = null;
    }
    this.publish(runtime);
    return failures;
  }

  private adoptPersistedRuntime(runtime: PluginRuntime, state: LocalPluginState): void {
    const persisted = state.plugins[runtime.manifest.id];
    runtime.desiredEnabled = persisted.desiredEnabled;
    runtime.settings = { ...persisted.settings };
  }

  private requireRuntime(pluginId: string): PluginRuntime {
    const runtime = this.runtimes.get(pluginId);
    if (!runtime) throw new Error(`PLUGIN_UNKNOWN: ${pluginId}`);
    return runtime;
  }

  private requireHydrated(): void {
    if (!this.hydrated) throw new Error('PLUGIN_NOT_HYDRATED');
  }

  private snapshot(runtime: PluginRuntime): PluginLifecycleSnapshot {
    const generation = runtime.generation;
    const ownedGeneration = generation ?? runtime.cleanupPending;
    return Object.freeze({
      id: runtime.manifest.id,
      manifestVersion: runtime.manifest.version,
      desiredEnabled: runtime.desiredEnabled,
      lifecycle: runtime.lifecycle,
      settings: Object.freeze({ ...runtime.settings }),
      activeGeneration: generation?.number ?? null,
      leaseCount: ownedGeneration?.leaseId ? 1 : 0,
      rendererRegistrations: generation?.registrations ?? 0,
      activationReason: runtime.activationReason ? Object.freeze({ ...runtime.activationReason }) : null,
      persistenceHealth: runtime.persistenceHealth,
      lastFailure: runtime.lastFailure,
      capability: Object.freeze({
        grant: runtime.capability.grant ? Object.freeze({ ...runtime.capability.grant }) : null,
        request: runtime.capability.request ? Object.freeze({ ...runtime.capability.request }) : null,
        restartRequired: runtime.capability.restartRequired,
      }),
      presentation: Object.freeze({
        name: runtime.manifest.name,
        description: runtime.manifest.description ?? '',
        origin: runtime.manifest.runtime === 'sandboxed' ? 'user' as const : 'bundled' as const,
        install: this.options.install?.(runtime.manifest.id) ?? null,
        commands: Object.freeze(runtime.manifest.commands.map((command) => Object.freeze({ id: command.id, title: command.title }))),
        hotkeys: Object.freeze(runtime.manifest.hotkeys.map((hotkey) => Object.freeze({ command: hotkey.command, keys: hotkey.keys }))),
      }),
    });
  }

  private publish(runtime: PluginRuntime): void {
    try {
      this.options.publish?.(this.snapshot(runtime));
    } catch (cause) {
      runtime.diagnostics.push(`PLUGIN_PUBLISH_OBSERVER_FAILED: ${toPublicPluginFailure(cause)}`);
      if (runtime.diagnostics.length > MAX_DIAGNOSTICS) runtime.diagnostics.shift();
    }
  }

  private adoptServiceEvent(event: ServiceHostEvent): void {
    const runtime = this.runtimes.get(filesystemProofManifest.id);
    if (!runtime) return;
    const generation = event.type === 'unexpected-exit'
      ? runtime.generation
      : runtime.generation ?? runtime.cleanupPending;
    if (!generation || generation.number !== event.registryGeneration
      || generation.serviceGeneration !== event.serviceGeneration) return;
    if (event.type === 'capability') {
      runtime.capability = {
        grant: event.capability.grant ? { ...event.capability.grant } : null,
        request: event.capability.request ? { ...event.capability.request } : null,
        restartRequired: event.capability.restartRequired,
      };
      this.publish(runtime);
      return;
    }
    generation.controller.abort();
    runtime.generation = null;
    runtime.cleanupPending = null;
    runtime.lifecycle = 'crashed';
    runtime.activationReason = null;
    runtime.capability = {
      ...runtime.capability,
      grant: runtime.capability.grant ? { ...runtime.capability.grant, state: 'revoked' } : null,
      request: runtime.capability.request?.state === 'pending'
        ? { ...runtime.capability.request, state: 'failed', detail: 'Service process exited' }
        : runtime.capability.request,
      restartRequired: true,
    };
    runtime.lastFailure = 'SERVICE_FAILED';
    this.publish(runtime);
  }
}

async function raceWithAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
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

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('PLUGIN_CLEANUP_TIMEOUT')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function persistedIntentMismatchDetail(): string {
  return 'PLUGIN_PERSISTED_INTENT_MISMATCH';
}

function cleanupFailureDetail(summary: string, failures: readonly unknown[]): string {
  return `${cleanupSummaryCode(summary)}: ${failures.map((failure) => toPublicPluginFailure(failure)).join(' | ')}`;
}

function combinedFailureDetail(
  primary: unknown,
  cleanupFailures: readonly unknown[],
): string {
  return `PLUGIN_GENERATION_FAILED: ${toPublicPluginFailure(primary)} | PLUGIN_CLEANUP_FAILED: ${cleanupFailures.map((failure) => toPublicPluginFailure(failure)).join(' | ')}`;
}

const PUBLIC_PLUGIN_FAILURE_CODES = new Set<string>([
  ...RENDERER_TRANSPORT_FAILURE_CODES,
  'BAD_REQUEST',
  'CAPABILITY_DENIED',
  'CORRUPT_LOCAL_PLUGIN_STATE',
  'PLUGIN_CATALOG_HOTKEY_CONFLICT',
  'PLUGIN_CATALOG_INVALID',
  'PLUGIN_CLEANUP_FAILED',
  'PLUGIN_CLEANUP_TIMEOUT',
  'PLUGIN_COMMAND_UNKNOWN',
  'PLUGIN_DISABLE_CLEANUP_FAILED',
  'PLUGIN_DISCOVERY_CATALOG_INVALID',
  'PLUGIN_DISCOVERY_LIMIT_EXCEEDED',
  'PLUGIN_DISCOVERY_MANIFEST_INVALID',
  'PLUGIN_DISCOVERY_MANIFEST_TOO_LARGE',
  'PLUGIN_DISCOVERY_UNAVAILABLE',
  'PLUGIN_DISCOVERY_UNSAFE',
  'PLUGIN_FAILED',
  'PLUGIN_GENERATION_ABORTED',
  'PLUGIN_GENERATION_FAILED',
  'PLUGIN_GENERATION_INVALID',
  'PLUGIN_GENERATION_STALE',
  'PLUGIN_LEASE_MISMATCH',
  'PLUGIN_LEASE_STALE',
  'PLUGIN_LEASE_UNKNOWN',
  'PLUGIN_MANIFEST_INVALID',
  'PLUGIN_MANIFEST_VERSION_UNSUPPORTED',
  'PLUGIN_NOT_HYDRATED',
  'PLUGIN_PERSISTED_INTENT_MISMATCH',
  'PLUGIN_PERSISTED_RECONCILIATION_CLEANUP_FAILED',
  'PLUGIN_RENDERER_ACK_MISMATCH',
  'PLUGIN_RENDERER_CLEANUP_INCOMPLETE',
  'PLUGIN_RENDERER_DISPATCH_FAILED',
  'PLUGIN_RENDERER_DISPOSED',
  'PLUGIN_RENDERER_DISPOSAL_CLEANUP_FAILED',
  'PLUGIN_RENDERER_REQUEST_ID_REUSED',
  'PLUGIN_RENDERER_REQUEST_INVALID',
  'PLUGIN_RENDERER_SESSION_STALE',
  'PLUGIN_RENDERER_TIMEOUT',
  'PLUGIN_SETTING_INVALID',
  'PLUGIN_SETTING_UNKNOWN',
  'PLUGIN_SHUTDOWN_CLEANUP_FAILED',
  'PLUGIN_STALE',
  'PLUGIN_UNKNOWN',
  'PLUGIN_REPLACEMENT_CLEANUP_FAILED',
  'READ_LOCAL_PLUGIN_STATE_FAILED',
  'SERVICE_CANCELLED',
  'SERVICE_FAILED',
  'SERVICE_STOPPED',
  'TIMEOUT',
  'UNSAFE_LOCAL_PLUGIN_STATE',
  'WRITE_LOCAL_PLUGIN_STATE_FAILED',
]);

export function toPublicPluginFailure(
  cause: unknown,
  fallback = 'PLUGIN_FAILED',
): string {
  const raw = cause instanceof Error && cause.message.length > 0
    ? cause.message
    : typeof cause === 'string' && cause.length > 0
      ? cause
      : '';
  const code = /^([A-Z][A-Z0-9_]{1,63})(?=\s*:|\s*$)/.exec(raw.trim())?.[1];
  return code && PUBLIC_PLUGIN_FAILURE_CODES.has(code)
    ? code
    : PUBLIC_PLUGIN_FAILURE_CODES.has(fallback) ? fallback : 'PLUGIN_FAILED';
}

function cleanupSummaryCode(summary: string): string {
  switch (summary) {
    case 'Plugin cleanup failed': return 'PLUGIN_DISABLE_CLEANUP_FAILED';
    case 'Replacement cleanup failed': return 'PLUGIN_REPLACEMENT_CLEANUP_FAILED';
    case 'Renderer disposal cleanup failed': return 'PLUGIN_RENDERER_DISPOSAL_CLEANUP_FAILED';
    case 'Shutdown cleanup failed': return 'PLUGIN_SHUTDOWN_CLEANUP_FAILED';
    case 'Persisted outcome reconciliation cleanup failed':
      return 'PLUGIN_PERSISTED_RECONCILIATION_CLEANUP_FAILED';
    default: return 'PLUGIN_CLEANUP_FAILED';
  }
}

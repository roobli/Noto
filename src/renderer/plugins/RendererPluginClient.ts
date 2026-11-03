import type { NotoPluginsApi } from '../../shared/ipc/contracts';
import {
  PLUGIN_LIFECYCLE_VERSION,
  toRendererTransportFailureCode,
} from '../../shared/plugins/lifecycle';
import type {
  RendererTransportFailureCode,
  RendererTransportAck,
  RendererTransportRequest,
} from '../../shared/plugins/lifecycle';
import type { NotoEditorPort } from '../editor/noto/NotoEditorPort';
import { RendererPluginHost } from './RendererPluginHost';

interface LocalLease {
  pluginId: string;
  leaseId: string;
  generation: number;
  controller: AbortController;
}

export class RendererPluginClient {
  private readonly leases = new Map<string, LocalLease>();
  private readonly closedLeases = new Map<string, Omit<LocalLease, 'controller'>>();
  private unsubscribe: (() => void) | null = null;
  private rendererSessionId: string | null = null;
  private disposed = false;

  /**
   * One host per plugin, keyed by plugin id.
   *
   * Each host owns its own leases and cleanup, so a lease issued for one plugin
   * can never be routed into another's runtime. A single shared host would make
   * that mistake possible by construction.
   */
  constructor(
    private readonly hosts: ReadonlyMap<string, RendererPluginHost>,
    private readonly api: NotoPluginsApi,
    /**
     * A host for a plugin the reader installed, made the first time main
     * asks for it: such a plugin is not compiled in, so its host cannot be
     * in the fixed map. Each still gets a host of its own.
     */
    private readonly installed?: (pluginId: string) => RendererPluginHost | undefined,
  ) {}

  private readonly created = new Map<string, RendererPluginHost>();
  private adapter: NotoEditorPort | null = null;

  private allHosts(): RendererPluginHost[] {
    return [...this.hosts.values(), ...this.created.values()];
  }

  /** Refuse a request for a plugin this renderer does not host. */
  private hostFor(pluginId: string): RendererPluginHost {
    const host = this.hosts.get(pluginId) ?? this.created.get(pluginId) ?? this.createInstalled(pluginId);
    if (!host) throw new Error('PLUGIN_UNKNOWN');
    return host;
  }


  start(): void {
    if (this.disposed || this.unsubscribe) return;
    this.rendererSessionId = crypto.randomUUID();
    this.unsubscribe = this.api.onRendererRequest((request) => { void this.handle(request); });
    this.api.rendererReady({
      version: PLUGIN_LIFECYCLE_VERSION,
      rendererSessionId: this.rendererSessionId,
    });
  }

  attachAdapter(adapter: NotoEditorPort): void {
    if (this.disposed) return;
    this.adapter = adapter;
    for (const host of this.allHosts()) host.attachAdapter(adapter);
  }

  private createInstalled(pluginId: string): RendererPluginHost | undefined {
    if (this.disposed) return undefined;
    const host = this.installed?.(pluginId);
    if (!host) return undefined;
    this.created.set(pluginId, host);
    if (this.adapter) host.attachAdapter(this.adapter);
    return host;
  }

  async detachAdapter(): Promise<void> {
    if (this.disposed) return;
    await this.releaseAndReportAll();
    for (const host of this.allHosts()) await host.disposeRenderer();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await this.releaseAndReportAll();
      for (const host of this.allHosts()) await host.disposeRenderer();
    } finally {
      this.unsubscribe?.();
      this.unsubscribe = null;
    }
  }

  private async handle(request: RendererTransportRequest): Promise<void> {
    if (!this.rendererSessionId || request.rendererSessionId !== this.rendererSessionId) return;
    if (this.disposed && request.action !== 'close') {
      this.acknowledgeFailure(request, 'PLUGIN_RENDERER_DISPOSED');
      return;
    }
    try {
      if (request.action === 'open') {
        const prior = this.leases.get(request.leaseId);
        if (prior && (prior.pluginId !== request.pluginId || prior.generation !== request.generation)) {
          throw new Error('PLUGIN_LEASE_MISMATCH');
        }
        const controller = new AbortController();
        const lease: LocalLease = {
          pluginId: request.pluginId,
          leaseId: request.leaseId,
          generation: request.generation,
          controller,
        };
        this.leases.set(request.leaseId, lease);
        this.closedLeases.delete(request.leaseId);
        try {
          const materialized = await this.hostFor(request.pluginId).openLease({
            pluginId: request.pluginId,
            leaseId: request.leaseId,
            generation: request.generation,
            settings: Object.freeze({ ...request.settings }),
            signal: controller.signal,
          });
          this.api.acknowledgeRenderer({
            ...ackBase(request),
            action: 'open',
            ok: true,
            registrations: materialized.registrations,
          });
        } catch (cause) {
          controller.abort();
          this.leases.delete(request.leaseId);
          this.rememberClosed(lease);
          throw cause;
        }
        return;
      }

      const lease = this.requireLeaseIdentity(request);
      if (request.action === 'close') {
        lease.controller?.abort();
        const release = await this.hostFor(request.pluginId).closeLease(request.leaseId);
        if (release.complete) {
          const current = this.leases.get(request.leaseId);
          if (current) this.rememberClosed(current);
          this.leases.delete(request.leaseId);
        }
        this.api.acknowledgeRenderer({
          ...ackBase(request),
          action: 'close',
          ok: true,
          complete: release.complete,
          failures: release.failures.map(toRendererTransportFailureCode),
          registrations: 0,
        });
        return;
      }

      if (!lease.controller) throw new Error('PLUGIN_LEASE_CLOSED');
      if (request.action === 'execute-command') {
        const handled = await this.hostFor(request.pluginId).executeLeaseCommand(
          request.leaseId,
          request.commandId,
          lease.controller.signal,
        );
        this.api.acknowledgeRenderer({
          ...ackBase(request),
          action: 'execute-command',
          ok: true,
          handled,
        });
        return;
      }

      await this.hostFor(request.pluginId).updateLeaseSetting(
        request.leaseId,
        request.key,
        request.value,
        lease.controller.signal,
      );
      this.api.acknowledgeRenderer({
        ...ackBase(request),
        action: 'update-setting',
        ok: true,
      });
    } catch (cause) {
      this.acknowledgeFailure(request, toRendererTransportFailureCode(cause));
    }
  }

  private requireLeaseIdentity(request: RendererTransportRequest): LocalLease | (Omit<LocalLease, 'controller'> & { controller?: undefined }) {
    const live = this.leases.get(request.leaseId);
    if (live) {
      if (live.pluginId !== request.pluginId || live.generation !== request.generation) {
        throw new Error('PLUGIN_GENERATION_STALE');
      }
      return live;
    }
    const closed = this.closedLeases.get(request.leaseId);
    if (closed && closed.pluginId === request.pluginId && closed.generation === request.generation) {
      return { ...closed };
    }
    throw new Error('PLUGIN_LEASE_UNKNOWN');
  }

  private async releaseAndReportAll(): Promise<void> {
    const active = [...this.leases.values()];
    for (const lease of active) {
      const result = await this.api.rendererDisposed({
        version: PLUGIN_LIFECYCLE_VERSION,
        requestId: `renderer-disposed:${crypto.randomUUID()}`,
        pluginId: lease.pluginId,
        leaseId: lease.leaseId,
        generation: lease.generation,
      });
      if (!result.ok) throw new Error(result.error.code);
      if (this.leases.has(lease.leaseId)) throw new Error('PLUGIN_RENDERER_DISPOSAL_INCOMPLETE');
    }
  }

  private rememberClosed(lease: LocalLease): void {
    this.closedLeases.set(lease.leaseId, {
      pluginId: lease.pluginId,
      leaseId: lease.leaseId,
      generation: lease.generation,
    });
    if (this.closedLeases.size <= 256) return;
    const oldest = this.closedLeases.keys().next().value;
    if (typeof oldest === 'string') this.closedLeases.delete(oldest);
  }

  private acknowledgeFailure(
    request: RendererTransportRequest,
    error: RendererTransportFailureCode,
  ): void {
    const ack: RendererTransportAck = {
      ...ackBase(request),
      action: request.action,
      ok: false,
      error,
    };
    this.api.acknowledgeRenderer(ack);
  }
}

function ackBase(request: RendererTransportRequest) {
  return {
    version: PLUGIN_LIFECYCLE_VERSION,
    requestId: request.requestId,
    rendererSessionId: request.rendererSessionId,
    pluginId: request.pluginId,
    leaseId: request.leaseId,
    generation: request.generation,
  } as const;
}

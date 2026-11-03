import type { PluginManifest } from './manifest';
export type PluginLifecycleState =
  | 'discovered'
  | 'disabled'
  | 'enabled-idle'
  | 'activating'
  | 'active'
  | 'deactivating'
  | 'failed'
  | 'crashed';

export type PluginActivationReason =
  | { type: 'startup' }
  | { type: 'event'; event: string }
  | { type: 'hotkey'; keys: string }
  | { type: 'command'; commandId: string };

export type PluginPersistenceHealth = 'healthy' | 'degraded' | 'indeterminate';

export type PluginCapabilityGrantState = 'active' | 'revoking' | 'revoked';
export type PluginCapabilityRequestState =
  | 'pending'
  | 'cancelling'
  | 'completed'
  | 'cancelled'
  | 'timed-out'
  | 'failed';

export interface PluginCapabilityGrantSnapshot {
  id: string;
  generation: number;
  root: string;
  state: PluginCapabilityGrantState;
}

export interface PluginCapabilityRequestSnapshot {
  requestId: string;
  generation: number;
  action: 'read-granted' | 'deny-probe';
  state: PluginCapabilityRequestState;
  detail: string;
}

export interface PluginCapabilitySnapshot {
  grant: PluginCapabilityGrantSnapshot | null;
  request: PluginCapabilityRequestSnapshot | null;
  restartRequired: boolean;
}

export interface RendererLeaseRequest {
  pluginId: string;
  leaseId: string;
  generation: number;
  settings: Readonly<Record<string, boolean>>;
  signal: AbortSignal;
}

export interface RendererLeaseMaterialization {
  leaseId: string;
  generation: number;
  registrations: number;
}

export interface RendererLeaseRelease {
  leaseId: string;
  complete: boolean;
  failures: string[];
  registrations: 0;
}

/**
 * What the shell shows of a plugin: its name, what it adds, where it came
 * from. Carried on every snapshot so the palette, the hotkeys, Plugin Center
 * and the Shortcuts pane read a plugin from the catalog main holds, rather
 * than from lists of the bundled manifests compiled into the renderer, which
 * a plugin installed by the reader would never be in.
 */
export interface PluginPresentationSnapshot {
  name: string;
  /** Empty for a bundled plugin, which Plugin Center describes itself. */
  description: string;
  origin: 'bundled' | 'user';
  commands: readonly { id: string; title: string }[];
  hotkeys: readonly { command: string; keys: string }[];
  /**
   * For a plugin the reader installed: where it came from, how far it is
   * trusted, where its code is served (pinned to the code's digest), and its
   * manifest, which the renderer needs to gate what the plugin may call.
   * Null for a bundled plugin, whose code is part of the app.
   */
  install: PluginInstallPresentation | null;
}

export interface PluginInstallPresentation {
  source: string;
  trust: 'sandboxed' | 'full';
  codeUrl: string;
  manifest: PluginManifest;
}

export interface PluginLifecycleSnapshot {
  id: string;
  manifestVersion: string;
  desiredEnabled: boolean;
  lifecycle: PluginLifecycleState;
  settings: Readonly<Record<string, boolean>>;
  activeGeneration: number | null;
  leaseCount: number;
  rendererRegistrations: number;
  activationReason: PluginActivationReason | null;
  persistenceHealth: PluginPersistenceHealth;
  lastFailure: string | null;
  capability: PluginCapabilitySnapshot;
  presentation: PluginPresentationSnapshot;
}

export const PLUGIN_LIFECYCLE_VERSION = 1 as const;

export const RENDERER_TRANSPORT_FAILURE_CODES = [
  'PLUGIN_FAILED',
  'PLUGIN_GENERATION_ABORTED',
  'PLUGIN_GENERATION_STALE',
  'PLUGIN_RENDERER_DISPOSED',
  'PLUGIN_RENDERER_UNAVAILABLE',
  'PLUGIN_RENDERER_DISPOSAL_FAILED',
  'PLUGIN_RENDERER_DISPOSAL_INCOMPLETE',
  'PLUGIN_LEASE_MISMATCH',
  'PLUGIN_LEASE_PLUGIN_MISMATCH',
  'PLUGIN_LEASE_INVALID',
  'PLUGIN_LEASE_REUSED',
  'PLUGIN_LEASE_CLOSED',
  'PLUGIN_LEASE_UNKNOWN',
  'PLUGIN_CAPABILITY_DENIED',
  'PLUGIN_DISPOSER_INVALID',
  'PLUGIN_MANIFEST_INVALID',
  'PLUGIN_REGISTRATION_DUPLICATE',
  'PLUGIN_REGISTRATION_UNDECLARED',
  'PLUGIN_REPLACEMENT_CLEANUP_FAILED',
  'PLUGIN_SETTING_INVALID',
  'PLUGIN_SETTING_UNKNOWN',
  'PLUGIN_SETTING_UNAVAILABLE',
] as const;

export type RendererTransportFailureCode = typeof RENDERER_TRANSPORT_FAILURE_CODES[number];

export function isRendererTransportFailureCode(
  value: unknown,
): value is RendererTransportFailureCode {
  return typeof value === 'string'
    && RENDERER_TRANSPORT_FAILURE_CODES.includes(value as RendererTransportFailureCode);
}

export function toRendererTransportFailureCode(cause: unknown): RendererTransportFailureCode {
  const detail = cause instanceof Error
    ? cause.message
    : typeof cause === 'string'
      ? cause
      : '';
  return RENDERER_TRANSPORT_FAILURE_CODES.find((code) => (
    detail === code || detail.startsWith(`${code}:`) || detail.startsWith(`${code} `)
  )) ?? 'PLUGIN_FAILED';
}

export type PluginLifecycleAction =
  | 'get-snapshots'
  | 'enable'
  | 'disable'
  | 'trigger-startup'
  | 'trigger-event'
  | 'trigger-hotkey'
  | 'execute-command'
  | 'set-setting'
  | 'replace-generation'
  | 'renderer-disposed';

interface PluginLifecycleRequestBase {
  version: typeof PLUGIN_LIFECYCLE_VERSION;
  requestId: string;
  action: PluginLifecycleAction;
}

export type PluginLifecycleRequest =
  | (PluginLifecycleRequestBase & { action: 'get-snapshots' })
  | (PluginLifecycleRequestBase & { action: 'trigger-startup' })
  | (PluginLifecycleRequestBase & { action: 'enable'; pluginId: string })
  | (PluginLifecycleRequestBase & { action: 'disable'; pluginId: string })
  | (PluginLifecycleRequestBase & { action: 'trigger-event'; event: string })
  | (PluginLifecycleRequestBase & { action: 'trigger-hotkey'; keys: string })
  | (PluginLifecycleRequestBase & {
    action: 'execute-command';
    pluginId: string;
    commandId: string;
  })
  | (PluginLifecycleRequestBase & {
    action: 'set-setting';
    pluginId: string;
    key: string;
    value: boolean;
  })
  | (PluginLifecycleRequestBase & {
    action: 'replace-generation';
    pluginId: string;
    reason: PluginActivationReason;
  })
  | (PluginLifecycleRequestBase & {
    action: 'renderer-disposed';
    pluginId: string;
    leaseId: string;
    generation: number;
  });

export interface PluginLifecycleReply {
  version: typeof PLUGIN_LIFECYCLE_VERSION;
  action: PluginLifecycleAction;
  snapshots: PluginLifecycleSnapshot[];
  handled: boolean | null;
}

export interface PluginSnapshotEvent {
  version: typeof PLUGIN_LIFECYCLE_VERSION;
  snapshots: PluginLifecycleSnapshot[];
}

interface RendererTransportRequestBase {
  version: typeof PLUGIN_LIFECYCLE_VERSION;
  requestId: string;
  rendererSessionId: string;
  pluginId: string;
  leaseId: string;
  generation: number;
}

export type RendererTransportRequest =
  | (RendererTransportRequestBase & {
    action: 'open';
    settings: Record<string, boolean>;
  })
  | (RendererTransportRequestBase & { action: 'close' })
  | (RendererTransportRequestBase & { action: 'execute-command'; commandId: string })
  | (RendererTransportRequestBase & {
    action: 'update-setting';
    key: string;
    value: boolean;
  });

interface RendererTransportAckBase {
  version: typeof PLUGIN_LIFECYCLE_VERSION;
  requestId: string;
  rendererSessionId: string;
  pluginId: string;
  leaseId: string;
  generation: number;
}

export type RendererTransportAck =
  | (RendererTransportAckBase & {
    action: RendererTransportRequest['action'];
    ok: false;
    error: RendererTransportFailureCode;
  })
  | (RendererTransportAckBase & {
    action: 'open';
    ok: true;
    registrations: number;
  })
  | (RendererTransportAckBase & {
    action: 'close';
    ok: true;
    complete: boolean;
    failures: RendererTransportFailureCode[];
    registrations: 0;
  })
  | (RendererTransportAckBase & {
    action: 'execute-command';
    ok: true;
    handled: boolean;
  })
  | (RendererTransportAckBase & {
    action: 'update-setting';
    ok: true;
  });

export interface RendererReadyMessage {
  version: typeof PLUGIN_LIFECYCLE_VERSION;
  rendererSessionId: string;
}

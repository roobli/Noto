import type { NotoErrorCode } from '../../shared/errors';
import type { Result } from '../../shared/ipc/contracts';
import type { PluginLifecycleSnapshot } from '../../shared/plugins/lifecycle';

export type PluginSnapshotAvailability = 'loading' | 'ready' | 'unavailable';
export type PluginPresentationTone = 'neutral' | 'warning' | 'danger';
export type RendererPrimaryAction = 'enable' | 'activate' | 'disable' | 'retry' | 'retry-cleanup';
export type FilesystemPrimaryAction = 'enable' | 'start' | 'grant' | 'read' | 'cancel' | 'restart' | 'retry-cleanup';

export interface PluginPresentation<TAction extends string> {
  status: string;
  scope: string;
  primaryAction: TAction | null;
  primaryLabel: string;
  actionDisabled: boolean;
  tone: PluginPresentationTone;
}

function unavailablePresentation<TAction extends string>(
  availability: PluginSnapshotAvailability,
  scope: string,
): PluginPresentation<TAction> | null {
  if (availability === 'loading') {
    return {
      status: 'Loading plugin state', scope, primaryAction: null,
      primaryLabel: 'Loading', actionDisabled: true, tone: 'neutral',
    };
  }
  if (availability === 'unavailable') {
    return {
      status: 'Plugin state unavailable', scope, primaryAction: null,
      primaryLabel: 'Unavailable', actionDisabled: true, tone: 'warning',
    };
  }
  return null;
}

export function presentRendererPlugin(
  snapshot: PluginLifecycleSnapshot | undefined,
  availability: PluginSnapshotAvailability = 'ready',
): PluginPresentation<RendererPrimaryAction> {
  const scope = 'Editor decoration only. No filesystem access.';
  const unavailable = unavailablePresentation<RendererPrimaryAction>(availability, scope);
  if (unavailable) return unavailable;
  if (!snapshot) {
    return {
      status: 'Plugin state unavailable', scope, primaryAction: 'enable', primaryLabel: 'Unavailable',
      actionDisabled: true, tone: 'warning',
    };
  }
  if (snapshot.lifecycle === 'discovered') {
    return {
      status: 'Discovered, loading saved state', scope, primaryAction: null,
      primaryLabel: 'Loading', actionDisabled: true, tone: 'neutral',
    };
  }
  const cleanupResidue = snapshot.leaseCount > 0
    && snapshot.lifecycle !== 'active' && snapshot.lifecycle !== 'activating';
  const recovery = snapshot.lifecycle === 'failed' || snapshot.lifecycle === 'crashed'
    || cleanupResidue || snapshot.lastFailure !== null || snapshot.persistenceHealth !== 'healthy';
  if (recovery) {
    const cleanup = !snapshot.desiredEnabled || cleanupResidue;
    return {
      status: 'Needs recovery', scope,
      primaryAction: cleanup ? 'retry-cleanup' : 'retry',
      primaryLabel: cleanup ? 'Retry cleanup' : 'Retry',
      actionDisabled: false,
      tone: snapshot.lifecycle === 'failed' || snapshot.lifecycle === 'crashed'
        || cleanupResidue || snapshot.lastFailure !== null ? 'danger' : 'warning',
    };
  }
  if (!snapshot.desiredEnabled) {
    return {
      status: 'Disabled', scope, primaryAction: 'enable', primaryLabel: 'Enable',
      actionDisabled: false, tone: 'neutral',
    };
  }
  if (snapshot.lifecycle === 'enabled-idle') {
    return {
      status: 'Enabled, waiting for editor',
      scope,
      primaryAction: 'activate',
      primaryLabel: 'Activate for this editor',
      actionDisabled: false,
      tone: 'neutral',
    };
  }
  if (snapshot.lifecycle === 'active' || snapshot.lifecycle === 'activating'
    || snapshot.lifecycle === 'deactivating') {
    return {
      status: 'Running', scope, primaryAction: 'disable', primaryLabel: 'Disable',
      actionDisabled: false, tone: 'neutral',
    };
  }
  return {
    status: 'Needs recovery', scope, primaryAction: 'retry', primaryLabel: 'Retry',
    actionDisabled: false, tone: 'warning',
  };
}

export function presentFilesystemPlugin(
  snapshot: PluginLifecycleSnapshot | undefined,
  availability: PluginSnapshotAvailability = 'ready',
): PluginPresentation<FilesystemPrimaryAction> {
  const noAccess = 'Reads files from one folder you pick. No access until you pick it.';
  const unavailable = unavailablePresentation<FilesystemPrimaryAction>(availability, noAccess);
  if (unavailable) return unavailable;
  if (!snapshot) {
    return {
      status: 'Plugin state unavailable', scope: noAccess, primaryAction: 'enable',
      primaryLabel: 'Unavailable', actionDisabled: true, tone: 'warning',
    };
  }
  if (snapshot.lifecycle === 'discovered') {
    return {
      status: 'Discovered, loading saved state', scope: noAccess, primaryAction: null,
      primaryLabel: 'Loading', actionDisabled: true, tone: 'neutral',
    };
  }

  const request = snapshot.capability.request;
  const grant = snapshot.capability.grant;
  const grantedRoot = grant?.state === 'active' ? grant.root : null;
  const grantedScope = grantedRoot
    ? `Filesystem read limited to ${grantedRoot}`
    : noAccess;

  const cleanupResidue = snapshot.leaseCount > 0 && snapshot.lifecycle !== 'active';
  const recovery = snapshot.lifecycle === 'failed' || snapshot.lifecycle === 'crashed'
    || cleanupResidue || snapshot.lastFailure !== null || snapshot.persistenceHealth !== 'healthy';
  if (recovery && (!snapshot.desiredEnabled || cleanupResidue)) {
    return {
      status: 'Needs recovery', scope: grantedScope,
      primaryAction: 'retry-cleanup', primaryLabel: 'Retry cleanup',
      actionDisabled: false, tone: 'danger',
    };
  }
  if (snapshot.lifecycle === 'failed' || snapshot.lifecycle === 'crashed'
    || snapshot.capability.restartRequired || request?.state === 'failed'
    || snapshot.lastFailure !== null || snapshot.persistenceHealth !== 'healthy') {
    return {
      status: 'Service stopped, editor remains usable',
      scope: grantedScope,
      primaryAction: 'restart',
      primaryLabel: 'Restart service',
      actionDisabled: false,
      tone: 'danger',
    };
  }
  if (!snapshot.desiredEnabled) {
    return {
      status: 'Disabled', scope: noAccess, primaryAction: 'enable', primaryLabel: 'Enable',
      actionDisabled: false, tone: 'neutral',
    };
  }
  if (request?.state === 'timed-out') {
    return {
      status: 'Timed out, access remains blocked',
      scope: grantedScope,
      primaryAction: 'restart',
      primaryLabel: 'Restart service',
      actionDisabled: false,
      tone: 'warning',
    };
  }
  if (request?.state === 'cancelled') {
    return {
      status: 'Read cancelled, no file read',
      scope: grantedScope,
      primaryAction: grantedRoot ? 'read' : 'grant',
      primaryLabel: grantedRoot ? 'Read again' : 'Grant read access',
      actionDisabled: false,
      tone: 'warning',
    };
  }
  if (snapshot.lifecycle !== 'active') {
    return {
      status: 'Enabled, service stopped',
      scope: noAccess,
      primaryAction: 'start',
      primaryLabel: 'Start service',
      actionDisabled: false,
      tone: 'neutral',
    };
  }
  if (request?.state === 'pending' || request?.state === 'cancelling') {
    return {
      status: grantedRoot ? `Access granted to ${grantedRoot}` : 'Access not granted',
      scope: grantedScope,
      primaryAction: 'cancel',
      primaryLabel: 'Cancel read',
      actionDisabled: false,
      tone: 'neutral',
    };
  }
  if (grantedRoot) {
    return {
      status: `Access granted to ${grantedRoot}`,
      scope: grantedScope,
      primaryAction: 'read',
      primaryLabel: request?.state === 'completed' ? 'Read again' : 'Read file',
      actionDisabled: false,
      tone: 'neutral',
    };
  }
  return {
    status: 'Access not granted',
    scope: noAccess,
    primaryAction: 'grant',
    primaryLabel: 'Grant read access',
    actionDisabled: false,
    tone: 'neutral',
  };
}

export function presentPluginOperationError(code: NotoErrorCode): string {
  if (code === 'CAPABILITY_DENIED') return 'Access was denied.';
  if (code === 'TIMEOUT') return 'The operation timed out.';
  if (code === 'SERVICE_CANCELLED') return 'The operation was cancelled.';
  if (code === 'SERVICE_STOPPED') return 'The plugin service is stopped.';
  if (code === 'BAD_REQUEST') return 'The plugin action was rejected.';
  if (code.startsWith('PLUGIN_')) return 'The plugin action could not be completed.';
  return 'The plugin action failed.';
}

export function pluginOperationFailure(result: Result<unknown>): string | null {
  return result.ok ? null : presentPluginOperationError(result.error.code);
}

export const PLUGIN_STATE_UPDATE_TIMEOUT_MS = 4_000;
export type PluginActionSection = 'renderer' | 'filesystem';
export type PluginActionCompletionPolicy =
  | { type: 'reply' }
  | { type: 'snapshot'; pluginId: string; beforeIdentity: string };

export function pluginSnapshotIdentity(snapshot: PluginLifecycleSnapshot | undefined): string {
  return JSON.stringify(snapshot ?? null);
}

interface PluginActionCompletionTrackerOptions {
  timeoutMs?: number;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  onIdle(section: PluginActionSection): void;
  onTimeout(section: PluginActionSection): void;
}

export function createPluginActionCompletionTracker(options: PluginActionCompletionTrackerOptions) {
  const waits = new Map<PluginActionSection, {
    pluginId: string;
    beforeIdentity: string;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  const timeoutMs = options.timeoutMs ?? PLUGIN_STATE_UPDATE_TIMEOUT_MS;

  const cancel = (section: PluginActionSection) => {
    const wait = waits.get(section);
    if (!wait) return;
    clearTimer(wait.timer);
    waits.delete(section);
  };

  const observe = (snapshots: readonly PluginLifecycleSnapshot[]) => {
    for (const [section, wait] of waits) {
      const current = snapshots.find((snapshot) => snapshot.id === wait.pluginId);
      if (pluginSnapshotIdentity(current) === wait.beforeIdentity) continue;
      cancel(section);
      options.onIdle(section);
    }
  };

  const complete = (
    section: PluginActionSection,
    policy: PluginActionCompletionPolicy,
    snapshots: readonly PluginLifecycleSnapshot[],
  ) => {
    cancel(section);
    if (policy.type === 'reply') {
      options.onIdle(section);
      return;
    }
    const current = snapshots.find((snapshot) => snapshot.id === policy.pluginId);
    if (pluginSnapshotIdentity(current) !== policy.beforeIdentity) {
      options.onIdle(section);
      return;
    }
    const timer = setTimer(() => {
      waits.delete(section);
      options.onTimeout(section);
    }, timeoutMs);
    waits.set(section, { pluginId: policy.pluginId, beforeIdentity: policy.beforeIdentity, timer });
  };

  return Object.freeze({
    begin(section: PluginActionSection): void {
      cancel(section);
    },
    complete,
    fail(section: PluginActionSection): void {
      cancel(section);
      options.onIdle(section);
    },
    observe,
    dispose(): void {
      for (const section of [...waits.keys()]) cancel(section);
    },
    isWaiting(section: PluginActionSection): boolean {
      return waits.has(section);
    },
  });
}

export interface PluginCenterMediaQuery {
  matches: boolean;
  addEventListener(type: 'change', listener: (event: { matches: boolean }) => void): void;
  removeEventListener(type: 'change', listener: (event: { matches: boolean }) => void): void;
}

export function watchPluginCenterModal(
  matchMedia: (query: string) => PluginCenterMediaQuery,
  publish: (modal: boolean) => void,
): () => void {
  const media = matchMedia('(max-width: 520px)');
  const onChange = (event: { matches: boolean }) => publish(event.matches);
  publish(media.matches);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

export function nextTrappedFocusIndex(current: number, backwards: boolean, count: number): number {
  if (count <= 0) return -1;
  if (backwards) return current <= 0 ? count - 1 : current - 1;
  return current < 0 || current >= count - 1 ? 0 : current + 1;
}

export function shouldClosePluginCenter(key: string, open: boolean): boolean {
  return open && key === 'Escape';
}

export function restorePluginTriggerFocus(
  trigger: Pick<HTMLElement, 'focus'> | null,
  schedule: (callback: () => void) => void = queueMicrotask,
): void {
  schedule(() => trigger?.focus());
}

/**
 * Leaving Settings returns to typing when a document is open.
 *
 * Esc / Cmd+, / Done are muscle memory for "back to the note". Focusing the
 * gear that opened Settings is correct when nothing is open to type into; with
 * an editor present, the caret has to land there or the next keystroke is lost.
 */
export function restoreSettingsExitFocus(
  editor: { focus(): void } | null | undefined,
  gear: Pick<HTMLElement, 'focus'> | null | undefined,
  schedule: (callback: () => void) => void = queueMicrotask,
): void {
  schedule(() => {
    if (editor) editor.focus();
    else gear?.focus();
  });
}

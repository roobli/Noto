import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { NotoDesktopApi, NotoPluginsApi, Result, ServiceRequest } from '../../shared/ipc/contracts';
import { IPC_VERSION } from '../../shared/ipc/contracts';
import { PLUGIN_LIFECYCLE_VERSION, type PluginLifecycleSnapshot } from '../../shared/plugins/lifecycle';
import {
  filesystemProofManifest,
  markdownPaddingManifest,
  rendererProofManifest,
  titleShiftManifest,
} from '../../shared/plugins/proof-manifests';
import {
  createPluginActionCompletionTracker,
  pluginSnapshotIdentity,
  presentFilesystemPlugin,
  pluginOperationFailure,
  presentRendererPlugin,
  type FilesystemPrimaryAction,
  type PluginActionCompletionPolicy,
  type PluginActionSection,
  type PluginPresentation,
  type PluginSnapshotAvailability,
  type RendererPrimaryAction,
} from './plugin-center-state';

/** Display names for the trusted plugins, which lifecycle snapshots omit. */
const trustedNames = new Map<string, string>([
  [titleShiftManifest.id, titleShiftManifest.name],
  [markdownPaddingManifest.id, markdownPaddingManifest.name],
]);

/**
 * What each plugin does, in the reader's terms.
 *
 * The lifecycle layer can only describe what a plugin is allowed to touch,
 * which is the same sentence for every renderer plugin. Three rows reading
 * "Editor decoration only. No filesystem access." told nobody what any of the
 * three actually did. The capability still governs; it is just not the thing
 * worth spending the one line of description on.
 */
const pluginDescriptions = new Map<string, string>([
  [titleShiftManifest.id, 'Promote and demote every heading in the document by one level.'],
  [markdownPaddingManifest.id, 'Insert the conventional spacing between CJK text and Latin text or numbers.'],
  [rendererProofManifest.id, 'Dim every block except the one the caret is in.'],
  [filesystemProofManifest.id, 'Read files from one folder you choose, and prove it is refused everywhere else.'],
]);

/** The commands a plugin adds to the palette, so the reader knows where it shows up. */
const pluginCommands = new Map<string, readonly string[]>([
  [titleShiftManifest.id, titleShiftManifest.commands?.map((command) => command.title) ?? []],
  [markdownPaddingManifest.id, markdownPaddingManifest.commands?.map((command) => command.title) ?? []],
  [rendererProofManifest.id, rendererProofManifest.commands?.map((command) => command.title) ?? []],
]);

type PluginMethods = Pick<NotoPluginsApi,
  'enable' | 'disable' | 'triggerEvent' | 'executeCommand' | 'setSetting' | 'replaceGeneration'>;
type ServiceRequestBody = ServiceRequest extends infer TRequest
  ? TRequest extends ServiceRequest
    ? Omit<TRequest, 'version' | 'requestId'>
    : never
  : never;

export interface PluginCenterApi {
  plugins: PluginMethods;
  requestService: NotoDesktopApi['requestService'];
}

interface PluginCenterProps {
  api: PluginCenterApi;
  snapshots: readonly PluginLifecycleSnapshot[];
  availability: PluginSnapshotAvailability;
  open: boolean;
  /** When set, only this plugin's detail/debug pane is shown. */
  detailId?: string | null;
  /** Open a plugin's detail route (Plugins › name). */
  onOpenDetail?: (pluginId: string, pluginName: string) => void;
  evidenceControls?: ReactNode;
}

const requestId = (prefix: string) => `${prefix}:${crypto.randomUUID()}`;

type PendingActions = Record<PluginActionSection, string | null>;
type OperationErrors = Record<PluginActionSection, string | null>;

const emptyPending = (): PendingActions => ({ renderer: null, filesystem: null });
const emptyErrors = (): OperationErrors => ({ renderer: null, filesystem: null });

/** One row of the index: what it is, where it stands, and what its detail needs. */
interface Entry {
  readonly id: string;
  readonly name: string;
  readonly group: 'installed' | 'examples';
  readonly kind: 'Editor plugin' | 'Service plugin';
  readonly section: PluginActionSection;
  readonly presentation: PluginPresentation<string>;
  readonly lifecycle: PluginLifecycleSnapshot['lifecycle'] | 'absent';
}

/** The dot beside a name: where the plugin stands, without reading. */
function dotState(lifecycle: Entry['lifecycle']): string {
  if (lifecycle === 'active' || lifecycle === 'activating') return 'on';
  if (lifecycle === 'failed' || lifecycle === 'crashed') return 'failed';
  if (lifecycle === 'enabled-idle' || lifecycle === 'deactivating') return 'ready';
  return 'off';
}

export function PluginCenter({ api, snapshots, availability, open, detailId = null, onOpenDetail, evidenceControls }: PluginCenterProps) {
  const [pendingAction, setPendingAction] = useState<PendingActions>(emptyPending);
  const [operationError, setOperationError] = useState<OperationErrors>(emptyErrors);
  const snapshotsRef = useRef(snapshots);
  const completionTrackerRef = useRef<ReturnType<typeof createPluginActionCompletionTracker> | null>(null);
  if (!completionTrackerRef.current) {
    completionTrackerRef.current = createPluginActionCompletionTracker({
      onIdle: (section) => setPendingAction((current) => ({ ...current, [section]: null })),
      onTimeout: (section) => {
        setPendingAction((current) => ({ ...current, [section]: null }));
        setOperationError((current) => ({ ...current, [section]: 'Plugin state did not update.' }));
      },
    });
  }
  snapshotsRef.current = snapshots;
  const renderer = snapshots.find((snapshot) => snapshot.id === rendererProofManifest.id);
  const filesystem = snapshots.find((snapshot) => snapshot.id === filesystemProofManifest.id);
  const rendererPresentation = presentRendererPlugin(renderer, availability);
  const filesystemPresentation = presentFilesystemPlugin(filesystem, availability);

  /**
   * Every other trusted plugin, rendered from its snapshot.
   *
   * Listing them from state rather than hand writing a section each means a new
   * bundled plugin appears here with no change to this component.
   */
  const trustedPlugins = snapshots
    .filter((snapshot) => snapshot.id !== rendererProofManifest.id
      && snapshot.id !== filesystemProofManifest.id)
    .map((snapshot) => ({
      snapshot: { ...snapshot, name: trustedNames.get(snapshot.id) ?? snapshot.id },
      presentation: presentRendererPlugin(snapshot, availability),
    }));

  useEffect(() => {
    completionTrackerRef.current?.observe(snapshots);
  }, [snapshots]);

  useEffect(() => () => completionTrackerRef.current?.dispose(), []);

  const run = async <T,>(section: PluginActionSection, key: string,
    completion: { type: 'reply' } | { type: 'snapshot'; pluginId: string },
    operation: () => Promise<Result<T>>) => {
    const policy: PluginActionCompletionPolicy = completion.type === 'reply'
      ? completion
      : {
        ...completion,
        beforeIdentity: pluginSnapshotIdentity(
          snapshotsRef.current.find((snapshot) => snapshot.id === completion.pluginId),
        ),
      };
    completionTrackerRef.current?.begin(section);
    setOperationError((current) => ({ ...current, [section]: null }));
    setPendingAction((current) => ({ ...current, [section]: key }));
    try {
      const result = await operation();
      const failure = pluginOperationFailure(result);
      if (failure) {
        setOperationError((current) => ({ ...current, [section]: failure }));
        completionTrackerRef.current?.fail(section);
        return false;
      }
      completionTrackerRef.current?.complete(section, policy, snapshotsRef.current);
      return true;
    } catch {
      setOperationError((current) => ({ ...current, [section]: 'Plugin connection unavailable.' }));
      completionTrackerRef.current?.fail(section);
      return false;
    }
  };

  const lifecycle = <T,>(section: PluginActionSection, prefix: string, pluginId: string,
    operation: () => Promise<Result<T>>) => (
    run(section, prefix, { type: 'snapshot', pluginId }, operation)
  );

  const rendererAction = (action: RendererPrimaryAction) => {
    if (action === 'enable') return lifecycle('renderer', 'renderer-enable', rendererProofManifest.id, () => api.plugins.enable({
      version: PLUGIN_LIFECYCLE_VERSION, requestId: requestId('plugin-enable-renderer'), pluginId: rendererProofManifest.id,
    }));
    if (action === 'disable' || action === 'retry-cleanup') return lifecycle('renderer', 'renderer-disable', rendererProofManifest.id, () => api.plugins.disable({
      version: PLUGIN_LIFECYCLE_VERSION, requestId: requestId('plugin-disable-renderer'), pluginId: rendererProofManifest.id,
    }));
    if (action === 'activate') return lifecycle('renderer', 'renderer-activate', rendererProofManifest.id, () => api.plugins.triggerEvent({
      version: PLUGIN_LIFECYCLE_VERSION, requestId: requestId('plugin-trigger-editor-ready'), event: 'editor.ready',
    }));
    return lifecycle('renderer', 'renderer-retry', rendererProofManifest.id, () => api.plugins.replaceGeneration({
      version: PLUGIN_LIFECYCLE_VERSION,
      requestId: requestId('plugin-retry-renderer'),
      pluginId: rendererProofManifest.id,
      reason: { type: 'event', event: 'editor.ready' },
    }));
  };

  /**
   * The same lifecycle actions, for any trusted-renderer plugin.
   *
   * The proof plugin keeps its bespoke detail because it carries a setting and
   * diagnostics; everything else needs only enable, activate and disable, so it
   * is rendered from the snapshot rather than hand written per plugin.
   */
  const trustedAction = (pluginId: string, action: RendererPrimaryAction) => {
    if (action === 'enable') return lifecycle('renderer', `enable-${pluginId}`, pluginId, () => api.plugins.enable({
      version: PLUGIN_LIFECYCLE_VERSION, requestId: requestId('plugin-enable'), pluginId,
    }));
    if (action === 'disable' || action === 'retry-cleanup') {
      return lifecycle('renderer', `disable-${pluginId}`, pluginId, () => api.plugins.disable({
        version: PLUGIN_LIFECYCLE_VERSION, requestId: requestId('plugin-disable'), pluginId,
      }));
    }
    if (action === 'activate') return lifecycle('renderer', `activate-${pluginId}`, pluginId, () => api.plugins.triggerEvent({
      version: PLUGIN_LIFECYCLE_VERSION, requestId: requestId('plugin-trigger-editor-ready'), event: 'editor.ready',
    }));
    return lifecycle('renderer', `retry-${pluginId}`, pluginId, () => api.plugins.replaceGeneration({
      version: PLUGIN_LIFECYCLE_VERSION,
      requestId: requestId('plugin-retry'),
      pluginId,
      reason: { type: 'event', event: 'editor.ready' },
    }));
  };

  const serviceRequest = (key: string, request: ServiceRequestBody) => run(
    'filesystem', key, { type: 'snapshot', pluginId: filesystemProofManifest.id }, () => (
    api.requestService({ ...request, version: IPC_VERSION, requestId: requestId(key) } as ServiceRequest)
    ),
  );

  const filesystemAction = (action: FilesystemPrimaryAction) => {
    if (action === 'enable') return lifecycle('filesystem', 'filesystem-enable', filesystemProofManifest.id, () => api.plugins.enable({
      version: PLUGIN_LIFECYCLE_VERSION, requestId: requestId('plugin-enable-filesystem'), pluginId: filesystemProofManifest.id,
    }));
    if (action === 'start') return lifecycle('filesystem', 'filesystem-start', filesystemProofManifest.id, () => api.plugins.triggerEvent({
      version: PLUGIN_LIFECYCLE_VERSION, requestId: requestId('plugin-trigger-document-opened'), event: 'document.opened',
    }));
    if (action === 'restart') return lifecycle('filesystem', 'filesystem-restart', filesystemProofManifest.id, () => api.plugins.replaceGeneration({
      version: PLUGIN_LIFECYCLE_VERSION,
      requestId: requestId('plugin-restart-filesystem'),
      pluginId: filesystemProofManifest.id,
      reason: { type: 'event', event: 'document.opened' },
    }));
    if (action === 'retry-cleanup') return lifecycle('filesystem', 'filesystem-disable', filesystemProofManifest.id, () => api.plugins.disable({
      version: PLUGIN_LIFECYCLE_VERSION,
      requestId: requestId('plugin-cleanup-filesystem'),
      pluginId: filesystemProofManifest.id,
    }));
    if (!filesystem?.activeGeneration) return Promise.resolve(false);
    if (action === 'cancel') {
      const request = filesystem.capability.request;
      if (!request) return Promise.resolve(false);
      return serviceRequest('cancel-request', {
        action: 'cancel-request', generation: filesystem.activeGeneration, targetRequestId: request.requestId,
      });
    }
    if (action === 'read') {
      const grant = filesystem.capability.grant;
      if (!grant || grant.state !== 'active') return Promise.resolve(false);
      return serviceRequest('read-granted', {
        action: 'read-granted', generation: filesystem.activeGeneration, grantId: grant.id,
      });
    }
    return serviceRequest('grant-read', { action: 'grant-read', generation: filesystem.activeGeneration });
  };

  const activeGrant = filesystem?.capability.grant?.state === 'active'
    ? filesystem.capability.grant
    : null;
  const activeRequest = filesystem?.capability.request;

  if (!open) return null;

  /*
   * An index and a detail, not a flat run of sections.
   *
   * Four plugins laid end to end, each with its own status line, button and
   * diagnostics, read as a debug console; the reader could not see at a
   * glance what was installed, what was on, or where to look. The index is the
   * list, one row per plugin with a dot for its state, and the detail is one
   * plugin at a time with everything it has to say. Examples sit in their own
   * group so nobody wonders what a "Fixture Reader" is doing in their editor.
   */
  const entries: Entry[] = [
    ...trustedPlugins.map(({ snapshot, presentation }): Entry => ({
      id: snapshot.id,
      name: snapshot.name,
      group: 'installed',
      kind: 'Editor plugin',
      section: 'renderer',
      presentation,
      lifecycle: snapshot.lifecycle,
    })),
    {
      id: rendererProofManifest.id,
      name: rendererProofManifest.name,
      group: 'examples',
      kind: 'Editor plugin',
      section: 'renderer',
      presentation: rendererPresentation,
      lifecycle: renderer?.lifecycle ?? 'absent',
    },
    {
      id: filesystemProofManifest.id,
      name: filesystemProofManifest.name,
      group: 'examples',
      kind: 'Service plugin',
      section: 'filesystem',
      presentation: filesystemPresentation,
      lifecycle: filesystem?.lifecycle ?? 'absent',
    },
  ];

  const primaryFor = (entry: Entry) => {
    if (entry.id === rendererProofManifest.id) return () => rendererPresentation.primaryAction
      && void rendererAction(rendererPresentation.primaryAction);
    if (entry.id === filesystemProofManifest.id) return () => filesystemPresentation.primaryAction
      && void filesystemAction(filesystemPresentation.primaryAction);
    return () => entry.presentation.primaryAction
      && void trustedAction(entry.id, entry.presentation.primaryAction as RendererPrimaryAction);
  };

  const detailTestId = (entry: Entry) => {
    if (entry.id === rendererProofManifest.id) return 'renderer-plugin-state';
    if (entry.id === filesystemProofManifest.id) return 'service-state';
    return `plugin-${entry.id}`;
  };

  /**
   * Compact list row for the Plugins index. Click opens Plugins › name.
   */
  const renderRow = (entry: Entry) => {
    const pending = pendingAction[entry.section] !== null;
    return (
      <button
        key={entry.id}
        type="button"
        className="plugin-row"
        data-testid={`plugin-row-${entry.id}`}
        aria-busy={pending}
        onClick={() => onOpenDetail?.(entry.id, entry.name)}
      >
        <span className="plugin-dot" data-state={
          entry.lifecycle === 'failed' || entry.lifecycle === 'crashed' ? 'failed'
            : entry.lifecycle === 'ready' ? 'on'
              : 'ready'
        } aria-hidden="true" />
        <span className="plugin-row-text">
          <strong>{entry.name}</strong>
          <span className="plugin-row-scope">{pluginDescriptions.get(entry.id) ?? entry.presentation.scope}</span>
        </span>
        <span className="plugin-row-status">{entry.presentation.status}</span>
      </button>
    );
  };

  /**
   * One plugin's detail/debug pane (Plugins › name).
   */
  const renderEntry = (entry: Entry) => {
    // Per plugin now, not per panel: with every plugin on screen at once, one
    // shared flag would have greyed out every button while any one of them
    // was working.
    const pending = pendingAction[entry.section] !== null;
    return (
      <section key={entry.id}
          className={`plugin-detail plugin-section plugin-tone-${entry.presentation.tone}`}
          data-testid={detailTestId(entry)} aria-busy={pending}>
          <header className="plugin-detail-head">
            <div className="plugin-name-row">
              <strong>{entry.name}</strong>
              <span className="plugin-kind">{entry.kind}</span>
            </div>
            <p className="plugin-scope">{pluginDescriptions.get(entry.id) ?? entry.presentation.scope}</p>
            {entry.group === 'examples' && (
              <p className="plugin-scope plugin-example-note">
                A bundled example, one of each kind, to read before writing your own. Not a product feature.
              </p>
            )}
          </header>

          <div className="plugin-state-row">
            <p className="plugin-status" aria-live="polite"
              data-testid={entry.id === rendererProofManifest.id ? 'renderer-plugin-lifecycle'
                : entry.id === filesystemProofManifest.id ? 'filesystem-plugin-lifecycle' : undefined}>
              {entry.presentation.status}
            </p>
            <button type="button" className="plugin-primary"
              disabled={entry.presentation.actionDisabled || pending}
              onClick={primaryFor(entry)}>
              {pending ? 'Working…' : entry.presentation.primaryLabel}
            </button>
          </div>

          {(pluginCommands.get(entry.id)?.length ?? 0) > 0 && (
            <p className="plugin-commands">
              <span className="plugin-commands-label">In the palette (⌘K)</span>
              {pluginCommands.get(entry.id)?.join(' · ')}
            </p>
          )}

          {entry.id === rendererProofManifest.id && (
            <label className="setting-row">
              <input type="checkbox" checked={renderer?.settings.focusEnabled ?? true}
                disabled={!renderer || availability !== 'ready' || pending}
                onChange={(event) => void run('renderer', 'renderer-setting',
                  { type: 'snapshot', pluginId: rendererProofManifest.id }, () => api.plugins.setSetting({
                  version: PLUGIN_LIFECYCLE_VERSION,
                  requestId: requestId('plugin-setting'),
                  pluginId: rendererProofManifest.id,
                  key: 'focusEnabled',
                  value: event.target.checked,
                  }))} />
              Focus the active block
            </label>
          )}

          <p className="plugin-operation-message" aria-live="polite" aria-atomic="true" role="status">
            {operationError[entry.section] ?? ''}
          </p>

          {entry.id === rendererProofManifest.id && (
            <details className="plugin-diagnostics">
              <summary>Diagnostics</summary>
              <div className="diagnostic-actions">
                <button type="button" disabled={!renderer?.desiredEnabled || pending}
                  onClick={() => void run('renderer', 'renderer-command', { type: 'reply' }, () => api.plugins.executeCommand({
                    version: PLUGIN_LIFECYCLE_VERSION,
                    requestId: requestId('plugin-command'),
                    pluginId: rendererProofManifest.id,
                    commandId: 'semantic-focus.toggle',
                  }))}>Run command</button>
                {(renderer?.lifecycle === 'failed' || renderer?.lifecycle === 'crashed') && (
                  <button type="button" disabled={pending}
                    onClick={() => void rendererAction('disable')}>Disable</button>
                )}
              </div>
              <p>Version {rendererProofManifest.version} · trusted renderer · editor.decorate · hotkey ⌘⇧J</p>
              <p>Generation {renderer?.activeGeneration ?? 'none'} · registrations {renderer?.rendererRegistrations ?? 0} · leases {renderer?.leaseCount ?? 0}</p>
              <p>Persistence {renderer?.persistenceHealth ?? 'indeterminate'}</p>
              {renderer?.lastFailure && <p className="plugin-failure" role="status">{renderer.lastFailure}</p>}
            </details>
          )}

          {entry.id === filesystemProofManifest.id && (
            <details className="plugin-diagnostics">
              <summary>Diagnostics</summary>
              <div className="diagnostic-actions">
                <button type="button" disabled={!activeGrant || activeRequest?.state === 'pending' || pending}
                  onClick={() => activeGrant && filesystem?.activeGeneration && void serviceRequest('read-granted', {
                    action: 'read-granted', grantId: activeGrant.id, generation: filesystem.activeGeneration,
                  })}>Read granted fixture</button>
                <button type="button" disabled={!activeGrant || activeRequest?.state === 'pending' || pending}
                  onClick={() => activeGrant && filesystem?.activeGeneration && void serviceRequest('deny-probe', {
                    action: 'deny-probe', grantId: activeGrant.id, generation: filesystem.activeGeneration,
                  })}>Prove denied path</button>
                <button type="button" disabled={!activeGrant || pending}
                  onClick={() => activeGrant && filesystem?.activeGeneration && void serviceRequest('revoke-grant', {
                    action: 'revoke-grant', grantId: activeGrant.id, generation: filesystem.activeGeneration,
                  })}>Revoke access</button>
                {filesystem?.desiredEnabled && (
                  <button type="button" disabled={pending}
                    onClick={() => void lifecycle('filesystem', 'filesystem-disable', filesystemProofManifest.id, () => api.plugins.disable({
                      version: PLUGIN_LIFECYCLE_VERSION,
                      requestId: requestId('plugin-disable-filesystem'),
                      pluginId: filesystemProofManifest.id,
                    }))}>Disable</button>
                )}
                {filesystem?.lifecycle === 'active' && (
                  <button type="button" disabled={pending}
                    onClick={() => void filesystemAction('restart')}>
                    Restart service (revokes current access)
                  </button>
                )}
              </div>
              <p>Version {filesystemProofManifest.version} · bundled utility process · filesystem.read</p>
              <p>{activeRequest
                ? `${activeRequest.action} · ${activeRequest.state} · ${activeRequest.detail}`
                : 'No service operation yet'}</p>
              <p>Generation {filesystem?.activeGeneration ?? 'none'} · persistence {filesystem?.persistenceHealth ?? 'indeterminate'}</p>
              {filesystem?.lastFailure && <p className="plugin-failure" role="status">{filesystem.lastFailure}</p>}
              <p>The main-process grant broker limits cooperative bundled code to the selected folder. It does not contain hostile code.</p>
              {filesystem?.lifecycle === 'active' && activeGrant && (
                <p>Restarting stops the service and revokes the current folder grant before a new generation starts.</p>
              )}
            </details>
          )}

          {entry.id === filesystemProofManifest.id && evidenceControls && (
            <details className="plugin-evidence"><summary>G001 evidence controls</summary>{evidenceControls}</details>
          )}
      </section>
    );
  };

  const renderGroup = (group: Entry['group'], label: string, mode: 'list' | 'detail') => {
    const inGroup = entries.filter((candidate) => candidate.group === group);
    if (inGroup.length === 0) return null;
    return (
      <section className="plugin-group" key={group}>
        <p className="pref-group">{label}</p>
        {inGroup.map(mode === 'list' ? renderRow : renderEntry)}
      </section>
    );
  };

  if (detailId) {
    const selected = entries.find((entry) => entry.id === detailId);
    return (
      <div className="plugin-center" id="plugin-drawer" data-plugin-view="detail">
        {selected ? renderEntry(selected) : (
          <p className="pref-note">That plugin is not in the catalog.</p>
        )}
      </div>
    );
  }

  return (
    <div className="plugin-center" id="plugin-drawer" data-plugin-view="list">
      {renderGroup('installed', 'Installed', 'list')}
      {renderGroup('examples', 'Examples', 'list')}
    </div>
  );
}

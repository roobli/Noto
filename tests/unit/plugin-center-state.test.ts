import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type {
  PluginCapabilityGrantState,
  PluginCapabilityRequestState,
  PluginLifecycleSnapshot,
  PluginLifecycleState,
} from '../../src/shared/plugins/lifecycle';
import {
  createPluginActionCompletionTracker,
  nextTrappedFocusIndex,
  pluginOperationFailure,
  pluginSnapshotIdentity,
  presentFilesystemPlugin,
  presentRendererPlugin,
  restorePluginTriggerFocus,
  shouldClosePluginCenter,
  watchPluginCenterModal,
} from '../../src/renderer/plugins/plugin-center-state';

const snapshot = (overrides: Partial<PluginLifecycleSnapshot> = {}): PluginLifecycleSnapshot => ({
  id: 'dev.lr00rl.noto.test',
  manifestVersion: '1.0.0',
  desiredEnabled: true,
  lifecycle: 'active',
  settings: {},
  activeGeneration: 4,
  leaseCount: 0,
  rendererRegistrations: 1,
  activationReason: { type: 'event', event: 'editor.ready' },
  persistenceHealth: 'healthy',
  lastFailure: null,
  capability: { grant: null, request: null, restartRequired: false },
  ...overrides,
});

describe('plugin center state presenters', () => {
  it.each<[PluginLifecycleState, string, string]>([
    ['disabled', 'Needs recovery', 'Retry'],
    ['enabled-idle', 'Enabled, waiting for editor', 'Activate for this editor'],
    ['activating', 'Running', 'Disable'],
    ['active', 'Running', 'Disable'],
    ['deactivating', 'Running', 'Disable'],
    ['failed', 'Needs recovery', 'Retry'],
    ['crashed', 'Needs recovery', 'Retry'],
  ])('maps renderer lifecycle %s to one user status and action', (lifecycle, status, action) => {
    expect(presentRendererPlugin(snapshot({ lifecycle }))).toMatchObject({ status, primaryLabel: action });
  });

  it('keeps renderer disable reachable during normal operation and reports persistence recovery', () => {
    expect(presentRendererPlugin(snapshot({ lifecycle: 'active' })).primaryAction).toBe('disable');
    expect(presentRendererPlugin(snapshot({ lifecycle: 'active', persistenceHealth: 'degraded' })))
      .toMatchObject({ status: 'Needs recovery', primaryAction: 'retry' });
    expect(presentRendererPlugin(snapshot({ desiredEnabled: false, lifecycle: 'failed' })))
      .toMatchObject({ status: 'Needs recovery', primaryAction: 'retry-cleanup', primaryLabel: 'Retry cleanup' });
    expect(presentRendererPlugin(snapshot({ desiredEnabled: false, lifecycle: 'disabled', leaseCount: 1 })))
      .toMatchObject({ status: 'Needs recovery', primaryAction: 'retry-cleanup' });
    expect(presentRendererPlugin(snapshot({ desiredEnabled: false, lifecycle: 'disabled', leaseCount: 0,
      lastFailure: 'cleanup failed' }))).toMatchObject({ status: 'Needs recovery', primaryAction: 'retry-cleanup' });
  });

  it('never presents missing snapshot state as disabled', () => {
    expect(presentRendererPlugin(undefined, 'loading')).toMatchObject({
      status: 'Loading plugin state', actionDisabled: true, primaryAction: null,
    });
    expect(presentFilesystemPlugin(undefined, 'unavailable')).toMatchObject({
      status: 'Plugin state unavailable', actionDisabled: true, primaryAction: null,
    });
    expect(presentRendererPlugin(undefined, 'ready').status).toBe('Plugin state unavailable');
  });

  it('keeps discovered plugins in a non-actionable saved-state loading presentation', () => {
    const discovered = snapshot({
      lifecycle: 'discovered',
      desiredEnabled: false,
      persistenceHealth: 'indeterminate',
    });
    expect(presentRendererPlugin(discovered, 'ready')).toMatchObject({
      status: 'Discovered, loading saved state',
      primaryAction: null,
      primaryLabel: 'Loading',
      actionDisabled: true,
    });
    expect(presentFilesystemPlugin(discovered, 'ready')).toMatchObject({
      status: 'Discovered, loading saved state',
      primaryAction: null,
      primaryLabel: 'Loading',
      actionDisabled: true,
    });
  });

  it('lets a real utility crash supersede retained request history', () => {
    expect(presentFilesystemPlugin(snapshot({
      lifecycle: 'crashed',
      activeGeneration: null,
      capability: {
        grant: { id: 'grant', generation: 4, root: '/Users/cdcd/Documents', state: 'revoked' },
        request: {
          requestId: 'timed-out-before-crash',
          generation: 4,
          action: 'read-granted',
          state: 'timed-out',
          detail: 'retained terminal evidence',
        },
        restartRequired: true,
      },
    }))).toMatchObject({
      status: 'Service stopped, editor remains usable',
      primaryAction: 'restart',
    });
  });

  it.each<[PluginLifecycleState, string, string]>([
    ['disabled', 'Enabled, service stopped', 'Start service'],
    ['enabled-idle', 'Enabled, service stopped', 'Start service'],
    ['activating', 'Enabled, service stopped', 'Start service'],
    ['active', 'Access not granted', 'Grant read access'],
    ['deactivating', 'Enabled, service stopped', 'Start service'],
    ['failed', 'Service stopped, editor remains usable', 'Restart service'],
    ['crashed', 'Service stopped, editor remains usable', 'Restart service'],
  ])('maps filesystem lifecycle %s to one user status and action', (lifecycle, status, action) => {
    expect(presentFilesystemPlugin(snapshot({ lifecycle }))).toMatchObject({ status, primaryLabel: action });
  });

  it.each<[PluginCapabilityRequestState, string, string]>([
    ['pending', 'Access granted to /Users/cdcd/Documents', 'Cancel read'],
    ['cancelling', 'Access granted to /Users/cdcd/Documents', 'Cancel read'],
    ['completed', 'Access granted to /Users/cdcd/Documents', 'Read again'],
    ['cancelled', 'Read cancelled, no file read', 'Read again'],
    ['timed-out', 'Timed out, access remains blocked', 'Restart service'],
    ['failed', 'Service stopped, editor remains usable', 'Restart service'],
  ])('maps filesystem request terminal %s without exposing transport terms', (state, status, action) => {
    expect(presentFilesystemPlugin(snapshot({
      capability: {
        grant: { id: 'grant', generation: 4, root: '/Users/cdcd/Documents', state: 'active' },
        request: { requestId: 'request', generation: 4, action: 'read-granted', state, detail: 'internal detail' },
        restartRequired: false,
      },
    }))).toMatchObject({ status, primaryLabel: action });
  });

  it.each<[PluginCapabilityGrantState, string]>([
    ['active', 'Access granted to /Users/cdcd/Documents'],
    ['revoking', 'Access not granted'],
    ['revoked', 'Access not granted'],
  ])('maps filesystem grant state %s to scoped access truth', (state, status) => {
    expect(presentFilesystemPlugin(snapshot({
      capability: {
        grant: { id: 'grant', generation: 4, root: '/Users/cdcd/Documents', state },
        request: null,
        restartRequired: false,
      },
    })).status).toBe(status);
  });

  it('uses an active grant for reading and keeps cleanup above disabled intent', () => {
    expect(presentFilesystemPlugin(snapshot({
      capability: {
        grant: { id: 'grant', generation: 4, root: '/Users/cdcd/Documents', state: 'active' },
        request: null,
        restartRequired: false,
      },
    }))).toMatchObject({ primaryAction: 'read', primaryLabel: 'Read file' });
    expect(presentFilesystemPlugin(snapshot({
      desiredEnabled: false,
      lifecycle: 'failed',
      leaseCount: 1,
      lastFailure: 'service cleanup failed',
    }))).toMatchObject({ status: 'Needs recovery', primaryAction: 'retry-cleanup' });
  });

  it('maps typed Result failures without exposing backend messages or reply snapshots', () => {
    expect(pluginOperationFailure({ ok: true, requestId: 'ok', value: { snapshots: ['ignored'] } })).toBeNull();
    expect(pluginOperationFailure({
      ok: false,
      requestId: 'denied',
      error: { code: 'CAPABILITY_DENIED', message: '/private/secret leaked detail' },
    })).toBe('Access was denied.');
    expect(pluginOperationFailure({
      ok: false,
      requestId: 'plugin',
      error: { code: 'PLUGIN_CLEANUP_FAILED', message: 'internal cleanup path' },
    })).toBe('The plugin action could not be completed.');
  });

  it('settles reply actions immediately but fences snapshot actions to matching pushes', () => {
    const callbacks: Array<() => void> = [];
    const cleared: number[] = [];
    const state = { renderer: 'busy', filesystem: 'busy' } as Record<'renderer' | 'filesystem', string>;
    const tracker = createPluginActionCompletionTracker({
      timeoutMs: 4_000,
      setTimer: (callback) => {
        callbacks.push(callback);
        return (callbacks.length - 1) as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: (timer) => cleared.push(timer as unknown as number),
      onIdle: (section) => { state[section] = 'idle'; },
      onTimeout: (section) => { state[section] = 'Plugin state did not update.'; },
    });

    tracker.complete('renderer', { type: 'reply' }, []);
    expect(state.renderer).toBe('idle');

    const before = snapshot({ id: 'plugin.filesystem', lifecycle: 'enabled-idle' });
    state.filesystem = 'busy';
    tracker.complete('filesystem', {
      type: 'snapshot', pluginId: before.id, beforeIdentity: pluginSnapshotIdentity(before),
    }, [before]);
    expect(tracker.isWaiting('filesystem')).toBe(true);
    tracker.observe([before, snapshot({ id: 'plugin.unrelated', desiredEnabled: false })]);
    expect(state.filesystem).toBe('busy');
    expect(tracker.isWaiting('filesystem')).toBe(true);

    const changed = { ...before, desiredEnabled: false };
    tracker.observe([changed]);
    expect(state.filesystem).toBe('idle');
    expect(tracker.isWaiting('filesystem')).toBe(false);
    expect(cleared).toContain(0);

    state.filesystem = 'busy';
    tracker.complete('filesystem', {
      type: 'snapshot', pluginId: before.id, beforeIdentity: pluginSnapshotIdentity(before),
    }, [before]);
    callbacks[1]();
    expect(state.filesystem).toBe('Plugin state did not update.');
    expect(tracker.isWaiting('filesystem')).toBe(false);

    state.renderer = 'busy';
    const failure = pluginOperationFailure({
      ok: false, requestId: 'failed', error: { code: 'PLUGIN_FAILED', message: 'unsafe detail' },
    });
    tracker.fail('renderer');
    if (failure) state.renderer = failure;
    expect(state.renderer).toBe('The plugin action could not be completed.');
    tracker.dispose();
  });
});

describe('plugin center interaction and production structure', () => {
  it('closes only an open panel on Escape and restores trigger focus asynchronously', () => {
    expect(shouldClosePluginCenter('Escape', true)).toBe(true);
    expect(shouldClosePluginCenter('Escape', false)).toBe(false);
    expect(shouldClosePluginCenter('Enter', true)).toBe(false);

    const focus = vi.fn();
    const callbacks: Array<() => void> = [];
    restorePluginTriggerFocus({ focus }, (callback) => callbacks.push(callback));
    expect(focus).not.toHaveBeenCalled();
    callbacks[0]();
    expect(focus).toHaveBeenCalledOnce();
  });

  it('updates modal state from matchMedia and wraps both Tab directions', () => {
    const published: boolean[] = [];
    let listener: (event: { matches: boolean }) => void = () => undefined;
    const remove = vi.fn();
    const cleanup = watchPluginCenterModal(() => ({
      matches: false,
      addEventListener: (_type, next) => { listener = next; },
      removeEventListener: remove,
    }), (modal) => published.push(modal));
    expect(published).toEqual([false]);
    listener({ matches: true });
    expect(published).toEqual([false, true]);
    cleanup();
    expect(remove).toHaveBeenCalledOnce();
    expect(nextTrappedFocusIndex(0, true, 4)).toBe(3);
    expect(nextTrappedFocusIndex(3, false, 4)).toBe(0);
    expect(nextTrappedFocusIndex(1, false, 4)).toBe(2);
  });

  it('mounts the shared production component in the single renderer entry point', async () => {
    const [app, center, prefs] = await Promise.all([
      readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/plugins/PluginCenter.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/Preferences.tsx', import.meta.url), 'utf8'),
    ]);
    expect(app).toContain('<PluginCenter api={window.notoDesktop} snapshots={pluginSnapshots}');
    expect(app).toContain('data-testid="plugin-toggle"');
    expect(center).not.toMatch(/setPluginSnapshots|reply\.value\.snapshots/);
    // Plugins are a Settings section now, so the page around them owns
    // modality and the focus trap. A second trap inside it fought the first.
    expect(center).not.toMatch(/role=\{modal|aria-modal=\{modal/);
    expect(app).toContain('<Preferences');
    expect(prefs).toContain('settings-page');
    // List rows open Plugins › name; detail keeps per-entry busy flags.
    expect(center).toContain('aria-busy={pending}');
    expect(center).toContain('pendingAction[entry.section] !== null');
    expect(center).toContain('plugin-row');
    expect(center).toContain('onOpenDetail');
    expect(center).toContain('data-plugin-view');
    expect(center).toContain("action === 'disable' || action === 'retry-cleanup'");
    expect(center).toContain("action === 'retry-cleanup'");
    expect(center).toContain('Restart service (revokes current access)');
    expect(center).toContain("{ type: 'reply' }");
    expect(center).toContain("'Plugin state did not update.'");
    expect(center).toContain('aria-atomic="true"');
    expect(center).not.toContain('waitingForPush');
    expect(center).toContain('<summary>Diagnostics</summary>');
    // The version lines live under Diagnostics, never in the summary above it.
    const firstDiagnostics = center.indexOf('<details className="plugin-diagnostics">');
    expect(firstDiagnostics).toBeGreaterThan(0);
    expect(center.indexOf('Version {rendererProofManifest.version}')).toBeGreaterThan(firstDiagnostics);
    expect(center.indexOf('Version {filesystemProofManifest.version}')).toBeGreaterThan(firstDiagnostics);
  });

  it('keeps plugin chrome neutral and reachable', async () => {
    const css = await readFile(new URL('../../src/renderer/styles/app.scss', import.meta.url), 'utf8');
    const pluginChrome = css.slice(css.indexOf('.plugin-center {'), css.indexOf('.search-field'));
    // The accent marks where you are and nothing else. The Plugins list is
    // neutral; tone on a detail card is carried by warning and danger rails.
    expect(pluginChrome).not.toMatch(/gradient|box-shadow|backdrop-filter/);
    expect(pluginChrome.match(/var\(--accent\)/g) ?? []).toHaveLength(0);
    expect(pluginChrome).toContain('border-color: var(--hairline);');
    expect(pluginChrome).toContain('background: transparent;');
    expect(pluginChrome).not.toMatch(/\.plugin-primary[^}]*background:\s*var\(--ink\)/s);
    expect(pluginChrome).toContain('.setting-row input { accent-color: var(--ink); }');
    expect(pluginChrome).toContain('border-left: 2px solid var(--warning);');
    expect(pluginChrome).toContain('border-left: 2px solid var(--danger);');
    // The action sits at its natural width beside the plugin rather than as a
    // full-width slab under a paragraph of it.
    expect(pluginChrome).not.toMatch(/\.plugin-primary\s*\{[^}]*width:\s*100%/s);
    expect(css).toContain('min-height: 44px;');
    expect(css).toContain('min-height: 17px;');
    expect(css).not.toContain('.plugin-operation-message:empty');
  });
});

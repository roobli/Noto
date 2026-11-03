import { useCallback, useEffect, useState } from 'react';
import type {
  MarketplaceEntryV1, PluginInstallReplyV1, PluginInstallRequest, PluginInstallStateV1, PluginPreviewV1,
} from '../../shared/plugins/install-ipc';
import type { PluginInstallPresentation } from '../../shared/plugins/lifecycle';
import { isComposing } from '../ime';

/** Told to every part of Plugin Center when an install, removal or trust change lands. */
const STATE_EVENT = 'noto:plugin-install-state';

function announce(state: PluginInstallStateV1): void {
  window.dispatchEvent(new CustomEvent<PluginInstallStateV1>(STATE_EVENT, { detail: state }));
}

async function ask(request: PluginInstallRequest): Promise<PluginInstallReplyV1> {
  const reply = await window.notoPluginInstall.request(request);
  if (reply.kind === 'done' || reply.kind === 'state') announce(reply.state);
  return reply;
}

function useInstallState(): PluginInstallStateV1 | null {
  const [state, setState] = useState<PluginInstallStateV1 | null>(null);
  useEffect(() => {
    let live = true;
    void ask({ action: 'state' }).then((reply) => { if (live && reply.kind === 'state') setState(reply.state); });
    const receive = (event: Event) => setState((event as CustomEvent<PluginInstallStateV1>).detail);
    window.addEventListener(STATE_EVENT, receive);
    return () => { live = false; window.removeEventListener(STATE_EVENT, receive); };
  }, []);
  return state;
}

function RestartBanner({ state }: { state: PluginInstallStateV1 | null }) {
  if (!state?.restartPending) return null;
  return (
    <div className="plugin-banner" role="status" data-testid="plugin-restart">
      <span>Plugin changes take effect when Noto starts again.</span>
      <button type="button" className="pref-action" onClick={() => { void ask({ action: 'restart' }); }}>Restart Now</button>
    </div>
  );
}

/**
 * Where plugins come from: a folder, a GitHub repository, or the
 * marketplace. Each path ends at the same preview, which says what the
 * plugin may do before anything is written; installing it puts it in the
 * plugins folder, off and sandboxed, for the next start.
 */
export function PluginSources() {
  const state = useInstallState();
  const [mode, setMode] = useState<'idle' | 'github' | 'marketplace'>('idle');
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [preview, setPreview] = useState<PluginPreviewV1 | null>(null);
  const [market, setMarket] = useState<readonly MarketplaceEntryV1[] | null>(null);
  const [installed, setInstalled] = useState('');
  const [repoDraft, setRepoDraft] = useState<string | null>(null);

  const run = useCallback(async (request: PluginInstallRequest) => {
    setBusy(true);
    setProblem('');
    setInstalled('');
    try {
      const reply = await ask(request);
      if (reply.kind === 'refused') setProblem(reply.message);
      if (reply.kind === 'preview') setPreview(reply.preview);
      if (reply.kind === 'marketplace') setMarket(reply.entries);
      return reply;
    } finally {
      setBusy(false);
    }
  }, []);

  const lookUp = () => { if (address.trim()) void run({ action: 'preview-github', url: address.trim() }); };

  return (
    <div className="plugin-sources" data-testid="plugin-sources">
      <div className="plugin-source-bar">
        <button type="button" className="pref-action" disabled={busy} data-testid="plugin-add-folder"
          onClick={() => { setMode('idle'); setPreview(null); void run({ action: 'preview-folder' }); }}>
          Add from Folder&hellip;
        </button>
        <button type="button" className={`pref-action${mode === 'github' ? ' is-on' : ''}`} disabled={busy} data-testid="plugin-add-github"
          onClick={() => { setMode(mode === 'github' ? 'idle' : 'github'); setPreview(null); setProblem(''); }}>
          Add from GitHub&hellip;
        </button>
        <button type="button" className={`pref-action${mode === 'marketplace' ? ' is-on' : ''}`} disabled={busy} data-testid="plugin-marketplace"
          onClick={() => {
            const next = mode === 'marketplace' ? 'idle' : 'marketplace';
            setMode(next);
            setPreview(null);
            if (next === 'marketplace') void run({ action: 'marketplace' });
          }}>
          Marketplace
        </button>
        <button type="button" className="plugin-source-folder" data-testid="plugin-open-folder"
          onClick={() => { void ask({ action: 'open-folder' }); }}>
          Open Plugins Folder
        </button>
      </div>

      {mode === 'github' && (
        <div className="plugin-source-field">
          <input type="url" data-testid="plugin-github-url" placeholder="https://github.com/owner/repo, or a folder in it"
            aria-label="GitHub repository address" value={address} spellCheck={false}
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => { if (!isComposing(event) && event.key === 'Enter') lookUp(); }} />
          <button type="button" className="pref-action" disabled={busy || !address.trim()} data-testid="plugin-github-look" onClick={lookUp}>
            {busy ? 'Looking…' : 'Look'}
          </button>
        </div>
      )}

      {mode === 'marketplace' && !preview && (
        <div className="plugin-market" data-testid="plugin-market">
          <div className="plugin-market-source">
            {repoDraft === null ? (
              <>
                <span>Listing from <code>{state?.marketplace || 'nowhere'}</code></span>
                <button type="button" className="plugin-source-folder" data-testid="plugin-market-change"
                  onClick={() => setRepoDraft(state?.marketplace ?? '')}>
                  Change
                </button>
              </>
            ) : (
              <form className="plugin-source-field" onSubmit={(event) => {
                event.preventDefault();
                const repo = repoDraft.trim();
                void window.notoSettings.write({ version: 1, requestId: `market:${crypto.randomUUID()}`, patch: { pluginMarketplace: repo } })
                  .then((result) => {
                    if (!result.ok) { setProblem('That is not a GitHub repository, written owner/repo.'); return; }
                    setRepoDraft(null);
                    setMarket(null);
                    void ask({ action: 'state' }).then(() => { if (repo) void run({ action: 'marketplace' }); });
                  });
              }}>
                <input data-testid="plugin-market-repo" aria-label="Marketplace repository" placeholder="owner/repo, or empty to turn it off"
                  value={repoDraft} spellCheck={false} onChange={(event) => setRepoDraft(event.target.value)} />
                <button type="submit" className="pref-action">Use</button>
                <button type="button" className="pref-action" onClick={() => setRepoDraft(null)}>Cancel</button>
              </form>
            )}
          </div>
          {busy && market === null && <p className="pref-note">Reading {state?.marketplace || 'the marketplace'}&hellip;</p>}
          {market !== null && market.length === 0 && <p className="pref-note">The marketplace lists no plugins yet.</p>}
          {market?.map((entry) => (
            <div key={entry.id} className="plugin-market-row">
              <span className="plugin-row-text">
                <strong>{entry.name}</strong>
                <span className="plugin-row-scope">{entry.description || entry.repo}</span>
              </span>
              <span className="plugin-row-status">{entry.installed ? `Installed ${entry.installed}` : entry.version}</span>
              <button type="button" className="pref-action" disabled={busy || entry.installed === entry.version}
                onClick={() => { void run({ action: 'preview-marketplace', id: entry.id }); }}>
                {entry.installed === null ? 'Install…' : entry.installed === entry.version ? 'Installed' : 'Update…'}
              </button>
            </div>
          ))}
        </div>
      )}

      {problem && <p className="pref-problem" role="alert" data-testid="plugin-source-problem">{problem}</p>}
      {installed && <p className="pref-note" role="status">{installed}</p>}

      {preview && (
        <div className="plugin-preview" data-testid="plugin-preview">
          <div className="plugin-preview-head">
            <strong>{preview.name}</strong>
            <span className="plugin-kind">{preview.replaces ? `${preview.replaces} → ${preview.version}` : preview.version}</span>
          </div>
          {preview.description && <p className="plugin-scope">{preview.description}</p>}
          <p className="plugin-preview-source">
            {preview.source} &middot; code <code>{preview.digest}</code>
            {preview.pinned && ' · the code the marketplace vouched for'}
          </p>
          <ul className="plugin-abilities">
            {preview.abilities.map((ability) => <li key={ability}>{ability}</li>)}
          </ul>
          {preview.commands.length > 0 && <p className="plugin-commands"><span className="plugin-commands-label">Adds</span>{preview.commands.join(' · ')}</p>}
          {preview.hotkeys.length > 0 && <p className="plugin-commands"><span className="plugin-commands-label">Keys</span>{preview.hotkeys.join(' · ')}</p>}
          <p className="pref-note">
            It installs switched off, and runs sandboxed: in a worker of its own, with no network of its own,
            unable to add a web address to a note, and with nothing beyond what is listed here.
          </p>
          {preview.problems.map((item) => <p key={item} className="pref-problem">{item}</p>)}
          <div className="plugin-preview-actions">
            <button type="button" className="plugin-primary" data-testid="plugin-install" disabled={busy || preview.problems.length > 0}
              onClick={() => {
                void run({ action: 'commit', stagingId: preview.stagingId }).then((reply) => {
                  if (reply.kind === 'done') {
                    setInstalled(`${preview.name} is installed. It loads when Noto starts again.`);
                    setPreview(null);
                    setMode('idle');
                  }
                });
              }}>
              {preview.replaces ? 'Update' : 'Install'}
            </button>
            <button type="button" className="pref-action"
              onClick={() => { void ask({ action: 'cancel', stagingId: preview.stagingId }); setPreview(null); }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <RestartBanner state={state} />

      {state && state.setAside.length > 0 && (
        <section className="plugin-group">
          <p className="pref-group">Not loaded</p>
          {state.setAside.map((item) => (
            <div key={item.folder} className="plugin-market-row is-set-aside" data-testid="plugin-set-aside">
              <span className="plugin-row-text">
                <strong>{item.folder}</strong>
                <span className="plugin-row-scope">{item.reason}</span>
              </span>
              <button type="button" className="pref-action"
                onClick={() => { void ask({ action: 'uninstall', pluginId: item.folder }); }}>
                Remove
              </button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

/**
 * On an installed plugin's page: where it came from, how far it is trusted,
 * and the way to remove it. Trusting fully asks again in a dialog main owns,
 * since it hands the plugin everything the app can do.
 */
export function InstalledPluginControls({ pluginId, install }: { pluginId: string; install: PluginInstallPresentation }) {
  const state = useInstallState();
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState('');
  const [chosen, setChosen] = useState<'sandboxed' | 'full' | null>(null);
  const trust = chosen ?? install.trust;
  return (
    <div className="plugin-installed" data-testid="plugin-installed-controls">
      <p className="plugin-preview-source">{install.source} &middot; code <code>{install.codeUrl.split('/').at(-2)?.slice(0, 12)}</code></p>
      <label className="pref-row pref-switch plugin-trust">
        <span className="pref-label">
          Trust fully
          <small>
            {trust === 'full'
              ? "Runs inside the editor with Noto's own access: every note in any folder you open, your settings, and the network."
              : 'Off: runs sandboxed, in a worker with no network of its own, unable to add a web address to a note, and with nothing beyond what it declares.'}
            {' '}Trust ends by itself if its code changes.
          </small>
        </span>
        <input type="checkbox" role="switch" data-testid="plugin-trust" checked={trust === 'full'}
          onChange={(event) => {
            const next = event.target.checked ? 'full' : 'sandboxed';
            void ask({ action: 'set-trust', pluginId, trust: next }).then((reply) => {
              if (reply.kind === 'done') setChosen(next);
              if (reply.kind === 'refused') setProblem(reply.message);
            });
          }} />
        <span className="pref-track" aria-hidden="true" />
      </label>
      {problem && <p className="pref-problem" role="alert">{problem}</p>}
      <div className="plugin-preview-actions">
        {confirming ? (
          <>
            <button type="button" className="pref-action is-danger" data-testid="plugin-uninstall-confirm"
              onClick={() => {
                void ask({ action: 'uninstall', pluginId }).then((reply) => {
                  setConfirming(false);
                  if (reply.kind === 'refused') setProblem(reply.message);
                });
              }}>
              Remove It
            </button>
            <button type="button" className="pref-action" onClick={() => setConfirming(false)}>Keep</button>
          </>
        ) : (
          <button type="button" className="pref-action" data-testid="plugin-uninstall" onClick={() => setConfirming(true)}>
            Uninstall&hellip;
          </button>
        )}
      </div>
      <RestartBanner state={state} />
    </div>
  );
}

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app, dialog, ipcMain, net, shell, type BrowserWindow } from 'electron';
import type { StructuredLogger } from '../logger';
import { isTrustedRendererSender } from '../ipc/trusted-renderer';
import type { PluginManifest } from '../../shared/plugins/manifest';
import {
  describeSource, isDigest, isGitRef, isGithubName, isRepoPath,
  INSTALL_RECORD_SCHEMA_VERSION, type InstallRecordV1, type InstallSourceV1,
} from '../../shared/plugins/install-record';
import {
  abilityOf, isPluginInstallRequest, PLUGIN_INSTALL_CHANNEL,
  type MarketplaceEntryV1, type PluginInstallReplyV1, type PluginInstallRequest, type PluginInstallStateV1,
} from '../../shared/plugins/install-ipc';
import {
  FRESH_MARKER, MAX_MAIN_BYTES, MAX_MANIFEST_BYTES, readContainedFile, sha256, userManifestProblem,
  type SetAsidePlugin, type UserPlugin,
} from './user-plugins';

/** A name as a dialog may show it: no control or direction characters to disguise it. */
function plainName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim() || 'This plugin';
}

/**
 * Installing, trusting and removing the reader's plugins.
 *
 * A preview is fetched and checked first and held in memory; nothing touches
 * the plugins folder until the reader installs it. An install is written to a
 * staging folder beside the plugins and renamed into place, so a crash leaves
 * the old version or the new one, never half of either. The catalog is read
 * once at launch, so every change here takes effect at the next start, which
 * Plugin Center offers.
 */

const FETCH_TIMEOUT_MS = 10_000;
const MAX_INDEX_BYTES = 512 * 1024;
const MAX_MARKETPLACE_ENTRIES = 200;
const RAW_ORIGIN = 'https://raw.githubusercontent.com';

interface Staged {
  readonly manifest: PluginManifest;
  readonly manifestBytes: Buffer;
  readonly main: Buffer;
  readonly mainDigest: string;
  readonly source: InstallSourceV1;
  readonly problems: string[];
}

interface MarketplaceIndexEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly owner: string;
  readonly repo: string;
  readonly ref: string;
  readonly path: string;
  readonly sha256: string | null;
  readonly manifestSha256: string | null;
}

export interface PluginInstallerDeps {
  /** `<userData>/plugins/user`. */
  readonly root: string;
  readonly getWindow: () => BrowserWindow | null;
  readonly logger: StructuredLogger;
  /** The reader's plugins loaded at launch, by id. */
  readonly installed: () => ReadonlyMap<string, UserPlugin>;
  readonly setAside: () => readonly SetAsidePlugin[];
  /** Every bundled plugin's id, and each hotkey a bundled plugin holds, with its name. */
  readonly bundled: () => { readonly ids: ReadonlySet<string>; readonly hotkeys: ReadonlyMap<string, string> };
  /** `owner/repo` of the marketplace, or empty when it is off. */
  readonly marketplace: () => string;
  /** Where GitHub's raw files are fetched from; replaced only in tests. */
  readonly rawOrigin?: string;
}

/** A GitHub address, read as the repo, the ref and the folder inside it. */
export function parseGithubSource(input: string): { owner: string; repo: string; ref: string; path: string } | null {
  const trimmed = input.trim().replace(/\/+$/, '');
  const short = /^([^/\s]+)\/([^/\s]+)$/.exec(trimmed);
  let owner: string; let repo: string; let ref = 'HEAD'; let folder = '';
  if (short) {
    [, owner, repo] = short as unknown as [string, string, string];
  } else {
    let url: URL;
    try { url = new URL(trimmed); } catch { return null; }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.search || url.hash || url.username || url.password) return null;
    let parts: string[];
    try {
      parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    } catch {
      return null;
    }
    if (parts.length < 2) return null;
    [owner, repo] = parts as [string, string];
    if (parts.length > 2) {
      if (parts[2] !== 'tree' || parts.length < 4) return null;
      ref = parts[3]!;
      folder = parts.slice(4).join('/');
    }
  }
  repo = repo.replace(/\.git$/, '');
  if (!isGithubName(owner) || !isGithubName(repo) || !isGitRef(ref) || !isRepoPath(folder)) return null;
  return { owner, repo, ref, path: folder };
}

function parseMarketplaceIndex(value: unknown): MarketplaceIndexEntry[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const index = value as Record<string, unknown>;
  if (index.schemaVersion !== 1 || !Array.isArray(index.plugins)) return null;
  const entries: MarketplaceIndexEntry[] = [];
  for (const raw of index.plugins.slice(0, MAX_MARKETPLACE_ENTRIES)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const repo = typeof entry.repo === 'string' ? parseGithubSource(entry.repo) : null;
    const ref = entry.ref === undefined ? 'HEAD' : entry.ref;
    const folder = entry.path === undefined ? '' : entry.path;
    if (!repo || !isGitRef(ref) || !isRepoPath(folder)) continue;
    if (typeof entry.id !== 'string' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(entry.id) || entry.id.length > 128) continue;
    if (typeof entry.name !== 'string' || entry.name.length === 0 || entry.name.length > 80) continue;
    if (typeof entry.version !== 'string' || entry.version.length === 0 || entry.version.length > 64) continue;
    const description = typeof entry.description === 'string' ? entry.description.slice(0, 200) : '';
    const pin = entry.sha256 === undefined ? null : isDigest(entry.sha256) ? entry.sha256 : undefined;
    const manifestPin = entry.manifestSha256 === undefined ? null : isDigest(entry.manifestSha256) ? entry.manifestSha256 : undefined;
    if (pin === undefined || manifestPin === undefined) continue;
    entries.push({
      id: entry.id, name: entry.name, description, version: entry.version,
      owner: repo.owner, repo: repo.repo, ref, path: folder, sha256: pin, manifestSha256: manifestPin,
    });
  }
  return entries;
}

export class PluginInstaller {
  private readonly staged = new Map<string, Staged>();
  private restartPending = false;

  constructor(private readonly deps: PluginInstallerDeps) {}

  register(): void {
    ipcMain.handle(PLUGIN_INSTALL_CHANNEL, async (event, value: unknown): Promise<PluginInstallReplyV1> => {
      if (!isTrustedRendererSender(this.deps.getWindow(), event) || !isPluginInstallRequest(value)) {
        this.deps.logger.log('plugin_install_ipc_rejected', {});
        return { kind: 'refused', message: 'That request was not accepted.' };
      }
      try {
        return await this.handle(value);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'It did not work.';
        this.deps.logger.log('plugin_install_failed', { action: value.action, error: message.slice(0, 300) });
        return { kind: 'refused', message: message.slice(0, 600) };
      }
    });
  }

  async handle(request: PluginInstallRequest): Promise<PluginInstallReplyV1> {
    switch (request.action) {
      case 'state': return { kind: 'state', state: this.state() };
      case 'preview-folder': return this.previewFolder();
      case 'preview-github': {
        const source = parseGithubSource(request.url);
        if (!source) return { kind: 'refused', message: 'That is not a GitHub repository address. Use https://github.com/owner/repo, or a folder in it.' };
        const files = await this.fetchPlugin(source);
        return this.preview(this.stage(files.manifest, files.main, { kind: 'github', ...source }));
      }
      case 'marketplace': {
        const entries = await this.marketplaceIndex();
        const installed = this.deps.installed();
        return {
          kind: 'marketplace',
          entries: entries.map((entry): MarketplaceEntryV1 => ({
            id: entry.id, name: entry.name, description: entry.description, version: entry.version,
            repo: `${entry.owner}/${entry.repo}`, installed: installed.get(entry.id)?.manifest.version ?? null,
          })),
        };
      }
      case 'preview-marketplace': {
        const entry = (await this.marketplaceIndex()).find((candidate) => candidate.id === request.id);
        if (!entry) return { kind: 'refused', message: 'The marketplace no longer lists that plugin.' };
        const files = await this.fetchPlugin(entry);
        const staged = this.stage(files.manifest, files.main, {
          kind: 'marketplace', owner: entry.owner, repo: entry.repo, ref: entry.ref, path: entry.path, index: this.deps.marketplace(),
        });
        if (staged.manifest.id !== entry.id) staged.problems.push(`The marketplace lists ${entry.id}, but the code is ${staged.manifest.id}.`);
        if (entry.sha256 !== null && entry.sha256 !== staged.mainDigest) {
          staged.problems.push('The code is not the code the marketplace vouched for: its digest does not match.');
        }
        // The manifest says what the code may do, so a pin on it holds the
        // capabilities too, not only the code.
        if (entry.manifestSha256 !== null && entry.manifestSha256 !== sha256(staged.manifestBytes)) {
          staged.problems.push('The manifest is not the one the marketplace vouched for: its digest does not match.');
        }
        return this.preview(staged, entry.sha256 !== null && entry.sha256 === staged.mainDigest);
      }
      case 'commit': return this.commit(request.stagingId);
      case 'cancel':
        this.staged.delete(request.stagingId);
        return { kind: 'cancelled' };
      case 'uninstall': return this.uninstall(request.pluginId);
      case 'set-trust': return this.setTrust(request.pluginId, request.trust);
      case 'open-folder':
        await mkdir(this.deps.root, { recursive: true });
        await shell.openPath(this.deps.root);
        return { kind: 'state', state: this.state() };
      case 'restart':
        app.relaunch();
        app.quit();
        return { kind: 'state', state: this.state() };
    }
  }

  private state(): PluginInstallStateV1 {
    return {
      folder: this.deps.root,
      setAside: this.deps.setAside().slice(0, 64).map((item) => ({ folder: item.folder.slice(0, 300), reason: item.reason.slice(0, 400) })),
      restartPending: this.restartPending,
      marketplace: this.deps.marketplace(),
    };
  }

  private async previewFolder(): Promise<PluginInstallReplyV1> {
    const window = this.deps.getWindow();
    const options = {
      title: 'Choose a plugin folder',
      buttonLabel: 'Choose',
      properties: ['openDirectory'] as ('openDirectory')[],
    };
    const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    const folder = picked.filePaths[0];
    if (picked.canceled || !folder) return { kind: 'cancelled' };
    const manifest = await readContainedFile(folder, 'manifest.json', MAX_MANIFEST_BYTES)
      .catch((error: Error) => { throw new Error(`The folder has no readable manifest.json: ${error.message}`); });
    const main = await readContainedFile(folder, 'main.js', MAX_MAIN_BYTES)
      .catch((error: Error) => { throw new Error(`The folder has no readable main.js: ${error.message}`); });
    return this.preview(this.stage(manifest, main, { kind: 'folder', path: folder }));
  }

  /** Check what was fetched or picked, and hold it until the reader decides. */
  private stage(manifestBytes: Buffer, main: Buffer, source: InstallSourceV1): Staged {
    let parsed: unknown;
    try { parsed = JSON.parse(manifestBytes.toString('utf8')); } catch { throw new Error('manifest.json is not JSON.'); }
    const problem = userManifestProblem(parsed);
    if (problem) throw new Error(`${problem.charAt(0).toUpperCase()}${problem.slice(1)}.`);
    const manifest = parsed as PluginManifest;
    const problems: string[] = [];
    const bundled = this.deps.bundled();
    if (bundled.ids.has(manifest.id)) problems.push('A plugin Noto ships has the same id.');
    const others = new Map(bundled.hotkeys);
    for (const plugin of this.deps.installed().values()) {
      if (plugin.manifest.id === manifest.id) continue;
      for (const hotkey of plugin.manifest.hotkeys) others.set(hotkey.keys, plugin.manifest.name);
    }
    for (const hotkey of manifest.hotkeys) {
      const holder = others.get(hotkey.keys);
      if (holder) problems.push(`Its key ${hotkey.keys} belongs to ${holder}.`);
    }
    const staged: Staged = { manifest, manifestBytes, main, mainDigest: sha256(main), source, problems };
    return staged;
  }

  private preview(staged: Staged, pinned = false): PluginInstallReplyV1 {
    const stagingId = randomUUID();
    // One preview at a time is all Plugin Center shows; older ones are dropped.
    this.staged.clear();
    this.staged.set(stagingId, staged);
    const { manifest } = staged;
    return {
      kind: 'preview',
      preview: {
        stagingId,
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description ?? '',
        source: describeSource(staged.source),
        abilities: manifest.capabilities.map(abilityOf),
        commands: manifest.commands.map((command) => command.title),
        hotkeys: manifest.hotkeys.map((hotkey) => hotkey.keys),
        digest: staged.mainDigest.slice(0, 12),
        pinned,
        replaces: this.replacing(manifest.id, staged.source),
        problems: staged.problems,
      },
    };
  }

  /** The version this would replace, saying where it came from when that is somewhere else. */
  private replacing(id: string, source: InstallSourceV1): string | null {
    const current = this.deps.installed().get(id);
    if (!current) return null;
    const was = describeSource(current.record?.source ?? null);
    return was === describeSource(source) ? current.manifest.version : `${current.manifest.version} from ${was}`;
  }

  private async commit(stagingId: string): Promise<PluginInstallReplyV1> {
    const staged = this.staged.get(stagingId);
    if (!staged) return { kind: 'refused', message: 'That preview has expired. Look the plugin up again.' };
    if (staged.problems.length > 0) return { kind: 'refused', message: staged.problems[0]! };
    this.staged.delete(stagingId);
    const { manifest } = staged;
    const record: InstallRecordV1 = {
      schemaVersion: INSTALL_RECORD_SCHEMA_VERSION,
      id: manifest.id,
      version: manifest.version,
      source: staged.source,
      mainDigest: staged.mainDigest,
      installedAt: new Date().toISOString(),
      // New code is never trusted on arrival, an update included.
      trust: 'sandboxed',
      trustedDigest: null,
    };
    const parent = path.dirname(this.deps.root);
    const staging = path.join(parent, '.staging', randomUUID());
    await mkdir(path.join(staging, '.noto'), { recursive: true });
    await writeFile(path.join(staging, 'manifest.json'), staged.manifestBytes, { flag: 'wx' });
    await writeFile(path.join(staging, 'main.js'), staged.main, { flag: 'wx' });
    try {
      await writeFile(path.join(staging, '.noto', 'record.json'), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
      // Turned off at the next start, so new code under an id that was on
      // does not start running by itself.
      await writeFile(path.join(staging, '.noto', FRESH_MARKER), '', { flag: 'wx' });
      await mkdir(this.deps.root, { recursive: true });
      const target = path.join(this.deps.root, manifest.id);
      const trash = await this.moveAside(target);
      try {
        await rename(staging, target);
      } catch (error) {
        // The old version goes back where it was rather than being lost.
        if (trash) await rename(trash, target).catch(() => undefined);
        throw error;
      }
      if (trash) await rm(trash, { recursive: true, force: true });
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
    this.restartPending = true;
    this.deps.logger.log('plugin_installed', { id: manifest.id, version: manifest.version, source: staged.source.kind });
    return { kind: 'done', state: this.state() };
  }

  /** Move a plugin's folder out of the way, returning where it went. */
  private async moveAside(target: string): Promise<string | null> {
    const trash = path.join(path.dirname(this.deps.root), '.trash', `${path.basename(target)}-${randomUUID()}`);
    try {
      await mkdir(path.dirname(trash), { recursive: true });
      await rename(target, trash);
      return trash;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async uninstall(pluginId: string): Promise<PluginInstallReplyV1> {
    const folders = await readdir(this.deps.root).catch(() => [] as string[]);
    if (!folders.includes(pluginId)) return { kind: 'refused', message: 'That plugin is not in the plugins folder.' };
    const trash = await this.moveAside(path.join(this.deps.root, pluginId));
    if (trash) await rm(trash, { recursive: true, force: true });
    this.restartPending = true;
    this.deps.logger.log('plugin_uninstalled', { id: pluginId });
    return { kind: 'done', state: this.state() };
  }

  private async setTrust(pluginId: string, trust: 'sandboxed' | 'full'): Promise<PluginInstallReplyV1> {
    const plugin = this.deps.installed().get(pluginId);
    if (!plugin) return { kind: 'refused', message: 'That plugin is not loaded. Restart Noto first.' };
    if (trust === 'full') {
      const window = this.deps.getWindow();
      const options = {
        type: 'warning' as const,
        buttons: ['Cancel', 'Trust Fully'],
        defaultId: 0,
        cancelId: 0,
        message: `Trust ${plainName(plugin.manifest.name)} fully?`,
        detail: `${plugin.manifest.id} ${plugin.manifest.version}, from ${describeSource(plugin.record?.source ?? null)}, code ${plugin.mainDigest.slice(0, 12)}.\n\n`
          + "It will run inside the editor with Noto's own access: every note in any folder you open, your settings, and the network. "
          + "Only trust code you have read. Trust ends by itself if the plugin's code changes.",
      };
      const answer = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
      if (answer.response !== 1) return { kind: 'cancelled' };
    }
    const record: InstallRecordV1 = {
      schemaVersion: INSTALL_RECORD_SCHEMA_VERSION,
      id: pluginId,
      version: plugin.manifest.version,
      source: plugin.record?.source ?? { kind: 'folder', path: plugin.directory },
      mainDigest: plugin.mainDigest,
      installedAt: plugin.record?.installedAt ?? new Date().toISOString(),
      trust,
      trustedDigest: trust === 'full' ? plugin.mainDigest : null,
    };
    await mkdir(path.join(plugin.directory, '.noto'), { recursive: true });
    const next = path.join(plugin.directory, '.noto', `record-${randomUUID()}.json`);
    await writeFile(next, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
    await rename(next, path.join(plugin.directory, '.noto', 'record.json'));
    this.restartPending = true;
    this.deps.logger.log('plugin_trust_changed', { id: pluginId, trust });
    return { kind: 'done', state: this.state() };
  }

  private rawUrl(source: { owner: string; repo: string; ref: string; path: string }, file: string): string {
    const folder = source.path ? `${source.path.split('/').map(encodeURIComponent).join('/')}/` : '';
    return `${this.deps.rawOrigin ?? RAW_ORIGIN}/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/${source.ref.split('/').map(encodeURIComponent).join('/')}/${folder}${file}`;
  }

  private async fetchPlugin(source: { owner: string; repo: string; ref: string; path: string }): Promise<{ manifest: Buffer; main: Buffer }> {
    const where = `${source.owner}/${source.repo}${source.path ? `/${source.path}` : ''}`;
    const manifest = await this.fetchCapped(this.rawUrl(source, 'manifest.json'), MAX_MANIFEST_BYTES)
      .catch((error: Error) => { throw new Error(`No manifest.json at ${where}: ${error.message}`); });
    const main = await this.fetchCapped(this.rawUrl(source, 'main.js'), MAX_MAIN_BYTES)
      .catch((error: Error) => { throw new Error(`No main.js at ${where}: ${error.message}`); });
    return { manifest, main };
  }

  private async marketplaceIndex(): Promise<MarketplaceIndexEntry[]> {
    const repo = this.deps.marketplace();
    const source = repo ? parseGithubSource(repo) : null;
    if (!source) throw new Error('The marketplace is off. Name its repository in Settings, Plugins.');
    const bytes = await this.fetchCapped(this.rawUrl(source, 'index.json'), MAX_INDEX_BYTES)
      .catch((error: Error) => { throw new Error(`The marketplace at ${repo} could not be read: ${error.message}`); });
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`The marketplace index at ${repo} is not JSON.`); }
    const entries = parseMarketplaceIndex(parsed);
    if (!entries) throw new Error(`The marketplace index at ${repo} is not in a shape Noto reads.`);
    return entries;
  }

  /** One file over HTTPS, refused past `limit` bytes or `FETCH_TIMEOUT_MS`. */
  private async fetchCapped(url: string, limit: number): Promise<Buffer> {
    const response = await net.fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
    }).catch((error: Error) => {
      throw new Error(error.name === 'TimeoutError' ? 'it took too long to answer' : 'it could not be reached');
    });
    if (response.status === 404) throw new Error('not found');
    if (!response.ok) throw new Error(`the server answered ${response.status}`);
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > limit) throw new Error(`it is larger than ${Math.round(limit / 1024)} KB`);
    const reader = response.body?.getReader();
    if (!reader) return Buffer.alloc(0);
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error(`it is larger than ${Math.round(limit / 1024)} KB`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }
}

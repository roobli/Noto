import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createPluginCatalog, type PluginCatalog } from '../../shared/plugins/catalog';
import { validatePluginManifest, type PluginManifest } from '../../shared/plugins/manifest';
import { effectiveTrust, isInstallRecordV1, type InstallRecordV1, type PluginTrust } from '../../shared/plugins/install-record';
import { isContainedPluginResourcePath } from './bundled-plugin-discovery';

/**
 * Plugins the reader installed, found in `<userData>/plugins/user/<id>/`.
 *
 * Each is a folder named for the plugin's id holding `manifest.json`, a
 * self-contained `main.js` ES module, and the record Noto keeps in
 * `.noto/record.json`. A folder that is not that shape is passed over with a
 * reason, never fatal: one broken plugin must not cost the reader the rest,
 * or the bundled ones.
 */

export const MAX_USER_PLUGINS = 48;
export const MAX_MANIFEST_BYTES = 256 * 1024;
export const MAX_MAIN_BYTES = 1024 * 1024;
const MAX_RECORD_BYTES = 16 * 1024;

/** The bundled plugins' namespace, which nothing the reader installs may claim. */
export const RESERVED_ID_PREFIX = 'dev.lr00rl.noto.';

export interface UserPlugin {
  readonly manifest: PluginManifest;
  readonly directory: string;
  readonly mainDigest: string;
  readonly record: InstallRecordV1 | null;
  readonly trust: PluginTrust;
  /**
   * Installed or replaced since the last start. Its switch is turned off
   * once the catalog is loaded, so new code under the id of a plugin that
   * was on does not start running by itself.
   */
  readonly fresh: boolean;
}

/** The marker an install leaves, read and removed at the next start. */
export const FRESH_MARKER = 'fresh';

export interface SetAsidePlugin {
  readonly folder: string;
  readonly reason: string;
}

export function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Read a regular file inside `directory`, refusing links and anything over `limit` bytes. */
export async function readContainedFile(directory: string, name: string, limit: number): Promise<Buffer> {
  const filePath = path.join(directory, name);
  // Non-blocking, so a pipe named like the file fails at the type check
  // below instead of waiting for a writer that never comes.
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error(`${name} is not a file`);
    if (stats.size > limit) throw new Error(`${name} is larger than ${Math.round(limit / 1024)} KB`);
    // Both sides resolved: a plugins folder reached through a link (macOS
    // keeps temporary and some home folders behind one) is still itself.
    const accepted = await realpath(filePath);
    if (!isContainedPluginResourcePath(await realpath(directory), accepted)) throw new Error(`${name} points outside its folder`);
    return await handle.readFile();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Why a manifest cannot be a user plugin, or null when it can. */
export function userManifestProblem(manifest: unknown): string | null {
  if (!validatePluginManifest(manifest)) return 'manifest.json is not a valid Noto plugin manifest';
  if (manifest.runtime !== 'sandboxed') return 'only a "sandboxed" plugin can be installed';
  if (manifest.id.startsWith(RESERVED_ID_PREFIX)) return `the id ${manifest.id} is reserved for the plugins Noto ships`;
  return null;
}

async function readUserPlugin(directory: string, folder: string): Promise<UserPlugin> {
  let manifest: unknown;
  try {
    manifest = JSON.parse((await readContainedFile(directory, 'manifest.json', MAX_MANIFEST_BYTES)).toString('utf8'));
  } catch (cause) {
    throw new Error(cause instanceof SyntaxError ? 'manifest.json is not JSON' : `manifest.json could not be read: ${(cause as Error).message}`);
  }
  const problem = userManifestProblem(manifest);
  if (problem) throw new Error(problem);
  const accepted = manifest as PluginManifest;
  if (accepted.id !== folder) throw new Error(`the folder is named ${folder} but the plugin is ${accepted.id}`);
  const main = await readContainedFile(directory, 'main.js', MAX_MAIN_BYTES)
    .catch((cause: Error) => { throw new Error(`main.js could not be read: ${cause.message}`); });
  const mainDigest = sha256(main);
  let record: InstallRecordV1 | null = null;
  try {
    const parsed: unknown = JSON.parse((await readContainedFile(path.join(directory, '.noto'), 'record.json', MAX_RECORD_BYTES)).toString('utf8'));
    if (isInstallRecordV1(parsed) && parsed.id === accepted.id) record = parsed;
  } catch {
    // No record: put there by hand, so sandboxed.
  }
  const fresh = await lstat(path.join(directory, '.noto', FRESH_MARKER)).then(() => true, () => false);
  return { manifest: accepted, directory, mainDigest, record, trust: effectiveTrust(record, mainDigest), fresh };
}

export async function discoverUserPlugins(root: string): Promise<{ plugins: UserPlugin[]; setAside: SetAsidePlugin[] }> {
  let entries;
  try {
    const stats = await lstat(root);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return { plugins: [], setAside: [{ folder: root, reason: 'the plugins folder is not a folder' }] };
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { plugins: [], setAside: [] };
  }
  const plugins: UserPlugin[] = [];
  const setAside: SetAsidePlugin[] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      setAside.push({ folder: entry.name, reason: 'not a folder' });
      continue;
    }
    if (plugins.length >= MAX_USER_PLUGINS) {
      setAside.push({ folder: entry.name, reason: `more than ${MAX_USER_PLUGINS} plugins are installed` });
      continue;
    }
    try {
      plugins.push(await readUserPlugin(path.join(root, entry.name), entry.name));
    } catch (cause) {
      setAside.push({ folder: entry.name, reason: (cause as Error).message });
    }
  }
  return { plugins, setAside };
}

/**
 * The bundled catalog with the reader's plugins joined to it. A plugin whose
 * id or hotkey another plugin already holds is set aside with the reason,
 * rather than refusing the catalog and with it every plugin.
 */
export function joinCatalog(bundled: PluginCatalog, user: readonly UserPlugin[]): {
  catalog: PluginCatalog;
  joined: UserPlugin[];
  setAside: SetAsidePlugin[];
} {
  const ids = new Set(bundled.plugins.map((manifest) => manifest.id));
  const keys = new Map<string, string>();
  for (const manifest of bundled.plugins) for (const hotkey of manifest.hotkeys) keys.set(hotkey.keys, manifest.name);
  const joined: UserPlugin[] = [];
  const setAside: SetAsidePlugin[] = [];
  for (const plugin of user) {
    const { manifest } = plugin;
    if (ids.has(manifest.id)) {
      setAside.push({ folder: manifest.id, reason: 'another plugin has the same id' });
      continue;
    }
    const clash = manifest.hotkeys.find((hotkey) => keys.has(hotkey.keys));
    if (clash) {
      setAside.push({ folder: manifest.id, reason: `its key ${clash.keys} belongs to ${keys.get(clash.keys)}` });
      continue;
    }
    if (bundled.plugins.length + joined.length >= 64) {
      setAside.push({ folder: manifest.id, reason: 'too many plugins' });
      continue;
    }
    ids.add(manifest.id);
    for (const hotkey of manifest.hotkeys) keys.set(hotkey.keys, manifest.name);
    joined.push(plugin);
  }
  return {
    catalog: createPluginCatalog([...bundled.plugins, ...joined.map((plugin) => plugin.manifest)]),
    joined,
    setAside,
  };
}

/** A plugin's code, if it is still exactly the code with this digest. */
export async function readUserPluginCode(plugin: UserPlugin, digest: string): Promise<Buffer | null> {
  try {
    const main = await readContainedFile(plugin.directory, 'main.js', MAX_MAIN_BYTES);
    return sha256(main) === digest ? main : null;
  } catch {
    return null;
  }
}

/**
 * The address the renderer loads a plugin's code from, pinned to its digest:
 * the page's origin for a plugin trusted fully, an origin only the sandbox
 * worker may import from otherwise.
 */
export function userPluginCodeUrl(plugin: UserPlugin): string {
  return plugin.trust === 'full'
    ? `noto://bundle/plugins/${plugin.manifest.id}/${plugin.mainDigest}/main.js`
    : `noto://plugin-code/${plugin.manifest.id}/${plugin.mainDigest}/main.js`;
}

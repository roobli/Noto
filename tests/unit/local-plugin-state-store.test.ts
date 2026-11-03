import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createNodeLocalPluginStateFileSystem,
  LocalPluginStateStore,
  LocalPluginStateStoreError,
} from '../../src/main/plugins/local-plugin-state-store';
import { createPluginCatalog } from '../../src/shared/plugins/catalog';
import {
  filesystemProofManifest,
  rendererProofManifest,
} from '../../src/shared/plugins/proof-manifests';
import { createDefaultLocalPluginState } from '../../src/shared/plugins/state';

const roots: string[] = [];
const catalog = createPluginCatalog([rendererProofManifest, filesystemProofManifest]);

async function harness() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noto-local-plugins-'));
  roots.push(root);
  return {
    root,
    statePath: path.join(root, 'local-plugin-state.json'),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('main-owned durable local plugin state store', () => {
  it('loads manifest defaults, persists atomically, and hydrates after restart', async () => {
    const { statePath } = await harness();
    const store = new LocalPluginStateStore(statePath, catalog);
    const state = await store.load();
    state.plugins[rendererProofManifest.id].desiredEnabled = false;
    state.plugins[rendererProofManifest.id].settings.focusEnabled = false;

    await store.save(state);

    const restarted = new LocalPluginStateStore(statePath, catalog);
    expect(await restarted.load()).toEqual(state);
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual(state);
  });

  it('serializes writes in call order', async () => {
    const { statePath } = await harness();
    const store = new LocalPluginStateStore(statePath, catalog);
    const first = createDefaultLocalPluginState(catalog);
    const second = createDefaultLocalPluginState(catalog);
    first.plugins[rendererProofManifest.id].settings.focusEnabled = false;
    second.plugins[rendererProofManifest.id].desiredEnabled = false;

    await Promise.all([store.save(first), store.save(second)]);

    expect(await store.load()).toEqual(second);
  });

  it('rejects corrupt state explicitly and preserves the original evidence', async () => {
    const { statePath } = await harness();
    const corrupt = '{"schemaVersion":1,"plugins":{"unsafe":true}}\n';
    await writeFile(statePath, corrupt);
    const store = new LocalPluginStateStore(statePath, catalog);

    await expect(store.load()).rejects.toMatchObject({
      code: 'CORRUPT_LOCAL_PLUGIN_STATE',
      evidencePath: statePath,
    });
    await expect(store.save(createDefaultLocalPluginState(catalog))).rejects.toBeInstanceOf(
      LocalPluginStateStoreError,
    );
    expect(await readFile(statePath, 'utf8')).toBe(corrupt);
  });

  it('loads and saves a state that still names a plugin no longer installed', async () => {
    // A user plugin removed since the state was written: the others must
    // load as they were, and the removed one keeps its switch for its return.
    const { statePath } = await harness();
    const state = createDefaultLocalPluginState(catalog);
    const written = { ...state, plugins: { ...state.plugins, 'local.someone.removed': { desiredEnabled: true, settings: {} } } };
    await writeFile(statePath, `${JSON.stringify(written)}\n`);
    const store = new LocalPluginStateStore(statePath, catalog);
    const loaded = await store.load();
    expect(loaded.plugins['local.someone.removed']).toEqual({ desiredEnabled: true, settings: {} });
    await expect(store.save(loaded)).resolves.not.toThrow();
  });

  it('rejects a symlink state path without touching its target', async () => {
    const { root, statePath } = await harness();
    const target = path.join(root, 'evidence.json');
    await writeFile(target, 'preserve-me');
    await symlink(target, statePath);
    const store = new LocalPluginStateStore(statePath, catalog);

    await expect(store.load()).rejects.toMatchObject({
      code: 'UNSAFE_LOCAL_PLUGIN_STATE',
      evidencePath: statePath,
    });
    expect(await readFile(target, 'utf8')).toBe('preserve-me');
  });

  it('cleans same-directory temporary state after a failed rename and retains accepted state', async () => {
    const { root, statePath } = await harness();
    const accepted = createDefaultLocalPluginState(catalog);
    const initial = new LocalPluginStateStore(statePath, catalog);
    await initial.save(accepted);

    const fileSystem = createNodeLocalPluginStateFileSystem();
    const failed = new LocalPluginStateStore(statePath, catalog, {
      ...fileSystem,
      rename: async () => { throw new Error('injected rename failure'); },
    });
    const replacement = structuredClone(accepted);
    replacement.plugins[rendererProofManifest.id].desiredEnabled = false;

    await expect(failed.save(replacement)).rejects.toMatchObject({
      code: 'WRITE_LOCAL_PLUGIN_STATE_FAILED',
    });
    expect(await initial.load()).toEqual(accepted);
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('returns published-uncertain state when directory sync fails after rename and adopts it on restart', async () => {
    const { statePath } = await harness();
    const fileSystem = createNodeLocalPluginStateFileSystem();
    const store = new LocalPluginStateStore(statePath, catalog, {
      ...fileSystem,
      open: async (filePath, flags, mode) => {
        const handle = await fileSystem.open(filePath, flags, mode);
        if (filePath !== path.dirname(statePath) || flags !== 'r') return handle;
        return {
          writeFile: (data) => handle.writeFile(data),
          sync: async () => { throw new Error('injected directory sync failure'); },
          close: () => handle.close(),
        };
      },
    });
    const replacement = createDefaultLocalPluginState(catalog);
    replacement.plugins[rendererProofManifest.id].desiredEnabled = true;

    await expect(store.save(replacement)).resolves.toMatchObject({
      status: 'published-uncertain',
      health: 'degraded',
      state: replacement,
    });
    expect(await new LocalPluginStateStore(statePath, catalog).load()).toEqual(replacement);
  });

  it('returns indeterminate published state when readback fails after rename and restart reconciles it', async () => {
    const { statePath } = await harness();
    const fileSystem = createNodeLocalPluginStateFileSystem();
    const store = new LocalPluginStateStore(statePath, catalog, {
      ...fileSystem,
      readFile: async (filePath) => {
        if (filePath === statePath) throw new Error('injected readback failure');
        return fileSystem.readFile(filePath);
      },
    });
    const replacement = createDefaultLocalPluginState(catalog);
    replacement.plugins[filesystemProofManifest.id].desiredEnabled = true;

    await expect(store.save(replacement)).resolves.toMatchObject({
      status: 'published-uncertain',
      health: 'indeterminate',
      state: replacement,
    });
    expect(await new LocalPluginStateStore(statePath, catalog).load()).toEqual(replacement);
  });
});

describe('durability where a directory cannot be opened', () => {
  it('is healthy on Windows, which has no directory to sync', async () => {
    // A directory cannot be opened for reading on Windows at all, and its
    // rename is journalled by the file system rather than by the caller.
    // Asking anyway fails every time, and a write that is durable was being
    // reported as degraded for it, which put every plugin into "needs
    // recovery" on that platform.
    const { statePath } = await harness();
    const windows = new LocalPluginStateStore(statePath, catalog, undefined, 'win32');
    const outcome = await windows.save(createDefaultLocalPluginState(catalog));
    expect(outcome.health).toBe('healthy');
    expect(outcome.status).toBe('durable');
  });

  it('still syncs the directory everywhere else', async () => {
    const { statePath } = await harness();
    const opened: string[] = [];
    const real = createNodeLocalPluginStateFileSystem();
    const watched = {
      ...real,
      open: async (target: string, flags: string, mode?: number) => {
        opened.push(`${target}:${flags}`);
        return real.open(target, flags, mode);
      },
    };
    const posix = new LocalPluginStateStore(statePath, catalog, watched, 'linux');
    const outcome = await posix.save(createDefaultLocalPluginState(catalog));
    expect(outcome.health).toBe('healthy');
    expect(opened.some((entry) => entry.endsWith(':r'))).toBe(true);
  });
});

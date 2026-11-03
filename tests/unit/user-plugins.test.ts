import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverUserPlugins, joinCatalog, readUserPluginCode, sha256, userPluginCodeUrl } from '../../src/main/plugins/user-plugins';
import { parseGithubSource } from '../../src/main/plugins/plugin-installer';
import { createPluginCatalog } from '../../src/shared/plugins/catalog';
import { effectiveTrust, isInstallRecordV1 } from '../../src/shared/plugins/install-record';
import { validatePluginManifest } from '../../src/shared/plugins/manifest';
import { titleShiftManifest } from '../../src/shared/plugins/proof-manifests';

const manifest = (id: string, extra: Record<string, unknown> = {}) => ({
  schemaVersion: 2, id, name: 'A plugin', version: '1.0.0', runtime: 'sandboxed',
  activation: { startup: false, events: ['editor.ready'], hotkeys: [] },
  capabilities: ['editor.read'], lifecycle: ['activate', 'deactivate'],
  commands: [{ id: 'a.run', title: 'Run' }], settings: [], hotkeys: [], editorExtensions: [], uiExtensions: [],
  ...extra,
});

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function plugins(entries: Record<string, { manifest?: unknown; main?: string } | 'link'>) {
  const root = await mkdtemp(path.join(tmpdir(), 'noto-user-plugins-'));
  roots.push(root);
  for (const [folder, files] of Object.entries(entries)) {
    if (files === 'link') { await symlink(tmpdir(), path.join(root, folder)); continue; }
    await mkdir(path.join(root, folder));
    if (files.manifest !== undefined) await writeFile(path.join(root, folder, 'manifest.json'), JSON.stringify(files.manifest));
    if (files.main !== undefined) await writeFile(path.join(root, folder, 'main.js'), files.main);
  }
  return root;
}

describe('a manifest the reader installs', () => {
  it('is sandboxed, and may carry a description the bundled kinds may not', () => {
    expect(validatePluginManifest(manifest('local.one', { description: 'Does one thing.' }))).toBe(true);
    expect(validatePluginManifest({ ...titleShiftManifest, description: 'x' })).toBe(false);
    expect(validatePluginManifest(manifest('local.one', { uiExtensions: ['panel'] }))).toBe(false);
    expect(validatePluginManifest(manifest('local.one', { capabilities: ['filesystem.read'] }))).toBe(false);
  });
});

describe('the plugins folder', () => {
  it('loads each well-formed plugin and sets the rest aside with a reason', async () => {
    const root = await plugins({
      'local.good': { manifest: manifest('local.good'), main: 'export function activate() {}' },
      'local.named-wrong': { manifest: manifest('local.other'), main: 'x' },
      'local.no-code': { manifest: manifest('local.no-code') },
      'dev.lr00rl.noto.fake': { manifest: manifest('dev.lr00rl.noto.fake'), main: 'x' },
      'local.trusted-kind': { manifest: { ...titleShiftManifest, id: 'local.trusted-kind' }, main: 'x' },
      'local.link': 'link',
    });
    const found = await discoverUserPlugins(root);
    expect(found.plugins.map((plugin) => plugin.manifest.id)).toEqual(['local.good']);
    expect(found.plugins[0]).toMatchObject({ trust: 'sandboxed', record: null, mainDigest: sha256('export function activate() {}') });
    const reasons = Object.fromEntries(found.setAside.map((item) => [item.folder, item.reason]));
    expect(reasons['local.named-wrong']).toMatch(/named local.named-wrong but the plugin is local.other/);
    expect(reasons['local.no-code']).toMatch(/main.js/);
    expect(reasons['dev.lr00rl.noto.fake']).toMatch(/reserved/);
    expect(reasons['local.trusted-kind']).toMatch(/sandboxed/);
    expect(reasons['local.link']).toMatch(/not a folder/);
  });

  it('serves a plugin’s code only while it is the code with that digest', async () => {
    const root = await plugins({ 'local.good': { manifest: manifest('local.good'), main: 'one' } });
    const [plugin] = (await discoverUserPlugins(root)).plugins;
    // Sandboxed: an origin only the sandbox worker may import from.
    expect(userPluginCodeUrl(plugin!)).toBe(`noto://plugin-code/local.good/${sha256('one')}/main.js`);
    expect((await readUserPluginCode(plugin!, sha256('one')))?.toString()).toBe('one');
    await writeFile(path.join(root, 'local.good', 'main.js'), 'two');
    expect(await readUserPluginCode(plugin!, sha256('one'))).toBeNull();
  });

  it('joins the bundled catalog, setting aside a plugin whose id or key is taken', async () => {
    const bundled = createPluginCatalog([titleShiftManifest]);
    const root = await plugins({
      'local.free': { manifest: manifest('local.free'), main: 'x' },
      'local.clash': {
        manifest: manifest('local.clash', { hotkeys: [{ command: 'a.run', keys: titleShiftManifest.hotkeys[0]!.keys }] }),
        main: 'x',
      },
    });
    const joined = joinCatalog(bundled, (await discoverUserPlugins(root)).plugins);
    expect(joined.catalog.plugins.map((item) => item.id)).toEqual([titleShiftManifest.id, 'local.free']);
    expect(joined.setAside).toEqual([{ folder: 'local.clash', reason: expect.stringMatching(/belongs to Title Shift/) }]);
  });
});

describe('trust', () => {
  const record = (trust: 'full' | 'sandboxed', trustedDigest: string | null) => ({
    schemaVersion: 1, id: 'local.good', version: '1.0.0', source: { kind: 'github', owner: 'a', repo: 'b', ref: 'HEAD', path: '' },
    mainDigest: 'a'.repeat(64), installedAt: '2026-11-03T00:00:00.000Z', trust, trustedDigest,
  });

  it('is full only while the code is the code that was trusted', () => {
    expect(isInstallRecordV1(record('full', 'a'.repeat(64)))).toBe(true);
    expect(effectiveTrust(record('full', 'a'.repeat(64)) as never, 'a'.repeat(64))).toBe('full');
    expect(effectiveTrust(record('full', 'a'.repeat(64)) as never, 'b'.repeat(64))).toBe('sandboxed');
    expect(effectiveTrust(null, 'a'.repeat(64))).toBe('sandboxed');
    expect(isInstallRecordV1({ ...record('full', null), source: { kind: 'github', owner: 'a', repo: 'b', ref: '../x', path: '' } })).toBe(false);
  });
});

describe('a GitHub address', () => {
  it('reads a repository, a folder in it at a ref, or the short form', () => {
    expect(parseGithubSource('https://github.com/roobli/noto-plugins')).toEqual({ owner: 'roobli', repo: 'noto-plugins', ref: 'HEAD', path: '' });
    expect(parseGithubSource('https://github.com/roobli/noto-plugins.git/')).toEqual({ owner: 'roobli', repo: 'noto-plugins', ref: 'HEAD', path: '' });
    expect(parseGithubSource('https://github.com/a/b/tree/main/plugins/shout'))
      .toEqual({ owner: 'a', repo: 'b', ref: 'main', path: 'plugins/shout' });
    expect(parseGithubSource('a/b')).toEqual({ owner: 'a', repo: 'b', ref: 'HEAD', path: '' });
  });

  it('refuses anything else', () => {
    for (const bad of [
      'http://github.com/a/b', 'https://gitlab.com/a/b', 'https://github.com/a', 'https://github.com/a/b/blob/main/x',
      'https://github.com/a/b/tree/main/../../x', 'https://github.com/a/b?x=1', 'https://user:pw@github.com/a/b', 'a/b/c', '',
    ]) {
      expect(parseGithubSource(bad), bad).toBeNull();
    }
  });
});

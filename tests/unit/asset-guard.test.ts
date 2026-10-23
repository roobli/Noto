import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveAssetPath } from '../../src/main/protocol/asset-guard';

let vault: string;
let outside: string;

beforeAll(async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noto-assets-')));
  vault = path.join(base, 'vault');
  outside = path.join(base, 'outside');
  await mkdir(path.join(vault, 'notes', 'pics'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(vault, 'notes', 'pics', 'a.png'), 'png');
  await writeFile(path.join(vault, 'notes', 'a.md'), '# a');
  await writeFile(path.join(outside, 'secret.png'), 'png');
  await symlink(path.join(outside, 'secret.png'), path.join(vault, 'notes', 'pics', 'escape.png'));
  await symlink(vault, path.join(base, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
});

afterAll(async () => {
  await rm(path.dirname(vault), { recursive: true, force: true });
});

const guard = (requested: string, roots: string[]) => resolveAssetPath(requested, { roots, realpath });

describe('the asset guard', () => {
  it('serves an image inside a trusted root, by its real path', async () => {
    const inside = path.join(vault, 'notes', 'pics', 'a.png');
    await expect(guard(inside, [vault])).resolves.toBe(inside);
    await expect(guard(inside, [path.join(vault, 'notes')])).resolves.toBe(inside);
    // A path that climbs and comes back is judged by where it lands.
    await expect(guard(path.join(vault, 'notes', '..', 'notes', 'pics', 'a.png'), [vault])).resolves.toBe(inside);
  });

  it('refuses a file outside every root, and a link that leads outside', async () => {
    await expect(guard(path.join(outside, 'secret.png'), [vault])).resolves.toBeNull();
    await expect(guard(path.join(vault, '..', 'outside', 'secret.png'), [vault])).resolves.toBeNull();
    await expect(guard(path.join(vault, 'notes', 'pics', 'escape.png'), [vault])).resolves.toBeNull();
  });

  it('refuses when there is no root at all', async () => {
    await expect(guard(path.join(vault, 'notes', 'pics', 'a.png'), [])).resolves.toBeNull();
  });

  it('serves only what is named as an image', async () => {
    await expect(guard(path.join(vault, 'notes', 'a.md'), [vault])).resolves.toBeNull();
    await expect(guard(path.join(vault, 'notes', 'pics', 'missing.png'), [vault])).resolves.toBeNull();
  });

  it('refuses a relative or malformed request outright', async () => {
    await expect(guard('notes/pics/a.png', [vault])).resolves.toBeNull();
    await expect(guard('', [vault])).resolves.toBeNull();
    await expect(guard(`${path.join(vault, 'notes', 'pics', 'a.png')}\0`, [vault])).resolves.toBeNull();
  });

  it('skips a root that does not exist rather than failing the request', async () => {
    const inside = path.join(vault, 'notes', 'pics', 'a.png');
    await expect(guard(inside, [path.join(outside, 'gone'), vault])).resolves.toBe(inside);
  });

  it('never asks the filesystem about a path outside every root', async () => {
    const asked: string[] = [];
    const recording = async (target: string) => {
      asked.push(target);
      return realpath(target);
    };
    const refused = [
      path.join(outside, 'secret.png'),
      path.join(vault, '..', 'outside', 'secret.png'),
      // UNC and device paths: resolving one on Windows opens a network
      // session before any containment check could refuse it.
      '//host/share/a.png',
      '\\\\host\\share\\a.png',
      '\\\\?\\C:\\a.png',
      '\\\\.\\pipe\\a.png',
    ];
    for (const requested of refused) {
      await expect(resolveAssetPath(requested, { roots: [vault], realpath: recording })).resolves.toBeNull();
    }
    expect(asked.filter((target) => target !== vault)).toEqual([]);
  });

  it('serves through a root that is spelled through a link', async () => {
    const alias = path.join(path.dirname(vault), 'alias');
    const inside = path.join(vault, 'notes', 'pics', 'a.png');
    await expect(guard(path.join(alias, 'notes', 'pics', 'a.png'), [alias])).resolves.toBe(inside);
    await expect(guard(inside, [alias])).resolves.toBe(inside);
  });
});

/**
 * Reading a picture the asset guard allowed, when the folder changes under it.
 *
 * The guard follows every link and answers with the real path; the read comes
 * after. A writer inside the vault that swaps a folder on that path for a link
 * in between must not get the read to follow it out of the vault, in export or
 * in the asset protocol.
 */

import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAssetPath } from '../../src/main/protocol/asset-guard';
import { nodeAssetFs, readResolvedAsset, type AssetFs } from '../../src/main/protocol/asset-read';
import { serveAsset } from '../../src/main/protocol/serve-asset';
import { toAssetUrl } from '../../src/shared/assets/v1/contracts';
import { inlineImages } from '../../src/main/workspace/inline-images';

let base: string;
let vault: string;
let outside: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'noto-asset-read-')));
  vault = path.join(base, 'vault');
  outside = path.join(base, 'outside');
  await mkdir(path.join(vault, 'assets'), { recursive: true });
  await mkdir(path.join(outside, 'assets'), { recursive: true });
  await writeFile(path.join(vault, 'assets', 'a.png'), 'INSIDE');
  await writeFile(path.join(outside, 'assets', 'a.png'), 'SECRET');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const swapFolderForLink = async () => {
  await rename(path.join(vault, 'assets'), path.join(vault, 'assets-moved'));
  await symlink(path.join(outside, 'assets'), path.join(vault, 'assets'), 'dir');
};

const putFolderBack = async () => {
  await rm(path.join(vault, 'assets'));
  await rename(path.join(vault, 'assets-moved'), path.join(vault, 'assets'));
};

/** The real filesystem, with something done just before the open. */
const beforeOpen = (move: () => Promise<void>): AssetFs => ({
  ...nodeAssetFs,
  open: async (target, flags) => {
    await move();
    return nodeAssetFs.open(target, flags);
  },
});

const logger = () => {
  const lines: { event: string; fields: unknown }[] = [];
  return { lines, log: (event: string, fields: unknown) => { lines.push({ event, fields }); } };
};

describe.skipIf(process.platform === 'win32')('a folder swapped for a link after the check', () => {
  it('is not read into an export', async () => {
    const html = '<img src="./assets/a.png">';
    const out = await inlineImages(html, {
      noteDirectory: vault,
      read: readResolvedAsset,
      resolve: async (absolute) => {
        const real = await resolveAssetPath(absolute, { roots: [vault], realpath });
        await swapFolderForLink();
        return real;
      },
    });
    expect(out).not.toContain(Buffer.from('SECRET').toString('base64'));
  });

  it('is not read when the folder is put back after the open', async () => {
    const real = path.join(vault, 'assets', 'a.png');
    const fs: AssetFs = {
      ...nodeAssetFs,
      open: async (target, flags) => {
        await swapFolderForLink();
        const handle = await nodeAssetFs.open(target, flags);
        await putFolderBack();
        return handle;
      },
    };
    await expect(readResolvedAsset(real, fs)).rejects.toThrow();
  });

  it('is not read when the file itself is swapped for a link', async () => {
    const real = path.join(vault, 'assets', 'a.png');
    const fs = beforeOpen(async () => {
      await rm(real);
      await symlink(path.join(outside, 'assets', 'a.png'), real);
    });
    await expect(readResolvedAsset(real, fs)).rejects.toThrow();
  });

  it('is not served by the asset protocol', async () => {
    const log = logger();
    const response = await serveAsset(
      new URL(toAssetUrl(path.join(vault, 'assets', 'a.png'))),
      [vault],
      log,
      beforeOpen(swapFolderForLink),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('SECRET');
    expect(JSON.stringify(log.lines)).not.toContain(vault);
  });
});

describe('a picture that stays put', () => {
  it('is read through the handle', async () => {
    const bytes = await readResolvedAsset(path.join(vault, 'assets', 'a.png'));
    expect(Buffer.from(bytes).toString()).toBe('INSIDE');
  });

  it('is served with its type', async () => {
    const response = await serveAsset(new URL(toAssetUrl(path.join(vault, 'assets', 'a.png'))), [vault], logger());
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(await response.text()).toBe('INSIDE');
  });

  it('is refused when it is a folder', async () => {
    await mkdir(path.join(vault, 'assets', 'b.png'));
    await expect(readResolvedAsset(path.join(vault, 'assets', 'b.png'))).rejects.toThrow();
    const response = await serveAsset(new URL(toAssetUrl(path.join(vault, 'assets', 'b.png'))), [vault], logger());
    expect(response.status).toBe(404);
  });

  it('is refused outside the roots, without naming the path in the log', async () => {
    const log = logger();
    const response = await serveAsset(new URL(toAssetUrl(path.join(outside, 'assets', 'a.png'))), [vault], log);
    expect(response.status).toBe(404);
    expect(log.lines).toEqual([{ event: 'asset_refused', fields: { roots: 1 } }]);
  });
});

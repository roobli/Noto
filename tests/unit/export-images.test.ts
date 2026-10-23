/**
 * Which pictures a Pandoc export may carry.
 *
 * Pandoc reads every picture a document names, from anywhere the process can
 * read, and writes it into the docx or epub. A shared note with
 * `![](/Users/me/.ssh/id_ed25519.png)` or `![](../../secret.png)` would put that
 * file inside the export, so every reference goes through the same containment
 * the asset protocol uses before Pandoc sees the document, and Pandoc itself
 * runs sandboxed and reads nothing but the document it is given.
 */

import { describe, expect, it } from 'vitest';
import { resolveAssetPath } from '../../src/main/protocol/asset-guard';
import {
  judgeImage,
  vetDocumentImages,
  type ImagePolicyDeps,
} from '../../src/main/workspace/export-images';
import { ASSET_ORIGIN } from '../../src/shared/assets/v1/contracts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

/** A small disk: what exists, and which paths are links to somewhere else. */
function disk(files: Record<string, Uint8Array>, links: Record<string, string> = {}) {
  const reads: string[] = [];
  const probes: string[] = [];
  const realpath = async (target: string): Promise<string> => {
    probes.push(target);
    for (const [from, to] of Object.entries(links)) {
      if (target === from || target.startsWith(`${from}/`)) return to + target.slice(from.length);
    }
    if (target in files || Object.keys(files).some((file) => file.startsWith(`${target}/`))) return target;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  const policy = (overrides: Partial<ImagePolicyDeps> = {}): ImagePolicyDeps => {
    const roots = overrides.roots ?? ['/vault'];
    return {
      noteDirectory: '/vault/notes',
      roots,
      remoteImages: false,
      resolve: (absolute) => resolveAssetPath(absolute, { roots, realpath }),
      // lstat: the last name is not followed, the folders above it are.
      exists: async (absolute) => realpath(absolute).then(() => true, () => false),
      read: async (absolute) => {
        reads.push(absolute);
        const bytes = files[absolute];
        if (!bytes) throw new Error('ENOENT');
        return bytes;
      },
      ...overrides,
    };
  };
  return { policy, reads, probes };
}

describe('judgeImage', () => {
  it('inlines a picture inside the folder, so it survives the sandbox', async () => {
    const { policy } = disk({ '/vault/notes/assets/a.png': PNG });
    expect(await judgeImage('assets/a.png', policy())).toEqual({
      kind: 'inline',
      data: `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`,
      bytes: PNG.byteLength,
    });
  });

  it('decodes a percent-encoded name the way the note does', async () => {
    const { policy } = disk({ '/vault/notes/my pic.png': PNG });
    expect((await judgeImage('my%20pic.png', policy())).kind).toBe('inline');
  });

  it('reads the asset URL the editor writes', async () => {
    const { policy } = disk({ '/vault/x.png': PNG });
    const source = `${ASSET_ORIGIN}/${encodeURIComponent('/vault/x.png')}`;
    expect((await judgeImage(source, policy())).kind).toBe('inline');
  });

  it('refuses a climb out of the folder without touching the disk', async () => {
    const { policy, reads, probes } = disk({ '/secret.png': PNG });
    expect(await judgeImage('../../secret.png', policy())).toEqual({ kind: 'refuse', why: 'outside-folder' });
    expect(reads).toEqual([]);
    expect(probes).toEqual([]);
  });

  it('refuses an absolute path outside the folder', async () => {
    const { policy, reads } = disk({ '/Users/me/key.png': PNG });
    expect(await judgeImage('/Users/me/key.png', policy())).toEqual({ kind: 'refuse', why: 'outside-folder' });
    expect(reads).toEqual([]);
  });

  it('refuses a UNC or network path without touching it', async () => {
    const { policy, probes } = disk({});
    expect(await judgeImage('//attacker/share/a.png', policy())).toEqual({ kind: 'refuse', why: 'outside-folder' });
    expect(await judgeImage('\\\\attacker\\share\\a.png', policy())).toEqual({ kind: 'refuse', why: 'outside-folder' });
    expect(probes).toEqual([]);
  });

  it('refuses a link inside the folder that points out of it', async () => {
    const { policy, reads } = disk({ '/etc/x.png': PNG }, { '/vault/notes/out': '/etc' });
    expect(await judgeImage('out/x.png', policy())).toEqual({ kind: 'refuse', why: 'outside-folder' });
    expect(reads).toEqual([]);
  });

  it('refuses a file that is not a picture', async () => {
    const { policy, reads } = disk({ '/vault/notes/notes.txt': PNG });
    expect(await judgeImage('notes.txt', policy())).toEqual({ kind: 'refuse', why: 'unsupported' });
    expect(reads).toEqual([]);
  });

  it('refuses a file: URL outside the folder, and other schemes', async () => {
    const { policy } = disk({ '/etc/a.png': PNG });
    expect(await judgeImage('file:///etc/a.png', policy())).toEqual({ kind: 'refuse', why: 'outside-folder' });
    expect(await judgeImage('file://attacker/share/a.png', policy())).toEqual({ kind: 'refuse', why: 'outside-folder' });
    expect(await judgeImage('ftp://example.com/a.png', policy())).toEqual({ kind: 'refuse', why: 'unsupported' });
  });

  it('refuses a web picture while remote images are off', async () => {
    const { policy } = disk({});
    expect(await judgeImage('https://example.com/a.png', policy())).toEqual({ kind: 'refuse', why: 'remote' });
    expect(await judgeImage('http://example.com/a.png', policy())).toEqual({ kind: 'refuse', why: 'remote' });
  });

  it('leaves a web picture alone while remote images are on, and never fetches it', async () => {
    const { policy, reads } = disk({});
    expect(await judgeImage('https://example.com/a.png', policy({ remoteImages: true }))).toEqual({ kind: 'keep' });
    expect(reads).toEqual([]);
  });

  it('leaves a missing picture inside the folder as it is, like the note shows it', async () => {
    const { policy } = disk({});
    expect(await judgeImage('assets/gone.png', policy())).toEqual({ kind: 'keep' });
  });

  it('leaves data already inline alone', async () => {
    const { policy } = disk({});
    expect(await judgeImage('data:image/png;base64,AAAA', policy())).toEqual({ kind: 'keep' });
  });

  it('refuses a picture too large to carry', async () => {
    const big = new Uint8Array(8 * 1024 * 1024 + 1);
    const { policy } = disk({ '/vault/notes/big.png': big });
    expect(await judgeImage('big.png', policy())).toEqual({ kind: 'refuse', why: 'too-large' });
  });
});

const image = (url: string) => ({ t: 'Image', c: [['', [], []], [{ t: 'Str', c: 'alt' }], [url, '']] });
const documentWith = (...urls: string[]) => ({
  'pandoc-api-version': [1, 23, 1],
  meta: {},
  blocks: urls.map((url) => ({ t: 'Para', c: [image(url)] })),
});

describe('vetDocumentImages', () => {
  it('rewrites allowed pictures to data and lists every refused one', async () => {
    const { policy } = disk({ '/vault/notes/a.png': PNG });
    const ast = documentWith('a.png', '../../etc/b.png', 'https://example.com/c.png', '../../etc/b.png');
    const refused = await vetDocumentImages(ast, policy());
    expect(refused).toEqual([
      { source: '../../etc/b.png', why: 'outside-folder' },
      { source: 'https://example.com/c.png', why: 'remote' },
    ]);
    expect(ast.blocks[0].c[0].c[2][0]).toMatch(/^data:image\/png;base64,/);
  });

  it('finds pictures nested inside links, lists and tables', async () => {
    const { policy } = disk({});
    const nested = {
      'pandoc-api-version': [1, 23, 1],
      meta: {},
      blocks: [{ t: 'BulletList', c: [[{ t: 'Plain', c: [{ t: 'Link', c: [['', [], []], [image('/etc/x.png')], ['https://x', '']] }] }]] }],
    };
    expect(await vetDocumentImages(nested, policy())).toEqual([{ source: '/etc/x.png', why: 'outside-folder' }]);
  });

  it('stops inlining past the total budget and says so', async () => {
    const seven = new Uint8Array(7 * 1024 * 1024);
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 8; i += 1) files[`/vault/notes/${i}.png`] = seven;
    const { policy } = disk(files);
    const refused = await vetDocumentImages(documentWith(...Object.keys(files).map((f) => f.slice('/vault/notes/'.length))), policy());
    expect(refused).toEqual([
      { source: '6.png', why: 'too-large' },
      { source: '7.png', why: 'too-large' },
    ]);
  });
});

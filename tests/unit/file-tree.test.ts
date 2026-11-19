import { describe, expect, it } from 'vitest';
import { sortEntries } from '../../src/main/workspace/file-tree';

describe('the order of a folder', () => {
  const entry = (name: string, kind: 'file' | 'directory', modifiedMs: number) =>
    ({ name, path: `/vault/${name}`, kind, modifiedMs });

  const rows = () => [
    entry('beta.md', 'file', 300),
    entry('Alpha.md', 'file', 100),
    entry('zeta', 'directory', 50),
    entry('mid.md', 'file', 200),
    entry('archive', 'directory', 400),
  ];

  const names = (order: Parameters<typeof sortEntries>[1]) =>
    sortEntries(rows(), order).map((row) => row.name);

  it('keeps folders at the top whatever the order', () => {
    for (const order of ['name', 'name-desc', 'modified', 'modified-old'] as const) {
      expect(names(order).slice(0, 2).sort()).toEqual(['archive', 'zeta']);
    }
  });

  it('sorts by name in both directions, ignoring case', () => {
    expect(names('name')).toEqual(['archive', 'zeta', 'Alpha.md', 'beta.md', 'mid.md']);
    expect(names('name-desc')).toEqual(['zeta', 'archive', 'mid.md', 'beta.md', 'Alpha.md']);
  });

  it('sorts by when a file was last written, newest or oldest first', () => {
    expect(names('modified').slice(2)).toEqual(['beta.md', 'mid.md', 'Alpha.md']);
    expect(names('modified-old').slice(2)).toEqual(['Alpha.md', 'mid.md', 'beta.md']);
  });

  it('falls back to the name when two were written in the same millisecond', () => {
    const same = [entry('b.md', 'file', 7), entry('a.md', 'file', 7)];
    expect(sortEntries(same, 'modified').map((row) => row.name)).toEqual(['a.md', 'b.md']);
  });
});

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { listDirectory } from '../../src/main/workspace/file-tree';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('listing a folder', () => {
  it('hides code files and pictures until includeCode is asked for', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'noto-tree-'));
    roots.push(root);
    await writeFile(path.join(root, 'note.md'), '# hi\n', 'utf8');
    await writeFile(path.join(root, 'main.ts'), 'console.log(1)\n', 'utf8');
    await writeFile(path.join(root, 'photo.png'), 'not really', 'utf8');
    await mkdir(path.join(root, 'src'));

    const plain = await listDirectory(root, root, 'name', false);
    expect(plain.map((row) => row.name).sort()).toEqual(['note.md', 'src']);

    const withCode = await listDirectory(root, root, 'name', true);
    // A picture is listed, and opens in the viewer as a picture.
    expect(withCode.map((row) => row.name).sort()).toEqual(['main.ts', 'note.md', 'photo.png', 'src']);
  });
});

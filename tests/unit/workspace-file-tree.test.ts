import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isInside, listDirectory, isEditableFile } from '../../src/main/workspace/file-tree';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A folder holding notes, a nested folder, and things that should be hidden. */
async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noto-tree-'));
  roots.push(root);
  await writeFile(path.join(root, 'beta.md'), '# Beta\n', 'utf8');
  await writeFile(path.join(root, 'alpha.md'), '# Alpha\n', 'utf8');
  await writeFile(path.join(root, 'notes.txt'), 'plain\n', 'utf8');
  await writeFile(path.join(root, 'image.png'), 'not markdown\n', 'utf8');
  await writeFile(path.join(root, 'sample.py'), 'print(1)\n', 'utf8');
  await writeFile(path.join(root, '.hidden.md'), 'secret\n', 'utf8');
  await mkdir(path.join(root, 'chapters'));
  await writeFile(path.join(root, 'chapters', 'one.md'), '# One\n', 'utf8');
  await mkdir(path.join(root, 'node_modules'));
  await writeFile(path.join(root, 'node_modules', 'noise.md'), 'noise\n', 'utf8');
  return root;
}

describe('listing a workspace folder', () => {
  it('shows markdown files and folders, directories first and alphabetical', async () => {
    const root = await workspace();
    const entries = await listDirectory(root, root);
    expect(entries.map((entry) => entry.name))
      .toEqual(['chapters', 'alpha.md', 'beta.md', 'notes.txt']);
    expect(entries[0].kind).toBe('directory');
  });


  it('lists viewable code files when asked', async () => {
    const root = await workspace();
    const without = (await listDirectory(root, root)).map((entry) => entry.name);
    expect(without).not.toContain('sample.py');
    const withCode = (await listDirectory(root, root, 'name', true)).map((entry) => entry.name);
    expect(withCode).toContain('sample.py');
    // A picture opens in the viewer as a picture, so it is listed with the code.
    expect(withCode).toContain('image.png');
  });

  it('leaves out files the editor cannot open', async () => {
    const root = await workspace();
    const names = (await listDirectory(root, root)).map((entry) => entry.name);
    expect(names).not.toContain('image.png');
  });

  it('leaves out dotfiles and dependency folders', async () => {
    const root = await workspace();
    const names = (await listDirectory(root, root)).map((entry) => entry.name);
    expect(names).not.toContain('.hidden.md');
    expect(names).not.toContain('node_modules');
  });

  it('lists one level only, so a large tree is not walked up front', async () => {
    const root = await workspace();
    const entries = await listDirectory(root, root);
    // The nested file is not present until its folder is asked for.
    expect(entries.map((entry) => entry.name)).not.toContain('one.md');
    expect((await listDirectory(root, path.join(root, 'chapters'))).map((entry) => entry.name))
      .toEqual(['one.md']);
  });

  it('refuses a target outside the root', async () => {
    const root = await workspace();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'noto-outside-'));
    roots.push(outside);
    await writeFile(path.join(outside, 'private.md'), 'private\n', 'utf8');

    await expect(listDirectory(root, outside)).rejects.toThrow(/OUTSIDE_ROOT/);
    await expect(listDirectory(root, path.join(root, '..'))).rejects.toThrow(/OUTSIDE_ROOT/);
  });

  it('does not follow a symlink that points out of the root', async () => {
    const root = await workspace();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'noto-escape-'));
    roots.push(outside);
    await writeFile(path.join(outside, 'private.md'), 'private\n', 'utf8');
    await symlink(outside, path.join(root, 'escape'));

    const names = (await listDirectory(root, root)).map((entry) => entry.name);
    expect(names).not.toContain('escape');
    // And the link cannot be used as a route either.
    await expect(listDirectory(root, path.join(root, 'escape'))).rejects.toThrow(/OUTSIDE_ROOT/);
  });

  it('keeps a symlink that stays inside the root', async () => {
    const root = await workspace();
    await symlink(path.join(root, 'chapters'), path.join(root, 'shortcut'));
    const entries = await listDirectory(root, root);
    expect(entries.find((entry) => entry.name === 'shortcut')?.kind).toBe('directory');
  });

  it('reports an unreadable path rather than returning an empty folder', async () => {
    const root = await workspace();
    await expect(listDirectory(root, path.join(root, 'missing'))).rejects.toThrow(/UNREADABLE/);
  });
});

describe('containment check', () => {
  it('accepts the root itself and paths within it', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/b', '/a/b/c/d.md')).toBe(true);
  });

  it('rejects a sibling whose name merely starts the same', () => {
    // "/a/bc" must not count as inside "/a/b".
    expect(isInside('/a/b', '/a/bc')).toBe(false);
    expect(isInside('/a/b', '/a')).toBe(false);
    expect(isInside('/a/b', '/other')).toBe(false);
  });
});

describe('what the editor opens', () => {
  it('says yes to the markdown spellings and to plain text', () => {
    for (const name of ['a.md', 'a.markdown', 'a.mdown', 'a.mkd', 'a.txt', 'A.MD']) {
      expect(isEditableFile(`/vault/${name}`)).toBe(true);
    }
  });

  it('says no to source files and to anything with no extension', () => {
    for (const name of ['main.ts', 'run.py', 'a.json', 'a.png', 'Makefile', 'a.mdx']) {
      expect(isEditableFile(`/vault/${name}`)).toBe(false);
    }
  });
});

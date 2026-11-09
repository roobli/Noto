/**
 * The recent-files list: only what remember() is told, newest first, capped.
 *
 * Callers are responsible for invoking remember only after a successful open;
 * this store itself does not know about attempts. The dedupe that matters here
 * is that remembering the same path again moves it to the front rather than
 * listing it twice.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lastNoteInside, RecentFiles } from '../../src/main/workspace/recent-files';

describe('RecentFiles', () => {
  let directory: string;
  let store: RecentFiles;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function fresh(): Promise<RecentFiles> {
    directory = await mkdtemp(path.join(tmpdir(), 'noto-recent-'));
    store = new RecentFiles(path.join(directory, 'recent-files.json'));
    return store;
  }

  it('remembers a successful open at the front', async () => {
    const recent = await fresh();
    await recent.remember('/vault/a.md');
    await recent.remember('/vault/b.md');
    expect(recent.list().map((entry) => entry.path)).toEqual(['/vault/b.md', '/vault/a.md']);
    expect(recent.list()[0].name).toBe('b.md');
  });

  it('dedupes the same path instead of listing it twice', async () => {
    const recent = await fresh();
    await recent.remember('/vault/a.md');
    await recent.remember('/vault/b.md');
    await recent.remember('/vault/a.md');
    expect(recent.list().map((entry) => entry.path)).toEqual(['/vault/a.md', '/vault/b.md']);
  });

  it('forgets a path without touching the others', async () => {
    const recent = await fresh();
    await recent.remember('/vault/a.md');
    await recent.remember('/vault/b.md');
    await recent.forget('/vault/a.md');
    expect(recent.list().map((entry) => entry.path)).toEqual(['/vault/b.md']);
    await recent.forget('/vault/missing.md');
    expect(recent.list().map((entry) => entry.path)).toEqual(['/vault/b.md']);
  });

  it('persists across a fresh load', async () => {
    const recent = await fresh();
    await recent.remember('/vault/kept.md');
    const filePath = path.join(directory, 'recent-files.json');
    const reloaded = new RecentFiles(filePath);
    await reloaded.load();
    expect(reloaded.list().map((entry) => entry.path)).toEqual(['/vault/kept.md']);
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as unknown[];
    expect(raw).toHaveLength(1);
  });

  it('keeps the listed files when a remember arrives mid-read', async () => {
    // A remember during the first load's read used to see an empty list, write
    // just itself, and lose every file already listed.
    const first = await fresh();
    await first.remember('/notes/a.md');
    const reopened = new RecentFiles(path.join(directory, 'recent-files.json'));
    const loading = reopened.load();
    const remembering = reopened.remember('/notes/b.md');
    await Promise.all([loading, remembering]);
    expect(reopened.list().map((entry) => entry.path)).toEqual(['/notes/b.md', '/notes/a.md']);
    const onDisk = JSON.parse(await readFile(path.join(directory, 'recent-files.json'), 'utf8')) as { path: string }[];
    expect(onDisk.map((entry) => entry.path)).toEqual(['/notes/b.md', '/notes/a.md']);
  });
});

describe('the note to reopen with a folder', () => {
  // Daily-use audit finding 9: launching put the folder back and no note.
  it('is the newest recent note inside the folder that is still there', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noto-last-note-'));
    try {
      const { mkdir, writeFile } = await import('node:fs/promises');
      await mkdir(path.join(root, 'vault', '..drafts'), { recursive: true });
      const inside = path.join(root, 'vault', 'a.md');
      const dotted = path.join(root, 'vault', '..drafts', 'b.md');
      const outside = path.join(root, 'elsewhere.md');
      const gone = path.join(root, 'vault', 'gone.md');
      await writeFile(inside, '# a\n');
      await writeFile(dotted, '# b\n');
      await writeFile(outside, '# c\n');
      const entry = (file: string, openedAt: number) => ({ path: file, name: path.basename(file), openedAt });
      const vault = path.join(root, 'vault');
      expect(await lastNoteInside([entry(outside, 9), entry(gone, 8), entry(inside, 7)], vault)).toBe(inside);
      expect(await lastNoteInside([entry(inside, 1), entry(dotted, 2)], vault)).toBe(dotted);
      expect(await lastNoteInside([entry(outside, 3)], vault)).toBeNull();
      expect(await lastNoteInside([entry(path.join(vault, 'pic.png'), 3)], vault)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

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
import { RecentFiles } from '../../src/main/workspace/recent-files';

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

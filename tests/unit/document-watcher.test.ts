import { mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocumentWatcher } from '../../src/main/file-truth/v1/document-watcher';

const roots: string[] = [];
const watchers: DocumentWatcher[] = [];

afterEach(async () => {
  watchers.splice(0).forEach((watcher) => watcher.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; file: string }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noto-watch-')));
  roots.push(root);
  const file = path.join(root, 'note.md');
  await writeFile(file, '# Note\n');
  return { root, file };
}

/** Long enough for the trailing report, which exists so a burst is one report. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 700));

/** Real time, for letting the file system's events arrive while the watcher's timers are fake. */
const realSetTimeout = globalThis.setTimeout;

function armed(file: string): { watcher: DocumentWatcher; counted: () => number } {
  let count = 0;
  const watcher = new DocumentWatcher({ onChanged: () => { count += 1; } });
  watchers.push(watcher);
  watcher.arm(file);
  return { watcher, counted: () => count };
}

describe('DocumentWatcher', () => {
  it('reports a write in place', async () => {
    const { file } = await fixture();
    const { counted } = armed(file);
    await writeFile(file, '# Changed\n');
    await settle();
    expect(counted()).toBe(1);
  });

  it('keeps working after the file is replaced by a rename, which plain fs.watch does not', async () => {
    const { root, file } = await fixture();
    const { counted } = armed(file);

    // This is the whole reason the class exists. A rename over the path leaves
    // fs.watch holding a file nothing points at, and it never fires again: no
    // error, no close, just silence. Every save this app performs is a rename.
    for (const line of ['one', 'two', 'three']) {
      const temp = path.join(root, `${line}.tmp`);
      await writeFile(temp, `# ${line}\n`);
      await rename(temp, file);
      await settle();
    }
    expect(counted()).toBe(3);
  });

  it('reports a burst of writes once', async () => {
    const { file } = await fixture();
    // What a program streaming a file out looks like. Reading between two of
    // its writes would give half a document. The settle timer is held still
    // until every write has been heard: on a loaded CI host two writes in a
    // row can land further apart than the settle, and the second report that
    // follows says something about the host, not the watcher.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { counted } = armed(file);
      for (let i = 0; i < 10; i += 1) {
        await writeFile(file, `# Note\n\n${'x'.repeat(i * 100)}\n`);
      }
      await new Promise((resolve) => realSetTimeout(resolve, 100));
      expect(counted()).toBe(0);
      vi.advanceTimersByTime(300);
      expect(counted()).toBe(1);
      vi.advanceTimersByTime(2_000);
      expect(counted()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still reports while a writer keeps going, rather than waiting for it to stop', async () => {
    const { file } = await fixture();
    const { counted } = armed(file);
    const until = Date.now() + 2_600;
    while (Date.now() < until) {
      await writeFile(file, `# Note\n\n${Date.now()}\n`);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    // The ceiling is what stops a continuous writer from pushing the report
    // back forever and the reader never being told anything changed.
    expect(counted()).toBeGreaterThanOrEqual(1);
  });

  it('reports the file being deleted', async () => {
    const { file } = await fixture();
    const { counted } = armed(file);
    await rm(file);
    await settle();
    expect(counted()).toBeGreaterThanOrEqual(1);
  });

  it('says nothing after it is closed', async () => {
    const { file } = await fixture();
    const { watcher, counted } = armed(file);
    watcher.close();
    expect(watcher.watching).toBe(false);
    await writeFile(file, '# Changed\n');
    await settle();
    expect(counted()).toBe(0);
  });

  it('says nothing while suspended, and hears again once re-armed', async () => {
    const { root, file } = await fixture();
    const { watcher, counted } = armed(file);

    // What a save does: suspend, replace the file by rename, then re-arm.
    watcher.suspend();
    const temp = path.join(root, 'saved.tmp');
    await writeFile(temp, '# Saved by us\n');
    await rename(temp, file);
    await settle();
    expect(counted()).toBe(0);

    watcher.rearm();
    await writeFile(file, '# Changed by somebody else\n');
    await settle();
    expect(counted()).toBe(1);
  });

  it('watching one file at a time, so arming again drops the last', async () => {
    const { root, file } = await fixture();
    const other = path.join(root, 'other.md');
    await writeFile(other, '# Other\n');
    const { watcher, counted } = armed(file);
    watcher.arm(other);
    await writeFile(file, '# The one it is no longer watching\n');
    await settle();
    expect(counted()).toBe(0);
    await writeFile(other, '# The one it is watching\n');
    await settle();
    expect(counted()).toBe(1);
  });
});

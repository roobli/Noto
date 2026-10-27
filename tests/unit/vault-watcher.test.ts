import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  VaultWatcher,
  classifyTouched,
  inspectTouched,
  touchedPath,
  type WatchRoot,
} from '../../src/main/workspace/vault-watcher';

const watchers: VaultWatcher[] = [];
const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  watchers.splice(0).forEach((watcher) => watcher.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A watcher fed by hand, so the timing is the test's. */
function driven(options: { maxTouched?: number } = {}) {
  let emit: (name: string | null) => void = () => {};
  let fail: (error: unknown) => void = () => {};
  const settled: Array<readonly string[] | null> = [];
  const watchRoot: WatchRoot = (_root, onChange, onError) => {
    emit = onChange;
    fail = onError;
    return () => { emit = () => {}; };
  };
  const watcher = new VaultWatcher({ onSettled: (touched) => settled.push(touched), watchRoot, ...options });
  watchers.push(watcher);
  watcher.open('/vault');
  return { watcher, settled, emit: (name: string | null) => emit(name), fail: (error: unknown) => fail(error) };
}

describe('VaultWatcher', () => {
  it('settles a burst once, after the folder goes quiet, with every name it touched', () => {
    vi.useFakeTimers();
    const { settled, emit } = driven();
    emit('a.md');
    vi.advanceTimersByTime(100);
    emit(path.join('notes', 'b.md'));
    emit('a.md');
    vi.advanceTimersByTime(200);
    expect(settled).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(settled).toHaveLength(1);
    expect([...(settled[0] ?? [])].sort()).toEqual(['a.md', 'notes/b.md']);
  });

  it('answers within the longest wait even while events keep coming', () => {
    vi.useFakeTimers();
    const { settled, emit } = driven();
    for (let elapsed = 0; elapsed < 2_000; elapsed += 100) {
      emit(`n${elapsed}.md`);
      vi.advanceTimersByTime(100);
    }
    expect(settled).toHaveLength(1);
    expect(settled[0]).toHaveLength(20);
  });

  it('says it lost track after a nameless event or too many names', () => {
    vi.useFakeTimers();
    const nameless = driven();
    nameless.emit('a.md');
    nameless.emit(null);
    vi.advanceTimersByTime(300);
    expect(nameless.settled).toEqual([null]);

    const flood = driven({ maxTouched: 3 });
    for (const name of ['a.md', 'b.md', 'c.md', 'd.md']) flood.emit(name);
    vi.advanceTimersByTime(300);
    expect(flood.settled).toEqual([null]);
  });

  it('ignores version control and dependency churn entirely', () => {
    vi.useFakeTimers();
    const { settled, emit } = driven();
    emit(path.join('.git', 'index'));
    emit(path.join('tool', 'node_modules', 'x', 'index.js'));
    vi.advanceTimersByTime(3_000);
    expect(settled).toEqual([]);
  });

  it('drops what had not settled when closed, and stops after the watch fails', () => {
    vi.useFakeTimers();
    const closed = driven();
    closed.emit('a.md');
    closed.watcher.close();
    vi.advanceTimersByTime(3_000);
    expect(closed.settled).toEqual([]);

    const failed = driven();
    failed.fail(new Error('EMFILE'));
    failed.emit('a.md');
    vi.advanceTimersByTime(3_000);
    expect(failed.settled).toEqual([]);
  });

  it('reports a folder moved inside the vault on the real filesystem', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noto-vault-')));
    roots.push(root);
    await mkdir(path.join(root, 'proj', 'design'), { recursive: true });
    await mkdir(path.join(root, 'B000'));
    for (let i = 0; i < 50; i += 1) await writeFile(path.join(root, 'proj', 'design', `n${i}.md`), `# n${i}\n`);
    const settled: Array<readonly string[] | null> = [];
    const watcher = new VaultWatcher({ onSettled: (touched) => settled.push(touched), quietMs: 150 });
    watchers.push(watcher);
    watcher.open(root);
    // The creations above may still be in flight on some systems; let them pass first.
    await new Promise((resolve) => setTimeout(resolve, 400));
    settled.length = 0;
    await rename(path.join(root, 'proj'), path.join(root, 'B000', 'proj'));
    await vi.waitFor(() => expect(settled.length).toBeGreaterThan(0), { timeout: 5_000, interval: 50 });
    const touched = settled.flatMap((batch) => batch ?? ['(unknown)']);
    expect(touched.some((name) => name === 'proj' || name === 'B000/proj' || name.startsWith('B000/proj/') || name === '(unknown)')).toBe(true);
  });
});

describe('touchedPath', () => {
  it('normalizes to forward slashes and drops ignored folders', () => {
    expect(touchedPath(path.join('A', 'b.md'))).toBe('A/b.md');
    expect(touchedPath(path.join('.git', 'HEAD'))).toBeNull();
    expect(touchedPath('')).toBeNull();
  });
});

describe('classifyTouched', () => {
  const showable = (relative: string, kind: 'file' | 'directory') => kind === 'directory' || relative.endsWith('.md');

  it('reads an atomic save as a text change, not a structural one', () => {
    const known = (relative: string) => relative === 'notes/a.md';
    const change = classifyTouched([
      { path: 'notes/.noto-ft1-a.tmp', kind: null },
      { path: 'notes/a.md.tmp-1f2e', kind: null },
      { path: 'notes/a.md', kind: 'file' },
    ], known, showable);
    expect(change).toEqual({ structural: false, notes: true });
  });

  it('calls a new note, a gone note and a moved folder structural', () => {
    const known = (relative: string) => relative === 'notes/a.md' || relative === 'proj';
    expect(classifyTouched([{ path: 'notes/b.md', kind: 'file' }], known, showable).structural).toBe(true);
    expect(classifyTouched([{ path: 'notes/a.md', kind: null }], known, showable).structural).toBe(true);
    expect(classifyTouched([
      { path: 'proj', kind: null },
      { path: 'B000/proj', kind: 'directory' },
    ], known, showable).structural).toBe(true);
  });

  it('ignores files the tree would never show', () => {
    const change = classifyTouched([{ path: 'notes/picture.png', kind: 'file' }], () => false, showable);
    expect(change).toEqual({ structural: false, notes: false });
  });
});

describe('inspectTouched', () => {
  it('tells a file from a folder from something gone', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noto-vault-')));
    roots.push(root);
    await mkdir(path.join(root, 'dir'));
    await writeFile(path.join(root, 'a.md'), '# a\n');
    expect(await inspectTouched(root, ['a.md', 'dir', 'gone.md'])).toEqual([
      { path: 'a.md', kind: 'file' },
      { path: 'dir', kind: 'directory' },
      { path: 'gone.md', kind: null },
    ]);
  });
});

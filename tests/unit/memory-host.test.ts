/**
 * Main's hold on the folder's memory: nothing is opened for a folder without
 * `.noto/`, nor for one whose scripts the person has not allowed; the first
 * question opens it and says so, the window is told when it is ready, answers
 * come by message, changes on disk are gathered into one refresh that keeps
 * what it could not read, a worker that dies is reported rather than waited
 * on and tried again after a pause, and a worker is let close its index
 * before it is stopped. The vault's own answers are the vault's tests; here
 * the worker is a fake.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { MemoryHost, insideFolder, memoryWorkerPath, type MemoryWorker } from '../../src/main/workspace/memory-host';
import { MemoryTrust, memoryScripts } from '../../src/main/workspace/memory-trust';
import { isWorkspaceKeepMemoryReplyV1, isWorkspaceNoteMemoryReplyV1, isWorkspaceTrustMemoryReplyV1 } from '../../src/shared/workspace/v1/validate';
import type { MemoryAnswer, MemoryRequest } from '../../src/vault-worker/vault-worker';
import { MEMORY } from './memory-fixture';

const made: string[] = [];
afterAll(() => { for (const directory of made) rmSync(directory, { recursive: true, force: true }); });

function folder(withMemory: boolean, scripts: readonly string[] = []): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'noto-memory-')));
  made.push(root);
  if (withMemory) mkdirSync(path.join(root, '.noto'));
  if (scripts.length > 0) {
    mkdirSync(path.join(root, '.noto', 'scripts'), { recursive: true });
    for (const name of scripts) writeFileSync(path.join(root, '.noto', 'scripts', name), 'export default {};\n');
  }
  return root;
}


/** A worker that answers as the test says, when the test says. */
class FakeWorker implements MemoryWorker {
  readonly asked: MemoryRequest[] = [];
  private readonly listeners: Record<string, ((value: never) => void)[]> = {};
  terminated = false;
  postMessage(request: MemoryRequest): void { this.asked.push(request); }
  on(event: string, listener: (value: never) => void): void { (this.listeners[event] ??= []).push(listener); }
  terminate(): void { this.terminated = true; }
  reply(answer: MemoryAnswer): void { for (const listener of this.listeners.message ?? []) listener(answer as never); }
  die(): void { for (const listener of this.listeners.exit ?? []) listener(1 as never); }
  last(kind: MemoryRequest['kind']): MemoryRequest { return [...this.asked].reverse().find((request) => request.kind === kind)!; }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the memory in main', () => {
  /** The worker started last; `workers` holds every one. */
  let worker: FakeWorker;
  let workers: FakeWorker[];
  let changed: Mock<() => void>;
  let host: MemoryHost;
  beforeEach(() => {
    worker = new FakeWorker();
    workers = [];
    changed = vi.fn<() => void>();
    host = new MemoryHost({
      startWorker: () => {
        if (workers.length > 0) worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      onChanged: changed,
    });
  });
  afterEach(() => host.dispose());

  it('never opens a folder without memory, nor a note outside the folder', async () => {
    const root = folder(false);
    host.setFolder(root);
    expect((await host.about(path.join(root, 'a.md'))).state).toBe('no-memory');
    expect((await host.about('/elsewhere/a.md')).state).toBe('outside');
    expect(worker.asked).toEqual([]);
  });

  it('opens on the first question, says so, and answers once it is open', async () => {
    const root = folder(true);
    host.setFolder(root);
    expect((await host.about(path.join(root, 'a.md'))).state).toBe('opening');
    const open = worker.last('open');
    expect(open).toMatchObject({ kind: 'open', root });
    changed.mockClear();
    worker.reply({ id: open.id, ok: true, value: { notes: 2 } });
    await flush();
    expect(changed).toHaveBeenCalledTimes(1);
    const asking = host.about(path.join(root, 'a.md'));
    await flush();
    const about = worker.last('about');
    expect(about).toMatchObject({ kind: 'about', rel: 'a.md' });
    worker.reply({ id: about.id, ok: true, value: MEMORY });
    const answer = await asking;
    expect(answer.state).toBe('ok');
    expect(isWorkspaceNoteMemoryReplyV1(answer)).toBe(true);
  });

  it('says a note it does not hold is unknown, and a worker that dies, unavailable', async () => {
    const root = folder(true);
    host.setFolder(root);
    await host.about(path.join(root, 'a.md'));
    worker.reply({ id: worker.last('open').id, ok: true, value: null });
    await flush();
    const asking = host.about(path.join(root, 'new.md'));
    await flush();
    worker.reply({ id: worker.last('about').id, ok: false, error: 'There is no note new.md.', unknown: true });
    expect((await asking).state).toBe('unknown');
    const waiting = host.about(path.join(root, 'a.md'));
    await flush();
    worker.die();
    expect((await waiting).state).toBe('unavailable');
    expect((await host.about(path.join(root, 'a.md'))).state).toBe('unavailable');
  });

  it('gathers changes on disk into one refresh, and tells the window only when something moved', async () => {
    vi.useFakeTimers();
    try {
      const root = folder(true);
      host.setFolder(root);
      await host.about(path.join(root, 'a.md'));
      worker.reply({ id: worker.last('open').id, ok: true, value: null });
      await vi.advanceTimersByTimeAsync(0);
      changed.mockClear();
      host.changed(['a.md']);
      host.changed(['b.md']);
      await vi.advanceTimersByTimeAsync(2_000);
      const refresh = worker.last('refresh');
      expect(refresh).toMatchObject({ kind: 'refresh', paths: ['a.md', 'b.md'] });
      worker.reply({ id: refresh.id, ok: true, value: { parsed: 0, events: 0, removed: 0, moved: 0 } });
      await vi.advanceTimersByTimeAsync(0);
      expect(changed).not.toHaveBeenCalled();
      host.changed(null);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(worker.last('refresh')).toMatchObject({ paths: null });
      worker.reply({ id: worker.last('refresh').id, ok: true, value: { parsed: 1 } });
      await vi.advanceTimersByTimeAsync(0);
      expect(changed).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets the worker close the index of a folder it leaves, then stops it, and has the window ask again', async () => {
    vi.useFakeTimers();
    try {
      const root = folder(true);
      host.setFolder(root);
      await host.about(path.join(root, 'a.md'));
      const first = worker;
      changed.mockClear();
      host.setFolder(folder(false));
      expect(changed).toHaveBeenCalledTimes(1);
      const close = first.last('close');
      expect(close).toBeDefined();
      expect(first.terminated).toBe(false);
      first.reply({ id: close.id, ok: true, value: null });
      expect(first.terminated).toBe(true);
      // One that never answers is stopped anyway.
      const other = folder(true);
      host.setFolder(other);
      await host.about(path.join(other, 'a.md'));
      const second = worker;
      host.setFolder(null);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(second.terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens a folder whose memory runs scripts only once they are allowed', async () => {
    const root = folder(true, ['10-mine.mjs']);
    let allowed = false;
    const guarded = new MemoryHost({ startWorker: () => worker, onChanged: changed, mayOpen: () => allowed });
    try {
      guarded.setFolder(root);
      expect((await guarded.about(path.join(root, 'a.md'))).state).toBe('untrusted');
      expect(worker.asked).toEqual([]);
      allowed = true;
      expect((await guarded.about(path.join(root, 'a.md'))).state).toBe('opening');
      // With no way to ask at all, scripts keep it shut.
      host.setFolder(root);
      expect((await host.about(path.join(root, 'a.md'))).state).toBe('untrusted');
    } finally {
      guarded.dispose();
    }
  });

  it('tries a memory that failed again after a pause that grows, and tells the window when', async () => {
    vi.useFakeTimers();
    try {
      const root = folder(true);
      host.setFolder(root);
      await host.about(path.join(root, 'a.md'));
      worker.reply({ id: worker.last('open').id, ok: false, error: 'The index is damaged.' });
      await vi.advanceTimersByTimeAsync(0);
      // Its worker is let go, and the answer is unavailable until the pause is over.
      expect(worker.last('close')).toBeDefined();
      expect((await host.about(path.join(root, 'a.md'))).state).toBe('unavailable');
      expect(workers).toHaveLength(1);
      changed.mockClear();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(changed).toHaveBeenCalledTimes(1);
      expect((await host.about(path.join(root, 'a.md'))).state).toBe('opening');
      expect(workers).toHaveLength(2);
      // A second failure waits twice as long.
      worker.die();
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await host.about(path.join(root, 'a.md'))).state).toBe('unavailable');
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await host.about(path.join(root, 'a.md'))).state).toBe('opening');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps what a failed refresh did not read, and runs one more after a refresh rather than piling them up', async () => {
    vi.useFakeTimers();
    try {
      const root = folder(true);
      host.setFolder(root);
      await host.about(path.join(root, 'a.md'));
      worker.reply({ id: worker.last('open').id, ok: true, value: null });
      await vi.advanceTimersByTimeAsync(0);
      host.changed(['a.md']);
      await vi.advanceTimersByTimeAsync(2_000);
      const first = worker.last('refresh');
      // Changes and ticks while it runs ask for one more, not one each.
      host.changed(['b.md']);
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(worker.asked.filter((request) => request.kind === 'refresh')).toHaveLength(1);
      worker.reply({ id: first.id, ok: false, error: 'The disk is busy.' });
      await vi.advanceTimersByTimeAsync(0);
      const second = worker.last('refresh');
      expect(second).not.toBe(first);
      expect(second).toMatchObject({ paths: expect.arrayContaining(['a.md', 'b.md']) });
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells the window again once a refresh is done, after an answer that timed out', async () => {
    vi.useFakeTimers();
    try {
      const root = folder(true);
      host.setFolder(root);
      await host.about(path.join(root, 'a.md'));
      worker.reply({ id: worker.last('open').id, ok: true, value: null });
      await vi.advanceTimersByTimeAsync(0);
      const asking = host.about(path.join(root, 'a.md'));
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await asking).state).toBe('unavailable');
      changed.mockClear();
      await vi.advanceTimersByTimeAsync(30_000);
      worker.reply({ id: worker.last('refresh').id, ok: true, value: { parsed: 0, events: 0 } });
      await vi.advanceTimersByTimeAsync(0);
      expect(changed).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts a note whose name begins with two dots as inside the folder', () => {
    expect(insideFolder('/v', '/v/..notes.md')).toBe('..notes.md');
    expect(insideFolder('/v', '/v/..x/a.md')).toBe('..x/a.md');
    expect(insideFolder('/v', '/v/../a.md')).toBeNull();
    expect(insideFolder('/v', '/v')).toBeNull();
  });

  it('finds its worker beside main, or unpacked from the archive', () => {
    expect(memoryWorkerPath(false, '/res', '/app/.vite/build')).toBe(path.join('/app/.vite/build', 'vault-worker.js'));
    expect(memoryWorkerPath(true, '/res', '/x')).toBe(path.join('/res', 'app.asar.unpacked', '.vite', 'build', 'vault-worker.js'));
  });
});

describe('which folders may run their memory\'s scripts', () => {
  it('lets a folder with no scripts open, and one with them only once allowed, remembered across launches', () => {
    const data = folder(false);
    const file = path.join(data, 'nested', 'memory-trust.json');
    const plain = folder(true);
    const scripted = folder(true, ['20-b.mjs', '10-a.js', 'notes.txt']);
    expect(memoryScripts(scripted)).toEqual(['10-a.js', '20-b.mjs']);
    const trust = new MemoryTrust(file);
    expect(trust.mayOpen(plain)).toBe(true);
    expect(trust.mayOpen(scripted)).toBe(false);
    trust.trust(scripted);
    expect(trust.mayOpen(scripted)).toBe(true);
    expect(new MemoryTrust(file).mayOpen(scripted)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, folders: [scripted] });
  });

  it('trusts nothing from a record it cannot read', () => {
    const data = folder(false);
    const file = path.join(data, 'memory-trust.json');
    const scripted = folder(true, ['a.mjs']);
    writeFileSync(file, '{ not json');
    expect(new MemoryTrust(file).mayOpen(scripted)).toBe(false);
    writeFileSync(file, JSON.stringify({ version: 1, folders: ['relative/path', scripted] }));
    expect(new MemoryTrust(file).mayOpen(scripted)).toBe(true);
    writeFileSync(file, JSON.stringify({ version: 2, folders: [scripted] }));
    expect(new MemoryTrust(file).mayOpen(scripted)).toBe(false);
  });
});

describe('what the window accepts of the memory', () => {
  it('takes what keeping and trusting answered, and nothing else', () => {
    expect(isWorkspaceKeepMemoryReplyV1({ version: 1, outcome: 'made', made: ['.noto/brain.yaml'] })).toBe(true);
    expect(isWorkspaceKeepMemoryReplyV1({ version: 1, outcome: 'cancelled', made: [] })).toBe(true);
    expect(isWorkspaceKeepMemoryReplyV1({ version: 1, outcome: 'cancelled', made: ['.noto/brain.yaml'] })).toBe(false);
    expect(isWorkspaceKeepMemoryReplyV1({ version: 1, outcome: 'maybe', made: [] })).toBe(false);
    expect(isWorkspaceKeepMemoryReplyV1({ version: 1, made: null })).toBe(false);
    expect(isWorkspaceTrustMemoryReplyV1({ version: 1, trusted: true })).toBe(true);
    expect(isWorkspaceTrustMemoryReplyV1({ version: 1, trusted: 'yes' })).toBe(false);
    expect(isWorkspaceNoteMemoryReplyV1({ version: 1, state: 'untrusted', memory: null })).toBe(true);
  });

  it('takes a whole answer and refuses a malformed one', () => {
    expect(isWorkspaceNoteMemoryReplyV1({ version: 1, state: 'ok', memory: MEMORY })).toBe(true);
    expect(isWorkspaceNoteMemoryReplyV1({ version: 1, state: 'no-memory', memory: null })).toBe(true);
    expect(isWorkspaceNoteMemoryReplyV1({ version: 1, state: 'ok', memory: null })).toBe(false);
    expect(isWorkspaceNoteMemoryReplyV1({ version: 1, state: 'ok', memory: { ...MEMORY, kind: { value: 'note', from: 'somewhere' } } })).toBe(false);
    expect(isWorkspaceNoteMemoryReplyV1({ version: 1, state: 'ok', memory: { ...MEMORY, extra: 1 } })).toBe(false);
  });
});

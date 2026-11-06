/**
 * Review in main and in its words: requests go to a second worker that reads
 * the index the first one keeps, only once the memory is open; what the
 * window may send and accept back is checked by action; and what a write
 * did is said in one sentence that names what it left alone.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryHost, type MemoryWorker } from '../../src/main/workspace/memory-host';
import { isWorkspaceReviewReplyV1, isWorkspaceReviewRequestV1 } from '../../src/shared/workspace/v1/validate';
import type { MemoryAnswer, MemoryRequest } from '../../src/vault-worker/vault-worker';
import { acceptWords, linkWords, proposalDetail, undoWords } from '../../src/renderer/plugins/bundled/memory/review-words';
import { positionOf, step, type Queue } from '../../src/renderer/plugins/bundled/memory/review-queue';

const made: string[] = [];
afterAll(() => { for (const directory of made) rmSync(directory, { recursive: true, force: true }); });

function folder(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'noto-review-')));
  made.push(root);
  mkdirSync(path.join(root, '.noto'));
  return root;
}

class FakeWorker implements MemoryWorker {
  readonly asked: MemoryRequest[] = [];
  private readonly listeners: Record<string, ((value: never) => void)[]> = {};
  terminated = false;
  postMessage(request: MemoryRequest): void { this.asked.push(request); }
  on(event: string, listener: (value: never) => void): void { (this.listeners[event] ??= []).push(listener); }
  terminate(): void { this.terminated = true; }
  reply(answer: MemoryAnswer): void { for (const listener of this.listeners.message ?? []) listener(answer as never); }
  last(kind: MemoryRequest['kind']): MemoryRequest { return [...this.asked].reverse().find((request) => request.kind === kind)!; }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Review in main', () => {
  let workers: FakeWorker[];
  let host: MemoryHost;
  beforeEach(() => {
    workers = [];
    host = new MemoryHost({ startWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker; }, onChanged: vi.fn() });
  });
  afterEach(() => host.dispose());

  /** The memory opened by its first worker, as Note Info would have it. */
  async function opened(): Promise<string> {
    const root = folder();
    host.setFolder(root);
    expect((await host.review({ kind: 'dismissals' })).state).toBe('opening');
    workers[0]!.reply({ id: workers[0]!.last('open').id, ok: true, value: null });
    await flush();
    return root;
  }

  it('asks a second worker, opened on the same index without refreshing it, only once the memory is open', async () => {
    const root = await opened();
    const asking = host.review({ kind: 'summary', counted: ['stale'] });
    await flush();
    expect(workers).toHaveLength(2);
    const reader = workers[1]!;
    expect(reader.last('open')).toMatchObject({ kind: 'open', root, refresh: false });
    reader.reply({ id: reader.last('open').id, ok: true, value: null });
    await flush();
    reader.reply({ id: reader.last('summary').id, ok: true, value: { proposals: [], counts: { stale: 0, mention: null, together: null }, dismissed: 0 } });
    expect(await asking).toMatchObject({ state: 'ok', error: null });
    // The first worker answers Note Info alone; Review never reaches it.
    expect(workers[0]!.asked.map((request) => request.kind)).toEqual(['open']);
  });

  it('says why when the memory answers with an error, and that it is out of reach when it is', async () => {
    await opened();
    const asking = host.review({ kind: 'reject', proposal: 'nope' });
    await flush();
    const reader = workers[1]!;
    reader.reply({ id: reader.last('open').id, ok: true, value: null });
    await flush();
    reader.reply({ id: reader.last('reject').id, ok: false, error: 'There is no proposal nope.' });
    expect(await asking).toEqual({ state: 'failed', value: null, error: 'There is no proposal nope.' });
  });

  it('tells the reader its lists are stale when the notes change, not when they are only read', async () => {
    vi.useFakeTimers();
    try {
      const root = folder();
      host.setFolder(root);
      await host.review({ kind: 'dismissals' });
      workers[0]!.reply({ id: workers[0]!.last('open').id, ok: true, value: null });
      await vi.advanceTimersByTimeAsync(0);
      void host.review({ kind: 'dismissals' });
      await vi.advanceTimersByTimeAsync(0);
      const reader = workers[1]!;
      reader.reply({ id: reader.last('open').id, ok: true, value: null });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30_000);
      workers[0]!.reply({ id: workers[0]!.last('refresh').id, ok: true, value: { parsed: 0, events: 4, removed: 0, moved: 0 } });
      await vi.advanceTimersByTimeAsync(0);
      expect(reader.asked.some((request) => request.kind === 'stale')).toBe(false);
      host.changed(['a.md']);
      await vi.advanceTimersByTimeAsync(2_000);
      workers[0]!.reply({ id: workers[0]!.last('refresh').id, ok: true, value: { parsed: 1, events: 0, removed: 0, moved: 0 } });
      await vi.advanceTimersByTimeAsync(0);
      expect(reader.last('stale')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the reader with the folder', async () => {
    await opened();
    void host.review({ kind: 'dismissals' });
    await flush();
    const reader = workers[1]!;
    host.setFolder(null);
    expect(reader.last('close')).toBeDefined();
  });
});

describe('what Review may send and accept back', () => {
  const request = (action: unknown) => ({ version: 1, requestId: 'memory-review-1', action });

  it('takes each action in its own shape and nothing else', () => {
    expect(isWorkspaceReviewRequestV1(request({ kind: 'summary', counted: ['stale', 'mention'] }))).toBe(true);
    expect(isWorkspaceReviewRequestV1(request({ kind: 'summary', counted: ['script'] }))).toBe(false);
    expect(isWorkspaceReviewRequestV1(request({ kind: 'suggestions', type: 'mention', offset: 0, limit: 40 }))).toBe(true);
    expect(isWorkspaceReviewRequestV1(request({ kind: 'suggestions', type: 'mention', offset: 0, limit: 5000 }))).toBe(false);
    expect(isWorkspaceReviewRequestV1(request({ kind: 'proposal-file', proposal: '20261105-094134-point-links', path: 'A/b.md' }))).toBe(true);
    expect(isWorkspaceReviewRequestV1(request({ kind: 'proposal-file', proposal: '20261105-094134-point-links', path: '../x.md' }))).toBe(false);
    expect(isWorkspaceReviewRequestV1(request({ kind: 'accept', proposal: '../../HEAD' }))).toBe(false);
    expect(isWorkspaceReviewRequestV1(request({ kind: 'link', type: 'mention', ids: ['a1b2c3d'] }))).toBe(true);
    // The kind is named, so the memory can work its list out again.
    expect(isWorkspaceReviewRequestV1(request({ kind: 'link', ids: ['a1b2c3d'] }))).toBe(false);
    expect(isWorkspaceReviewRequestV1(request({ kind: 'link', type: 'mention', ids: [] }))).toBe(false);
    expect(isWorkspaceReviewRequestV1(request({ kind: 'link', type: 'mention', ids: ['not-an-id'] }))).toBe(false);
    // A Fix All in a reorganized folder names thousands.
    const many = Array.from({ length: 3000 }, (_, n) => n.toString(16).padStart(7, '0'));
    expect(isWorkspaceReviewRequestV1(request({ kind: 'link', type: 'stale', ids: many }))).toBe(true);
    expect(isWorkspaceReviewRequestV1(request({ kind: 'dismiss', type: 'together', ids: ['a1b2c3d'] }))).toBe(true);
    expect(isWorkspaceReviewRequestV1(request({ kind: 'accept', proposal: 'a/../../HEAD' }))).toBe(false);
    expect(isWorkspaceReviewRequestV1(request({ kind: 'accept', proposal: 'made_by.another-tool' }))).toBe(true);
    expect(isWorkspaceReviewRequestV1(request({ kind: 'undismiss', ids: 'all' }))).toBe(true);
    // The window cannot say which notes are unsaved; main adds that itself.
    expect(isWorkspaceReviewRequestV1(request({ kind: 'undo', busy: [] }))).toBe(false);
    expect(isWorkspaceReviewRequestV1(request({ kind: 'write', path: 'a.md' }))).toBe(false);
  });

  it('accepts a reply only in the shape its action answers', () => {
    const ok = (value: unknown) => ({ version: 1, state: 'ok', value, error: null });
    expect(isWorkspaceReviewReplyV1(ok({ applied: ['a.md'], unchanged: [], conflicts: [], busy: [] }), 'accept')).toBe(true);
    expect(isWorkspaceReviewReplyV1(ok({ applied: ['a.md'], unchanged: [], conflicts: [], busy: [] }), 'link')).toBe(false);
    expect(isWorkspaceReviewReplyV1(ok(null), 'undo')).toBe(true);
    expect(isWorkspaceReviewReplyV1(ok(null), 'summary')).toBe(false);
    expect(isWorkspaceReviewReplyV1({ version: 1, state: 'failed', value: null, error: 'There is no proposal x.' }, 'reject')).toBe(true);
    expect(isWorkspaceReviewReplyV1({ version: 1, state: 'opening', value: { count: 1, missing: [] }, error: null }, 'dismiss')).toBe(false);
    expect(isWorkspaceReviewReplyV1(ok({ count: 0, missing: ['a1b2c3d'] }), 'dismiss')).toBe(true);
  });
});

describe('the queue', () => {
  const item = (n: number) => ({ id: n.toString(16).padStart(7, '0'), type: 'mention' as const, from: `n${n}.md`, to: 't.md', toTitle: 'T', score: 1, reason: '', line: 1, around: null });
  /** The memory's list, which drops what is linked or said no to, as the worker does. */
  function walk(size: number, page: number, gone: (n: number) => boolean): number[] {
    let list = Array.from({ length: size }, (_, n) => item(n));
    let queue: Queue = { kind: 'mention', items: list.slice(0, page), total: size, index: 0, fetched: Math.min(page, size) };
    const seen: number[] = [];
    for (let guard = 0; guard < size * 3; guard += 1) {
      const shown = queue.items[queue.index];
      if (!shown) break;
      const n = parseInt(shown.id, 16);
      seen.push(n);
      expect(positionOf(queue)).toBe(list.findIndex((entry) => entry.id === shown.id) + 1);
      const drop = gone(n);
      if (drop) list = list.filter((entry) => entry.id !== shown.id);
      const next = step(queue, drop);
      queue = next.fetch === null
        ? next.queue
        : { ...next.queue, items: list.slice(next.fetch, next.fetch + page), index: 0, fetched: next.fetch + list.slice(next.fetch, next.fetch + page).length };
    }
    return seen;
  }

  it('shows every suggestion once, however many on a page are linked or said no to', () => {
    // Every one linked: the next page starts where the list now is, not 39 further on.
    expect(walk(100, 40, () => true)).toEqual(Array.from({ length: 100 }, (_, n) => n));
    // Some linked, some skipped.
    expect(walk(100, 40, (n) => n % 3 !== 0)).toEqual(Array.from({ length: 100 }, (_, n) => n));
    expect(walk(7, 3, () => false)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe('what Review says a write did', () => {
  it('names what accepting took in, what it left, and why', () => {
    expect(acceptWords({ applied: ['A/one.md', 'B/two.md'], unchanged: [], conflicts: [], busy: [] })).toBe('Took in the changes to 2 notes.');
    expect(acceptWords({ applied: ['A/one.md'], unchanged: [], conflicts: ['B/two.md'], busy: [] }))
      .toBe('Took in the changes to 1 note; two changed since in a way that does not merge, so the proposal stays for it.');
    expect(acceptWords({ applied: [], unchanged: [], conflicts: [], busy: ['A/one.md'] })).toBe('Nothing taken in: save one first, which has unsaved edits.');
  });

  it('says how many of the asked were linked, and what was left and why', () => {
    expect(linkWords({ linked: ['a1b2c3d'], outdated: [], busy: [] }, 1)).toBe('Linked.');
    expect(linkWords({ linked: ['a1b2c3d', 'b2c3d4e'], outdated: ['c3d4e5f'], busy: ['d4e5f6a'] }, 4))
      .toBe('Linked 2 of 4; 1 had changed since and is left to be suggested again; 1 is in a note with unsaved edits.');
    expect(linkWords({ linked: [], outdated: [], busy: [] }, 1)).toBe('Nothing was linked.');
  });

  it('says what taking back put back, and what it left', () => {
    expect(undoWords(null)).toBe('There is nothing to take back.');
    expect(undoWords({ restored: ['A/one.md'], changed: ['B/two.md'], busy: [] })).toBe('Put 1 note back as it was; left two, written to since.');
    expect(undoWords({ restored: [], changed: [], busy: ['A/one.md'] })).toBe('Left one, with unsaved edits.');
  });

  it('says who proposed it, when, and which file is shown', () => {
    const now = new Date(2026, 10, 5, 15).getTime();
    const proposal = { id: 'x', subject: 'Fix', author: 'claude-code', time: new Date(2026, 10, 5, 9).toISOString(), files: [{ status: 'M', path: 'A/one.md' }, { status: 'A', path: 'B/two.md' }] };
    expect(proposalDetail(proposal, 1, now)).toBe('claude-code · today · file 2 of 2: B/two.md');
  });
});

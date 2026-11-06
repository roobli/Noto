/**
 * The open folder's memory, as main holds it.
 *
 * A folder keeps memory when it has a `.noto/` folder; one without it is
 * never written to and never opened here. The vault itself runs on a worker
 * thread (`src/vault-worker/vault-worker.ts`), started the first time Note
 * Info asks about a note in such a folder, so a window that never shows the
 * pane costs nothing. A folder whose memory runs scripts is opened only once
 * the person has allowed it (`memory-trust.ts`); until then the answer is
 * `untrusted`. While it opens (seconds, the first time, for a big folder) the
 * answer is `opening`, and `onChanged` fires once it is ready so the window
 * asks again. After that it is refreshed when notes change on disk and every
 * half minute, which takes in what was read in the meantime; an answer never
 * waits for a refresh to be asked for, and at most one waits behind the one
 * running. A memory that failed to open is tried again after a pause that
 * grows each time.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  NOTO_WORKSPACE_VERSION,
  type FolderMemoryV1,
  type NoteMemoryV1,
  type WorkspaceFolderMemoryReplyV1,
  type WorkspaceMemoryAskReplyV1,
  type WorkspaceNoteMemoryReplyV1,
  type WorkspaceReviewReplyV1,
} from '../../shared/workspace/v1/contracts';
import { memoryScripts } from './memory-trust';
import { MemoryError, WorkerLink, type MemoryWorker, type Unnumbered } from './memory-worker-link';

export { systemMemoryWorker, type MemoryWorker } from './memory-worker-link';

const ABOUT_TIMEOUT_MS = 5_000;
/** Opening builds the index the first time, which for a big folder is a while. */
const OPEN_TIMEOUT_MS = 180_000;
const REFRESH_EVERY_MS = 30_000;
const REFRESH_AFTER_CHANGE_MS = 1_500;
/** The first pause before a failed memory is tried again; it doubles, up to the cap. */
const RETRY_FIRST_MS = 30_000;
const RETRY_CAP_MS = 10 * 60_000;

type State = 'closed' | 'opening' | 'open' | 'failed';

export interface MemoryHostOptions {
  readonly startWorker: () => MemoryWorker;
  /** The window should ask again: the memory opened, changed, or the folder did. */
  readonly onChanged: () => void;
  /** Whether the folder's memory may be opened, scripts and all. Without it, only a folder with no scripts. */
  readonly mayOpen?: (root: string) => boolean;
  readonly log?: (event: string, fields: Record<string, unknown>) => void;
}

/** Where the bundled worker is, packaged or not. */
export function memoryWorkerPath(packaged: boolean, resourcesPath: string, here: string, file = 'vault-worker.js'): string {
  return packaged
    ? path.join(resourcesPath, 'app.asar.unpacked', '.vite', 'build', file)
    : path.join(here, file);
}

/** A path inside the folder, as the vault names notes, or null. */
export function insideFolder(root: string, file: string): string | null {
  const rel = path.relative(root, file);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/** Review's lists can take seconds (every mention in a big folder), on their own worker. */
const REVIEW_TIMEOUT_MS = 60_000;
/**
 * A write is never cut off: the worker finishes it whether or not anyone
 * waits, so waiting long beats telling the person it failed when it did not.
 * Linking a few thousand notes runs git for each.
 */
const REVIEW_WRITE_TIMEOUT_MS = 10 * 60_000;
const WRITES = new Set(['accept', 'reject', 'link', 'dismiss', 'undismiss', 'undo']);

/** A Review request as the worker takes it, main having added what has unsaved edits. */
export type ReviewRequest = Extract<Unnumbered, { kind: 'summary' | 'suggestions' | 'proposal-file' | 'accept' | 'reject' | 'link' | 'dismiss' | 'dismissals' | 'undismiss' | 'undo' | 'mentions' }>;

/** What the folder's memory answers a question with; see `WorkspaceMemoryAskReplyV1`. */
export type AskOutcome = Omit<WorkspaceMemoryAskReplyV1, 'version'>;

/** What the index holds, for Settings → Memory. */
export interface MemoryIndexStatus {
  readonly notes: number;
  readonly links: number;
  /** Lines in the read record: notes opened, by the person and by agents. */
  readonly reads: number;
  /** The index's files on disk. */
  readonly bytes: number;
  /** When it last took in the notes, as an ISO time. */
  readonly refreshed: string | null;
}

export type MemoryFolderState = 'outside' | 'no-memory' | 'untrusted' | 'opening' | 'open' | 'unavailable';

export interface ReviewOutcome {
  readonly state: WorkspaceReviewReplyV1['state'];
  readonly value: unknown;
  readonly error: string | null;
}

/** Without a way to ask, only a folder whose memory runs no scripts is opened. */
const runsNoScripts = (root: string): boolean => memoryScripts(root).length === 0;

export class MemoryHost {
  private root: string | null = null;
  private state: State = 'closed';
  private link: WorkerLink | null = null;
  /** The second worker, for Review: reads the first one's index, never refreshes it. */
  private reader: WorkerLink | null = null;
  private readerReady: Promise<WorkerLink> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private everyTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private touched: Set<string> | null = new Set();
  private refreshing = false;
  /** Another refresh was asked for while one ran. */
  private again = false;
  /** An answer timed out, so the window is told when the memory is free again. */
  private owed = false;
  private failures = 0;
  private retryAt = 0;
  /** Bumped by every stop, so work that waited across one knows the memory it started on is gone. */
  private generation = 0;
  /** The rebuild running, which a second ask joins rather than starting another. */
  private rebuilding: Promise<'ok' | 'outside' | 'no-memory' | 'untrusted' | 'failed'> | null = null;

  constructor(private readonly options: MemoryHostOptions) {}

  /** The folder the window shows, as its real path, or null. Closes the memory of the one before. */
  setFolder(root: string | null): void {
    if (root === this.root) return;
    this.stop();
    this.failures = 0;
    this.root = root;
    // Anything asked before the folder was known was told it is outside.
    this.options.onChanged();
  }

  folder(): string | null {
    return this.root;
  }

  /**
   * Whether the memory can answer now, opening it if it may be: null when it
   * is open, or the state to answer with. Note Info and Review both pass here,
   * so the scripts are asked about once, and the index built once.
   */
  private gate(root: string): Exclude<WorkspaceNoteMemoryReplyV1['state'], 'ok' | 'unknown'> | null {
    if (!existsSync(path.join(root, '.noto'))) return 'no-memory';
    if (this.state === 'failed' && Date.now() >= this.retryAt) this.state = 'closed';
    if (this.state === 'closed') {
      if (!(this.options.mayOpen ?? runsNoScripts)(root)) return 'untrusted';
      this.open(root);
    }
    if (this.state === 'opening') return 'opening';
    if (this.state === 'failed') return 'unavailable';
    return null;
  }

  /** What the memory knows about the note at `real`, a real path inside the folder. */
  async about(real: string): Promise<WorkspaceNoteMemoryReplyV1> {
    const reply = (state: WorkspaceNoteMemoryReplyV1['state'], memory: NoteMemoryV1 | null = null): WorkspaceNoteMemoryReplyV1 => ({
      version: NOTO_WORKSPACE_VERSION, state, memory,
    });
    const root = this.root;
    if (root === null) return reply('outside');
    const rel = insideFolder(root, real);
    if (rel === null) return reply('outside');
    const closed = this.gate(root);
    if (closed !== null) return reply(closed);
    try {
      const memory = await this.ask({ kind: 'about', rel }, ABOUT_TIMEOUT_MS) as NoteMemoryV1;
      return reply('ok', memory);
    } catch (error) {
      if (error instanceof MemoryError && error.unknown) return reply('unknown');
      this.owed = true;
      return reply('unavailable');
    }
  }

  /**
   * What the memory knows about the folder at `real`, a real directory: the
   * open folder itself or one inside it. Opens the memory as `about` does.
   */
  async aboutFolder(real: string): Promise<WorkspaceFolderMemoryReplyV1> {
    const reply = (state: WorkspaceFolderMemoryReplyV1['state'], memory: FolderMemoryV1 | null = null): WorkspaceFolderMemoryReplyV1 => ({
      version: NOTO_WORKSPACE_VERSION, state, memory,
    });
    const root = this.root;
    if (root === null) return reply('outside');
    const rel = path.relative(root, real) === '' ? '' : insideFolder(root, real);
    if (rel === null) return reply('outside');
    const closed = this.gate(root);
    if (closed !== null) return reply(closed);
    try {
      return reply('ok', await this.ask({ kind: 'folder', rel }, ABOUT_TIMEOUT_MS) as FolderMemoryV1);
    } catch {
      this.owed = true;
      return reply('unavailable');
    }
  }

  /**
   * How the memory stands, and what its index holds once it is open. Asking
   * opens it when it may be opened, as Note Info does: the person is looking
   * at the memory's own settings.
   */
  async status(): Promise<{ state: MemoryFolderState; index: MemoryIndexStatus | null }> {
    const root = this.root;
    if (root === null) return { state: 'outside', index: null };
    const closed = this.gate(root);
    if (closed !== null) return { state: closed, index: null };
    try {
      return { state: 'open', index: await this.ask({ kind: 'status' }, ABOUT_TIMEOUT_MS) as MemoryIndexStatus };
    } catch {
      this.owed = true;
      return { state: 'unavailable', index: null };
    }
  }

  /**
   * Build the index again from the notes: the workers let go of it, and a
   * new one empties it in place and reads everything in again. The notes and
   * the read record are not touched; the read record is read back in.
   * Meanwhile every answer is `opening`. Asked again while it runs, it is the
   * same rebuild.
   */
  rebuild(): Promise<'ok' | 'outside' | 'no-memory' | 'untrusted' | 'failed'> {
    this.rebuilding ??= this.rebuildOnce().finally(() => { this.rebuilding = null; });
    return this.rebuilding;
  }

  private async rebuildOnce(): Promise<'ok' | 'outside' | 'no-memory' | 'untrusted' | 'failed'> {
    const root = this.root;
    if (root === null) return 'outside';
    if (!existsSync(path.join(root, '.noto'))) return 'no-memory';
    if (!(this.options.mayOpen ?? runsNoScripts)(root)) return 'untrusted';
    const closing = this.stop();
    const generation = this.generation;
    // Nothing opens the memory while its workers close: answers say `opening` until the new one is open.
    this.state = 'opening';
    this.options.onChanged();
    await closing;
    // The folder changed, or something else stopped the memory, while the workers closed.
    if (this.generation !== generation || this.root !== root) return 'failed';
    const started = Date.now();
    const link = this.start();
    try {
      const value = await link.ask({ kind: 'open', root, rebuild: true }, OPEN_TIMEOUT_MS) as { notes?: number } | null;
      if (this.link !== link) return 'failed';
      this.options.log?.('memory_rebuilt', { ms: Date.now() - started, notes: value?.notes ?? null });
      this.opened();
      return 'ok';
    } catch (error) {
      if (this.link === link) this.failed('memory_rebuild_failed', error as Error);
      return 'failed';
    }
  }

  /**
   * Stop keeping memory for `root`, the folder the person was asked about:
   * the workers are let go, and `remove` takes its `.noto` away (main moves
   * it to the Trash). Until it is gone nothing opens the memory again, since
   * opening would make the index anew inside it. Resolves with whether it
   * was removed: not when the window has moved to another folder since.
   */
  async turnOff(root: string, remove: (folder: string) => Promise<void>): Promise<boolean> {
    if (this.root !== root) return false;
    const closing = this.stop();
    const generation = this.generation;
    this.state = 'opening';
    try {
      await closing;
      if (this.generation !== generation || this.root !== root) return false;
      await remove(path.join(root, '.noto'));
      return true;
    } finally {
      if (this.generation === generation && this.root === root && this.link === null) this.state = 'closed';
      this.options.onChanged();
    }
  }

  /**
   * A question in words, answered with the context pack, on Review's worker,
   * so a question never holds up an answer about the note in front. `rel` is
   * the note whose neighbours count for more, or null.
   */
  async recall(cue: string, rel: string | null): Promise<AskOutcome> {
    const root = this.root;
    if (root === null) return { state: 'outside', value: null };
    const closed = this.gate(root);
    if (closed !== null) return { state: closed, value: null };
    try {
      const reader = await this.startReader(root);
      return { state: 'ok', value: await reader.ask({ kind: 'recall', cue, rel }, REVIEW_TIMEOUT_MS) as AskOutcome['value'] };
    } catch {
      return { state: 'unavailable', value: null };
    }
  }

  /** Who has read the folder's notes, from the read record: null unless the memory is open now. */
  async readers(): Promise<readonly { actor: string; count: number; last: string }[] | null> {
    if (this.state !== 'open' || this.link === null) return null;
    try {
      return await this.link.ask({ kind: 'readers' }, ABOUT_TIMEOUT_MS) as { actor: string; count: number; last: string }[];
    } catch {
      return null;
    }
  }

  /**
   * Ask Review's question. It goes to a second worker that opens the same
   * index once the first has it open, without refreshing it, so a list that
   * takes seconds never holds up an answer about the note in front.
   */
  async review(request: ReviewRequest): Promise<ReviewOutcome> {
    const outcome = (state: ReviewOutcome['state'], value: unknown = null, error: string | null = null): ReviewOutcome => ({ state, value, error });
    const root = this.root;
    if (root === null) return outcome('outside');
    const closed = this.gate(root);
    if (closed !== null) return outcome(closed);
    let reader: WorkerLink;
    try {
      reader = await this.startReader(root);
    } catch {
      return outcome('unavailable');
    }
    try {
      return outcome('ok', await reader.ask(request, WRITES.has(request.kind) ? REVIEW_WRITE_TIMEOUT_MS : REVIEW_TIMEOUT_MS));
    } catch (error) {
      // The memory said why not (no such proposal, a note it may not write), or could not be reached.
      return error instanceof MemoryError && error.answered ? outcome('failed', null, error.message) : outcome('unavailable');
    }
  }

  /**
   * Begin keeping memory for the folder: what `noto-vault init` makes, then
   * the index. Only after the person said yes to what will be written; main
   * asks. Resolves with the files made, or null when it failed.
   */
  async keep(): Promise<readonly string[] | null> {
    const root = this.root;
    if (root === null) return null;
    const closing = this.stop();
    const generation = this.generation;
    this.state = 'opening';
    await closing;
    // The window may have moved to another folder while the workers closed.
    if (this.generation !== generation || this.root !== root) return null;
    const link = this.start();
    try {
      const value = await link.ask({ kind: 'keep', root }, OPEN_TIMEOUT_MS) as { made?: string[] } | null;
      if (this.link === link) this.opened();
      // Made, even when the folder changed meanwhile.
      return value?.made ?? [];
    } catch (error) {
      if (this.link === link) this.failed('memory_keep_failed', error as Error);
      return null;
    }
  }

  /**
   * Notes changed on disk, as folder-relative paths, or null for "anything
   * may have". They are read again a moment later, together.
   */
  changed(paths: readonly string[] | null): void {
    if (this.state !== 'open') return;
    if (paths === null) this.touched = null;
    else if (this.touched !== null) for (const rel of paths) this.touched.add(rel.split(path.sep).join('/'));
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => { this.refreshTimer = null; void this.refresh(); }, REFRESH_AFTER_CHANGE_MS);
  }

  dispose(): void {
    this.stop();
    this.root = null;
  }

  private start(): WorkerLink {
    const link: WorkerLink = new WorkerLink(this.options.startWorker(), (why) => {
      if (this.link !== link) return;
      this.link = null;
      this.failed('memory_worker_lost', new Error(why));
    });
    this.link = link;
    return link;
  }

  private startReader(root: string): Promise<WorkerLink> {
    if (this.readerReady) return this.readerReady;
    const link: WorkerLink = new WorkerLink(this.options.startWorker(), () => {
      if (this.reader !== link) return;
      this.reader = null;
      this.readerReady = null;
    });
    this.reader = link;
    const ready = link.ask({ kind: 'open', root, refresh: false }, OPEN_TIMEOUT_MS).then(() => link, (error: unknown) => {
      if (this.reader === link) {
        this.reader = null;
        this.readerReady = null;
        link.close();
      }
      throw error;
    });
    this.readerReady = ready;
    return ready;
  }

  private opened(): void {
    this.state = 'open';
    this.failures = 0;
    if (this.everyTimer !== null) clearInterval(this.everyTimer);
    this.everyTimer = setInterval(() => { void this.refresh(); }, REFRESH_EVERY_MS);
    this.options.onChanged();
  }

  /** The memory could not be had: stop its worker, and try again after a pause. */
  private failed(event: string, error: Error): void {
    this.options.log?.(event, { error: error.message, failures: this.failures + 1 });
    this.clear();
    this.state = 'failed';
    const pause = Math.min(RETRY_CAP_MS, RETRY_FIRST_MS * 2 ** this.failures);
    this.failures += 1;
    this.retryAt = Date.now() + pause;
    // The window asks again then, which opens it again.
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.options.onChanged(); }, pause);
    this.options.onChanged();
  }

  private open(root: string): void {
    this.state = 'opening';
    const started = Date.now();
    const link = this.start();
    void link.ask({ kind: 'open', root }, OPEN_TIMEOUT_MS).then((value) => {
      if (this.link !== link) return;
      this.options.log?.('memory_open', { ms: Date.now() - started, notes: (value as { notes?: number } | null)?.notes ?? null });
      this.opened();
    }, (error: MemoryError) => {
      if (this.link === link) this.failed('memory_open_failed', error);
    });
  }

  private async refresh(): Promise<void> {
    if (this.state !== 'open') return;
    if (this.refreshing) { this.again = true; return; }
    this.refreshing = true;
    const link = this.link;
    const paths = this.touched === null ? null : [...this.touched];
    this.touched = new Set();
    try {
      const stats = await this.ask({ kind: 'refresh', paths }, OPEN_TIMEOUT_MS) as { parsed?: number; events?: number; removed?: number; moved?: number } | null;
      if (this.link !== link) return;
      // Only news when something the window shows may differ, or an answer was missed meanwhile.
      const content = stats !== null && ((stats.parsed ?? 0) > 0 || (stats.removed ?? 0) > 0 || (stats.moved ?? 0) > 0);
      const news = content || (stats !== null && (stats.events ?? 0) > 0);
      // Review's lists come from the notes, not from what was read: only a change to them makes them stale.
      if (content) void this.reader?.ask({ kind: 'stale' }, ABOUT_TIMEOUT_MS).catch(() => {});
      if (news || this.owed) {
        this.owed = false;
        this.options.onChanged();
      }
    } catch {
      // What was not read waits for the next one.
      if (this.link === link) {
        if (paths === null) this.touched = null;
        else if (this.touched !== null) for (const rel of paths) this.touched.add(rel);
      }
    } finally {
      if (this.link === link) {
        this.refreshing = false;
        if (this.again) {
          this.again = false;
          void this.refresh();
        }
      }
    }
  }

  private ask(request: Unnumbered, timeoutMs: number): Promise<unknown> {
    return this.link ? this.link.ask(request, timeoutMs) : Promise.reject(new MemoryError('The memory is not open.'));
  }

  /**
   * Timers and bookkeeping off, and the workers let go: everything waiting
   * is told the memory closed. Resolves once both workers have stopped.
   */
  private clear(): Promise<void> {
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    if (this.everyTimer !== null) clearInterval(this.everyTimer);
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.refreshTimer = null;
    this.everyTimer = null;
    this.retryTimer = null;
    this.touched = new Set();
    this.refreshing = false;
    this.again = false;
    this.owed = false;
    const link = this.link;
    const reader = this.reader;
    this.link = null;
    this.reader = null;
    this.readerReady = null;
    return Promise.all([link?.close(), reader?.close()]).then(() => {});
  }

  private stop(): Promise<void> {
    this.generation += 1;
    const closing = this.clear();
    this.state = 'closed';
    return closing;
  }
}

/**
 * The open folder's memory, on a thread of its own.
 *
 * `@roobli/vault` keeps its index in SQLite through `node:sqlite`, whose calls
 * are synchronous, and building the index for a folder of eight thousand
 * notes the first time takes seconds. On main's own thread that would freeze
 * the window's menus and every channel for as long, so the vault lives here
 * and main asks it things by message (`src/main/workspace/memory-host.ts`).
 * One folder at a time; requests are answered in the order they came.
 *
 * Main runs this file twice. The first keeps the index (it opens with a
 * refresh and is refreshed as notes change) and answers Note Info. The
 * second only reads that same index, for Review, whose lists take seconds
 * (every mention in eight thousand notes is about four), so they never hold
 * up an answer about the note in front. Review's writes (accepting a
 * proposal, linking, taking a batch back) go through the vault here, and the
 * first worker reads them in when the folder's watcher reports the files.
 */

import { readFileSync, statSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parentPort } from 'node:worker_threads';
import {
  about, dismiss, dismissals, folderAbout, formatRecall, indexPath, initVault, prepare, recall, suggest, undismiss, Vault,
  type FileChange, type Suggestion, type SuggestionType,
} from '@roobli/vault';
import { PROPOSAL_ID } from '../shared/workspace/v1/contracts';

/** The kinds of suggestion Review lists; a script's are shown with the note they are about, later. */
export type ReviewKind = 'stale' | 'mention' | 'together';

export type MemoryRequest =
  /** `rebuild`: empty the index first, so it is built again from the notes and the read record. */
  | { readonly id: number; readonly kind: 'open'; readonly root: string; readonly refresh?: boolean; readonly rebuild?: boolean }
  | { readonly id: number; readonly kind: 'keep'; readonly root: string }
  | { readonly id: number; readonly kind: 'about'; readonly rel: string }
  /** What the index knows about a folder, `''` for the whole of it. */
  | { readonly id: number; readonly kind: 'folder'; readonly rel: string }
  /** The notes whose links name any of these words: those a move may have broken a link in. */
  | { readonly id: number; readonly kind: 'link-sources'; readonly words: readonly string[] }
  | { readonly id: number; readonly kind: 'refresh'; readonly paths: readonly string[] | null }
  | { readonly id: number; readonly kind: 'close' }
  /** What the index holds, for Settings → Memory. */
  | { readonly id: number; readonly kind: 'status' }
  /** Who has read the folder's notes, how often and when last. */
  | { readonly id: number; readonly kind: 'readers' }
  /** The notes changed on disk: what was worked out from them is worked out again when next asked. */
  | { readonly id: number; readonly kind: 'stale' }
  | { readonly id: number; readonly kind: 'summary'; readonly counted: readonly ReviewKind[] }
  | { readonly id: number; readonly kind: 'suggestions'; readonly type: ReviewKind; readonly offset: number; readonly limit: number }
  | { readonly id: number; readonly kind: 'proposal-file'; readonly proposal: string; readonly path: string }
  | { readonly id: number; readonly kind: 'accept'; readonly proposal: string; readonly busy: readonly string[] }
  | { readonly id: number; readonly kind: 'reject'; readonly proposal: string }
  | { readonly id: number; readonly kind: 'link'; readonly type: ReviewKind; readonly ids: readonly string[]; readonly busy: readonly string[] }
  | { readonly id: number; readonly kind: 'dismiss'; readonly type: ReviewKind; readonly ids: readonly string[] }
  | { readonly id: number; readonly kind: 'dismissals' }
  | { readonly id: number; readonly kind: 'undismiss'; readonly ids: readonly string[] | 'all' }
  | { readonly id: number; readonly kind: 'undo'; readonly busy: readonly string[] }
  /** The likeliest unlinked mentions in one note, to mark in it while it is in front. */
  | { readonly id: number; readonly kind: 'mentions'; readonly rel: string }
  /** A question in words, answered with the context pack, near `rel` when there is one. */
  | { readonly id: number; readonly kind: 'recall'; readonly cue: string; readonly rel: string | null };

export type MemoryAnswer =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: string; readonly unknown?: boolean };

/** A suggestion as the window shows it. */
export interface ReviewSuggestion {
  readonly id: string;
  readonly type: ReviewKind;
  readonly from: string;
  readonly to: string;
  readonly toTitle: string;
  readonly score: number;
  readonly reason: string;
  readonly line: number | null;
  readonly around: readonly [string, string, string] | null;
}

/** One write Review made, kept so it can be taken back: each file before and after. */
interface Batch {
  readonly files: readonly { readonly path: string; readonly before: string | null; readonly after: string | null }[];
}

/** How many writes can be taken back, the latest first. */
/** Rows of each list Note Info is given: the eight it shows, and Show More's. */
const ABOUT_LIMIT = 24;
const UNDO_DEPTH = 20;

/**
 * Marks in the note in front are few, so the page is not strewn with
 * underlines: the likeliest, above the score most of a folder's mentions
 * fall under (on the author's eight thousand notes, three in four score
 * below 0.6), and no more than eight.
 */
const NOTE_MENTION_FLOOR = 0.6;
const NOTE_MENTION_LIMIT = 8;
/** The most words one ask for link sources takes; a move names one or two. */
const LINK_WORDS = 64;
/** Notes in each of a folder's lists: the pane is narrow. */
const FOLDER_LIST = 8;

let vault: Vault | null = null;
// One request at a time: a refresh in the middle of an answer would read a half-built index.
let queue: Promise<void> = Promise.resolve();
/** What suggest found, per kind; kept until asked for afresh after the notes changed. */
const found = new Map<ReviewKind, Suggestion[]>();
/** Kinds whose list was found before the notes last changed. */
const outdatedKinds = new Set<ReviewKind>();
const batches: Batch[] = [];

const open = (): Vault => {
  if (!vault) throw new Error('The memory is not open.');
  return vault;
};

/**
 * A kind's suggestions. `fresh` works them out again if the notes changed
 * since; without it a kept list is used as it is, which for a count is near
 * enough and spares finding every mention again (seconds, in a big folder)
 * on every save. What a kept list says is checked again before it is applied
 * (`prepare`), so it never writes in the wrong place.
 */
function list(kind: ReviewKind, fresh: boolean): Suggestion[] {
  let all = found.get(kind);
  if (!all || (fresh && outdatedKinds.has(kind))) {
    all = suggest(open(), { types: [kind as SuggestionType] });
    found.set(kind, all);
    outdatedKinds.delete(kind);
  }
  return all;
}

/** Everything changed: each list is worked out again when next asked for. */
function forgetAll(): void {
  found.clear();
  outdatedKinds.clear();
}

/** The suggestions named, from the kind's list, worked out again if one is not in it. */
function resolve(kind: ReviewKind, ids: readonly string[]): { chosen: Suggestion[]; missing: string[] } {
  const wanted = new Set(ids);
  let chosen = list(kind, false).filter((item) => wanted.has(item.id));
  if (chosen.length < wanted.size && (outdatedKinds.has(kind) || !found.has(kind))) chosen = list(kind, true).filter((item) => wanted.has(item.id));
  const have = new Set(chosen.map((item) => item.id));
  return { chosen, missing: ids.filter((id) => !have.has(id)) };
}

const clamp = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
/** A path the window will take: forward slashes, inside the folder. */
const plainPath = (rel: string) => rel.length > 0 && rel.length <= 1024 && !rel.startsWith('/') && !rel.split('/').includes('..') && !rel.includes('\0');

/** The same name written two ways (macOS writes é apart, git together) is one note. */
const sameNames = (paths: readonly string[]) => new Set(paths.map((rel) => rel.normalize('NFC')));

/**
 * Write changes the vault's own way where it can, as a proposal taken in at
 * once (its three-way merge); in a folder that is not in git, which
 * proposals need, straight to the files. Resolves with what was written.
 */
function writeChanges(memory: Vault, changes: readonly FileChange[], message: string): string[] {
  if (memory.inGit()) {
    const { id } = memory.propose(changes, message);
    return [...memory.accept(id).applied];
  }
  const written: string[] = [];
  for (const change of changes) {
    const target = path.join(memory.root, change.path);
    if (change.content === null) unlinkSync(target);
    else { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, change.content, 'utf8'); }
    written.push(change.path);
  }
  if (written.length > 0) memory.refresh({ paths: written });
  return written;
}

const lite = (item: Suggestion): ReviewSuggestion => ({
  id: item.id, type: item.type as ReviewKind, from: item.from, to: item.to, toTitle: item.toTitle,
  score: item.score, reason: item.reason, line: item.line ?? null, around: item.around ?? null,
});

const textOf = (root: string, rel: string): string | null => {
  try { return readFileSync(path.join(root, rel), 'utf8'); } catch { return null; }
};

/** Drop what was linked or dismissed from the lists kept, so they stay right without being worked out again. */
function forget(ids: ReadonlySet<string>): void {
  for (const [kind, all] of found) found.set(kind, all.filter((item) => !ids.has(item.id)));
}

function remember(batch: Batch): void {
  if (batch.files.length === 0) return;
  batches.push(batch);
  if (batches.length > UNDO_DEPTH) batches.shift();
}

async function handle(request: MemoryRequest): Promise<unknown> {
  switch (request.kind) {
    case 'open': {
      vault?.close();
      vault = null;
      forgetAll();
      batches.length = 0;
      // The owner: the person at the window may read every note of their own folder. A rebuild
      // empties the index in place, safe for an agent's server that has it open too.
      vault = await Vault.open(request.root, { owner: true, refresh: request.refresh !== false, rebuild: request.rebuild === true });
      return { notes: (vault.status() as { notes?: number }).notes ?? null };
    }
    case 'keep': {
      // What `noto-vault init` makes, and nothing that is already there.
      const made = initVault(request.root);
      vault?.close();
      vault = await Vault.open(request.root, { owner: true });
      return { made };
    }
    case 'about':
      // Three screens of each group, for Show More, and the reads of as many days for the timeline.
      return about(open(), request.rel, { limit: ABOUT_LIMIT });
    case 'link-sources': {
      // More than one query takes: the caller reads the folder instead, rather than miss some.
      if (request.words.length > LINK_WORDS) return null;
      if (request.words.length === 0) return [];
      // instr, not LIKE, so nothing in a word means anything to it; lower on both sides, as a name is found in any case.
      const rows = open().store.db.prepare(`SELECT DISTINCT src FROM links WHERE ${request.words.map(() => 'instr(lower(target), lower(?)) > 0').join(' OR ')}`)
        .all(...request.words) as { src: string }[];
      return rows.map((row) => row.src);
    }
    case 'folder':
    {
      const known = folderAbout(open(), request.rel, { limit: FOLDER_LIST });
      // A title is the note's first heading, as long as the person wrote it: the window takes a line of it.
      const short = (note: (typeof known.warmest)[number]) => ({ ...note, title: clamp(note.title, 300) });
      return {
        ...known,
        warmest: known.warmest.map(short),
        mostRead: known.mostRead.map(short),
        orphans: { count: known.orphans.count, items: known.orphans.items.map(short) },
      };
    }
    case 'readers':
      return open().readers();
    case 'refresh':
      if (!vault) return null;
      return vault.refresh(request.paths ? { paths: request.paths } : {});
    case 'stale':
      for (const kind of found.keys()) outdatedKinds.add(kind);
      return null;
    case 'close':
      vault?.close();
      vault = null;
      return null;
    case 'status': {
      const memory = open();
      const status = memory.status() as { notes?: number; links?: number; events?: number; refreshed?: string | null };
      const index = indexPath(memory.root);
      const size = (file: string) => { try { return statSync(file).size; } catch { return 0; } };
      return {
        notes: status.notes ?? 0, links: status.links ?? 0, reads: status.events ?? 0,
        bytes: size(index) + size(`${index}-wal`), refreshed: status.refreshed ?? null,
      };
    }
    case 'summary': {
      const memory = open();
      const counts: Partial<Record<ReviewKind, number | null>> = {};
      for (const kind of ['stale', 'mention', 'together'] as const) {
        // Only what was asked for is worked out now; the rest is said if it is known. The
        // mentions are counted from the kept list once found, since finding them takes seconds.
        counts[kind] = request.counted.includes(kind) ? list(kind, kind !== 'mention').length : found.get(kind)?.length ?? null;
      }
      return {
        // A proposal is a ref anyone with git can write: one the window could not name or show is left out, not the whole list.
        proposals: memory.proposals().filter((proposal) => PROPOSAL_ID.test(proposal.id)).slice(0, 500).map((proposal) => ({
          id: proposal.id, subject: clamp(proposal.subject, 1000), author: clamp(proposal.author, 200), time: clamp(proposal.time, 60),
          files: proposal.files.filter((file) => plainPath(file.path)).slice(0, 2000).map((file) => ({ status: clamp(file.status, 8), path: file.path })),
        })),
        counts,
        dismissed: dismissals(memory).length,
      };
    }
    case 'suggestions': {
      const all = list(request.type, true);
      return { total: all.length, items: all.slice(request.offset, request.offset + request.limit).map(lite) };
    }
    case 'proposal-file':
      return open().proposalFile(request.proposal, request.path);
    case 'accept': {
      const memory = open();
      const proposal = memory.proposals().find((item) => item.id === request.proposal);
      if (!proposal) throw new Error(`There is no proposal ${request.proposal}.`);
      const files = proposal.files.map((file) => file.path);
      // A note with unsaved edits in the window would be written under them: nothing is taken in until it is saved.
      const unsaved = sameNames(request.busy);
      const busy = files.filter((rel) => unsaved.has(rel.normalize('NFC')));
      if (busy.length > 0) return { applied: [], unchanged: [], conflicts: [], busy };
      const before = new Map(files.map((rel) => [rel, textOf(memory.root, rel)]));
      const result = memory.accept(request.proposal);
      remember({ files: result.applied.map((rel) => ({ path: rel, before: before.get(rel) ?? null, after: textOf(memory.root, rel) })) });
      forgetAll();
      return { ...result, busy: [] };
    }
    case 'reject':
      open().reject(request.proposal);
      return null;
    case 'link': {
      const memory = open();
      const { chosen, missing } = resolve(request.type, request.ids);
      const unsaved = sameNames(request.busy);
      const busy = chosen.filter((item) => unsaved.has(item.from.normalize('NFC')));
      const free = chosen.filter((item) => !unsaved.has(item.from.normalize('NFC')));
      const { changes, outdated } = prepare(memory, free);
      let written: string[] = [];
      if (changes.length > 0) {
        const before = new Map(changes.map((change) => [change.path, textOf(memory.root, change.path)]));
        written = writeChanges(memory, changes, chosen.length === 1 ? `Link ${chosen[0]!.toTitle}` : `Link ${chosen.length} notes`);
        remember({ files: written.map((rel) => ({ path: rel, before: before.get(rel) ?? null, after: textOf(memory.root, rel) })) });
      }
      const linked = free.filter((item) => written.includes(item.from)).map((item) => item.id);
      // What could not be applied, or is no longer suggested at all, is worked out afresh next time.
      const gone = [...outdated.map((item) => item.id), ...missing];
      forget(new Set([...linked, ...gone]));
      return { linked, outdated: gone, busy: busy.map((item) => item.id) };
    }
    case 'dismiss': {
      const { chosen, missing } = resolve(request.type, request.ids);
      const count = dismiss(open(), chosen);
      forget(new Set(request.ids));
      return { count, missing };
    }
    case 'dismissals':
      return dismissals(open()).map((item) => ({ id: item.id, type: item.type, from: item.from, to: item.to, time: item.time }));
    case 'undismiss': {
      const count = undismiss(open(), request.ids);
      // They come back into the lists, which are worked out again.
      if (count > 0) forgetAll();
      return { count };
    }
    case 'mentions':
      // The whole folder's names and counts, from scans kept per note: the first ask reads them all, the next only what changed.
      return suggest(open(), { types: ['mention'], from: [request.rel] })
        .filter((item) => item.score >= NOTE_MENTION_FLOOR && item.around && item.splice)
        .sort((left, right) => right.score - left.score)
        .slice(0, NOTE_MENTION_LIMIT)
        .map((item) => ({ id: item.id, to: item.to, toTitle: item.toTitle, score: item.score, around: item.around!, replacement: item.splice!.replacement }));
    case 'recall': {
      // Recorded as the owner's recall, as an agent's ask through MCP is recorded as its own.
      const pack = recall(open(), request.cue, request.rel ? { from: request.rel } : {});
      return {
        cue: pack.cue,
        items: pack.items.map((item) => ({ path: item.path, title: item.title, kind: item.kind, why: [...item.why], excerpt: item.excerpt })),
        omitted: pack.omitted,
        markdown: formatRecall(pack),
      };
    }
    case 'undo': {
      const memory = open();
      const batch = batches.pop();
      if (!batch) return null;
      const restored: string[] = [];
      const changed: string[] = [];
      const busy: string[] = [];
      const unsaved = sameNames(request.busy);
      const waiting: Batch['files'][number][] = [];
      for (const file of batch.files) {
        // Kept to be taken back once the note is saved.
        if (unsaved.has(file.path.normalize('NFC'))) { busy.push(file.path); waiting.push(file); continue; }
        // Only a file still as Review left it: one written to since keeps what was written.
        if (textOf(memory.root, file.path) !== file.after) { changed.push(file.path); continue; }
        const target = path.join(memory.root, file.path);
        if (file.before === null) unlinkSync(target);
        else { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, file.before, 'utf8'); }
        restored.push(file.path);
      }
      if (waiting.length > 0) batches.push({ files: waiting });
      if (restored.length > 0) {
        memory.refresh({ paths: restored });
        forgetAll();
      }
      return { restored, changed, busy };
    }
  }
}

parentPort?.on('message', (request: MemoryRequest) => {
  queue = queue.then(async () => {
    let answer: MemoryAnswer;
    try {
      answer = { id: request.id, ok: true, value: await handle(request) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The vault says so when a reference names no note it holds.
      answer = { id: request.id, ok: false, error: message, unknown: /no note|not found|unknown note/i.test(message) };
    }
    parentPort!.postMessage(answer);
  });
});

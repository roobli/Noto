/**
 * Searching inside the notes, rather than across their names.
 *
 * Scanned on demand, with no index and no external binary. Both of those were
 * considered and both cost more than they return here. An inverted index over
 * this vault means holding tens of megabytes of text in the main process and
 * then owning its invalidation, for a query that already answers in a quarter
 * of a second. Shelling out to ripgrep means the feature works on machines that
 * happen to have it and silently does not on the rest.
 *
 * Measured on the author's vault, 7,066 notes and 82.5 MB of markdown: a full
 * scan takes about 1.3 seconds cold and 274 ms once the operating system has
 * the files cached, which is what a debounce is for.
 *
 * Reads are concurrent and bounded. Reading seven thousand files one at a time
 * on the main process would hold the event loop for the whole scan, which is
 * the window freezing; a bounded pool keeps it responsive and is also faster,
 * because the cost here is waiting for the disk rather than doing arithmetic.
 */

import { PLAIN_FLAGS, patternFor, type SearchFlags } from '../../shared/search/pattern';
import { readFile } from 'node:fs/promises';
import type {
  WorkspaceContentMatchV1,
  WorkspaceContentReplyV1,
  WorkspaceIndexEntryV1,
} from '../../shared/workspace/v1/contracts';

/** Reads in flight at once. Enough to keep the disk busy, few enough to stay polite. */
const CONCURRENCY = 24;

/** A scan that has run this long stops and says so, rather than hanging the box. */
export const SEARCH_BUDGET_MS = 4_000;

/** Files reported. Past this nobody is reading results, they are retyping. */
export const MAX_FILES = 60;

/** Lines kept per file, so one file of nothing but the query cannot fill the list. */
export const MAX_PER_FILE = 3;

/** Lines longer than this are cut around the match: a minified file is not context. */
const MAX_LINE = 400;

export interface ContentSearchOptions {
  readonly budgetMs?: number;
  readonly maxFiles?: number;
  readonly now?: () => number;
  readonly read?: (path: string) => Promise<string>;
}

/**
 * Where the pattern appears in one file's text.
 *
 * The pattern is the find bar's, built the same way from the same switches,
 * so what the sidebar finds is what the bar would find on opening the note.
 * A match of no characters, which an expression like `a*` can make, is
 * stepped over rather than reported: a hit with nothing in it is not one.
 */
export function matchesIn(
  text: string,
  pattern: RegExp,
  limit = MAX_PER_FILE,
): { line: string; lineNumber: number; column: number; length: number }[] {
  const found: { line: string; lineNumber: number; column: number; length: number }[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length && found.length < limit; index += 1) {
    const line = lines[index];
    const hit = firstHit(line, pattern);
    if (hit === null) continue;
    // A very long line is shown around its match rather than from its start,
    // because the point of the line is to show the query in context.
    let shown = line;
    let column = hit.at;
    if (line.length > MAX_LINE) {
      const from = wordStart(line, Math.max(0, hit.at - 40));
      // An ellipsis and a space, so the cut reads as a cut and the first word is whole.
      const lead = from > 0 ? '… ' : '';
      shown = `${lead}${line.slice(from, from + MAX_LINE)}`;
      column = hit.at - from + lead.length;
    }
    const leading = shown.length - shown.trimStart().length;
    found.push({ line: shown.trim(), lineNumber: index + 1, column: column - leading, length: hit.length });
  }
  return found;
}

/**
 * Where a window cut at `at` should begin so it starts on a whole word: the
 * next space after it within a dozen characters, or `at` itself in text with
 * no spaces to find (CJK runs, a long URL), where any character is a start.
 */
function wordStart(line: string, at: number): number {
  if (at === 0 || /\s/.test(line[at - 1] ?? '')) return at;
  const next = line.slice(at, at + 12).search(/\s/);
  return next < 0 ? at : at + next + 1;
}

/** The first non-empty match in a line, or null. */
function firstHit(line: string, pattern: RegExp): { at: number; length: number } | null {
  pattern.lastIndex = 0;
  for (;;) {
    const match = pattern.exec(line);
    if (match === null) return null;
    if (match[0].length > 0) return { at: match.index, length: match[0].length };
    pattern.lastIndex = match.index + 1;
    if (pattern.lastIndex > line.length) return null;
  }
}

/** Every non-empty match in a file, which is what a note is ranked by. */
function countOccurrences(text: string, pattern: RegExp): number {
  let count = 0;
  pattern.lastIndex = 0;
  for (;;) {
    const match = pattern.exec(text);
    if (match === null) return count;
    if (match[0].length > 0) count += 1;
    else pattern.lastIndex = match.index + 1;
    if (pattern.lastIndex > text.length) return count;
  }
}

/**
 * Run `work` over `items` with at most `limit` in flight.
 *
 * A pool rather than `Promise.all` over everything: seven thousand concurrent
 * reads exhausts the file descriptor table, and the failure when it does is an
 * `EMFILE` rather than a slow search.
 */
async function pool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await work(items[index]);
    }
  });
  await Promise.all(runners);
}

/**
 * Every note containing `query`, best first.
 *
 * Ranked by how many times the query appears, then by path so the order is
 * total and a repeated search does not reshuffle. Frecency is deliberately not
 * mixed in here: for a name search it says which of several plausible notes you
 * meant, but a content hit is evidence in itself and burying a match in a note
 * you rarely open is the opposite of what a search is for.
 */
export async function searchContent(
  entries: readonly WorkspaceIndexEntryV1[],
  query: string,
  flags: SearchFlags = PLAIN_FLAGS,
  options: ContentSearchOptions = {},
): Promise<WorkspaceContentReplyV1> {
  const needle = query.trim();
  if (needle.length === 0) {
    return { version: 1, matches: [], scanned: 0, truncated: false, timedOut: false, invalidPattern: false };
  }
  const pattern = patternFor(needle, flags);
  if (pattern === null) {
    return { version: 1, matches: [], scanned: 0, truncated: false, timedOut: false, invalidPattern: true };
  }

  const budget = options.budgetMs ?? SEARCH_BUDGET_MS;
  const maxFiles = options.maxFiles ?? MAX_FILES;
  const now = options.now ?? Date.now;
  const read = options.read ?? ((path: string) => readFile(path, 'utf8'));
  const started = now();

  const found: { entry: WorkspaceIndexEntryV1; hits: ReturnType<typeof matchesIn>; total: number }[] = [];
  let scanned = 0;
  let timedOut = false;

  await pool(entries, CONCURRENCY, async (entry) => {
    if (timedOut || found.length >= maxFiles) return;
    if (now() - started > budget) { timedOut = true; return; }

    let text: string;
    try {
      text = await read(entry.path);
    } catch {
      // A file that cannot be read is skipped rather than fatal: one unreadable
      // note should not cost the user the rest of their results.
      return;
    }
    scanned += 1;

    const hits = matchesIn(text, pattern);
    if (hits.length === 0) return;
    // Counted across the whole file, not just the lines kept, so a note that
    // mentions the query thirty times outranks one that mentions it once.
    const total = countOccurrences(text, pattern);
    found.push({ entry, hits, total });
  });

  found.sort((a, b) => b.total - a.total
    || a.entry.relativePath.localeCompare(b.entry.relativePath));

  const matches: WorkspaceContentMatchV1[] = found.slice(0, maxFiles).map((item) => ({
    path: item.entry.path,
    name: item.entry.name,
    relativePath: item.entry.relativePath,
    occurrences: item.total,
    lines: item.hits,
  }));

  return {
    version: 1,
    matches,
    scanned,
    truncated: found.length > maxFiles,
    timedOut,
    invalidPattern: false,
  };
}


/**
 * Fuzzy matching and ranking for quick open.
 *
 * An fzf-shaped subsequence scorer: it rewards consecutive runs, word
 * boundaries, camelCase humps and an exact prefix, and lightly penalises a wide
 * match span and a long tail. Ported from the author's `fuzzy-search` Typora
 * plugin, whose weightings are the ones his muscle memory is tuned to.
 *
 * Pure, and deliberately in shared code rather than in main: ranking happens in
 * the renderer on every keystroke, and a round trip per character is the one
 * thing that would make a search box feel slow. Main sends the index once and
 * the renderer does the arithmetic.
 *
 * Matching is a code-unit subsequence over lowercased text, which is CJK safe
 * as it stands: Han characters are in the BMP and are unaffected by case
 * folding, so a query in Chinese matches the same way one in English does.
 */

/** Everything a candidate offers the scorer, all pre-lowercased. */
export interface ScoreKeys {
  /** The file's own name. */
  readonly nameKey: string;
  /** Its path relative to the workspace root. */
  readonly pathKey: string;
}

export interface ScoreOptions {
  /** The query looks like a path, so path matches should outrank name ones. */
  readonly pathQuery: boolean;
  /** Bounded lift from how often and how recently this file is opened. */
  readonly frecencyBoost: number;
}

/** Scored so that a miss is unmistakable rather than merely low. */
export const NO_MATCH = Number.NEGATIVE_INFINITY;

export function fuzzyScore(text: string, query: string): number {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (lowerQuery.length === 0) return 0;

  const positions: number[] = [];
  let queryIndex = 0;
  for (let index = 0; index < lowerText.length && queryIndex < lowerQuery.length; index += 1) {
    if (lowerText[index] === lowerQuery[queryIndex]) {
      positions.push(index);
      queryIndex += 1;
    }
  }
  if (queryIndex < lowerQuery.length) return NO_MATCH;

  let score = 100;
  let previous = -2;
  let run = 0;

  for (const position of positions) {
    if (position === previous + 1) {
      run += 1;
      score += run * 6;
    } else {
      run = 0;
    }
    const before = position > 0 ? lowerText[position - 1] : '';
    if (position === 0 || /[\\/\-_.\s]/.test(before)) score += 10;
    // A camelCase hump: a capital following a lower case letter reads as the
    // start of a word even without a separator.
    if (position > 0
      && text[position] !== text[position].toLowerCase()
      && text[position - 1] === text[position - 1].toLowerCase()) {
      score += 8;
    }
    if (position === 0) score += 12;
    previous = position;
  }

  if (lowerText.startsWith(lowerQuery)) score += 20;

  const span = positions[positions.length - 1] - positions[0] + 1;
  score -= span * 0.4;
  score -= (lowerText.length - lowerQuery.length) * 0.1;
  return score;
}

/**
 * The words of a query. Quick open matches each word on its own and wants all
 * of them, the way fzf does, so `docker es` finds `Docker/deploy_es.md`: as
 * one subsequence the space had to be in the name too, and nothing matched.
 */
export const queryTokens = (query: string): string[] => query.trim().split(/\s+/).filter((token) => token.length > 0);

function subsequence(lowerText: string, lowerQuery: string): number[] | null {
  const positions: number[] = [];
  let queryIndex = 0;
  for (let index = 0; index < lowerText.length && queryIndex < lowerQuery.length; index += 1) {
    if (lowerText[index] === lowerQuery[queryIndex]) {
      positions.push(index);
      queryIndex += 1;
    }
  }
  return queryIndex === lowerQuery.length ? positions : null;
}

/**
 * Where a word sits whole in the text, preferring a start of a word, so the
 * highlight shows `es` in `docker_es` rather than an `e` from one word and an
 * `s` from the next.
 */
function occurrence(lowerText: string, token: string): number[] | null {
  let first = -1;
  for (let at = lowerText.indexOf(token); at >= 0; at = lowerText.indexOf(token, at + 1)) {
    if (first < 0) first = at;
    if (at === 0 || /[\\/\-_.\s]/.test(lowerText[at - 1])) { first = at; break; }
  }
  return first < 0 ? null : Array.from(token, (_, offset) => first + offset);
}

/**
 * Which characters of `text` the match consumed, for highlighting. With
 * several words, each word's own characters, so a name shows the words it
 * carries even when another word matched in the path instead.
 */
export function matchPositions(text: string, query: string): number[] | null {
  const lowerText = text.toLowerCase();
  const tokens = queryTokens(query.toLowerCase());
  if (tokens.length === 0) return [];
  const all = new Set<number>();
  let any = false;
  for (const token of tokens) {
    const positions = occurrence(lowerText, token) ?? subsequence(lowerText, token);
    if (positions === null) continue;
    any = true;
    for (const position of positions) all.add(position);
  }
  return any ? [...all].sort((a, b) => a - b) : null;
}

/**
 * The best a candidate scores across the keys it offers.
 *
 * The name is worth more than the path, because people search for what a note
 * is called far more often than for where it lives. A query containing a slash
 * says otherwise about itself, and flips the weighting.
 */
export function scoreCandidate(keys: ScoreKeys, query: string, options: ScoreOptions): number {
  const tokens = queryTokens(query);
  if (tokens.length <= 1) return scoreToken(keys, query.trim(), options) + options.frecencyBoost;
  // Every word must match the name or the path; each is scored where it fits
  // best, so a folder word and a name word can share one note.
  let total = 0;
  for (const token of tokens) {
    const best = scoreToken(keys, token, options);
    if (best === NO_MATCH) return NO_MATCH;
    total += best;
  }
  return total / tokens.length + options.frecencyBoost;
}

function scoreToken(keys: ScoreKeys, token: string, options: ScoreOptions): number {
  const name = fuzzyScore(keys.nameKey, token) + (options.pathQuery ? 6 : 25);
  const path = fuzzyScore(keys.pathKey, token) + (options.pathQuery ? 22 : 8);
  return Math.max(name, path);
}

/** A query is about location when it names one. */
export const isPathQuery = (query: string): boolean => query.includes('/');

/**
 * The top `limit` candidates, without sorting the rest.
 *
 * A bounded max-heap keyed on the *worst* kept entry, so a vault of several
 * thousand notes costs one scoring pass and a heap of ten, rather than a full
 * sort per keystroke. The comparison falls through to the path and then to
 * input order so the ranking is total: equal scores must not reorder between
 * keystrokes, or the list flickers under the fingers while you are aiming at it.
 */
export function rankCandidates<T extends ScoreKeys>(
  candidates: readonly T[],
  query: string,
  optionsFor: (candidate: T) => ScoreOptions,
  limit: number,
): T[] {
  const bounded = Math.max(0, Math.floor(limit));
  if (bounded === 0) return [];

  interface Ranked { candidate: T; score: number; index: number }
  const heap: Ranked[] = [];
  const worseFirst = (a: Ranked, b: Ranked): number => (
    b.score - a.score
    || a.candidate.pathKey.localeCompare(b.candidate.pathKey)
    || a.index - b.index
  );
  const swap = (left: number, right: number) => {
    const held = heap[left];
    heap[left] = heap[right];
    heap[right] = held;
  };

  const raise = (start: number) => {
    let index = start;
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (worseFirst(heap[index], heap[parent]) <= 0) break;
      swap(index, parent);
      index = parent;
    }
  };
  const sink = () => {
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      if (left >= heap.length) return;
      const right = left + 1;
      const worst = right < heap.length && worseFirst(heap[right], heap[left]) > 0 ? right : left;
      if (worseFirst(heap[worst], heap[index]) <= 0) return;
      swap(worst, index);
      index = worst;
    }
  };

  candidates.forEach((candidate, index) => {
    const score = scoreCandidate(candidate, query, optionsFor(candidate));
    if (score === NO_MATCH) return;
    const entry: Ranked = { candidate, score, index };
    if (heap.length < bounded) {
      heap.push(entry);
      raise(heap.length - 1);
      return;
    }
    if (worseFirst(entry, heap[0]) >= 0) return;
    heap[0] = entry;
    sink();
  });

  return heap.sort(worseFirst).map((entry) => entry.candidate);
}

/**
 * How long to wait after a keystroke before searching inside the notes.
 *
 * Adaptive, because the cost is not the same for every query. One or two
 * characters match nearly every file, so the scan does the most work and
 * returns the least useful answer; a longer query is both cheaper to satisfy
 * and more likely to be what the reader actually meant, so it starts sooner.
 * Ported from the same plugin as the ranking, where these numbers were tuned
 * against a vault this size.
 */
export function contentDebounceMs(query: string): number {
  const length = [...query.trim()].length;
  if (length === 0) return 120;
  if (length === 1) return 420;
  if (length === 2) return 320;
  return 240;
}

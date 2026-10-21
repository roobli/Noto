/**
 * Which blocks of a note differ from the note as last committed.
 *
 * Pure, with no Node builtins, so main can run it on a git blob and a unit
 * test can pin it. The unit is the block `@roobli/md` splits a note into, the
 * same unit the editor's top-level nodes come from, so a result here lands on
 * exactly one node in the editor.
 *
 * Three answers, as the tree gives three: a block that differs from the one
 * in its place at HEAD, a block HEAD does not have, and a place where HEAD had
 * blocks that are gone. Never a character diff: the popover shows the block
 * as committed and the reader's eye does the rest, which is what a note needs
 * and a code review does not.
 */

export type GitBlockChangeV1 = 'modified' | 'added';

export interface GitChangedBlockV1 {
  /** Index of the block in the current note. */
  readonly ordinal: number;
  readonly change: GitBlockChangeV1;
  /** The block as committed, for `modified`; null for `added`. */
  readonly head: string | null;
}

export interface GitDeletedBlocksV1 {
  /**
   * The current block the deleted ones stood before, or the block count when
   * they were at the end.
   */
  readonly before: number;
  /** What was there, the committed blocks joined by a blank line. */
  readonly head: string;
  /** The committed blocks one by one, as their source, for a revert. */
  readonly heads: readonly string[];
}

export interface GitBlockDiffV1 {
  readonly changed: readonly GitChangedBlockV1[];
  readonly deleted: readonly GitDeletedBlocksV1[];
}

/**
 * The most cells one alignment table may have. A middle larger than this is
 * first split at blocks that occur exactly once on each side (patience
 * anchors), and each piece is aligned on its own; a piece still too large
 * and with no such anchor is not aligned and reads as changed, which on a
 * stretch rewritten that thoroughly is the truth anyway. The cost stays
 * bounded either way.
 */
export const MAX_ALIGNMENT_CELLS = 4_000_000;

const MAX_ANCHOR_DEPTH = 32;

/**
 * Pairs of equal blocks, in order: a longest common subsequence where the
 * table fits, patience anchors where it does not.
 *
 * Common prefix and suffix are taken first, which is all an ordinary edit
 * needs, so a table is only ever built over the part that actually moved.
 */
function alignment(head: readonly string[], current: readonly string[], maxCells: number): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  alignRange(head, current, 0, head.length, 0, current.length, maxCells, pairs, 0);
  return pairs;
}

function alignRange(
  head: readonly string[], current: readonly string[],
  headStart: number, headEnd: number, currentStart: number, currentEnd: number,
  maxCells: number, pairs: Array<[number, number]>, depth: number,
): void {
  while (headStart < headEnd && currentStart < currentEnd && head[headStart] === current[currentStart]) {
    pairs.push([headStart, currentStart]);
    headStart += 1;
    currentStart += 1;
  }
  const tail: Array<[number, number]> = [];
  while (headEnd > headStart && currentEnd > currentStart && head[headEnd - 1] === current[currentEnd - 1]) {
    headEnd -= 1;
    currentEnd -= 1;
    tail.push([headEnd, currentEnd]);
  }

  const rows = headEnd - headStart;
  const columns = currentEnd - currentStart;
  if (rows > 0 && columns > 0) {
    if (rows * columns <= maxCells) {
      tableAlign(head, current, headStart, rows, currentStart, columns, pairs);
    } else if (depth < MAX_ANCHOR_DEPTH) {
      let headAt = headStart;
      let currentAt = currentStart;
      for (const [headIndex, currentIndex] of uniqueAnchors(head, current, headStart, headEnd, currentStart, currentEnd)) {
        alignRange(head, current, headAt, headIndex, currentAt, currentIndex, maxCells, pairs, depth + 1);
        pairs.push([headIndex, currentIndex]);
        headAt = headIndex + 1;
        currentAt = currentIndex + 1;
      }
      if (headAt !== headStart || currentAt !== currentStart) {
        alignRange(head, current, headAt, headEnd, currentAt, currentEnd, maxCells, pairs, depth + 1);
      }
    }
  }

  for (let index = tail.length - 1; index >= 0; index -= 1) pairs.push(tail[index]);
}

/** Longest common subsequence by table, for a middle that fits. */
function tableAlign(
  head: readonly string[], current: readonly string[],
  start: number, rows: number, currentStart: number, columns: number,
  pairs: Array<[number, number]>,
): void {
  // lengths[i][j]: LCS of head[start+i..] and current[currentStart+j..], flattened.
  const width = columns + 1;
  const lengths = new Uint32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      lengths[i * width + j] = head[start + i] === current[currentStart + j]
        ? lengths[(i + 1) * width + j + 1] + 1
        : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < rows && j < columns) {
    if (head[start + i] === current[currentStart + j]) {
      pairs.push([start + i, currentStart + j]);
      i += 1;
      j += 1;
    } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
}

/**
 * Blocks that occur exactly once on each side, the longest run of them in
 * the same order on both (patience sorting, n log n).
 */
function uniqueAnchors(
  head: readonly string[], current: readonly string[],
  headStart: number, headEnd: number, currentStart: number, currentEnd: number,
): Array<[number, number]> {
  const seen = new Map<string, { head: number; headCount: number; current: number; currentCount: number }>();
  for (let index = headStart; index < headEnd; index += 1) {
    const entry = seen.get(head[index]);
    if (entry) entry.headCount += 1;
    else seen.set(head[index], { head: index, headCount: 1, current: -1, currentCount: 0 });
  }
  for (let index = currentStart; index < currentEnd; index += 1) {
    const entry = seen.get(current[index]);
    if (!entry) continue;
    entry.currentCount += 1;
    entry.current = index;
  }
  const candidates: Array<[number, number]> = [];
  for (let index = headStart; index < headEnd; index += 1) {
    const entry = seen.get(head[index])!;
    if (entry.head === index && entry.headCount === 1 && entry.currentCount === 1) candidates.push([index, entry.current]);
  }
  if (candidates.length === 0) return [];
  // Longest increasing run of current indices, in head order.
  const tops: number[] = [];
  const previous = new Int32Array(candidates.length).fill(-1);
  for (let index = 0; index < candidates.length; index += 1) {
    const value = candidates[index][1];
    let low = 0;
    let high = tops.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (candidates[tops[middle]][1] < value) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tops[low - 1];
    tops[low] = index;
  }
  const anchors: Array<[number, number]> = [];
  for (let index = tops[tops.length - 1]; index >= 0; index = previous[index]) anchors.push(candidates[index]);
  return anchors.reverse();
}

/** Runs longer than this on either side pair up in order, without similarity. */
const MAX_SIMILARITY_RUN = 64;

/** Below this, two blocks are different blocks rather than one block edited. */
const SIMILAR = 0.3;

function words(block: string): Set<string> {
  return new Set(block.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/** Dice coefficient over the blocks' word sets: 1 for the same words, 0 for none shared. */
function similarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

/**
 * Inside an unmatched stretch, which committed block each current block is
 * an edit of: the in-order pairing with the most similarity, counting only
 * pairs that share enough words. A paragraph inserted above an edited one is
 * then new rather than an edit of the paragraph it pushed down.
 */
function similarPairs(head: readonly string[], current: readonly string[]): Array<[number, number]> {
  const rows = head.length;
  const columns = current.length;
  const headWords = head.map(words);
  const currentWords = current.map(words);
  const width = columns + 1;
  const best = new Float64Array((rows + 1) * width);
  const score = (i: number, j: number) => {
    const value = similarity(headWords[i], currentWords[j]);
    return value >= SIMILAR ? value : 0;
  };
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      const pair = score(i, j);
      best[i * width + j] = Math.max(
        pair > 0 ? best[(i + 1) * width + j + 1] + pair : 0,
        best[(i + 1) * width + j],
        best[i * width + j + 1],
      );
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < columns) {
    const pair = score(i, j);
    if (pair > 0 && best[i * width + j] === best[(i + 1) * width + j + 1] + pair) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (best[(i + 1) * width + j] >= best[i * width + j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/**
 * Diff two notes given as their blocks' markdown, line endings already LF.
 *
 * Between two matched blocks lie a run of committed blocks and a run of
 * current ones. Blocks in them that share enough words pair up as modified;
 * what is left between those pairs pairs up in order, each pair also a
 * modified block (a paragraph rewritten in place is still that paragraph);
 * current blocks left over are added; committed blocks left over are
 * deleted, marked before the next current block.
 */
export function diffBlocks(
  head: readonly string[],
  current: readonly string[],
  maxCells: number = MAX_ALIGNMENT_CELLS,
): GitBlockDiffV1 {
  const changed: GitChangedBlockV1[] = [];
  const deleted: GitDeletedBlocksV1[] = [];
  const pairs = alignment(head, current, maxCells);
  const positional = (headFrom: number, headTo: number, currentFrom: number, currentTo: number) => {
    const headRun = headTo - headFrom;
    const currentRun = currentTo - currentFrom;
    const paired = Math.min(headRun, currentRun);
    for (let offset = 0; offset < paired; offset += 1) {
      changed.push({ ordinal: currentFrom + offset, change: 'modified', head: head[headFrom + offset] });
    }
    for (let offset = paired; offset < currentRun; offset += 1) {
      changed.push({ ordinal: currentFrom + offset, change: 'added', head: null });
    }
    if (headRun > paired) {
      const heads = head.slice(headFrom + paired, headTo);
      deleted.push({ before: currentTo, head: heads.map((block) => block.replace(/\n+$/, '')).join('\n\n'), heads });
    }
  };
  let headAt = 0;
  let currentAt = 0;
  const settle = (headTo: number, currentTo: number) => {
    const headRun = headTo - headAt;
    const currentRun = currentTo - currentAt;
    if (headRun > 0 && currentRun > 0 && headRun + currentRun > 2
      && headRun <= MAX_SIMILARITY_RUN && currentRun <= MAX_SIMILARITY_RUN) {
      let headFrom = headAt;
      let currentFrom = currentAt;
      for (const [i, j] of similarPairs(head.slice(headAt, headTo), current.slice(currentAt, currentTo))) {
        positional(headFrom, headAt + i, currentFrom, currentAt + j);
        changed.push({ ordinal: currentAt + j, change: 'modified', head: head[headAt + i] });
        headFrom = headAt + i + 1;
        currentFrom = currentAt + j + 1;
      }
      positional(headFrom, headTo, currentFrom, currentTo);
    } else {
      positional(headAt, headTo, currentAt, currentTo);
    }
  };
  for (const [headIndex, currentIndex] of pairs) {
    settle(headIndex, currentIndex);
    headAt = headIndex + 1;
    currentAt = currentIndex + 1;
  }
  settle(head.length, current.length);
  return { changed, deleted };
}

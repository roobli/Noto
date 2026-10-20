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
}

export interface GitBlockDiffV1 {
  readonly changed: readonly GitChangedBlockV1[];
  readonly deleted: readonly GitDeletedBlocksV1[];
}

/**
 * The most cells the alignment table may have. Past it the unmatched middle
 * is not aligned at all and reads as changed, which on a note rewritten that
 * thoroughly is the truth anyway, and the cost stays bounded.
 */
export const MAX_ALIGNMENT_CELLS = 4_000_000;

/**
 * Pairs of equal blocks, in order, from a longest common subsequence.
 *
 * Common prefix and suffix are taken first, which is all an ordinary edit
 * needs, so the table is only ever built over the part that actually moved.
 */
function alignment(head: readonly string[], current: readonly string[], maxCells: number): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let start = 0;
  while (start < head.length && start < current.length && head[start] === current[start]) {
    pairs.push([start, start]);
    start += 1;
  }
  let headEnd = head.length;
  let currentEnd = current.length;
  const tail: Array<[number, number]> = [];
  while (headEnd > start && currentEnd > start && head[headEnd - 1] === current[currentEnd - 1]) {
    headEnd -= 1;
    currentEnd -= 1;
    tail.push([headEnd, currentEnd]);
  }

  const rows = headEnd - start;
  const columns = currentEnd - start;
  if (rows > 0 && columns > 0 && rows * columns <= maxCells) {
    // lengths[i][j]: LCS of head[start+i..] and current[start+j..], flattened.
    const width = columns + 1;
    const lengths = new Uint32Array((rows + 1) * width);
    for (let i = rows - 1; i >= 0; i -= 1) {
      for (let j = columns - 1; j >= 0; j -= 1) {
        lengths[i * width + j] = head[start + i] === current[start + j]
          ? lengths[(i + 1) * width + j + 1] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < rows && j < columns) {
      if (head[start + i] === current[start + j]) {
        pairs.push([start + i, start + j]);
        i += 1;
        j += 1;
      } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) {
        i += 1;
      } else {
        j += 1;
      }
    }
  }

  for (let index = tail.length - 1; index >= 0; index -= 1) pairs.push(tail[index]);
  return pairs;
}

/**
 * Diff two notes given as their blocks' markdown, line endings already LF.
 *
 * Between two matched blocks lie a run of committed blocks and a run of
 * current ones. They pair up in order, each pair a modified block; current
 * blocks left over are added; committed blocks left over are deleted, marked
 * before the next current block.
 */
export function diffBlocks(
  head: readonly string[],
  current: readonly string[],
  maxCells: number = MAX_ALIGNMENT_CELLS,
): GitBlockDiffV1 {
  const changed: GitChangedBlockV1[] = [];
  const deleted: GitDeletedBlocksV1[] = [];
  const pairs = alignment(head, current, maxCells);
  let headAt = 0;
  let currentAt = 0;
  const settle = (headTo: number, currentTo: number) => {
    const headRun = headTo - headAt;
    const currentRun = currentTo - currentAt;
    const paired = Math.min(headRun, currentRun);
    for (let offset = 0; offset < paired; offset += 1) {
      changed.push({ ordinal: currentAt + offset, change: 'modified', head: head[headAt + offset] });
    }
    for (let offset = paired; offset < currentRun; offset += 1) {
      changed.push({ ordinal: currentAt + offset, change: 'added', head: null });
    }
    if (headRun > paired) {
      deleted.push({ before: currentTo, head: head.slice(headAt + paired, headTo).map((block) => block.replace(/\n+$/, '')).join('\n\n') });
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

/**
 * What a note's unsaved changes are, block by block.
 *
 * The note as saved and the note as it stands are each cut into the blocks
 * the editor's top-level nodes come from, and paired by the same alignment the
 * git gutter uses: a block in both, a block edited, a block added, a block
 * gone. The rows come out in reading order with the saved block and the
 * current one side by side, so every layout of the view draws from the same
 * list and a change is the same change in all three.
 *
 * Inside an edited block the words are compared too, so the reader sees what
 * changed in the paragraph and not only that it did. Chinese, Japanese and
 * Korean text has no spaces to split on and is compared a character at a
 * time; other text a word at a time.
 *
 * Pure, so it is tested without a window.
 */

import { diffBlocks } from '../shared/git/block-diff';
import { blocksOf } from '../shared/markdown/v3/note-blocks';

export type DiffRowKind = 'same' | 'modified' | 'added' | 'removed';

export interface DiffRow {
  readonly kind: DiffRowKind;
  /** The block as saved, or null when it was added. */
  readonly saved: string | null;
  /** The block as it is now, or null when it was removed. */
  readonly current: string | null;
  /**
   * Which change the row belongs to, counted from zero in reading order:
   * neighbouring changed rows are one change. Minus one for an unchanged row.
   */
  readonly change: number;
}

export interface UnsavedDiff {
  readonly rows: readonly DiffRow[];
  readonly changes: number;
  /**
   * No block differs, but the text does: a blank line between blocks, or how
   * the file ends. The note is unsaved all the same, and saving writes it.
   */
  readonly spacingOnly: boolean;
  readonly added: number;
  readonly removed: number;
  readonly modified: number;
}

const trimBlock = (block: string): string => block.replace(/\n+$/, '');

const normalized = (text: string): string => (text.startsWith('\uFEFF') ? text.slice(1) : text).replace(/\r\n?/g, '\n');

/** The rows for a note saved as `savedText` and now reading `currentText`. */
export function unsavedDiff(savedText: string, currentText: string): UnsavedDiff {
  const saved = blocksOf(savedText);
  const current = blocksOf(currentText);
  const { changed, deleted } = diffBlocks(saved, current);
  const changedAt = new Map(changed.map((entry) => [entry.ordinal, entry]));
  const removedBefore = new Map<number, string[]>();
  for (const entry of deleted) {
    removedBefore.set(entry.before, [...(removedBefore.get(entry.before) ?? []), ...entry.heads]);
  }

  const rows: DiffRow[] = [];
  let change = -1;
  let open = false;
  const push = (kind: DiffRowKind, savedBlock: string | null, currentBlock: string | null) => {
    if (kind === 'same') {
      open = false;
    } else if (!open) {
      change += 1;
      open = true;
    }
    rows.push({
      kind,
      saved: savedBlock === null ? null : trimBlock(savedBlock),
      current: currentBlock === null ? null : trimBlock(currentBlock),
      change: kind === 'same' ? -1 : change,
    });
  };

  for (let ordinal = 0; ordinal <= current.length; ordinal += 1) {
    for (const head of removedBefore.get(ordinal) ?? []) push('removed', head, null);
    if (ordinal === current.length) break;
    const entry = changedAt.get(ordinal);
    if (!entry) push('same', current[ordinal]!, current[ordinal]!);
    else if (entry.change === 'modified') push('modified', entry.head, current[ordinal]!);
    else push('added', null, current[ordinal]!);
  }

  return {
    rows,
    changes: change + 1,
    spacingOnly: change === -1 && normalized(savedText) !== normalized(currentText),
    added: rows.filter((row) => row.kind === 'added').length,
    removed: rows.filter((row) => row.kind === 'removed').length,
    modified: rows.filter((row) => row.kind === 'modified').length,
  };
}

export type WordOp = 'same' | 'removed' | 'added';

export interface WordPiece {
  readonly op: WordOp;
  readonly text: string;
}

/**
 * Words, runs of space, and every other character on its own: a Han or kana
 * character, a mark of punctuation. Joined back together they are the text.
 */
const TOKEN = /\s+|[A-Za-z0-9_À-ɏ]+|[\s\S]/gu;

/** Lines, each with its own line break. */
const LINE = /[^\n]*\n|[^\n]+/g;

/** The most cells one comparison may take, words or lines. */
const MAX_WORD_CELLS = 250_000;

function merge(pieces: WordPiece[], op: WordOp, text: string): void {
  if (text === '') return;
  const last = pieces[pieces.length - 1];
  if (last && last.op === op) pieces[pieces.length - 1] = { op, text: last.text + text };
  else pieces.push({ op, text });
}

/**
 * Append `a` against `b` as kept, removed and added pieces, by a longest
 * common subsequence of their tokens. False, with nothing appended, when the
 * table would be larger than the cap.
 */
function aligned(pieces: WordPiece[], a: readonly string[], b: readonly string[]): boolean {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_WORD_CELLS) return false;
  // lengths[i * (m + 1) + j]: the longest common run of a[i..] and b[j..].
  const lengths = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lengths[i * (m + 1) + j] = a[i] === b[j]
        ? lengths[(i + 1) * (m + 1) + j + 1]! + 1
        : Math.max(lengths[(i + 1) * (m + 1) + j]!, lengths[i * (m + 1) + j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      merge(pieces, 'same', a[i]!);
      i += 1;
      j += 1;
    } else if (i < n && (j === m || lengths[(i + 1) * (m + 1) + j]! >= lengths[i * (m + 1) + j + 1]!)) {
      // On a tie what went comes before what came, so a replaced word reads
      // struck, then its replacement.
      merge(pieces, 'removed', a[i]!);
      i += 1;
    } else {
      merge(pieces, 'added', b[j]!);
      j += 1;
    }
  }
  return true;
}

/**
 * The words of an edited block, each kept, removed or added, in reading
 * order. The common start and end are taken first, which is all most edits
 * need; the middle is a longest common subsequence of its words where that
 * fits, of its lines where only that fits, and marked changed whole where
 * neither does.
 */
export function wordDiff(saved: string, current: string): WordPiece[] {
  const a = saved.match(TOKEN) ?? [];
  const b = current.match(TOKEN) ?? [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const pieces: WordPiece[] = [];
  merge(pieces, 'same', a.slice(0, start).join(''));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (!aligned(pieces, midA, midB)) {
    // Too many words between the first change and the last to compare one
    // by one, which a long fence edited at both ends easily is. Lines are far
    // fewer, so the block is compared line by line instead, and only a block
    // too large even for that is marked changed whole.
    const linesA = midA.join('').match(LINE) ?? [];
    const linesB = midB.join('').match(LINE) ?? [];
    if (!aligned(pieces, linesA, linesB)) {
      merge(pieces, 'removed', midA.join(''));
      merge(pieces, 'added', midB.join(''));
    }
  }
  merge(pieces, 'same', a.slice(endA).join(''));
  return pieces;
}

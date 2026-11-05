/**
 * Which rows of a table differ from the table as last committed.
 *
 * The git gutter marks blocks, and a table is one block, so a table with one
 * row changed showed a bar the height of the whole table. A markdown table is
 * one row per line, so the rows can be compared as lines: the committed
 * table's rows against the rows of the table as it is now, matched by their
 * cells' text. Rows that match are unchanged; between two matches, rows now
 * that take the place of committed ones are changed, more than that are new,
 * and fewer mean some were deleted there.
 *
 * Null whenever rows cannot be compared honestly, and the whole table is
 * marked as before: a column added or taken away, the alignment changed (the
 * rule row), or the table differing only in something rows do not show, such
 * as the padding between pipes.
 */

export type TableRowChange = 'same' | 'modified' | 'added';

export interface TableRowChanges {
  /** One per row of the table as it is now, the header first. */
  readonly rows: readonly TableRowChange[];
  /** Where committed rows were deleted: the row now they stood before, or `rows.length` for the end. */
  readonly deletedBefore: readonly number[];
}

/** Past this many row pairs to compare, the whole table is marked rather than spending the time. */
const MAX_PAIRS = 250_000;

function cells(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  return text.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\s+/g, ' '));
}

function rowsOf(markdown: string): { rows: string[][]; rule: string } | null {
  const lines = markdown.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length < 2) return null;
  const rule = cells(lines[1]!).map((cell) => cell.replace(/-+/g, '-')).join('|');
  return { rows: [lines[0]!, ...lines.slice(2)].map(cells), rule };
}

export function tableRowChanges(committed: string, now: string): TableRowChanges | null {
  const before = rowsOf(committed);
  const after = rowsOf(now);
  if (!before || !after || before.rule !== after.rule) return null;
  const width = before.rows[0]!.length;
  if (before.rows.some((row) => row.length !== width) || after.rows.some((row) => row.length !== width)) return null;
  const a = before.rows.map((row) => row.join('\u0000'));
  const b = after.rows.map((row) => row.join('\u0000'));
  if (a.length * b.length > MAX_PAIRS) return null;

  // Longest common run of rows, by the usual table of lengths from the end.
  const n = a.length;
  const m = b.length;
  const lengths = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lengths[i]![j] = a[i] === b[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  const rows: TableRowChange[] = new Array<TableRowChange>(m).fill('same');
  const deletedBefore: number[] = [];
  // Settle the unmatched run between two matches: rows now that stand in
  // for committed ones are changed, any past those are new, and committed
  // ones left over were deleted before the next row now.
  const settle = (removed: number, start: number, end: number) => {
    for (let j = start; j < end; j += 1) rows[j] = j - start < removed ? 'modified' : 'added';
    if (removed > end - start) deletedBefore.push(end);
  };
  let i = 0;
  let j = 0;
  let runFrom = 0;
  let removed = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      settle(removed, runFrom, j);
      removed = 0;
      i += 1;
      j += 1;
      runFrom = j;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      removed += 1;
      i += 1;
    } else {
      j += 1;
    }
  }
  settle(removed + (n - i), runFrom, m);
  if (rows.every((row) => row === 'same') && deletedBefore.length === 0) return null;
  return { rows, deletedBefore };
}

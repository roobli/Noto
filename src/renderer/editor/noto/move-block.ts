/**
 * Move what the caret is in, up or down.
 *
 * Typora puts three behaviours on one key. Inside a code fence the line moves.
 * Inside a table the row moves. Anywhere else the block moves among its
 * siblings, and when it has no sibling on that side the move is tried again on
 * its parent, so the last item of a list carries the whole list with it.
 *
 * Columns move the same way on their own key, left and right.
 *
 * The line arithmetic is pure and tested on its own, because it is the part
 * with an off-by-one in every direction.
 */

import type { Command } from 'prosemirror-state';
import { TextSelection } from 'prosemirror-state';
import type { Node as ProseNode, ResolvedPos } from 'prosemirror-model';
import { isUnwritableBlock } from './capture';

export interface MovedLine {
  readonly text: string;
  /** Where the caret goes: the same column, on the line that moved. */
  readonly offset: number;
}

/**
 * Swap the line holding `offset` with the one above or below it.
 *
 * Returns null when there is nothing to swap with, so the caller can let the
 * key through to whatever else wants it.
 */
export function moveLine(text: string, offset: number, up: boolean): MovedLine | null {
  const lines = text.split('\n');
  let start = 0;
  let index = 0;
  for (; index < lines.length; index += 1) {
    const end = start + lines[index].length;
    if (offset <= end) break;
    start = end + 1;
  }
  if (index >= lines.length) return null;
  const target = up ? index - 1 : index + 1;
  if (target < 0 || target >= lines.length) return null;

  const column = offset - start;
  const next = lines.slice();
  [next[index], next[target]] = [next[target], next[index]];

  let movedStart = 0;
  for (let i = 0; i < target; i += 1) movedStart += next[i].length + 1;
  // The line keeps its text, so the column it held is still there.
  return { text: next.join('\n'), offset: movedStart + column };
}

/** The depth of the innermost table row around `$pos`, or null. */
function rowDepth($pos: ResolvedPos): number | null {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.name === 'table_row') return depth;
  }
  return null;
}

/** The innermost code-like block around `$pos`: a fence, display maths, raw HTML. */
function codeDepth($pos: ResolvedPos): number | null {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.spec.code === true) return depth;
  }
  return null;
}

/**
 * Swap the node at `depth` with its neighbour, carrying the caret with it.
 *
 * Both nodes are replaced in one step so the document is never briefly missing
 * a row, which a delete followed by an insert would make it.
 */
function swapWithSibling(
  state: Parameters<Command>[0],
  dispatch: Parameters<Command>[1],
  $pos: ResolvedPos,
  depth: number,
  up: boolean,
): boolean {
  const parent = $pos.node(depth - 1);
  const index = $pos.index(depth - 1);
  const step = up ? -1 : 1;
  let other = index + step;
  if (other < 0 || other >= parent.childCount) return false;

  const node = parent.child(index);
  // Between top-level blocks, empty lines are the file's blank lines: a block
  // moves past the block beyond them, and they stay where they were.
  if (depth === 1 && !isUnwritableBlock(node)) {
    while (other >= 0 && other < parent.childCount && isUnwritableBlock(parent.child(other))) other += step;
    if (other < 0 || other >= parent.childCount) return false;
  }
  const sibling = parent.child(other);
  const between: ProseNode[] = [];
  for (let at = Math.min(index, other) + 1; at < Math.max(index, other); at += 1) between.push(parent.child(at));
  const betweenSize = between.reduce((size, child) => size + child.nodeSize, 0);
  const start = $pos.before(depth);
  const end = $pos.after(depth);
  const from = up ? start - betweenSize - sibling.nodeSize : start;
  const to = up ? end : end + betweenSize + sibling.nodeSize;
  const ordered: ProseNode[] = up ? [node, ...between, sibling] : [sibling, ...between, node];

  if (dispatch) {
    const within = $pos.pos - start;
    const movedStart = up ? from : from + sibling.nodeSize + betweenSize;
    const transaction = state.tr.replaceWith(from, to, ordered);
    transaction.setSelection(TextSelection.near(transaction.doc.resolve(movedStart + within)));
    transaction.scrollIntoView();
    dispatch(transaction);
  }
  return true;
}

/**
 * Up or down: a line of code, a table row, or the block itself.
 *
 * A table's first row is its header, and markdown has no way to write a table
 * without one, so the header stays where it is and no row moves above it.
 */
export function moveBlock(up: boolean): Command {
  return (state, dispatch) => {
    const { $from, empty } = state.selection;

    // Inside a fence the line moves, and only when it cannot does the fence
    // itself go. Typora stops at the line, which leaves a fence with nothing
    // above it stuck where it is; the intent behind the key is the same either
    // way, so the move carries on to the block.
    const code = codeDepth($from);
    const moved = code !== null && empty
      ? moveLine($from.node(code).textContent, $from.parentOffset, up)
      : null;
    if (code !== null && moved) {
      if (dispatch) {
        const block = $from.node(code);
        const start = $from.start(code);
        const transaction = state.tr.replaceWith(
          start,
          start + block.content.size,
          moved.text ? state.schema.text(moved.text) : [],
        );
        transaction.setSelection(TextSelection.near(transaction.doc.resolve(start + moved.offset)));
        transaction.scrollIntoView();
        dispatch(transaction);
      }
      return true;
    }

    const row = rowDepth($from);
    if (row !== null) {
      const index = $from.index(row - 1);
      if (index === 0 || (up && index === 1)) return false;
      return swapWithSibling(state, dispatch, $from, row, up);
    }

    for (let depth = $from.depth; depth > 0; depth -= 1) {
      if (swapWithSibling(state, dispatch, $from, depth, up)) return true;
    }
    return false;
  };
}

/**
 * Left or right: the column the caret is in, cell by cell down every row.
 *
 * Markdown tables have no merged cells, so every row has the same cells in the
 * same order and swapping two of them in each row is the whole operation.
 */
export function moveColumn(left: boolean): Command {
  return (state, dispatch) => {
    const { $from } = state.selection;
    const row = rowDepth($from);
    if (row === null) return false;
    const table = $from.node(row - 1);
    const tableStart = $from.before(row - 1) + 1;

    const column = $from.index(row);
    const other = left ? column - 1 : column + 1;
    const width = table.child(0).childCount;
    if (other < 0 || other >= width) return false;
    // A table pasted from HTML can have a merged cell, and then the rows do not
    // line up and there is no one column to move. Decline before touching it.
    for (let r = 0; r < table.childCount; r += 1) {
      if (table.child(r).childCount !== width) return false;
    }

    if (dispatch) {
      const transaction = state.tr;
      let caret: number | null = null;
      let offset = tableStart;
      for (let r = 0; r < table.childCount; r += 1) {
        const line = table.child(r);
        const cells = line.content.content.slice();
        [cells[column], cells[other]] = [cells[other], cells[column]];
        const lineStart = offset + 1;
        transaction.replaceWith(
          transaction.mapping.map(lineStart),
          transaction.mapping.map(lineStart + line.content.size),
          cells,
        );
        if (r === $from.index(row - 1)) {
          let cellStart = lineStart;
          for (let c = 0; c < other; c += 1) cellStart += cells[c].nodeSize;
          caret = transaction.mapping.map(cellStart) + 1;
        }
        offset += line.nodeSize;
      }
      if (caret !== null) {
        transaction.setSelection(TextSelection.near(transaction.doc.resolve(caret)));
      }
      transaction.scrollIntoView();
      dispatch(transaction);
    }
    return true;
  };
}

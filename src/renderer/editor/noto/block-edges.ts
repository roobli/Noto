/**
 * What Backspace and Enter do at the edges of a block, Typora's way.
 *
 * Typora's model is the markdown source: a heading is a line with `#` in front
 * of it, so Backspace at its start deletes the `#` and leaves a paragraph,
 * and a fence with nothing in it is two lines of backticks that Backspace
 * takes away. ProseMirror's own Backspace joins the block into the one before
 * it instead, which is right for a paragraph and wrong for these, because it
 * makes a heading disappear into the paragraph above it when the writer only
 * meant to demote it.
 *
 * In a table, Enter goes down a column rather than splitting a cell, and at
 * the bottom it makes a row, which is how a table is filled in from the
 * keyboard. And two typed lines that spell a table's header and its rule
 * become the table when Enter is pressed after the rule, which is what a hand
 * that writes markdown by habit expects to happen.
 *
 * At the edges of the note, Down from the last line of a quote, a list, a
 * table or a code block that ends it makes a plain line below and goes there,
 * and Up from the first line of one that starts it makes a line above. And
 * with whole rows or whole columns selected, Delete and Backspace take them out.
 */

import { TextSelection, type Command } from 'prosemirror-state';
import type { Node as ProseNode } from 'prosemirror-model';
import { CellSelection, TableMap, cellAround, deleteColumn, deleteRow, isInTable, selectionCell } from 'prosemirror-tables';
import { notoSchema } from '../../../shared/markdown/v3/pm/schema';

const { nodes } = notoSchema;

/**
 * Backspace at the start of a heading makes it a paragraph; at the start of
 * an empty fence or maths block, takes the block away. Anywhere else it
 * declines, and the ordinary Backspace runs.
 */
export const unwrapAtStart: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0) return false;
  const block = $from.parent;
  if (block.type === nodes.heading) {
    if (dispatch) {
      dispatch(state.tr.setBlockType($from.before(), $from.after(), nodes.paragraph).scrollIntoView());
    }
    return true;
  }
  const codeLike = block.type === nodes.code_block || block.type === nodes.math_block;
  if (codeLike && block.content.size === 0) {
    if (dispatch) {
      const tr = state.tr.replaceWith($from.before(), $from.after(), nodes.paragraph.create());
      tr.setSelection(TextSelection.create(tr.doc, $from.before() + 1));
      dispatch(tr.scrollIntoView());
    }
    return true;
  }
  return false;
};

/**
 * Enter in a cell moves to the same column of the row below, making the row
 * when there is none. The new row's cells take the alignment of the column.
 */
export const enterInTable: Command = (state, dispatch) => {
  if (!isInTable(state)) return false;
  const $cell = selectionCell(state);
  const table = $cell.node(-1);
  const start = $cell.start(-1);
  const map = TableMap.get(table);
  const index = map.map.indexOf($cell.pos - start);
  if (index < 0) return false;
  const row = Math.floor(index / map.width);
  const column = index % map.width;
  if (!dispatch) return true;

  const tr = state.tr;
  let cellPos: number;
  if (row + 1 < map.height) {
    cellPos = start + map.map[(row + 1) * map.width + column];
  } else {
    const cells: ProseNode[] = [];
    for (let at = 0; at < map.width; at += 1) {
      const above = table.nodeAt(map.map[row * map.width + at]);
      cells.push(nodes.table_cell.create({ align: above?.attrs.align ?? null }));
    }
    const end = $cell.end(-1);
    tr.insert(end, nodes.table_row.create(null, cells));
    cellPos = end + 1;
    for (let at = 0; at < column; at += 1) cellPos += cells[at].nodeSize;
  }
  tr.setSelection(TextSelection.near(tr.doc.resolve(cellPos + 1)));
  dispatch(tr.scrollIntoView());
  return true;
};

/** A pipe that is not escaped ends a cell. */
const CELL_SPLIT = /(?<!\\)\|/;
const RULE_CELL = /^:?-+:?$/;

/** The cells of a typed row, or null when the line is not one. */
function cellsOf(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return null;
  let inner = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  if (inner.endsWith('|') && !inner.endsWith('\\|')) inner = inner.slice(0, -1);
  return inner.split(CELL_SPLIT).map((cell) => cell.trim());
}

function alignOf(rule: string): 'left' | 'center' | 'right' | null {
  const left = rule.startsWith(':');
  const right = rule.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

/**
 * Enter at the end of a paragraph holding a table's rule, straight after a
 * paragraph holding its header, turns the two into the table with one empty
 * row to type into. The header's cells are taken as their text: a header is
 * a few words, and a word typed before its table has no marks to lose.
 */
export const tableFromRows: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  const block = $from.parent;
  if (!empty || block.type !== nodes.paragraph) return false;
  if ($from.parentOffset !== block.content.size) return false;
  const rule = cellsOf(block.textContent);
  if (!rule || !rule.every((cell) => RULE_CELL.test(cell))) return false;

  const index = $from.index(-1);
  if (index === 0) return false;
  const previous = $from.node(-1).child(index - 1);
  if (previous.type !== nodes.paragraph) return false;
  const heads = cellsOf(previous.textContent);
  if (!heads || heads.length !== rule.length) return false;
  if (!dispatch) return true;

  const aligns = rule.map(alignOf);
  const header = nodes.table_row.create(null, heads.map((text, at) =>
    nodes.table_header.create({ align: aligns[at] }, text ? notoSchema.text(text) : undefined)));
  const body = nodes.table_row.create(null, aligns.map((align) => nodes.table_cell.create({ align })));
  const table = nodes.table.create(null, [header, body]);

  const from = $from.before() - previous.nodeSize;
  const tr = state.tr.replaceWith(from, $from.after(), table);
  // The first cell of the empty row: past the table and header row openings,
  // past the header row, past the body row's opening, into its first cell.
  tr.setSelection(TextSelection.near(tr.doc.resolve(from + 1 + header.nodeSize + 1 + 1)));
  dispatch(tr.scrollIntoView());
  return true;
};

/**
 * Down from the last line of a note that ends inside something, or Up from
 * the first line of one that starts inside something, makes a plain line
 * there and goes to it.
 *
 * "Inside something" is a quote, a list, a callout, a code or maths block:
 * anything that is not a plain paragraph or heading at the top level.
 * Without this the keyboard had no way past one at the edge of a note. Enter
 * on an empty line steps out of a quote or a list one level at a time, but a
 * code block keeps its Enters, and a note that starts with a quote had no
 * line above it at all, so the only way was the source.
 *
 * A table is the exception: its arrows move within it, and no line is made
 * past it. The table's own arrow handler takes the caret into a block beyond
 * the table when there is one; at the edge of the note there is none, so the
 * key stops there instead of growing a cell the reader never asked for.
 *
 * Only from the last line (or the first), so Down inside a long last item
 * still moves down through it first. The new line is empty, and an empty last
 * line is not written when the note is saved, so going there and coming back
 * leaves the file as it was.
 */
export function exitAtEdge(direction: 1 | -1): Command {
  return (state, dispatch, view) => {
    const { selection, doc } = state;
    if (!(selection instanceof TextSelection) || !selection.empty) return false;
    const $at = selection.$head;
    if (!$at.parent.isTextblock || $at.depth < 1) return false;
    const index = $at.index(0);
    if (index !== (direction === 1 ? doc.childCount - 1 : 0)) return false;
    const top = $at.node(1);
    const codeLike = top.type === nodes.code_block || top.type === nodes.math_block;
    if ($at.depth === 1 && !codeLike) return false;
    // Nothing further that way inside the block. In a table that is the row:
    // the cells beside the caret's are on the same line, not further down.
    const table = top.type === nodes.table ? top : null;
    if (table) {
      const row = $at.index(1);
      if (row !== (direction === 1 ? table.childCount - 1 : 0)) return false;
    } else {
      let further = false;
      const [from, to] = direction === 1 ? [$at.after(), $at.end(1)] : [$at.start(1), $at.before()];
      if (from < to) {
        doc.nodesBetween(from, to, (node) => {
          if (further) return false;
          if (node.isTextblock) further = true;
          return !further;
        });
      }
      if (further) return false;
    }
    // From the last visual line of a wrapped paragraph, not from the middle of it.
    if (view && !view.endOfTextblock(direction === 1 ? 'down' : 'up')) return false;
    // At the edge of a note a table has no block beyond it: the arrows move
    // within the table, so the key is spent here and nothing is made.
    if (table) return true;
    if (dispatch) {
      const at = direction === 1 ? doc.content.size : 0;
      const tr = state.tr.insert(at, nodes.paragraph.create());
      tr.setSelection(TextSelection.create(tr.doc, at + 1));
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/**
 * Delete or Backspace with whole rows or whole columns selected takes them
 * out, as it does for the lines of a paragraph.
 *
 * A press on a row's or a column's handle selects it, and Shift with a press
 * adds the ones between; dragging across cells to the far edge does the same.
 * Before this the keys only emptied the cells, so taking a row out meant the
 * Table menu or the source. All the rows and all the columns at once is the
 * whole table, which is Delete Table's to do: then the keys empty the cells,
 * as they did.
 */
/**
 * Move the caret to the cell directly above or below, in the same column.
 *
 * The up and down arrows in a table used to walk the cells by their number,
 * so Up from a cell took the caret to the cell before it, on its left, and
 * Down to the one after it, on its right. Within the cell's own text the
 * keys still walk the text first: only from its top line (Up) or bottom
 * line (Down) do they leave it, which is what a single-line cell is all
 * over. At the table's top or bottom row there is no cell that way; the key
 * falls through, and the browser's caret steps into the block beyond the
 * table when there is one, or stays in the cell at the note's edge.
 */
export const moveCellVertically = (dir: 1 | -1): Command => (state, dispatch, view) => {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  // The cell around the caret, by the library's own bookkeeping: a caret at
  // the cell's inner edge resolves with its parent on the boundary, so
  // positions read from it there are off by one cell.
  const $cell = cellAround(selection.$head);
  if (!$cell) return false;
  if (view && !view.endOfTextblock(dir < 0 ? 'up' : 'down')) return false;
  const table = $cell.node(-1);
  const map = TableMap.get(table);
  // The cell's place by the map, not by its index in the row: a column the
  // reader merged spans its neighbours, which would put the index off.
  const { left, top } = map.findCell($cell.pos - $cell.start(-1));
  const row = top + dir;
  const target = row >= 0 && row < map.height ? map.map[left + row * map.width] : null;
  if (target === null || target === undefined) return false;
  if (dispatch) {
    const at = $cell.start(-1) + target + 1;
    dispatch(state.tr.setSelection(TextSelection.create(state.doc, at)));
  }
  return true;
};

export const deleteSelectedRowsOrColumns: Command = (state, dispatch) => {
  const { selection } = state;
  if (!(selection instanceof CellSelection)) return false;
  const rows = selection.isRowSelection();
  const columns = selection.isColSelection();
  if (rows && !columns) return deleteRow(state, dispatch);
  if (columns && !rows) return deleteColumn(state, dispatch);
  return false;
};

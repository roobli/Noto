/**
 * The table's lines in the editor's right-click menu.
 *
 * A right click in a table offers what the Table menu does for the row and
 * the column under the pointer: insert above, below, left and right, and
 * delete. With several rows or columns selected (by their handles, Shift with
 * a press, or a drag across cells) the delete lines say how many and take all
 * of them, so a run of rows goes in one step rather than one at a time through
 * the source.
 *
 * Each line runs the same editor command its Table menu item does, by name.
 */

import { Plugin, type EditorState } from 'prosemirror-state';
import { CellSelection, selectedRect } from 'prosemirror-tables';
import { notoSchema } from '../../../shared/markdown/v3/pm/schema';
import type { EditorContextItem } from './editor-extensions';

const { nodes } = notoSchema;

/** The start of the table's content that a document position is inside, or null. */
function tableStartAt(state: EditorState, pos: number): number | null {
  const $pos = state.doc.resolve(Math.max(0, Math.min(pos, state.doc.content.size)));
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type === nodes.table) return $pos.start(depth);
  }
  return null;
}

const plural = (count: number, one: string, many: string) => (count > 1 ? `Delete ${count} ${many}` : `Delete ${one}`);

export function tableContextItems(state: EditorState, pos: number | null): EditorContextItem[] {
  if (pos === null) return [];
  const start = tableStartAt(state, pos);
  if (start === null) return [];
  // The click is in a table. The commands act on the selection, which is the
  // cell clicked, or the cells selected if the click was inside them.
  let rows = 1;
  let columns = 1;
  const { selection } = state;
  if (selection instanceof CellSelection && selection.$anchorCell.start(-1) === start) {
    const rect = selectedRect(state);
    rows = rect.bottom - rect.top;
    columns = rect.right - rect.left;
  } else if (tableStartAt(state, selection.from) !== start) {
    // The caret is somewhere else, and the commands would act there.
    return [];
  }
  return [
    { title: 'Insert Row Above', command: 'table-row-above' },
    { title: 'Insert Row Below', command: 'table-row-below' },
    { title: 'Insert Column Left', command: 'table-column-before' },
    { title: 'Insert Column Right', command: 'table-column-after' },
    { title: plural(rows, 'Row', 'Rows'), command: 'table-row-delete' },
    { title: plural(columns, 'Column', 'Columns'), command: 'table-column-delete' },
    { title: 'Delete Table', command: 'table-delete' },
  ];
}

/**
 * A right press on cells that are selected keeps them selected.
 *
 * The browser's own right press moves the caret to the word under it, which
 * would turn three selected rows into a caret in one cell just before the
 * menu asked what to offer, so Delete 3 Rows would never be offered. A press
 * anywhere else is left to the browser, which puts the caret where it landed.
 */
export function tableContextPress(): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        mousedown(view, event) {
          const secondary = event.button === 2 || (event.button === 0 && event.ctrlKey);
          if (!secondary || !(view.state.selection instanceof CellSelection)) return false;
          const target = event.target instanceof Element ? event.target : null;
          if (!target?.closest('.selectedCell')) return false;
          event.preventDefault();
          return true;
        },
      },
    },
  });
}

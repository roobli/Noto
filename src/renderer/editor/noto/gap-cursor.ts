/**
 * The gap cursor, kept out of tables.
 *
 * The gap cursor is the caret between two blocks, where a new block would
 * go. Its arrow keys move it, and at a textblock's edge they create it. A
 * table cell is a textblock too, so the arrows that should move the caret
 * between cells were eaten at a cell's edge and a gap cursor made inside
 * the cell instead; typing then put the letter in the gap, which grew a new
 * cell, and the header row gained an empty one to match. The table's own
 * arrow handler runs after this plugin, so refusing inside a table hands
 * the keys to it, and a click in a cell never makes a gap cursor either.
 */

import { gapCursor } from 'prosemirror-gapcursor';
import { Plugin, type EditorState, type PluginSpec } from 'prosemirror-state';
import type { EditorProps, EditorView } from 'prosemirror-view';
import type { ResolvedPos } from 'prosemirror-model';

/** Whether any ancestor of the resolved position is a table. */
function inTableAt(state: EditorState, pos: number): boolean {
  const $pos = state.doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.spec.tableRole === 'table') return true;
  }
  return false;
}

/** Whether either end of the selection sits in a table. */
function selectionInTable(state: EditorState): boolean {
  const { $from, $to } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.spec.tableRole === 'table') return true;
  }
  for (let depth = $to.depth; depth > 0; depth -= 1) {
    if ($to.node(depth).type.spec.tableRole === 'table') return true;
  }
  return false;
}

export function notoGapCursor(): Plugin {
  const inner = gapCursor();
  const spec = inner.spec as PluginSpec<unknown>;
  const props = (spec.props ?? {}) as EditorProps;
  return new Plugin({
    ...spec,
    props: {
      ...props,
      handleKeyDown: (view: EditorView, event: KeyboardEvent) =>
        selectionInTable(view.state) ? false : props.handleKeyDown?.(view, event) ?? false,
      handleClick: (view: EditorView, pos: number, event: MouseEvent) =>
        inTableAt(view.state, pos) ? false : props.handleClick?.(view, pos, event) ?? false,
      createSelectionBetween: (view: EditorView, $anchor: ResolvedPos, $head: ResolvedPos) =>
        inTableAt(view.state, $anchor.pos) || inTableAt(view.state, $head.pos)
          ? null
          : props.createSelectionBetween?.(view, $anchor, $head) ?? null,
    },
  });
}

/**
 * The table editing plugin, minus the vertical arrows.
 *
 * The library's own Up and Down walk the cells by their number, so from a
 * cell they took the caret to the cell before it (on its left) or after it
 * (on its right). The reader's keys are column-wise: Up is the cell
 * directly above, Down the one directly below, and within a cell's text
 * they walk the text first. `moveCellVertically` (block-edges.ts) does the
 * between-cell move, and wherever it leaves the key to the browser, the
 * browser moves the caret column-wise too, so this plugin's vertical
 * handlers never get them. Its horizontal arrows, and Delete and Backspace
 * on whole rows and columns, still go through as they are.
 */

import { tableEditing } from 'prosemirror-tables';
import { Plugin, type PluginSpec } from 'prosemirror-state';
import type { EditorProps, EditorView } from 'prosemirror-view';
import { selectionInTable } from './gap-cursor';

export function notoTableEditing(): Plugin {
  const inner = tableEditing();
  const spec = inner.spec as PluginSpec<unknown>;
  const props = (spec.props ?? {}) as EditorProps;
  return new Plugin({
    ...spec,
    props: {
      ...props,
      handleKeyDown: (view: EditorView, event: KeyboardEvent) => {
        if ((event.key === 'ArrowUp' || event.key === 'ArrowDown')
          && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey
          && selectionInTable(view.state)) {
          return false;
        }
        return props.handleKeyDown?.(view, event) ?? false;
      },
    },
  });
}

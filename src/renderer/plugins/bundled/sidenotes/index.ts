/**
 * Sidenotes: `<span class="sidenote">` drawn as numbered margin notes, the
 * author's Typora plugin as a bundled one, with notes written in the margin.
 *
 * Everything it does to the editor goes through one editor extension: the
 * decorations that draw the notes, the card a new note is written in, the
 * commands, and the right-click items. Switched off in Plugin Center, the
 * extension leaves every open editor and the tags read as the source they are.
 */

import { TextSelection, type Command } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { EditorContextItem, EditorContextPoint } from '../../../editor/noto/editor-extensions';
import type { TrustedPlugin, TrustedPluginContext } from '../index';
import { composeMeta, sidenoteKey, sidenotePlugin } from './sidenote-plugin';
import { noteableRange, removeSidenote, sidenoteAt } from './sidenote-edit';

/** The manifest's commands, and the editor commands the extension answers to. */
export const INSERT_SIDENOTE = 'sidenotes.insert';
export const REMOVE_SIDENOTE = 'sidenotes.remove';

/**
 * Open the card for a new note: on the selected words, which become its
 * target, or at the caret with no target. With the caret in a note that has
 * no text yet, the card fills that one. A fence or maths block refuses, as
 * the other wraps do.
 */
export const composeSidenote: Command = (state, dispatch) => {
  const value = sidenoteKey.getState(state);
  if (!value) return false;
  const { from, to, empty, $from } = state.selection;
  let composer: { from: number; to: number; fill: number | null };
  if (empty) {
    const inside = sidenoteAt(value.ranges, from);
    if (inside) {
      if (inside.contentFrom !== inside.contentTo) return false;
      composer = { from: inside.contentFrom, to: inside.contentFrom, fill: inside.contentFrom };
    } else {
      if (!$from.parent.isTextblock || $from.parent.type.spec.code) return false;
      composer = { from, to: from, fill: null };
    }
  } else {
    const words = noteableRange(state, from, to);
    if (!words) return false;
    composer = { ...words, fill: null };
  }
  if (dispatch) dispatch(composeMeta(state.tr, composer).scrollIntoView());
  return true;
};

/** Take out the note the caret or selection is in, keeping the words it was about. */
export const deleteSidenote: Command = (state, dispatch) => {
  const range = sidenoteAt(sidenoteKey.getState(state)?.ranges ?? [], state.selection.from);
  if (!range) return false;
  if (dispatch) {
    const tr = state.tr;
    removeSidenote(tr, range);
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Over a note or its words, Remove; over a selection a note could go on, Add. */
export function sidenoteContextItems(view: EditorView, at: EditorContextPoint): EditorContextItem[] {
  const state = view.state;
  const ranges = sidenoteKey.getState(state)?.ranges ?? [];
  // A note in the margin is wider than its text, so the element says it was
  // hit where the position under the pointer may be the line beside it.
  const drawn = at.element?.closest('[data-sidenote-index]')?.getAttribute('data-sidenote-index');
  const hit = (drawn ? ranges.find((range) => String(range.index) === drawn) : undefined)
    ?? (at.pos !== null ? sidenoteAt(ranges, at.pos) : null);
  if (hit) {
    // A right click on a note puts the caret in it, as a right click in text
    // does, so Remove takes out the note that was clicked.
    if (sidenoteAt(ranges, state.selection.from) !== hit) {
      view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, hit.contentTo)));
    }
    return [{ title: 'Remove Sidenote', command: REMOVE_SIDENOTE }];
  }
  // Add is about the selected words, so only for a click on them.
  const { from, to, empty } = state.selection;
  if (empty || at.pos === null || at.pos < from || at.pos > to || !noteableRange(state, from, to)) return [];
  return [{ title: 'Add Sidenote', command: INSERT_SIDENOTE }];
}

export class SidenotesPlugin implements TrustedPlugin {
  activate(context: TrustedPluginContext): () => void {
    context.registerEditorExtension({
      id: 'sidenotes',
      plugins: () => [sidenotePlugin()],
      commands: { [INSERT_SIDENOTE]: composeSidenote, [REMOVE_SIDENOTE]: deleteSidenote },
      contextMenu: sidenoteContextItems,
    });
    context.registerCommand(INSERT_SIDENOTE, () => {
      if (!context.runEditorCommand(INSERT_SIDENOTE)) {
        context.notice('Select words in a paragraph, or put the caret in one, to add a sidenote.');
      }
    });
    context.registerCommand(REMOVE_SIDENOTE, () => {
      if (!context.runEditorCommand(REMOVE_SIDENOTE)) {
        context.notice('Put the caret in a sidenote or the words it is about to remove it.');
      }
    });
    // Everything above is released with the plugin's lease.
    return () => {};
  }
}

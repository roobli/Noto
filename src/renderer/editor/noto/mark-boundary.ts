/**
 * Which side of a revealed delimiter the caret is on.
 *
 * With the caret in a bold run its `**` are drawn as widgets around it, so
 * `**abc**` at the head of a line shows a place before the `**` and a place
 * after it. Both are one position in the document: there is nothing between
 * them but syntax. ProseMirror gives that position the marks of the text
 * after it at a line's start and of the text before it elsewhere, so only one
 * of the two places could ever be reached: at the head of a line the caret
 * could not get in front of the `**`, and typing there always went into the
 * bold; in mid-line it could not get behind it.
 *
 * Typora treats them as two places, and so does this. At either edge of the
 * span being shown the caret is `outside` or `inside`. The left arrow from
 * inside the opening `**` steps to outside without moving through the text,
 * the right arrow back again, and the same at the closing edge; Home and End
 * land outside, which is where Typora puts them, and so does a click at the
 * head of a line; any other click keeps what the place means. What the side means is said twice: in the stored marks, so a
 * character typed outside is plain and one typed inside takes the mark, and
 * in where the caret is drawn (`caret-plugin.ts`), before or after the
 * delimiter. The file never changes: delimiters are decorations.
 */

import type { Mark } from 'prosemirror-model';
import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { revealedRange, type MarkRange } from './active-node-plugin';

export type BoundarySide = 'outside' | 'inside';

export interface Boundary {
  readonly at: number;
  /** The opening edge of the span or its closing one. */
  readonly edge: 'open' | 'close';
  readonly side: BoundarySide;
}

export const markBoundaryKey = new PluginKey<Boundary | null>('noto-mark-boundary');

/** The edge of a revealed span a collapsed caret sits on, or null. */
export function edgeAt(state: EditorState): { range: MarkRange; edge: 'open' | 'close' } | null {
  const { empty, head } = state.selection;
  if (!empty) return null;
  const range = revealedRange(state, head);
  if (!range) return null;
  if (head === range.from) return { range, edge: 'open' };
  if (head === range.to) return { range, edge: 'close' };
  return null;
}

/** The marks a character typed at the caret should carry on this side. */
export function marksFor(state: EditorState, mark: Mark, side: BoundarySide): readonly Mark[] {
  const base = state.storedMarks ?? state.selection.$head.marks();
  return side === 'inside' ? mark.addToSet(base) : mark.removeFromSet(base);
}

/**
 * The side the caret is on already: inside if a character typed now would
 * take the mark. Stored marks first, which is where an input rule that has
 * just closed `*斜体*` says the next character is plain.
 */
function naturalSide(state: EditorState, mark: Mark): BoundarySide {
  return mark.isInSet(state.storedMarks ?? state.selection.$head.marks()) ? 'inside' : 'outside';
}

/**
 * Record the side, and say it in the stored marks only when it differs from
 * what typing would already do, so a side the editor chose for itself, by an
 * input rule or an edit, is never overridden.
 */
function placed(tr: Transaction, state: EditorState, boundary: Boundary, mark: Mark): Transaction {
  tr.setMeta(markBoundaryKey, boundary).setMeta('addToHistory', false);
  if (naturalSide(state, mark) !== boundary.side) tr.setStoredMarks(marksFor(state, mark, boundary.side));
  return tr;
}

export function markBoundaryPlugin(mac: boolean): Plugin<Boundary | null> {
  /*
   * Set by Home or End, read by the selection change that follows it. The
   * key may move nothing (Home at the head of the line already), and then no
   * change follows, so the flag holds for one key only: the state it was
   * pressed in, and only until the next key or press of the mouse. A later
   * change from any other state is not the key's.
   */
  let lineEdge: EditorState | null = null;
  return new Plugin<Boundary | null>({
    key: markBoundaryKey,
    state: {
      init: () => null,
      apply(tr, value) {
        const meta = tr.getMeta(markBoundaryKey) as Boundary | null | undefined;
        if (meta !== undefined) return meta;
        return tr.selectionSet || tr.docChanged ? null : value;
      },
    },
    appendTransaction(transactions, oldState, newState) {
      if (markBoundaryKey.getState(newState) !== null) return null;
      if (!transactions.some((tr) => tr.selectionSet || tr.docChanged)) return null;
      const found = edgeAt(newState);
      const fromLineEdge = lineEdge === oldState;
      lineEdge = null;
      if (!found) return null;
      const { range, edge } = found;
      let side: BoundarySide;
      if (fromLineEdge) {
        side = 'outside';
      } else if (transactions.some((tr) => tr.getMeta('pointer') === true)) {
        // A click at the head of a line is a click before the line's first
        // delimiter, as Home is; anywhere else it keeps what the place means.
        const atLineStart = edge === 'open' && newState.selection.$head.parentOffset === 0;
        side = atLineStart ? 'outside' : naturalSide(newState, range.mark);
      } else if (transactions.some((tr) => tr.docChanged)) {
        side = naturalSide(newState, range.mark);
      } else {
        // Arrived by a key: inside if it came from within the span, outside
        // if it came from beyond this edge, as the caret walks in Typora.
        const was = oldState.selection.head;
        const fromWithin = was > range.from && was < range.to;
        side = fromWithin ? 'inside' : 'outside';
      }
      return placed(newState.tr, newState, { at: newState.selection.head, edge, side }, range.mark);
    },
    props: {
      handleDOMEvents: {
        mousedown() {
          lineEdge = null;
          return false;
        },
      },
      handleKeyDown(view: EditorView, event: KeyboardEvent) {
        lineEdge = null;
        if (event.altKey || event.shiftKey) return false;
        const lineKey = event.key === 'Home' || event.key === 'End'
          || (mac && event.metaKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight'))
          || (mac && event.ctrlKey && (event.key === 'a' || event.key === 'e'));
        if (lineKey) {
          lineEdge = view.state;
          return false;
        }
        if (event.metaKey || event.ctrlKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return false;
        const state = view.state;
        const boundary = markBoundaryKey.getState(state);
        const found = edgeAt(state);
        if (!boundary || !found || boundary.at !== state.selection.head) return false;
        const left = event.key === 'ArrowLeft';
        // The one step that crosses the delimiter: from inside the opening
        // edge leftward, from outside it rightward, and the mirror at the
        // closing edge. Any other press moves the caret as usual.
        const crossing = found.edge === 'open'
          ? (left ? boundary.side === 'inside' : boundary.side === 'outside')
          : (left ? boundary.side === 'outside' : boundary.side === 'inside');
        if (!crossing) return false;
        const side: BoundarySide = boundary.side === 'inside' ? 'outside' : 'inside';
        view.dispatch(placed(state.tr, state, { ...boundary, side }, found.range.mark));
        return true;
      },
    },
  });
}

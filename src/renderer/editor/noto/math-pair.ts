/**
 * Typing `$` opens an inline formula, the way Typora's does.
 *
 * Typora (TypeMark `frame.js`, the auto-suggest after a typed `$`) inserts the
 * closing dollar after the caret, so `$` becomes `$|$`, marks the range as a
 * formula in the making and shows its preview reading "Empty Inline Math".
 * Here that is an empty `math_inline` node with the caret inside: the node
 * view draws both dollars and the preview, and the formula is a formula from
 * the first keystroke rather than when its closing dollar arrives.
 *
 * A dollar is a price as often as it is maths: the vault has 2,361 dollars
 * followed by a digit and 124 formulas that start with one. So `$` only opens
 * a formula where one could start: not after a letter or a digit (`US$`,
 * `5$`), not before a word character, never inside code or a formula. And a
 * digit typed first into a formula just opened turns it back into a dollar
 * and the digit, so `$8,000` typed as it reads is a price; a formula that
 * starts with a number is written by hand (`$2^8$`), which Pandoc's rule
 * still turns into a formula.
 *
 * A second `$` typed straight into a formula just opened makes `$$`, the start
 * of display maths: Typora's "two dollar signs and Return" for a block. It is
 * left as the text `$$`, and Return on a paragraph of nothing but `$$` opens
 * the block (`fenceOnEnter`), as it always did.
 *
 * With text selected, `$` wraps it, as Inline Math on the Format menu does.
 * Typing `$` at the end of a formula, where its closing dollar is drawn, steps
 * out of it; Backspace in an empty formula takes it away; and an empty formula
 * the caret leaves is taken away too, since it was one being opened, never
 * written. An empty formula has no Markdown spelling and is written as nothing.
 */

import { Plugin, TextSelection, type EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

/** Letters, digits and anything a language writes words with. */
const WORD = /[\p{L}\p{N}]/u;

/** Whether a typed `$` at a caret between `before` and `after` opens a formula. */
export function dollarOpensMath(before: string, after: string): boolean {
  if (WORD.test(before) || before === '$' || before === '\\') return false;
  if (after !== '' && (WORD.test(after) || after === '$')) return false;
  return true;
}

/** The `math_inline` the caret is in, as the range of its content, or null. */
function mathAround(state: EditorState): { start: number; end: number; size: number } | null {
  const { $from } = state.selection;
  if ($from.parent.type.name !== 'math_inline') return null;
  return { start: $from.start(), end: $from.end(), size: $from.parent.content.size };
}

/** `$`: open a formula, wrap the selection in one, or step out of one at its end. */
/** A digit typed first into an empty formula: it was a price, so a dollar and the digit. */
function digitIntoEmptyMath(view: EditorView, from: number, to: number, text: string): boolean {
  if (!/^[0-9]$/.test(text) || from !== to) return false;
  const { state } = view;
  const inMath = mathAround(state);
  if (!inMath || inMath.size !== 0) return false;
  const tr = state.tr.replaceWith(inMath.start - 1, inMath.end + 1, state.schema.text(`$${text}`));
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, inMath.start + 1)).scrollIntoView());
  return true;
}

function typeDollar(view: EditorView, from: number, to: number): boolean {
  const { state } = view;
  const math = state.schema.nodes.math_inline;
  const inMath = mathAround(state);
  if (inMath) {
    if (from !== to) return false;
    // `$` into a formula just opened: `$$`, the start of display maths, as text.
    if (inMath.size === 0) {
      const tr = state.tr.replaceWith(inMath.start - 1, inMath.end + 1, state.schema.text('$$'));
      view.dispatch(tr.setSelection(TextSelection.create(tr.doc, inMath.start + 1)).scrollIntoView());
      return true;
    }
    if (from !== inMath.end) return false;
    view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, inMath.end + 1)).scrollIntoView());
    return true;
  }
  const $from = state.doc.resolve(from);
  const parent = $from.parent;
  if (!parent.isTextblock || parent.type.spec.code || !parent.type.contentMatch.matchType(math)) return false;
  if ($from.marks().some((mark) => mark.type.spec.code)) return false;
  if (from !== to) {
    if (!$from.sameParent(state.doc.resolve(to))) return false;
    const selected = state.doc.textBetween(from, to);
    if (selected.trim().length === 0) return false;
    const tr = state.tr.replaceRangeWith(from, to, math.create(null, state.schema.text(selected)));
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from + 1 + selected.length)).scrollIntoView());
    return true;
  }
  const before = from > $from.start() ? state.doc.textBetween(from - 1, from) : '';
  const after = to < $from.end() ? state.doc.textBetween(to, to + 1) : '';
  if (!dollarOpensMath(before, after)) return false;
  const tr = state.tr.replaceRangeWith(from, to, math.create());
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from + 1)).scrollIntoView());
  return true;
}

/** Backspace in an empty formula takes both of its dollars at once. */
function backspaceInEmptyMath(view: EditorView, event: KeyboardEvent): boolean {
  if (event.key !== 'Backspace' || event.metaKey || event.ctrlKey || event.altKey) return false;
  const { state } = view;
  const inMath = mathAround(state);
  if (!inMath || inMath.size !== 0 || !state.selection.empty) return false;
  view.dispatch(state.tr.delete(inMath.start - 1, inMath.end + 1).scrollIntoView());
  return true;
}

export function mathPairPlugin(enabled: () => boolean): Plugin {
  return new Plugin({
    props: {
      handleTextInput(view, from, to, text) {
        if (!enabled()) return false;
        return text === '$' ? typeDollar(view, from, to) : digitIntoEmptyMath(view, from, to, text);
      },
      handleKeyDown(view, event) {
        return backspaceInEmptyMath(view, event);
      },
    },
    /*
     * An empty formula the caret has left goes. Only the textblocks the old
     * selection was in are looked at: an empty formula can only exist where
     * one was just opened, and that is where the caret was.
     */
    appendTransaction(transactions, oldState, state) {
      if (!transactions.some((tr) => tr.docChanged || tr.selectionSet)) return null;
      const was = oldState.selection.$from;
      if (was.parent.type.name !== 'math_inline' || was.parent.content.size !== 0) return null;
      const mapped = transactions.reduce((position, tr) => tr.mapping.map(position, -1), was.before());
      const node = state.doc.nodeAt(mapped);
      if (!node || node.type.name !== 'math_inline' || node.content.size !== 0) return null;
      const { from, to } = state.selection;
      if (from >= mapped && to <= mapped + node.nodeSize) return null;
      return state.tr.delete(mapped, mapped + node.nodeSize).setMeta('addToHistory', false);
    },
  });
}

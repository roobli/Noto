/**
 * Two inline formulas never touch: the editor merges them as they meet.
 *
 * The pure fix is exercised through a real EditorState with history, so the
 * tests see what the editor does: the appended transaction, the caret it
 * leaves, and the single undo that takes the edit and the merge away together.
 */
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import { history, redo, undo } from 'prosemirror-history';
import { Fragment, Slice, type Mark, type Node as ProseNode } from 'prosemirror-model';
import { notoSchema as s } from '../../src/shared/markdown/v3/pm/schema';
import {
  endsInOddBackslashes,
  fixAdjacentInlineMath,
  mathAdjacencyPlugin,
} from '../../src/renderer/editor/noto/math-adjacency';

const math = (latex: string, marks: readonly Mark[] = []) =>
  s.nodes.math_inline.create(null, latex ? s.text(latex) : null, marks);
const text = (value: string, marks: readonly Mark[] = []) => s.text(value, marks);
const para = (...kids: ProseNode[]) => s.nodes.paragraph.create(null, kids);

function stateOf(...blocks: ProseNode[]): EditorState {
  return EditorState.create({
    doc: s.nodes.doc.create(null, blocks),
    plugins: [history(), mathAdjacencyPlugin()],
  });
}

function run(state: EditorState, edit: (tr: Transaction) => Transaction): EditorState {
  return state.apply(edit(state.tr));
}

/** The first block as `<math>` and text tokens. */
function shape(state: EditorState, index = 0): string {
  const out: string[] = [];
  state.doc.child(index).forEach((child) => {
    out.push(child.type.name === 'math_inline' ? `<${child.textContent}>` : child.text ?? `{${child.type.name}}`);
  });
  return out.join('');
}

function undone(state: EditorState): EditorState {
  let next = state;
  const ok = undo(state, (tr) => { next = state.apply(tr); });
  expect(ok).toBe(true);
  return next;
}

function redone(state: EditorState): EditorState {
  let next = state;
  const ok = redo(state, (tr) => { next = state.apply(tr); });
  expect(ok).toBe(true);
  return next;
}

/** Position of character `offset` inside the math node at child `index` of block 0. */
function inMath(state: EditorState, index: number, offset: number): number {
  let position = 1;
  for (let k = 0; k < index; k += 1) position += state.doc.child(0).child(k).nodeSize;
  return position + 1 + offset;
}

describe('endsInOddBackslashes', () => {
  it('counts the trailing run only', () => {
    expect(endsInOddBackslashes('')).toBe(false);
    expect(endsInOddBackslashes('a')).toBe(false);
    expect(endsInOddBackslashes('a\\')).toBe(true);
    expect(endsInOddBackslashes('a\\\\')).toBe(false);
    expect(endsInOddBackslashes('\\\\\\')).toBe(true);
    expect(endsInOddBackslashes('\\a')).toBe(false);
  });
});

describe('merging touching inline formulas', () => {
  it('merges when the text between them is deleted, with one space', () => {
    const before = stateOf(para(text('a '), math('x'), text(' '), math('y'), text(' b')));
    // `a ` is 1..3, the formula 3..6, the space 6..7.
    const after = run(before, (tr) => tr.delete(6, 7));
    expect(shape(after)).toBe('a <x y> b');
  });

  it('keeps commands from running into the next token', () => {
    const before = stateOf(para(math('\\alpha'), text('+'), math('b')));
    const after = run(before, (tr) => tr.delete(1 + math('\\alpha').nodeSize, 2 + math('\\alpha').nodeSize));
    expect(shape(after)).toBe('<\\alpha b>');
  });

  it('is one undo step with the edit that caused it, and redoes as one', () => {
    const before = stateOf(para(math('x'), text('--'), math('y')));
    const after = run(before, (tr) => tr.delete(4, 6));
    expect(shape(after)).toBe('<x y>');
    const back = undone(after);
    expect(shape(back)).toBe('<x>--<y>');
    expect(back.doc.eq(before.doc)).toBe(true);
    expect(shape(redone(back))).toBe('<x y>');
  });

  it('puts a caret left between them after the merged formula', () => {
    const before = stateOf(para(text('a'), math('x'), text('-'), math('y'), text('b')));
    // Deleting the `-` leaves the caret at the seam.
    const after = run(before, (tr) => tr.setSelection(TextSelection.create(tr.doc, 6)).delete(5, 6));
    expect(shape(after)).toBe('a<x y>b');
    const merged = after.doc.child(0).child(1);
    expect(after.selection.empty).toBe(true);
    expect(after.selection.head).toBe(2 + merged.nodeSize);
  });

  it('keeps a caret inside the right formula on the same character', () => {
    const before = stateOf(para(math('ab'), text('-'), math('cd')));
    const at = inMath(before, 2, 1); // between `c` and `d`
    const after = run(before, (tr) => tr.setSelection(TextSelection.create(tr.doc, at)).delete(5, 6));
    expect(shape(after)).toBe('<ab cd>');
    expect(after.selection.head).toBe(inMath(after, 0, 'ab c'.length));
  });

  it('keeps a caret inside the left formula where it was', () => {
    const before = stateOf(para(math('ab'), text('-'), math('cd')));
    const at = inMath(before, 0, 2); // end of `ab`
    const after = run(before, (tr) => tr.setSelection(TextSelection.create(tr.doc, at)).delete(5, 6));
    expect(after.selection.head).toBe(inMath(after, 0, 2));
  });

  it('folds a chain into one formula', () => {
    const before = stateOf(para(math('a'), text('-'), math('b'), text('-'), math('c')));
    const after = run(before, (tr) => tr.delete(4, 5).delete(7, 8));
    expect(shape(after)).toBe('<a b c>');
  });

  it('merges a pasted formula landing against another', () => {
    const before = stateOf(para(math('x'), text('!')));
    const slice = new Slice(Fragment.from(math('y')), 0, 0);
    const after = run(before, (tr) => tr.replace(4, 5, slice));
    expect(shape(after)).toBe('<x y>');
  });

  it('merges across a join of two paragraphs', () => {
    const before = stateOf(para(text('a'), math('x')), para(math('y'), text('b')));
    const seam = before.doc.child(0).nodeSize;
    const after = run(before, (tr) => tr.join(seam));
    expect(after.doc.childCount).toBe(1);
    expect(shape(after)).toBe('a<x y>b');
  });

  it('drops an empty side rather than leaving a stray space', () => {
    const before = stateOf(para(math(''), text('-'), math('y')));
    const after = run(before, (tr) => tr.delete(3, 4));
    expect(shape(after)).toBe('<y>');
  });

  it('leaves formulas under different marks apart', () => {
    const strong = [s.marks.strong.create()];
    const before = stateOf(para(math('x', strong), text('-'), math('y')));
    const after = run(before, (tr) => tr.delete(4, 5));
    expect(shape(after)).toBe('<x><y>');
  });

  it('merges formulas under the same marks and keeps the marks', () => {
    const strong = [s.marks.strong.create()];
    const before = stateOf(para(math('x', strong), text('-', strong), math('y', strong)));
    const after = run(before, (tr) => tr.delete(4, 5));
    expect(shape(after)).toBe('<x y>');
    expect(after.doc.child(0).child(0).marks.map((m) => m.type.name)).toEqual(['strong']);
  });
});

describe('a left formula ending in an odd run of backslashes', () => {
  it('stays apart, with one text space between', () => {
    const before = stateOf(para(math('a\\'), text('-'), math('b')));
    const after = run(before, (tr) => tr.delete(5, 6));
    expect(shape(after)).toBe('<a\\> <b>');
  });

  it('is still one undo step', () => {
    const before = stateOf(para(math('a\\'), text('-'), math('b')));
    const after = run(before, (tr) => tr.delete(5, 6));
    expect(undone(after).doc.eq(before.doc)).toBe(true);
  });

  it('merges when the run is even', () => {
    const before = stateOf(para(math('a\\\\'), text('-'), math('b')));
    const after = run(before, (tr) => tr.delete(6, 7));
    expect(shape(after)).toBe('<a\\\\ b>');
  });
});

describe('fixAdjacentInlineMath', () => {
  it('returns null when nothing touches', () => {
    const state = stateOf(para(math('x'), text(' '), math('y')));
    expect(fixAdjacentInlineMath(state)).toBeNull();
  });

  it('leaves a document change that does not create a seam alone', () => {
    const before = stateOf(para(math('x'), text(' '), math('y')));
    const after = run(before, (tr) => tr.insertText('z', 5));
    expect(shape(after)).toBe('<x> z<y>');
  });
});

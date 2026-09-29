import { describe, expect, it } from 'vitest';
import { EditorState, Selection, TextSelection } from 'prosemirror-state';
import type { DecorationSet } from 'prosemirror-view';
import { splitBlocks } from '../../src/shared/markdown/v3/blocks';
import { docFromSpans } from '../../src/shared/markdown/v3/pm/from-mdast';
import {
  SPELL_CHECK_RADIUS,
  SPELL_CHECK_RESCAN,
  rootSpellCheck,
  spellCheckIsScoped,
  spellCheckScopeKey,
  spellCheckScopePlugin,
} from '../../src/renderer/editor/noto/spell-check-scope';
import { STUB_MIN_TOP_LEVEL_BLOCKS } from '../../src/renderer/editor/noto/viewport-stub';

function manyParagraphs(count: number): string {
  return `${Array.from({ length: count }, (_, index) => `Paragraph ${index}.`).join('\n\n')}\n`;
}

function startOf(doc: EditorState['doc'], index: number): number {
  let position = 0;
  for (let i = 0; i < index; i += 1) position += doc.child(i).nodeSize;
  return position;
}

function stateFor(count: number, caretInBlock: number, enabled: () => boolean = () => true): EditorState {
  const doc = docFromSpans(splitBlocks(manyParagraphs(count)).spans);
  const state = EditorState.create({ doc, plugins: [spellCheckScopePlugin(enabled)] });
  return state.apply(state.tr.setSelection(TextSelection.create(doc, startOf(doc, caretInBlock) + 1)));
}

/** The top-level indices that carry `spellcheck="true"`, in order. */
function checkedBlocks(state: EditorState): number[] {
  const set = spellCheckScopeKey.getState(state) as DecorationSet;
  const indices: number[] = [];
  for (const decoration of set.find()) {
    expect((decoration as unknown as { type: { attrs: Record<string, string> } }).type.attrs.spellcheck).toBe('true');
    expect(state.doc.nodeAt(decoration.from)).toBe(state.doc.resolve(decoration.from + 1).node(1));
    indices.push(state.doc.resolve(decoration.from).index(0));
  }
  return indices.sort((a, b) => a - b);
}

const LONG = STUB_MIN_TOP_LEVEL_BLOCKS;

describe('spell checking in a long note', () => {
  it('checks the whole of a short note, from the root', () => {
    const state = stateFor(40, 20);
    expect(spellCheckIsScoped(state.doc)).toBe(false);
    expect(rootSpellCheck(true, state)).toBe('true');
    expect(checkedBlocks(state)).toEqual([]);
  });

  it('checks only the blocks around the selection in a long note', () => {
    const middle = Math.floor(LONG / 2);
    const state = stateFor(LONG, middle);
    expect(spellCheckIsScoped(state.doc)).toBe(true);
    expect(rootSpellCheck(true, state)).toBe('false');
    const expected = [];
    for (let i = middle - SPELL_CHECK_RADIUS; i <= middle + SPELL_CHECK_RADIUS; i += 1) expected.push(i);
    expect(checkedBlocks(state)).toEqual(expected);
  });

  it('stops at the edges of the note', () => {
    expect(checkedBlocks(stateFor(LONG, 0))).toEqual([0, 1, 2]);
    expect(checkedBlocks(stateFor(LONG, LONG - 1))).toEqual([LONG - 3, LONG - 2, LONG - 1]);
  });

  it('handles a selection on the boundary after the last block', () => {
    const state = stateFor(LONG, 0);
    const atEnd = state.apply(state.tr.setSelection(Selection.atEnd(state.doc)));
    const last = atEnd.doc.childCount - 1;
    expect(checkedBlocks(atEnd).at(-1)).toBe(last);
  });

  it('checks nothing when the setting is off', () => {
    const state = stateFor(LONG, 10, () => false);
    expect(rootSpellCheck(false, state)).toBe('false');
    expect(checkedBlocks(state)).toEqual([]);
    expect(rootSpellCheck(false, stateFor(40, 5))).toBe('false');
  });

  it('follows the selection and a change of setting', () => {
    let enabled = true;
    let state = stateFor(LONG, 100, () => enabled);
    expect(checkedBlocks(state)).toContain(100);
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, startOf(state.doc, 2000) + 1)));
    expect(checkedBlocks(state)).toContain(2000);
    expect(checkedBlocks(state)).not.toContain(100);
    enabled = false;
    state = state.apply(state.tr.setMeta(spellCheckScopeKey, SPELL_CHECK_RESCAN));
    expect(checkedBlocks(state)).toEqual([]);
  });
});

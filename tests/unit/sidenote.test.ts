import { describe, expect, it } from 'vitest';
import {
  SIDENOTE_CLASS,
  SIDENOTE_MARKER_CLASS,
  SIDENOTE_TAG_CLOSE,
  SIDENOTE_TAG_OPEN,
  formatSidenoteInsertion,
  isSidenoteClose,
  isSidenoteOpen,
  sidenoteRangesInBlock,
} from '../../src/renderer/plugins/bundled/sidenotes/sidenote';
import {
  INSERT_SIDENOTE,
  REMOVE_SIDENOTE,
  composeSidenote,
  deleteSidenote,
  sidenoteContextItems,
} from '../../src/renderer/plugins/bundled/sidenotes';
import { sidenoteKey, sidenotePlugin } from '../../src/renderer/plugins/bundled/sidenotes/sidenote-plugin';
import { insertSidenote } from '../../src/renderer/plugins/bundled/sidenotes/sidenote-edit';
import type { EditorView } from 'prosemirror-view';
import { EditorState, TextSelection } from 'prosemirror-state';
import { splitBlocks } from '../../src/shared/markdown/v3/blocks';
import { docFromSpans } from '../../src/shared/markdown/v3/pm/from-mdast';
import { blockToMarkdown } from '../../src/shared/markdown/v3/pm/to-mdast';

describe('recognising a sidenote tag', () => {
  it("accepts the author's spelling and the older marginnote class", () => {
    expect(isSidenoteOpen('<span class="sidenote">')).toBe(true);
    expect(isSidenoteOpen("<span class='marginnote'>")).toBe(true);
    expect(isSidenoteOpen('<span class="sidenote" data-x="1">')).toBe(true);
    expect(isSidenoteOpen('<span class="other">')).toBe(false);
    expect(isSidenoteOpen('<span>')).toBe(false);
    expect(isSidenoteClose('</span>')).toBe(true);
    expect(isSidenoteClose('</div>')).toBe(false);
  });
});

describe('the markdown a command writes', () => {
  it('wraps a selection and flattens newlines', () => {
    expect(formatSidenoteInsertion('a note')).toBe(
      `${SIDENOTE_TAG_OPEN}a note${SIDENOTE_TAG_CLOSE}`,
    );
    expect(formatSidenoteInsertion('one\n  two  \n')).toBe(
      `${SIDENOTE_TAG_OPEN}one two${SIDENOTE_TAG_CLOSE}`,
    );
    expect(formatSidenoteInsertion('')).toBe(
      `${SIDENOTE_TAG_OPEN}${SIDENOTE_TAG_CLOSE}`,
    );
  });
});

describe('pairing opens with closes', () => {
  it('numbers notes in reading order and skips a bare closing tag', () => {
    const children = [
      { type: 'text', size: 4 },
      { type: 'inline_html', value: '<span class="sidenote">', size: 1 },
      { type: 'text', size: 5 },
      { type: 'inline_html', value: '</span>', size: 1 },
      { type: 'text', size: 3 },
      { type: 'inline_html', value: '<span class="sidenote">', size: 1 },
      { type: 'text', size: 2 },
      { type: 'inline_html', value: '</span>', size: 1 },
    ];
    const ranges = sidenoteRangesInBlock(children, 10, 0);
    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toMatchObject({
      openFrom: 14, openTo: 15, contentFrom: 15, contentTo: 20,
      closeFrom: 20, closeTo: 21, index: 1,
    });
    expect(ranges[1]).toMatchObject({
      openFrom: 24, openTo: 25, contentFrom: 25, contentTo: 27,
      closeFrom: 27, closeTo: 28, index: 2,
    });
  });

  it('ignores a closing tag with nothing open', () => {
    const children = [
      { type: 'inline_html', value: '</span>', size: 1 },
      { type: 'text', size: 3 },
    ];
    expect(sidenoteRangesInBlock(children, 1, 0)).toEqual([]);
  });
});

describe('the classes the stylesheet paints', () => {
  it('are the names the decorations and the CSS agree on', () => {
    expect(SIDENOTE_CLASS).toBe('noto-sidenote');
    expect(SIDENOTE_MARKER_CLASS).toBe('noto-sidenote-num');
  });
});

function stateFor(markdown: string, from: number, to = from): EditorState {
  const state = EditorState.create({ doc: docFromSpans(splitBlocks(markdown).spans), plugins: [sidenotePlugin()] });
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
}

const markdownOf = (state: EditorState) => blockToMarkdown(state.doc.firstChild!);

/** Open the card on the selection and write `body` from it, as Enter does. */
function written(state: EditorState, body: string): string | null {
  let next = state;
  if (!composeSidenote(state, (tr) => { next = state.apply(tr); })) return null;
  const composer = sidenoteKey.getState(next)!.composer!;
  const tr = next.tr;
  insertSidenote(tr, composer.from, composer.to, body);
  return markdownOf(next.apply(tr));
}

describe('writing a note on the selected words', () => {
  it('wraps the words as its target and writes the note right after them', () => {
    expect(written(stateFor('one two three', 5, 8), 'why two?'))
      .toBe('one <span class="sidenote-target">two</span><span class="sidenote">why two?</span> three');
  });

  it('leaves the spaces at either end of the selection outside the target', () => {
    expect(written(stateFor('one two three', 4, 9), 'n'))
      .toBe('one <span class="sidenote-target">two</span><span class="sidenote">n</span> three');
  });

  it('writes a note with no target at the caret when nothing is selected', () => {
    expect(written(stateFor('one', 4), 'a note')).toBe('one<span class="sidenote">a note</span>');
  });

  it('refuses a fence, and words that already hold a note', () => {
    expect(composeSidenote(stateFor('```\nconst a = 1;\n```', 2, 5))).toBe(false);
    const noted = stateFor('a <span class="sidenote-target">b</span><span class="sidenote">n</span> c', 1, 6);
    expect(composeSidenote(noted)).toBe(false);
  });

  it('refuses words holding another span\u2019s tag, whose close would part them from the note', () => {
    expect(composeSidenote(stateFor('a <span style="color:red">hi</span> there', 3, 10))).toBe(false);
    // Inside such a span, words are fine: both of the target's tags sit within it.
    expect(written(stateFor('a <span style="color:red">hi there</span>', 7, 12), 'n'))
      .toBe('a <span style="color:red">hi <span class="sidenote-target">there</span><span class="sidenote">n</span></span>');
  });
});

describe('a note and its target', () => {
  it('pairs a target with the note that follows it directly, and only that one', () => {
    const tied = sidenoteKey.getState(stateFor('a <span class="sidenote-target">b</span><span class="sidenote">n</span>', 1))!;
    expect(tied.ranges).toHaveLength(1);
    expect(tied.ranges[0]!.target).not.toBeNull();
    const apart = sidenoteKey.getState(stateFor('a <span class="sidenote-target">b</span> <span class="sidenote">n</span>', 1))!;
    expect(apart.ranges[0]!.target).toBeNull();
  });

  it('removes a note and unwraps its target, keeping the words', () => {
    const state = stateFor('one <span class="sidenote-target">two</span><span class="sidenote">why?</span> three', 1);
    let next = state;
    const inside = sidenoteKey.getState(state)!.ranges[0]!.contentFrom + 1;
    const at = state.apply(state.tr.setSelection(TextSelection.create(state.doc, inside)));
    expect(deleteSidenote(at, (tr) => { next = at.apply(tr); })).toBe(true);
    expect(markdownOf(next)).toBe('one two three');
  });

  it('takes the rest of a note with it when an edit deletes one of its tags', () => {
    const state = stateFor('one <span class="sidenote-target">two</span><span class="sidenote">why?</span> three', 1);
    const range = sidenoteKey.getState(state)!.ranges[0]!;
    // The note's opening tag on its own, as a selection over it and a keystroke would.
    const result = state.applyTransaction(state.tr.delete(range.openFrom, range.openTo));
    expect(markdownOf(result.state)).toBe('one twowhy? three');
  });
});

describe('the right-click items', () => {
  const view = (state: EditorState) => ({ state, dispatch: () => {} }) as unknown as EditorView;
  const at = (pos: number) => ({ pos, element: null });

  it('offers Add over words a note can go on, and Remove over a note or its words', () => {
    expect(sidenoteContextItems(view(stateFor('one two', 5, 8)), at(6))).toEqual([{ title: 'Add Sidenote', command: INSERT_SIDENOTE }]);
    expect(sidenoteContextItems(view(stateFor('one two', 2)), at(2))).toEqual([]);
    // A click away from the selected words is not about them.
    expect(sidenoteContextItems(view(stateFor('one two', 5, 8)), at(2))).toEqual([]);
    const noted = stateFor('a <span class="sidenote-target">b</span><span class="sidenote">n</span>', 1);
    const target = sidenoteKey.getState(noted)!.ranges[0]!.target!.contentFrom;
    expect(sidenoteContextItems(view(noted), at(target))).toEqual([{ title: 'Remove Sidenote', command: REMOVE_SIDENOTE }]);
  });
});

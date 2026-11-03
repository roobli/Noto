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
import { surroundSidenote } from '../../src/renderer/plugins/bundled/sidenotes';
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

describe('wrapping a selection as a sidenote', () => {
  function stateFor(markdown: string, from: number, to = from): EditorState {
    const state = EditorState.create({ doc: docFromSpans(splitBlocks(markdown).spans) });
    return state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
  }

  function run(state: EditorState): string | null {
    let next: EditorState | null = null;
    const handled = surroundSidenote(state, (tr) => { next = state.apply(tr); });
    if (!handled || next === null) return null;
    return blockToMarkdown((next as EditorState).doc.firstChild!);
  }

  it('writes the classed span, not a bare one a save would keep without meaning', () => {
    expect(run(stateFor('one two', 5, 8))).toBe('one <span class="sidenote">two</span>');
  });

  it('inserts an empty note around the caret when nothing is selected', () => {
    expect(run(stateFor('one', 4))).toBe('one<span class="sidenote"></span>');
  });

  it('leaves a fence alone', () => {
    expect(run(stateFor('```\nconst a = 1;\n```', 2, 5))).toBeNull();
  });
});

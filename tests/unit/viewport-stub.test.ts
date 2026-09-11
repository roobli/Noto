import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { splitBlocks } from '../../src/shared/markdown/v3/blocks';
import { docFromSpans } from '../../src/shared/markdown/v3/pm/from-mdast';
import {
  STUB_MIN_TOP_LEVEL_BLOCKS,
  blockWindowForY,
  countRealIndices,
  cumulativeHeights,
  estimateAllHeights,
  estimateBlockHeight,
  isIndexReal,
  isIndexStubbed,
  isTopLevelPos,
  selectionRealRange,
  stubbingEnabled,
  topLevelIndexAt,
  unionRanges,
  viewportStubKey,
  viewportStubPlugin,
} from '../../src/renderer/editor/noto/viewport-stub';

function docFor(markdown: string) {
  return docFromSpans(splitBlocks(markdown).spans);
}

function stateFor(markdown: string, caretInBlock = 0): EditorState {
  const doc = docFor(markdown);
  let position = 0;
  for (let index = 0; index < caretInBlock; index += 1) position += doc.child(index).nodeSize;
  const state = EditorState.create({ doc, plugins: [viewportStubPlugin()] });
  return state.apply(state.tr.setSelection(TextSelection.create(doc, Math.min(position + 1, doc.content.size))));
}

function manyParagraphs(count: number): string {
  return `${Array.from({ length: count }, (_, index) => `Paragraph ${index}.`).join('\n\n')}\n`;
}

function withViewport(state: EditorState, viewport: { from: number; to: number }): EditorState {
  return state.apply(state.tr.setMeta(viewportStubKey, { viewport }));
}

describe('when stubbing turns on', () => {
  it('stays off below the large-document threshold', () => {
    expect(stubbingEnabled(STUB_MIN_TOP_LEVEL_BLOCKS - 1)).toBe(false);
    expect(stubbingEnabled(STUB_MIN_TOP_LEVEL_BLOCKS)).toBe(true);
    const state = stateFor(manyParagraphs(20), 0);
    expect(viewportStubKey.getState(state)?.enabled).toBe(false);
  });

  it('turns on for a document at the threshold', () => {
    const state = stateFor(manyParagraphs(STUB_MIN_TOP_LEVEL_BLOCKS), 10);
    const stub = viewportStubKey.getState(state)!;
    expect(stub.enabled).toBe(true);
    expect(stub.heights).toHaveLength(STUB_MIN_TOP_LEVEL_BLOCKS);
  });
});

describe('selection neighbourhood stays real', () => {
  it('keeps a wider window than a single block', () => {
    const state = stateFor(manyParagraphs(40), 20);
    expect(selectionRealRange(state.doc, state.selection)).toEqual({ from: 18, to: 22 });
  });

  it('does not walk past the ends of the document', () => {
    const start = stateFor(manyParagraphs(10), 0);
    expect(selectionRealRange(start.doc, start.selection)).toEqual({ from: 0, to: 2 });
    const end = stateFor(manyParagraphs(10), 9);
    expect(selectionRealRange(end.doc, end.selection)).toEqual({ from: 7, to: 9 });
  });

  it('marks only indices outside the real windows as stubbed', () => {
    const state = stateFor(manyParagraphs(STUB_MIN_TOP_LEVEL_BLOCKS), 100);
    const stub = viewportStubKey.getState(state)!;
    expect(stub.enabled).toBe(true);
    expect(isIndexStubbed(stub, stub.selection.from, 'paragraph')).toBe(false);
    expect(isIndexStubbed(stub, stub.selection.to, 'paragraph')).toBe(false);
    if (stub.selection.from > 0) {
      expect(isIndexStubbed(stub, stub.selection.from - 1, 'paragraph')).toBe(true);
    }
    expect(isIndexStubbed(stub, stub.selection.from, 'code_block')).toBe(false);
  });
});

describe('vertical window from estimated heights', () => {
  it('finds the blocks that intersect a y-range', () => {
    const heights = Float64Array.from([10, 20, 30, 40, 50]);
    const cumulative = cumulativeHeights(heights);
    expect(Array.from(cumulative)).toEqual([0, 10, 30, 60, 100, 150]);
    expect(blockWindowForY(cumulative, 0, 25)).toEqual({ from: 0, to: 1 });
    expect(blockWindowForY(cumulative, 30, 90)).toEqual({ from: 2, to: 3 });
    expect(blockWindowForY(cumulative, 140, 200)).toEqual({ from: 4, to: 4 });
  });

  it('can still compute a contiguous envelope when windows overlap', () => {
    expect(unionRanges({ from: 10, to: 20 }, { from: 18, to: 22 }, 100)).toEqual({ from: 10, to: 22 });
    // Contiguous envelope spans the gap — membership must NOT use this alone.
    expect(unionRanges({ from: 50, to: 60 }, { from: 0, to: 2 }, 100)).toEqual({ from: 0, to: 60 });
  });
});

describe('scroll-away keeps the gap stubbed', () => {
  it('does not keep every block between caret and viewport real', () => {
    let state = stateFor(manyParagraphs(STUB_MIN_TOP_LEVEL_BLOCKS + 100), 0);
    // Caret stays near the top; viewport jumps far down — the body-feel case.
    state = withViewport(state, { from: 800, to: 860 });
    const stub = viewportStubKey.getState(state)!;
    expect(stub.enabled).toBe(true);
    expect(stub.selection.to).toBeLessThan(10);
    expect(stub.viewport.from).toBe(800);

    // Ends of each window stay real.
    expect(isIndexReal(stub, stub.selection.from)).toBe(true);
    expect(isIndexReal(stub, stub.viewport.from)).toBe(true);
    expect(isIndexStubbed(stub, stub.viewport.from, 'paragraph')).toBe(false);

    // The gap between them must stay stubbed — contiguous union was the bug.
    const gap = Math.floor((stub.selection.to + stub.viewport.from) / 2);
    expect(gap).toBeGreaterThan(stub.selection.to);
    expect(gap).toBeLessThan(stub.viewport.from);
    expect(isIndexReal(stub, gap)).toBe(false);
    expect(isIndexStubbed(stub, gap, 'paragraph')).toBe(true);

    const realCount = countRealIndices(stub, state.doc.childCount);
    const contiguous = stub.real.to - stub.real.from + 1;
    expect(realCount).toBeLessThan(150);
    expect(contiguous).toBeGreaterThan(700);
    expect(realCount).toBeLessThan(contiguous / 4);
  });
});

describe('top-level positions', () => {
  it('recognises direct children of the document', () => {
    const doc = docFor('One.\n\nTwo.\n\nThree.\n');
    expect(isTopLevelPos(doc, 0)).toBe(true);
    expect(topLevelIndexAt(doc, 0)).toBe(0);
    const second = doc.child(0).nodeSize;
    expect(topLevelIndexAt(doc, second)).toBe(1);
    expect(isTopLevelPos(doc, 1)).toBe(false);
    expect(topLevelIndexAt(doc, 1)).toBeNull();
  });
});

describe('height estimates', () => {
  it('are positive for ordinary blocks', () => {
    const doc = docFor('# Title\n\nA short paragraph.\n\n---\n\n- item\n\n```\none\ntwo\n```\n');
    const heights = estimateAllHeights(doc, 16);
    expect(heights.length).toBe(doc.childCount);
    for (let index = 0; index < heights.length; index += 1) {
      expect(heights[index]).toBeGreaterThan(0);
      expect(estimateBlockHeight(doc.child(index), 16)).toBeGreaterThan(0);
    }
  });
});

describe('large-document real window', () => {
  it('keeps only a neighbourhood real around the caret on open', () => {
    const state = stateFor(manyParagraphs(STUB_MIN_TOP_LEVEL_BLOCKS + 200), 50);
    const stub = viewportStubKey.getState(state)!;
    expect(stub.enabled).toBe(true);
    const realCount = countRealIndices(stub, state.doc.childCount);
    expect(realCount).toBeLessThan(200);
    expect(realCount).toBeGreaterThanOrEqual(5);
    expect(stub.selection.from).toBeLessThanOrEqual(50);
    expect(stub.selection.to).toBeGreaterThanOrEqual(50);
  });

  it('moves the selection window when the caret does', () => {
    let state = stateFor(manyParagraphs(STUB_MIN_TOP_LEVEL_BLOCKS), 0);
    let stub = viewportStubKey.getState(state)!;
    expect(stub.selection.from).toBe(0);

    let position = 0;
    for (let index = 0; index < 80; index += 1) position += state.doc.child(index).nodeSize;
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, position + 1)));
    stub = viewportStubKey.getState(state)!;
    expect(stub.selection.from).toBeGreaterThan(70);
    expect(isIndexReal(stub, 80)).toBe(true);
  });
});

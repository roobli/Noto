import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { splitBlocks } from '../../src/shared/markdown/v3/blocks';
import { docFromSpans } from '../../src/shared/markdown/v3/pm/from-mdast';
import {
  STUB_MIN_TOP_LEVEL_BLOCKS,
  SPECIALISED_STUBBABLE_TYPES,
  STUBBABLE_TYPES,
  blockWindowForY,
  countRealIndices,
  cumulativeHeights,
  STUB_BLOCK_GAP_EM,
  blockGapPx,
  estimateAllHeights,
  estimateBlockHeight,
  isIndexReal,
  isIndexStubbed,
  isTopLevelPos,
  mergeStubAwareNodeViews,
  selectionRealRange,
  stubbingEnabled,
  topLevelIndexAt,
  unionRanges,
  slideViewportWindow,
  viewportNeedsRemount,
  viewportStubKey,
  viewportStubPlugin,
  wrapSpecialisedStubbable,
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
    // Selection neighbourhood stays real for specialised types too.
    expect(isIndexStubbed(stub, stub.selection.from, 'code_block')).toBe(false);
    expect(isIndexStubbed(stub, stub.selection.from, 'table')).toBe(false);
    expect(isIndexStubbed(stub, stub.selection.from, 'math_block')).toBe(false);
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

  it('answers exactly what resolving the position says, at every position', () => {
    const doc = docFor('# Title\n\nA paragraph.\n\n---\n\n- one\n- two\n\n```\ncode\n```\n\n> quote\n\nEnd.\n');
    for (let pos = -1; pos <= doc.content.size + 1; pos += 1) {
      const inside = pos >= 0 && pos <= doc.content.size;
      const expected = inside && doc.resolve(pos).depth === 0 ? doc.resolve(pos).index() : null;
      expect(topLevelIndexAt(doc, pos), `pos ${pos}`).toBe(expected);
      expect(isTopLevelPos(doc, pos), `pos ${pos}`).toBe(expected !== null);
    }
  });

  it('stays fast for every block of a long note', () => {
    // Each stubbable block asks for its index as the view is built. Resolving
    // each position walked the children from the first: quadratic.
    const doc = docFor(`${Array.from({ length: 40_000 }, (_, index) => `P${index}.`).join('\n\n')}\n`);
    const started = performance.now();
    let found = 0;
    doc.forEach((_child, offset) => { if (topLevelIndexAt(doc, offset) !== null) found += 1; });
    expect(found).toBe(40_000);
    expect(performance.now() - started).toBeLessThan(500);
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

  it('folds the document block-rhythm gap into each estimate', () => {
    expect(STUB_BLOCK_GAP_EM).toBeCloseTo(0.74);
    expect(blockGapPx(16)).toBeCloseTo(16 * 0.74);
    const doc = docFor('A short paragraph.\n');
    const estimated = estimateBlockHeight(doc.child(0), 16);
    // Content is one line (1.6em) plus the collapsed neighbour gap.
    expect(estimated).toBeCloseTo(16 * 1.6 + 16 * 0.74);
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

describe('viewport remount hysteresis', () => {
  it('stays put while the visible band is inside the buffered window', () => {
    expect(viewportNeedsRemount({ from: 100, to: 200 }, { from: 120, to: 180 })).toBe(false);
  });

  it('remounts when the visible band crosses an edge', () => {
    expect(viewportNeedsRemount({ from: 100, to: 200 }, { from: 90, to: 180 })).toBe(true);
    expect(viewportNeedsRemount({ from: 100, to: 200 }, { from: 120, to: 210 })).toBe(true);
  });
});

describe('slideViewportWindow remount batch', () => {
  it('extends the leading edge without tearing the trailing buffer on a small advance', () => {
    const current = { from: 100, to: 200 };
    // Ideal recenter jumped the trailing edge forward by ~40; a hard take would
    // remount 40 leave + 40 enter. With slack, keep from and only extend to.
    const ideal = { from: 140, to: 240 };
    expect(slideViewportWindow(current, ideal, 1000)).toEqual({ from: 100, to: 240 });
  });

  it('slides the trailing edge once the window exceeds the slack budget', () => {
    const current = { from: 100, to: 200 };
    // idealSpan=100, maxSpan=150 → nextTo=300 implies nextFrom >= 150
    const ideal = { from: 200, to: 300 };
    expect(slideViewportWindow(current, ideal, 1000)).toEqual({ from: 150, to: 300 });
  });

  it('takes the ideal window on a disjoint jump', () => {
    expect(slideViewportWindow({ from: 10, to: 40 }, { from: 400, to: 460 }, 1000))
      .toEqual({ from: 400, to: 460 });
  });
});


describe('specialised types participate in stubbing', () => {
  it('lists fences, tables and display math among stubbable types', () => {
    expect(STUBBABLE_TYPES).toEqual(expect.arrayContaining([...SPECIALISED_STUBBABLE_TYPES]));
    expect(SPECIALISED_STUBBABLE_TYPES).toEqual(['code_block', 'table', 'math_block']);
  });

  it('stubs specialised types outside the real windows', () => {
    let state = stateFor(manyParagraphs(STUB_MIN_TOP_LEVEL_BLOCKS + 100), 0);
    state = withViewport(state, { from: 800, to: 860 });
    const stub = viewportStubKey.getState(state)!;
    const gap = Math.floor((stub.selection.to + stub.viewport.from) / 2);
    expect(isIndexStubbed(stub, gap, 'code_block')).toBe(true);
    expect(isIndexStubbed(stub, gap, 'table')).toBe(true);
    expect(isIndexStubbed(stub, gap, 'math_block')).toBe(true);
    // HTML / images stay always-real in this cut.
    expect(isIndexStubbed(stub, gap, 'html_block')).toBe(false);
    expect(isIndexStubbed(stub, gap, 'image')).toBe(false);
  });

  it('keeps specialised types real inside either window', () => {
    let state = stateFor(manyParagraphs(STUB_MIN_TOP_LEVEL_BLOCKS + 100), 0);
    state = withViewport(state, { from: 800, to: 860 });
    const stub = viewportStubKey.getState(state)!;
    expect(isIndexStubbed(stub, stub.viewport.from, 'code_block')).toBe(false);
    expect(isIndexStubbed(stub, stub.selection.from, 'table')).toBe(false);
  });
});

describe('mergeStubAwareNodeViews', () => {
  it('wraps specialised constructors and leaves others alone', () => {
    const calls: string[] = [];
    const fake = (label: string) => () => {
      calls.push(label);
      return { dom: {} as HTMLElement };
    };
    const specialised = {
      code_block: fake('code') as never,
      table: fake('table') as never,
      math_block: fake('math') as never,
      math_inline: fake('inline') as never,
      html_block: fake('html') as never,
    };
    const merged = mergeStubAwareNodeViews(specialised);
    expect(merged.code_block).not.toBe(specialised.code_block);
    expect(merged.table).not.toBe(specialised.table);
    expect(merged.math_block).not.toBe(specialised.math_block);
    expect(merged.math_inline).toBe(specialised.math_inline);
    expect(merged.html_block).toBe(specialised.html_block);
    expect(typeof wrapSpecialisedStubbable).toBe('function');
    // Default stubbables are present.
    expect(merged.paragraph).toBeTypeOf('function');
    expect(merged.heading).toBeTypeOf('function');
  });
});

describe('decoration set identity', () => {
  it('reuses the decorations set when membership does not change', () => {
    let state = stateFor(manyParagraphs(STUB_MIN_TOP_LEVEL_BLOCKS + 50), 10);
    state = withViewport(state, { from: 100, to: 140 });
    const before = viewportStubKey.getState(state)!;
    expect(before.decorations).toBeTruthy();
    // Same viewport meta again — no membership change.
    const again = withViewport(state, { from: 100, to: 140 });
    const after = viewportStubKey.getState(again)!;
    expect(after.decorations).toBe(before.decorations);
  });

  it('maps decorations through a doc edit that keeps the same windows', () => {
    let state = stateFor(manyParagraphs(STUB_MIN_TOP_LEVEL_BLOCKS + 50), 10);
    state = withViewport(state, { from: 100, to: 140 });
    const before = viewportStubKey.getState(state)!;
    const edited = state.apply(state.tr.insertText('x', state.selection.from));
    const after = viewportStubKey.getState(edited)!;
    expect(after.viewport).toEqual(before.viewport);
    expect(after.selection).toEqual(before.selection);
    // Mapped set — not the same object, but still a live DecorationSet for the new doc.
    expect(after.decorations).not.toBe(before.decorations);
    expect(after.decorations.find().length).toBe(before.decorations.find().length);
  });

  it('rebuilds decorations when the viewport window moves', () => {
    let state = stateFor(manyParagraphs(STUB_MIN_TOP_LEVEL_BLOCKS + 50), 10);
    state = withViewport(state, { from: 100, to: 140 });
    const before = viewportStubKey.getState(state)!;
    const moved = withViewport(state, { from: 200, to: 240 });
    const after = viewportStubKey.getState(moved)!;
    expect(after.decorations).not.toBe(before.decorations);
    expect(after.generation).toBeGreaterThan(before.generation);
  });
});

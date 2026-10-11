/**
 * @vitest-environment happy-dom
 *
 * A wide selection on a stubbed note keeps only its two ends real.
 *
 * The selection window used to be the whole span between the selection's
 * ends, so Select All on a long note mounted every block and threw away what
 * sparse docView saves on open (the 8 MB corpus: ~15 s to select, ~3.5 s to
 * collapse, in happy-dom). These lock the split windows and that editing a
 * selection whose interior sits in range spacers still edits the document.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { AllSelection, EditorState, TextSelection } from 'prosemirror-state';
import { history, redo, undo } from 'prosemirror-history';
import { EditorView } from 'prosemirror-view';
import { splitBlocks } from '../../src/shared/markdown/v3/blocks';
import { docFromSpans } from '../../src/shared/markdown/v3/pm/from-mdast';
import { fenceNodeViews } from '../../src/renderer/editor/noto/fence-view';
import { mathNodeViews } from '../../src/renderer/editor/noto/math-view';
import { tableNodeViews } from '../../src/renderer/editor/noto/table-view';
import {
  STUB_MIN_TOP_LEVEL_BLOCKS,
  STUB_SELECTION_RADIUS,
  STUB_SELECTION_SPAN_MAX,
  isIndexReal,
  mergeStubAwareNodeViews,
  selectionRealWindows,
  viewportStubKey,
  viewportStubPlugin,
} from '../../src/renderer/editor/noto/viewport-stub';
import {
  isRangeSpacer,
  sparseTopLevelDescAt,
} from '../../src/renderer/editor/noto/sparse-doc-view';

function docFor(markdown: string) {
  return docFromSpans(splitBlocks(markdown).spans);
}

function specialisedMarkdown(): string {
  const head = Array.from({ length: 40 }, (_, index) => `Lead ${index}.`).join('\n\n');
  const specialised = [
    '```ts\nconst a = 1;\nconst b = 2;\n```',
    '| H | T |\n| --- | --- |\n| a | b |\n| c | d |',
    '$$\nx = y + 1\n$$',
  ].join('\n\n');
  const mid = Array.from(
    { length: STUB_MIN_TOP_LEVEL_BLOCKS },
    (_, index) => `Body ${index}.`,
  ).join('\n\n');
  const tail = [
    '```js\ntailFence();\n```',
    '| Z | Y |\n| --- | --- |\n| 1 | 2 |',
    '$$\nz = 0\n$$',
    'End.',
  ].join('\n\n');
  return `${head}\n\n${specialised}\n\n${mid}\n\n${tail}\n`;
}

function mount(markdown: string): { view: EditorView } {
  const doc = docFor(markdown);
  expect(doc.childCount).toBeGreaterThanOrEqual(STUB_MIN_TOP_LEVEL_BLOCKS);

  const scroller = document.createElement('div');
  scroller.className = 'canvas-scroll';
  scroller.style.overflowY = 'auto';
  scroller.style.height = '400px';

  const host = document.createElement('div');
  host.className = 'noto-editor-host';
  host.style.fontSize = '16px';

  const mountPoint = document.createElement('div');
  host.append(mountPoint);
  scroller.append(host);
  document.body.append(scroller);

  const specialised = {
    ...mathNodeViews(),
    ...fenceNodeViews(),
    ...tableNodeViews(),
  };
  const state = EditorState.create({
    doc,
    plugins: [history(), viewportStubPlugin()],
  });
  const view = new EditorView(mountPoint, {
    state,
    nodeViews: mergeStubAwareNodeViews(specialised),
  });
  return { view };
}

function startOf(doc: ReturnType<typeof docFor>, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i += 1) pos += doc.child(i).nodeSize;
  return pos;
}

function setViewport(view: EditorView, from: number, to: number): void {
  view.dispatch(view.state.tr.setMeta(viewportStubKey, { viewport: { from, to } }));
}

/** Top-level descs cover the document exactly, spacers included. */
function expectDescsCoverDoc(view: EditorView): void {
  const docView = (view as unknown as { docView: { children: { size: number }[] } }).docView;
  const total = docView.children.reduce((sum, child) => sum + child.size, 0);
  expect(total).toBe(view.state.doc.content.size);
}

function realIndices(view: EditorView): number[] {
  const stub = viewportStubKey.getState(view.state)!;
  const out: number[] = [];
  for (let index = 0; index < view.state.doc.childCount; index += 1) {
    if (isIndexReal(stub, index)) out.push(index);
  }
  return out;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('selectionRealWindows', () => {
  const doc = docFor(specialisedMarkdown());

  it('keeps a narrow selection as one contiguous span', () => {
    const from = startOf(doc, 10) + 1;
    const to = startOf(doc, 10 + STUB_SELECTION_SPAN_MAX) + 1;
    const { start, end } = selectionRealWindows(doc, TextSelection.create(doc, from, to));
    expect(start).toEqual({
      from: 10 - STUB_SELECTION_RADIUS,
      to: 10 + STUB_SELECTION_SPAN_MAX + STUB_SELECTION_RADIUS,
    });
    expect(end).toEqual(start);
  });

  it('splits a wide selection into the neighbourhoods of its two ends', () => {
    const toIndex = 11 + STUB_SELECTION_SPAN_MAX;
    const selection = TextSelection.create(doc, startOf(doc, 10) + 1, startOf(doc, toIndex) + 1);
    const { start, end } = selectionRealWindows(doc, selection);
    expect(start).toEqual({ from: 10 - STUB_SELECTION_RADIUS, to: 10 + STUB_SELECTION_RADIUS });
    expect(end).toEqual({ from: toIndex - STUB_SELECTION_RADIUS, to: toIndex + STUB_SELECTION_RADIUS });
  });

  it('orders the windows by document position for a backward selection', () => {
    const selection = TextSelection.create(doc, startOf(doc, 2000) + 1, startOf(doc, 5) + 1);
    const { start, end } = selectionRealWindows(doc, selection);
    expect(start.from).toBeLessThan(end.from);
    expect(end).toEqual({ from: 2000 - STUB_SELECTION_RADIUS, to: 2000 + STUB_SELECTION_RADIUS });
  });

  it('clamps an AllSelection to the last block', () => {
    const { start, end } = selectionRealWindows(doc, new AllSelection(doc));
    const last = doc.childCount - 1;
    expect(start).toEqual({ from: 0, to: STUB_SELECTION_RADIUS });
    expect(end).toEqual({ from: last - STUB_SELECTION_RADIUS, to: last });
  });
});

describe('wide selection on a stubbed note', () => {
  it('Select All mounts only the two ends, then collapses back', () => {
    const { view } = mount(specialisedMarkdown());
    setViewport(view, 0, 5);
    const count = view.state.doc.childCount;

    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
    const real = realIndices(view);
    expect(real.length).toBeLessThan(20);
    expect(real).toContain(0);
    expect(real).toContain(count - 1);
    expect(isRangeSpacer(sparseTopLevelDescAt(view, Math.floor(count / 2)))).toBe(true);
    expect(view.dom.childElementCount).toBeLessThan(20);
    expect(isRangeSpacer(sparseTopLevelDescAt(view, count - 1))).toBe(false);
    expectDescsCoverDoc(view);

    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
    expect(realIndices(view).length).toBeLessThan(20);
    expect(isRangeSpacer(sparseTopLevelDescAt(view, count - 1))).toBe(true);
    expectDescsCoverDoc(view);
    view.destroy();
  });

  it('places the DOM selection on the two real ends', () => {
    const { view } = mount(specialisedMarkdown());
    setViewport(view, 0, 5);
    const doc = view.state.doc;
    const toIndex = doc.childCount - 10;
    const anchor = startOf(doc, 3) + 2;
    const head = startOf(doc, toIndex) + 3;
    view.focus();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, anchor, head)));

    // happy-dom reports focusNode as the anchor; read the range's ends instead.
    const range = document.getSelection()!.getRangeAt(0);
    expect(view.dom.contains(range.startContainer)).toBe(true);
    expect(view.dom.contains(range.endContainer)).toBe(true);
    expect(view.posAtDOM(range.startContainer, range.startOffset)).toBe(anchor);
    expect(view.posAtDOM(range.endContainer, range.endOffset)).toBe(head);
    expect(isRangeSpacer(sparseTopLevelDescAt(view, Math.floor((3 + toIndex) / 2)))).toBe(true);
    view.destroy();
  });

  it('deletes and types over a selection whose interior is in spacers, and undoes', () => {
    const { view } = mount(specialisedMarkdown());
    setViewport(view, 0, 5);
    const before = view.state.doc;
    const toIndex = before.childCount - 30;
    const from = startOf(before, 3) + 1;
    const to = startOf(before, toIndex) + 2;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(before, from, to)));
    expect(isRangeSpacer(sparseTopLevelDescAt(view, Math.floor((3 + toIndex) / 2)))).toBe(true);

    view.dispatch(view.state.tr.insertText('Z'));
    const after = view.state.doc;
    expect(after.childCount).toBe(before.childCount - (toIndex - 3));
    expect(after.child(3).textContent).toBe(`Z${before.child(toIndex).textContent.slice(1)}`);
    expectDescsCoverDoc(view);
    const caretBlock = sparseTopLevelDescAt(view, 3) as unknown as { dom: HTMLElement };
    expect(caretBlock.dom.textContent).toBe(after.child(3).textContent);

    undo(view.state, view.dispatch);
    expect(view.state.doc.eq(before)).toBe(true);
    expect(realIndices(view).length).toBeLessThan(40);
    expectDescsCoverDoc(view);

    redo(view.state, view.dispatch);
    expect(view.state.doc.eq(after)).toBe(true);
    expectDescsCoverDoc(view);
    view.destroy();
  });

  it('mounts the interior when the viewport scrolls into a wide selection', () => {
    const { view } = mount(specialisedMarkdown());
    setViewport(view, 0, 5);
    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
    const mid = Math.floor(view.state.doc.childCount / 2);
    expect(isRangeSpacer(sparseTopLevelDescAt(view, mid))).toBe(true);

    setViewport(view, mid - 3, mid + 3);
    expect(isRangeSpacer(sparseTopLevelDescAt(view, mid))).toBe(false);
    expect(view.state.selection instanceof AllSelection).toBe(true);
    expectDescsCoverDoc(view);
    view.destroy();
  });

  it('keeps a narrow multi-block selection fully real', () => {
    const { view } = mount(specialisedMarkdown());
    setViewport(view, 0, 5);
    const doc = view.state.doc;
    const fromIndex = 200;
    const toIndex = fromIndex + STUB_SELECTION_SPAN_MAX;
    view.dispatch(view.state.tr.setSelection(
      TextSelection.create(doc, startOf(doc, fromIndex) + 1, startOf(doc, toIndex) + 1),
    ));
    for (let index = fromIndex; index <= toIndex; index += 1) {
      expect(isRangeSpacer(sparseTopLevelDescAt(view, index))).toBe(false);
    }
    view.destroy();
  });
});

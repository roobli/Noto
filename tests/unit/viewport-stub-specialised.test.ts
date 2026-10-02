/**
 * @vitest-environment happy-dom
 *
 * Remount coverage for specialised stubbing: fences, tables and display math
 * must stand in as stubs off-viewport and remount their real NodeViews when
 * the real window covers them — without breaking contentDOM editing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { splitBlocks } from '../../src/shared/markdown/v3/blocks';
import { docFromSpans } from '../../src/shared/markdown/v3/pm/from-mdast';
import { fenceNodeViews } from '../../src/renderer/editor/noto/fence-view';
import { mathNodeViews } from '../../src/renderer/editor/noto/math-view';
import { tableNodeViews } from '../../src/renderer/editor/noto/table-view';
import {
  STUB_CLASS,
  STUB_MIN_TOP_LEVEL_BLOCKS,
  findScroller,
  mergeStubAwareNodeViews,
  topLevelIndexAt,
  viewportStubKey,
  viewportStubPlugin,
} from '../../src/renderer/editor/noto/viewport-stub';

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

function mount(markdown: string): { view: EditorView; host: HTMLElement; scroller: HTMLElement } {
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
    plugins: [viewportStubPlugin()],
  });
  const view = new EditorView(mountPoint, {
    state,
    nodeViews: mergeStubAwareNodeViews(specialised),
  });
  return { view, host, scroller };
}

function childAt(view: EditorView, index: number): HTMLElement {
  const child = view.dom.children[index];
  if (!(child instanceof HTMLElement)) throw new Error(`no child at ${index}`);
  return child;
}

function indexOfType(doc: ReturnType<typeof docFor>, typeName: string, occurrence: number): number {
  let seen = 0;
  for (let index = 0; index < doc.childCount; index += 1) {
    if (doc.child(index).type.name === typeName) {
      if (seen === occurrence) return index;
      seen += 1;
    }
  }
  throw new Error(`no ${typeName} #${occurrence}`);
}

function setViewport(view: EditorView, from: number, to: number): void {
  view.dispatch(view.state.tr.setMeta(viewportStubKey, { viewport: { from, to } }));
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('specialised stub remount', () => {
  it('stubs far fences/tables/math and remounts them when the viewport covers them', () => {
    const { view } = mount(specialisedMarkdown());
    const stub = viewportStubKey.getState(view.state)!;
    expect(stub.enabled).toBe(true);

    const fenceIndex = indexOfType(view.state.doc, 'code_block', 1); // tail fence
    const tableIndex = indexOfType(view.state.doc, 'table', 1);
    const mathIndex = indexOfType(view.state.doc, 'math_block', 1);
    expect(fenceIndex).toBeGreaterThan(1000);

    // Open leaves selection near the start; push viewport to the lead only so
    // the tail specialised blocks stay outside both real windows.
    setViewport(view, 0, 20);

    expect(childAt(view, fenceIndex).classList.contains(STUB_CLASS)).toBe(true);
    expect(childAt(view, fenceIndex).dataset.stubType).toBe('code_block');
    expect(childAt(view, tableIndex).classList.contains(STUB_CLASS)).toBe(true);
    expect(childAt(view, tableIndex).dataset.stubType).toBe('table');
    expect(childAt(view, mathIndex).classList.contains(STUB_CLASS)).toBe(true);
    expect(childAt(view, mathIndex).dataset.stubType).toBe('math_block');

    // Scroll the real window over the tail specialised trio — remount.
    setViewport(view, fenceIndex - 2, mathIndex + 2);

    const fence = childAt(view, fenceIndex);
    expect(fence.classList.contains(STUB_CLASS)).toBe(false);
    expect(fence.classList.contains('noto-fence')).toBe(true);
    expect(fence.querySelector('.noto-fence-code')).not.toBeNull();

    const table = childAt(view, tableIndex);
    expect(table.classList.contains(STUB_CLASS)).toBe(false);
    expect(table.querySelector('table')).not.toBeNull();

    const math = childAt(view, mathIndex);
    expect(math.classList.contains(STUB_CLASS)).toBe(false);
    expect(math.classList.contains('noto-math-block')).toBe(true);

    // Leave again — specialised views remount back to stubs.
    setViewport(view, 0, 20);
    expect(childAt(view, fenceIndex).classList.contains(STUB_CLASS)).toBe(true);
    expect(childAt(view, tableIndex).classList.contains(STUB_CLASS)).toBe(true);
    expect(childAt(view, mathIndex).classList.contains(STUB_CLASS)).toBe(true);

    view.destroy();
  });

  it('lets the caret edit a remounted fence', () => {
    const { view } = mount(specialisedMarkdown());
    const fenceIndex = indexOfType(view.state.doc, 'code_block', 0); // near the lead
    // Cover that fence with the viewport so it remounts as FenceView.
    setViewport(view, Math.max(0, fenceIndex - 5), fenceIndex + 5);

    const fence = childAt(view, fenceIndex);
    expect(fence.classList.contains('noto-fence')).toBe(true);

    let pos = 0;
    for (let index = 0; index < fenceIndex; index += 1) pos += view.state.doc.child(index).nodeSize;
    // Inside the code_block text.
    const inside = pos + 2;
    expect(topLevelIndexAt(view.state.doc, pos)).toBe(fenceIndex);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, inside)));
    view.dispatch(view.state.tr.insertText('Z'));

    const node = view.state.doc.child(fenceIndex);
    expect(node.type.name).toBe('code_block');
    expect(node.textContent.startsWith('Z') || node.textContent.includes('Z')).toBe(true);
    // Still the specialised view after the edit.
    expect(childAt(view, fenceIndex).classList.contains('noto-fence')).toBe(true);

    view.destroy();
  });

  it('keeps a specialised block under the selection real even when the viewport is far', () => {
    const { view } = mount(specialisedMarkdown());
    const fenceIndex = indexOfType(view.state.doc, 'code_block', 1);
    let pos = 0;
    for (let index = 0; index < fenceIndex; index += 1) pos += view.state.doc.child(index).nodeSize;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 2)));
    setViewport(view, 0, 10);

    const stub = viewportStubKey.getState(view.state)!;
    expect(stub.selection.from).toBeLessThanOrEqual(fenceIndex);
    expect(stub.selection.to).toBeGreaterThanOrEqual(fenceIndex);
    expect(childAt(view, fenceIndex).classList.contains('noto-fence')).toBe(true);

    view.destroy();
  });
});

describe('findScroller avoids layout on the ProseMirror mount parent', () => {
  it('finds an inline-overflow scroller without computing style on the mount parent', () => {
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    const host = document.createElement('div');
    host.className = 'noto-editor-host';
    const mountPoint = document.createElement('div');
    host.append(mountPoint);
    scroller.append(host);
    document.body.append(scroller);

    const view = new EditorView(mountPoint, {
      state: EditorState.create({ doc: docFor('Hello.\n\nWorld.\n') }),
    });

    const computedOn: Element[] = [];
    const original = globalThis.getComputedStyle;
    globalThis.getComputedStyle = ((el: Element, ...rest: unknown[]) => {
      computedOn.push(el);
      return (original as typeof getComputedStyle)(el, ...(rest as []));
    }) as typeof getComputedStyle;

    try {
      expect(findScroller(view)).toBe(scroller);
      expect(computedOn).not.toContain(mountPoint);
      expect(computedOn).not.toContain(view.dom.parentElement);
    } finally {
      globalThis.getComputedStyle = original;
      view.destroy();
      document.body.replaceChildren();
    }
  });

  it('recognises .canvas-scroll without reading computed overflow on the mount parent', () => {
    const scroller = document.createElement('div');
    scroller.className = 'canvas-scroll';
    // Product sets overflow via stylesheet, not inline — class must be enough.
    const host = document.createElement('div');
    host.className = 'noto-editor-host';
    const mountPoint = document.createElement('div');
    host.append(mountPoint);
    scroller.append(host);
    document.body.append(scroller);

    const view = new EditorView(mountPoint, {
      state: EditorState.create({ doc: docFor('Hello.\n\nWorld.\n') }),
    });

    const computedOn: Element[] = [];
    const original = globalThis.getComputedStyle;
    globalThis.getComputedStyle = ((el: Element, ...rest: unknown[]) => {
      computedOn.push(el);
      return (original as typeof getComputedStyle)(el, ...(rest as []));
    }) as typeof getComputedStyle;

    try {
      expect(findScroller(view)).toBe(scroller);
      expect(computedOn).not.toContain(mountPoint);
    } finally {
      globalThis.getComputedStyle = original;
      view.destroy();
      document.body.replaceChildren();
    }
  });
});

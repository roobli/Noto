/**
 * @vitest-environment happy-dom
 *
 * Remount coverage for specialised stubbing: fences, tables and display math
 * must stand in as stubs off-viewport and remount their real NodeViews when
 * the real window covers them — without breaking contentDOM editing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EditorState, Plugin, TextSelection } from 'prosemirror-state';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
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
  // Sparse docView: DOM child index ≠ top-level block index. Resolve via desc.
  const desc = sparseTopLevelDescAt(view, index);
  if (desc?.dom instanceof HTMLElement) return desc.dom;
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

    // Sparse docView: far specialised blocks live inside a range spacer, not
    // a per-type stub shell. The spacer carries STUB_CLASS + data-stub-range.
    for (const index of [fenceIndex, tableIndex, mathIndex]) {
      const el = childAt(view, index);
      expect(el.classList.contains(STUB_CLASS)).toBe(true);
      const desc = sparseTopLevelDescAt(view, index);
      expect(isRangeSpacer(desc)).toBe(true);
      if (isRangeSpacer(desc)) {
        expect(desc.indexFrom).toBeLessThanOrEqual(index);
        expect(desc.indexTo).toBeGreaterThanOrEqual(index);
      }
    }

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


describe('band-enter remount path', () => {
  it('remounts a fence into the real window without throwing', () => {
    const { view } = mount(specialisedMarkdown());
    setViewport(view, 0, 20);
    const fenceIndex = indexOfType(view.state.doc, 'code_block', 1);
    expect(isRangeSpacer(sparseTopLevelDescAt(view, fenceIndex))).toBe(true);

    setViewport(view, fenceIndex - 2, fenceIndex + 5);
    const fence = childAt(view, fenceIndex);
    expect(fence.classList.contains(STUB_CLASS)).toBe(false);
    expect(fence.classList.contains('noto-fence')).toBe(true);
    expect(isRangeSpacer(sparseTopLevelDescAt(view, fenceIndex))).toBe(false);

    view.destroy();
  });

  it('remounts through a top-level widget sibling (sparse children stay small)', () => {
    // Widgets at top-level boundaries must not break sparse index lookup.
    const widgetPlugin = new Plugin({
      props: {
        decorations(state) {
          const first = state.doc.firstChild;
          if (!first) return DecorationSet.empty;
          const end = first.nodeSize;
          return DecorationSet.create(state.doc, [
            Decoration.widget(end, () => {
              const el = document.createElement('span');
              el.className = 'noto-test-top-widget';
              el.textContent = 'w';
              return el;
            }, { side: 1, key: 'noto-test-top-widget' }),
          ]);
        },
      },
    });

    const markdown = specialisedMarkdown();
    const doc = docFor(markdown);
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    scroller.style.height = '600px';
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
      plugins: [viewportStubPlugin(), widgetPlugin],
    });
    const view = new EditorView(mountPoint, {
      state,
      nodeViews: mergeStubAwareNodeViews(specialised),
    });

    try {
      setViewport(view, 0, 20);
      const fenceIndex = indexOfType(view.state.doc, 'code_block', 1);
      setViewport(view, fenceIndex - 2, fenceIndex + 5);

      const fence = view.dom.querySelector('.noto-fence');
      expect(fence).not.toBeNull();
      expect(fence!.classList.contains(STUB_CLASS)).toBe(false);

      const docView = (view as unknown as {
        docView: { children: unknown[] };
      }).docView;
      // Sparse: children ≪ doc.childCount even with a widget sibling.
      expect(docView.children.length).toBeLessThan(view.state.doc.childCount / 10);

      setViewport(view, 0, 20);
      expect(view.dom.querySelector('.noto-range-spacer')).not.toBeNull();
    } finally {
      view.destroy();
    }
  });
});

describe('sparse enter/leave for default blocks', () => {
  it('mounts a real paragraph when the viewport covers a spacer index', () => {
    const { view } = mount(specialisedMarkdown());
    setViewport(view, 0, 5);

    let target = -1;
    for (let index = 100; index < view.state.doc.childCount; index += 1) {
      if (view.state.doc.child(index).type.name === 'paragraph') {
        target = index;
        break;
      }
    }
    expect(target).toBeGreaterThan(0);
    expect(isRangeSpacer(sparseTopLevelDescAt(view, target))).toBe(true);

    setViewport(view, target - 2, target + 2);
    const realEl = childAt(view, target);
    expect(isRangeSpacer(sparseTopLevelDescAt(view, target))).toBe(false);
    expect(realEl.classList.contains(STUB_CLASS)).toBe(false);
    expect(realEl.tagName).toBe('P');
    expect(realEl.textContent).toMatch(/Body|Lead|Paragraph|End/);

    setViewport(view, 0, 5);
    expect(isRangeSpacer(sparseTopLevelDescAt(view, target))).toBe(true);

    view.destroy();
  });

  it('mounts real headings and lists from a spacer run', () => {
    const head = Array.from({ length: 20 }, (_, i) => `P ${i}.`).join('\n\n');
    const body = [
      '## Heading mid',
      '- item a',
      '- item b',
      '### Another',
      '1. one',
      '2. two',
    ].join('\n\n');
    const pad = Array.from(
      { length: STUB_MIN_TOP_LEVEL_BLOCKS },
      (_, i) => `Pad ${i}.`,
    ).join('\n\n');
    const { view } = mount(`${head}\n\n${body}\n\n${pad}\n`);
    setViewport(view, 0, 5);

    const headingIndex = indexOfType(view.state.doc, 'heading', 0);
    const listIndex = indexOfType(view.state.doc, 'bullet_list', 0);
    expect(headingIndex).toBeGreaterThan(5);
    expect(isRangeSpacer(sparseTopLevelDescAt(view, headingIndex))).toBe(true);
    expect(isRangeSpacer(sparseTopLevelDescAt(view, listIndex))).toBe(true);

    setViewport(view, headingIndex - 1, listIndex + 1);
    const heading = childAt(view, headingIndex);
    const list = childAt(view, listIndex);
    expect(heading.tagName).toBe('H2');
    expect(list.tagName).toBe('UL');
    expect(heading.classList.contains(STUB_CLASS)).toBe(false);
    expect(list.classList.contains(STUB_CLASS)).toBe(false);
    expect(list.querySelectorAll('li').length).toBeGreaterThan(0);

    view.destroy();
  });
});

describe('sparse enter/leave for specialised blocks', () => {
  it('mounts a real fence from a spacer and collapses it back', () => {
    const { view } = mount(specialisedMarkdown());
    setViewport(view, 0, 20);

    const fenceIndex = indexOfType(view.state.doc, 'code_block', 1);
    expect(isRangeSpacer(sparseTopLevelDescAt(view, fenceIndex))).toBe(true);

    setViewport(view, fenceIndex - 2, fenceIndex + 5);
    const realEl = childAt(view, fenceIndex);
    expect(realEl.classList.contains(STUB_CLASS)).toBe(false);
    expect(realEl.classList.contains('noto-fence')).toBe(true);
    expect(realEl.querySelector('.noto-fence-code')).not.toBeNull();

    setViewport(view, 0, 20);
    expect(isRangeSpacer(sparseTopLevelDescAt(view, fenceIndex))).toBe(true);

    view.destroy();
  });

  it('mounts real tables and display math from a spacer run', () => {
    const { view } = mount(specialisedMarkdown());
    setViewport(view, 0, 20);

    const tableIndex = indexOfType(view.state.doc, 'table', 1);
    const mathIndex = indexOfType(view.state.doc, 'math_block', 1);
    expect(isRangeSpacer(sparseTopLevelDescAt(view, tableIndex))).toBe(true);
    expect(isRangeSpacer(sparseTopLevelDescAt(view, mathIndex))).toBe(true);

    setViewport(view, tableIndex - 2, mathIndex + 2);
    const table = childAt(view, tableIndex);
    const math = childAt(view, mathIndex);
    expect(table.classList.contains(STUB_CLASS)).toBe(false);
    expect(table.querySelector('table')).not.toBeNull();
    expect(math.classList.contains(STUB_CLASS)).toBe(false);
    expect(math.classList.contains('noto-math-block')).toBe(true);

    view.destroy();
  });
});

describe('sparse docView range spacers', () => {
  it('keeps DOM child count far below doc.childCount when stubbing is on', () => {
    const { view } = mount(specialisedMarkdown());
    const docCount = view.state.doc.childCount;
    expect(docCount).toBeGreaterThanOrEqual(STUB_MIN_TOP_LEVEL_BLOCKS);
    // Real window + selection pad + a couple of spacers ≪ tens of thousands.
    expect(view.dom.childElementCount).toBeLessThan(200);
    expect(view.dom.childElementCount).toBeLessThan(docCount / 10);
    expect(view.dom.querySelectorAll('.noto-range-spacer').length).toBeGreaterThan(0);
    view.destroy();
  });

  it('does not place selection-neighbourhood blocks inside a spacer', () => {
    const { view } = mount(specialisedMarkdown());
    const stub = viewportStubKey.getState(view.state)!;
    for (let index = stub.selection.from; index <= stub.selection.to; index += 1) {
      expect(isRangeSpacer(sparseTopLevelDescAt(view, index))).toBe(false);
    }
    view.destroy();
  });

  it('leaves medium documents on the stock ProseMirror path (no spacers)', () => {
    const md = Array.from({ length: 40 }, (_, i) => `P ${i}.`).join('\n\n') + '\n';
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    scroller.style.height = '400px';
    const host = document.createElement('div');
    host.className = 'noto-editor-host';
    const mountPoint = document.createElement('div');
    host.append(mountPoint);
    scroller.append(host);
    document.body.append(scroller);
    const doc = docFor(md);
    const state = EditorState.create({ doc, plugins: [viewportStubPlugin()] });
    const view = new EditorView(mountPoint, {
      state,
      nodeViews: mergeStubAwareNodeViews({
        ...mathNodeViews(),
        ...fenceNodeViews(),
        ...tableNodeViews(),
      }),
    });
    expect(viewportStubKey.getState(view.state)?.enabled).toBe(false);
    expect(view.dom.querySelectorAll('.noto-range-spacer').length).toBe(0);
    expect(view.dom.childElementCount).toBe(doc.childCount);
    view.destroy();
  });
});

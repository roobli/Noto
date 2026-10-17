/**
 * @vitest-environment happy-dom
 *
 * Sparse docView patches private prosemirror-view internals. A shape drift must
 * fall back to stock rendering (no spacers, every block in the DOM), log once,
 * and keep the editor editable.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { splitBlocks } from '../../src/shared/markdown/v3/blocks';
import { docFromSpans } from '../../src/shared/markdown/v3/pm/from-mdast';
import {
  STUB_MIN_TOP_LEVEL_BLOCKS,
  mergeStubAwareNodeViews,
  viewportStubPlugin,
} from '../../src/renderer/editor/noto/viewport-stub';
import {
  __resetSparseDocViewForTests,
  ensureSparseDocViewInstalled,
  isRangeSpacer,
  isSparseDocViewInstalled,
  sparseDocViewFallbackReason,
  validatePmViewShape,
} from '../../src/renderer/editor/noto/sparse-doc-view';
import pkg from '../../package.json';

function bigDoc() {
  const count = STUB_MIN_TOP_LEVEL_BLOCKS + 200;
  const md = `${Array.from({ length: count }, (_, i) => `Paragraph ${i}.`).join('\n\n')}\n`;
  return docFromSpans(splitBlocks(md).spans);
}

function mount(): EditorView {
  const mountPoint = document.createElement('div');
  document.body.append(mountPoint);
  return new EditorView(mountPoint, {
    state: EditorState.create({ doc: bigDoc(), plugins: [viewportStubPlugin()] }),
    nodeViews: mergeStubAwareNodeViews({}),
  });
}

function spacerCount(view: EditorView): number {
  const docView = (view as unknown as { docView: { children: unknown[] } }).docView;
  return docView.children.filter((child) => isRangeSpacer(child)).length;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('sparse docView shape guard', () => {
  it('pins prosemirror-view to the exact version the shape was validated on', () => {
    expect((pkg as { dependencies: Record<string, string> }).dependencies['prosemirror-view']).toBe('1.42.3');
  });

  it('falls back to stock rendering when the shape check fails, logging once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    __resetSparseDocViewForTests({ forceShapeFailure: 'simulated drift' });
    ensureSparseDocViewInstalled();
    ensureSparseDocViewInstalled();
    expect(isSparseDocViewInstalled()).toBe(false);
    expect(sparseDocViewFallbackReason()).toContain('simulated drift');

    const view = mount();
    expect(spacerCount(view)).toBe(0);
    const docView = (view as unknown as { docView: { children: unknown[] } }).docView;
    expect(docView.children.length).toBeGreaterThanOrEqual(view.state.doc.childCount);

    // Still editable.
    const end = view.state.doc.content.size - 1;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)).insertText('!'));
    expect(view.state.doc.lastChild?.textContent.endsWith('!')).toBe(true);
    view.destroy();

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('installs and renders spacers when the real shape validates', () => {
    __resetSparseDocViewForTests();
    ensureSparseDocViewInstalled();
    expect(sparseDocViewFallbackReason()).toBe('');
    expect(isSparseDocViewInstalled()).toBe(true);
    const view = mount();
    expect(spacerCount(view)).toBeGreaterThan(0);
    view.destroy();
  });

  it('reports concrete problems for drifted shapes', () => {
    expect(validatePmViewShape(null, null, null, null, null)).toBe('docView missing');
    const fakeDoc = {
      parent: undefined,
      children: [],
      dom: document.createElement('div'),
      contentDOM: document.createElement('div'),
      dirty: 0,
      node: {},
      innerDeco: { forChild: () => null },
    };
    expect(validatePmViewShape(fakeDoc, function NotDesc() {}, null, null, null))
      .toBe('NodeViewDesc.create missing');
    expect(validatePmViewShape({ ...fakeDoc, dirty: 'x' }, null, null, null, null))
      .toBe('docView.dirty is not a number');
  });
});

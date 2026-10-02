/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { splitBlocks } from '../../src/shared/markdown/v3/blocks';
import { docFromSpans } from '../../src/shared/markdown/v3/pm/from-mdast';
import { fenceNodeViews } from '../../src/renderer/editor/noto/fence-view';
import { mathNodeViews } from '../../src/renderer/editor/noto/math-view';
import { tableNodeViews } from '../../src/renderer/editor/noto/table-view';
import {
  mergeStubAwareNodeViews,
  viewportStubKey,
  viewportStubPlugin,
} from '../../src/renderer/editor/noto/viewport-stub';
import { isRangeSpacer, sparseTopLevelDescAt } from '../../src/renderer/editor/noto/sparse-doc-view';

describe('sparse open sanity on large corpus', () => {
  it('keeps size sum, tall spacer, mid remount + edit', () => {
    const text = readFileSync(path.resolve(__dirname, '../../out/bench/corpus/large.md'), 'utf8');
    const doc = docFromSpans(splitBlocks(text).spans);
    expect(doc.childCount).toBeGreaterThan(3000);

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

    const view = new EditorView(mountPoint, {
      state: EditorState.create({ doc, plugins: [viewportStubPlugin()] }),
      nodeViews: mergeStubAwareNodeViews({
        ...mathNodeViews(),
        ...fenceNodeViews(),
        ...tableNodeViews(),
      }),
    });

    const docView = (view as unknown as { docView: { children: Array<{ size: number; dom: HTMLElement }> } }).docView;
    let sizeSum = 0;
    for (const c of docView.children) sizeSum += c.size;
    expect(sizeSum).toBe(doc.content.size);
    expect(docView.children.length).toBeLessThan(100);

    const spacers = [...docView.children].filter((c) => isRangeSpacer(c));
    expect(spacers.length).toBeGreaterThan(0);
    expect(Number.parseFloat(spacers[0]!.dom.style.height)).toBeGreaterThan(1000);

    const mid = Math.floor(doc.childCount / 2);
    view.dispatch(view.state.tr.setMeta(viewportStubKey, { viewport: { from: mid - 5, to: mid + 5 } }));
    expect(isRangeSpacer(sparseTopLevelDescAt(view, mid))).toBe(false);

    let pos = 0;
    for (let i = 0; i < mid; i += 1) pos += view.state.doc.child(i).nodeSize;
    const node = view.state.doc.child(mid);
    if (node.isTextblock && node.content.size > 0) {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1)));
      view.dispatch(view.state.tr.insertText('X'));
      expect(view.state.doc.child(mid).textContent.includes('X')).toBe(true);
    }

    view.destroy();
  });
});

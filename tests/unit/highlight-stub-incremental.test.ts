/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { notoSchema } from '../../src/shared/markdown/v3/pm/schema';
import {
  highlightKey,
  syntaxHighlightPlugin,
} from '../../src/renderer/editor/noto/highlight';
import {
  STUB_MIN_TOP_LEVEL_BLOCKS,
  viewportStubKey,
  viewportStubPlugin,
} from '../../src/renderer/editor/noto/viewport-stub';

function para(text: string) {
  return notoSchema.nodes.paragraph.create(null, notoSchema.text(text));
}

function fence(code: string) {
  return notoSchema.nodes.code_block.create(
    { lang: 'ts', fenced: true },
    notoSchema.text(code),
  );
}

describe('highlight under stubbing', () => {
  it('keeps the decoration set on a caret move that does not change stub windows', () => {
    const children = [];
    for (let i = 0; i < STUB_MIN_TOP_LEVEL_BLOCKS + 10; i += 1) {
      children.push(i % 40 === 0 ? fence(`const n${i} = ${i};`) : para(`p${i}`));
    }
    const doc = notoSchema.nodes.doc.create(null, children);
    const state = EditorState.create({
      doc,
      plugins: [viewportStubPlugin(), syntaxHighlightPlugin()],
    });
    const mount = document.createElement('div');
    document.body.append(mount);
    const view = new EditorView(mount, { state });
    const mid = Math.floor(doc.childCount / 2);
    view.dispatch(view.state.tr.setMeta(viewportStubKey, {
      viewport: { from: mid - 5, to: mid + 5 },
    }));
    // Put caret inside the mid window
    let pos = 0;
    for (let i = 0; i < mid; i += 1) pos += doc.child(i).nodeSize;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1)));
    const before = highlightKey.getState(view.state)!;
    // Move caret one character within the same block / window
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 2)));
    const after = highlightKey.getState(view.state)!;
    expect(after).toBe(before);
    view.destroy();
  });
});

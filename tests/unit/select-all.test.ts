import { describe, expect, it } from 'vitest';
import { AllSelection, EditorState, TextSelection } from 'prosemirror-state';
import { splitBlocks } from '../../src/shared/markdown/v3/blocks';
import { docFromSpans } from '../../src/shared/markdown/v3/pm/from-mdast';
import { selectAllStepwise } from '../../src/renderer/editor/noto/keymap';

function stateWithCaretIn(markdown: string, needle: string): EditorState {
  const state = EditorState.create({ doc: docFromSpans(splitBlocks(markdown).spans) });
  let at = -1;
  state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text!.includes(needle)) at = pos + node.text!.indexOf(needle);
    return at < 0;
  });
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, at)));
}

function press(state: EditorState): EditorState {
  let next = state;
  selectAllStepwise(state, (tr) => { next = state.apply(tr); });
  return next;
}

describe('Select All', () => {
  it('takes a code block\'s code first and the whole note on the next press', () => {
    const state = stateWithCaretIn('Intro.\n\n```js\nconst a = 1;\nconst b = 2;\n```\n', 'const b');
    const once = press(state);
    expect(once.selection).toBeInstanceOf(TextSelection);
    expect(once.doc.textBetween(once.selection.from, once.selection.to)).toBe('const a = 1;\nconst b = 2;');
    expect(press(once).selection).toBeInstanceOf(AllSelection);
  });

  it('takes the whole note at once outside a code block', () => {
    expect(press(stateWithCaretIn('One.\n\nTwo.\n', 'Two')).selection).toBeInstanceOf(AllSelection);
  });
});

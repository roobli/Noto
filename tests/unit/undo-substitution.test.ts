import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection, type Plugin, type Transaction } from 'prosemirror-state';
import { notoSchema } from '../../src/shared/markdown/v3/pm/schema';
import { notoInputRules, undoSubstitution } from '../../src/renderer/editor/noto/input-rules';

/** An editor with the input rules alone, typed into one character at a time. */
function editor(smart: boolean) {
  const plugins: Plugin[] = [notoInputRules({ smartQuotes: () => smart, smartDashes: () => smart, smartEllipsis: () => smart })];
  let state = EditorState.create({ schema: notoSchema, plugins });
  state = state.apply(state.tr.setSelection(TextSelection.atStart(state.doc)));
  const view = {
    get state() { return state; },
    composing: false,
    dispatch(tr: Transaction) { state = state.apply(tr); },
  };
  return {
    type(text: string) {
      for (const ch of text) {
        const { from, to } = state.selection;
        const deflt = () => state.tr.insertText(ch, from, to);
        const handled = plugins.some((plugin) => plugin.props.handleTextInput?.call(plugin, view as never, from, to, ch, deflt));
        if (!handled) view.dispatch(deflt());
      }
    },
    backspace: () => undoSubstitution(state, (tr) => view.dispatch(tr)),
    get text() { return state.doc.textContent; },
    get block() { return state.doc.firstChild?.type.name; },
  };
}

describe('Backspace straight after a substitution', () => {
  it('gives back the straight quote that was typed', () => {
    const page = editor(true);
    page.type('say "');
    expect(page.text).toBe('say \u201c');
    expect(page.backspace()).toBe(true);
    expect(page.text).toBe('say "');
  });

  it('gives back both hyphens and all three dots', () => {
    const page = editor(true);
    page.type('a--');
    expect(page.text).toBe('a\u2014');
    expect(page.backspace()).toBe(true);
    expect(page.text).toBe('a--');
    const dots = editor(true);
    dots.type('wait...');
    expect(dots.backspace()).toBe(true);
    expect(dots.text).toBe('wait...');
  });

  it('is an ordinary Backspace once anything else was typed', () => {
    const page = editor(true);
    page.type('"x');
    expect(page.backspace()).toBe(false);
    expect(page.text).toBe('\u201cx');
  });

  it('leaves a heading just made from `# ` alone, and does nothing with the substitutions off', () => {
    const heading = editor(true);
    heading.type('# ');
    expect(heading.block).toBe('heading');
    expect(heading.backspace()).toBe(false);
    const plain = editor(false);
    plain.type('"');
    expect(plain.text).toBe('"');
    expect(plain.backspace()).toBe(false);
  });
});

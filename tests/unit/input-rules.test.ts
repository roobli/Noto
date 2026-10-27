import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection, type Plugin, type Transaction } from 'prosemirror-state';
import { notoSchema } from '../../src/shared/markdown/v3/pm/schema';
import { blockToMarkdown } from '../../src/shared/markdown/v3/pm/to-mdast';
import { fenceOnEnter, notoInputRules } from '../../src/renderer/editor/noto/input-rules';
import { autoPairPlugin } from '../../src/renderer/editor/noto/auto-pair';

/**
 * Type `text` into an empty paragraph one character at a time, through the
 * editor's own text-input plugins in the editor's order (input rules, then
 * auto-pair), falling back to a plain insert as ProseMirror does. `\n` presses
 * Enter through `fenceOnEnter`, the only Enter behaviour these tests need.
 */
function typed(text: string, { autoPair = true } = {}) {
  const plugins: Plugin[] = [notoInputRules({ autoPair: () => autoPair }), autoPairPlugin(() => autoPair)];
  let state = EditorState.create({ schema: notoSchema, plugins });
  state = state.apply(state.tr.setSelection(TextSelection.atStart(state.doc)));
  const view = {
    get state() { return state; },
    composing: false,
    dispatch(tr: Transaction) { state = state.apply(tr); },
  };
  for (const ch of text) {
    if (ch === '\n') {
      if (!fenceOnEnter(state, (tr) => view.dispatch(tr))) view.dispatch(state.tr.split(state.selection.from));
      continue;
    }
    const { from, to } = state.selection;
    const deflt = () => state.tr.insertText(ch, from, to);
    const handled = plugins.some((plugin) => plugin.props.handleTextInput?.call(plugin, view as never, from, to, ch, deflt));
    if (!handled) view.dispatch(deflt());
  }
  const blocks: string[] = [];
  state.doc.forEach((block) => blocks.push(blockToMarkdown(block)));
  return { doc: state.doc, markdown: blocks.join('\n\n') };
}

const emphasized = (doc: ReturnType<typeof typed>['doc']) => {
  const out: string[] = [];
  doc.descendants((node) => {
    if (node.isText && node.marks.some((mark) => mark.type === notoSchema.marks.emphasis)) out.push(node.text ?? '');
  });
  return out;
};

describe('typing inline marks', () => {
  it('keeps the character before a single-star emphasis', () => {
    expect(typed('and *em* end').markdown).toBe('and *em* end');
    const cjk = typed('中文*斜体*中文');
    expect(cjk.markdown).toBe('中文*斜体*中文');
    expect(emphasized(cjk.doc)).toEqual(['斜体']);
    expect(typed('2*3*4').markdown).toBe('2*3*4');
  });

  it('finds the content from the closing delimiter, not from the first match of its text', () => {
    const doc = typed('a*a* b').doc;
    expect(doc.textContent).toBe('aa b');
    expect(emphasized(doc)).toEqual(['a']);
  });

  it('leaves an underscore inside a word alone, as CommonMark does', () => {
    const snake = typed('snake_case_name here');
    expect(snake.markdown).toBe('snake_case_name here');
    expect(emphasized(snake.doc)).toEqual([]);
    expect(emphasized(typed('x _em_ y').doc)).toEqual(['em']);
  });

  it('does not close emphasis on a delimiter that follows a space', () => {
    expect(emphasized(typed('a *b *').doc)).toEqual([]);
  });

  it('still makes bold, and keeps the text around it', () => {
    expect(typed('so **bold** here').markdown).toBe('so **bold** here');
  });
});

describe('typing with auto-pair on', () => {
  it('leaves no stray backtick after inline code', () => {
    expect(typed('a `x` b').markdown).toBe('a `x` b');
  });

  it('types three backticks as three', () => {
    expect(typed('```').doc.textContent).toBe('```');
  });

  it('opens a fence with a language and a space, and nothing else in it', () => {
    const { doc } = typed('```js ');
    expect(doc.firstChild?.type).toBe(notoSchema.nodes.code_block);
    expect(doc.firstChild?.attrs.lang).toBe('js');
    expect(doc.firstChild?.textContent).toBe('');
  });
});

describe('pressing Enter after block syntax', () => {
  it('turns a fence line into a code block', () => {
    for (const autoPair of [false, true]) {
      const { doc } = typed('```js\nlet x = 1;', { autoPair });
      expect(doc.firstChild?.type).toBe(notoSchema.nodes.code_block);
      expect(doc.firstChild?.attrs.lang).toBe('js');
      expect(doc.firstChild?.textContent).toBe('let x = 1;');
    }
    expect(typed('```\n', { autoPair: false }).doc.firstChild?.type).toBe(notoSchema.nodes.code_block);
  });

  it('turns $$ into a math block', () => {
    expect(typed('$$\n', { autoPair: false }).doc.firstChild?.type).toBe(notoSchema.nodes.math_block);
  });
});

describe('typing a link', () => {
  it('becomes a link when its closing parenthesis is typed, and saves unescaped', () => {
    for (const autoPair of [false, true]) {
      const typedLink = typed('see [text](https://a.b) after', { autoPair });
      expect(typedLink.markdown).toBe('see [text](https://a.b) after');
      let href: string | null = null;
      typedLink.doc.descendants((node) => {
        const link = node.marks.find((mark) => mark.type === notoSchema.marks.link);
        if (link) href = link.attrs.href as string;
      });
      expect(href).toBe('https://a.b');
    }
  });

  it('leaves an image alone', () => {
    let linked = false;
    typed('![alt](a.png)', { autoPair: false }).doc.descendants((node) => {
      if (node.marks.some((mark) => mark.type === notoSchema.marks.link)) linked = true;
    });
    expect(linked).toBe(false);
  });
});

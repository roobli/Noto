import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Decoration } from 'prosemirror-view';
import { splitBlocks } from '../../src/shared/markdown/v3/blocks';
import { docFromSpans } from '../../src/shared/markdown/v3/pm/from-mdast';
import { notoSchema } from '../../src/shared/markdown/v3/pm/schema';
import { markCharacters, mightDecorate, typoraMarksKey, typoraMarksPlugin } from '../../src/renderer/editor/noto/typora-marks-plugin';
import { ALL_MARK_KINDS, typoraMarkRanges } from '../../src/renderer/editor/noto/typora-marks';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A state whose caret is in the last block. A fresh state puts it in the
 * first, which would keep that block in its editing state throughout.
 */
function stateFor(markdown: string): EditorState {
  const state = EditorState.create({ doc: docFromSpans(splitBlocks(markdown).spans), plugins: [typoraMarksPlugin()] });
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, state.doc.content.size - 1)));
}

/** The classes drawn, in document order. */
function drawn(state: EditorState): string[] {
  const set = typoraMarksKey.getState(state)!;
  return set.find().map((decoration) => (decoration as Decoration & { type: { attrs: { class: string } } }).type.attrs.class);
}

/** Position of `text` in the first paragraph. */
function positionOf(state: EditorState, text: string): number {
  return 1 + state.doc.firstChild!.textContent.indexOf(text);
}

describe('the Typora marks plugin', () => {
  it('draws a highlight and its two delimiters', () => {
    expect(drawn(stateFor('Mark ==key== here.\n\nelsewhere'))).toEqual(['noto-typora-delim', 'noto-mark-highlight', 'noto-typora-delim']);
  });

  it('rescans a block whose marks changed, even though a mark step maps nothing', () => {
    let state = stateFor('Mark ==key== here.\n\nelsewhere');
    const from = positionOf(state, '==key==');
    const to = from + '==key=='.length;
    state = state.apply(state.tr.addMark(from, to, notoSchema.marks.inline_code.create()));
    expect(drawn(state)).toEqual([]);
    state = state.apply(state.tr.removeMark(from, to, notoSchema.marks.inline_code));
    expect(drawn(state)).toEqual(['noto-typora-delim', 'noto-mark-highlight', 'noto-typora-delim']);
  });

  it('reveals the syntax while the selection touches the block', () => {
    let state = stateFor('Mark ==key== here.\n\nelsewhere');
    expect(drawn(state)).not.toContain('noto-marks-editing');
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 2)));
    expect(drawn(state)).toContain('noto-marks-editing');
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, state.doc.content.size - 1)));
    expect(drawn(state)).not.toContain('noto-marks-editing');
  });

  it('does not scan inside inline code', () => {
    expect(drawn(stateFor('Not `==this==` here.\n\nelsewhere'))).toEqual([]);
  });

  it('leaves a neighbour alone when only the block after it changes', () => {
    let state = stateFor('==a==\n\nplain');
    const endOfFirst = state.doc.firstChild!.nodeSize - 1;
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, endOfFirst)));
    expect(drawn(state)).toContain('noto-marks-editing');
    // A change in the second block, with the selection left where it is.
    const second = state.doc.firstChild!.nodeSize + 1;
    state = state.apply(state.tr.insertText('x', second));
    expect(drawn(state)).toContain('noto-marks-editing');
    expect(drawn(state)).toHaveLength(4);
  });
});

/**
 * The open-time scan skips a block that cannot draw anything. The skip has to
 * be conservative: a block it passes over must be one the full read would have
 * left bare.
 */
describe('the skip for blocks that cannot draw', () => {
  it('only skips blocks with no inline HTML and no mark in their text, across the golden fixtures', () => {
    const dir = path.resolve(__dirname, '../fixtures/markdown-golden');
    const characters = markCharacters(ALL_MARK_KINDS);
    let skipped = 0;
    let read = 0;
    for (const name of readdirSync(dir).filter((file) => file.endsWith('.md'))) {
      const doc = docFromSpans(splitBlocks(readFileSync(path.join(dir, name), 'utf8')).spans);
      doc.descendants((node) => {
        if (!node.isTextblock) return true;
        if (mightDecorate(node, characters)) {
          read += 1;
          return false;
        }
        skipped += 1;
        let html = false;
        node.forEach((child) => { if (child.type.name === 'inline_html') html = true; });
        expect(html, name).toBe(false);
        expect(typoraMarkRanges(node.textContent), `${name}: ${node.textContent}`).toEqual([]);
        return false;
      });
    }
    expect(skipped).toBeGreaterThan(100);
    expect(read).toBeGreaterThan(10);
  });

  it('still reads a block whose only mark character sits in a text node next to code', () => {
    expect(drawn(stateFor('`code` then ^sup^ end\n\nelsewhere'))).toEqual(['noto-typora-delim', 'noto-mark-sup', 'noto-typora-delim']);
  });

  it('reads nothing for a kind that is switched off', () => {
    expect(markCharacters({ highlight: false, superscript: true, subscript: false })).toBe('^');
  });
});


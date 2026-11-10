import { describe, expect, it } from 'vitest';
import { EditorState, Selection, TextSelection, type Command } from 'prosemirror-state';
import { CellSelection } from 'prosemirror-tables';
import type { Node as ProseNode } from 'prosemirror-model';
import { splitBlocks } from '../../src/shared/markdown/v3/blocks';
import { docFromSpans } from '../../src/shared/markdown/v3/pm/from-mdast';
import { deleteSelectedRowsOrColumns, exitAtEdge } from '../../src/renderer/editor/noto/block-edges';
import { notoBindings } from '../../src/renderer/editor/noto/keymap';

/** The document's structure, text in quotes, so a test reads as the tree it means. */
const shape = (node: ProseNode): string => (node.isText
  ? JSON.stringify(node.text)
  : `${node.type.name}(${node.content.content.map(shape).join(',')})`);

const stateOf = (markdown: string) => EditorState.create({ doc: docFromSpans(splitBlocks(markdown).spans) });
const atEnd = (markdown: string) => { const state = stateOf(markdown); return state.apply(state.tr.setSelection(Selection.atEnd(state.doc))); };
const atStart = (markdown: string) => { const state = stateOf(markdown); return state.apply(state.tr.setSelection(Selection.atStart(state.doc))); };

function run(state: EditorState, command: Command): EditorState | null {
  let next: EditorState | null = null;
  return command(state, (tr) => { next = state.apply(tr); }) ? next : null;
}

describe('leaving a block at the edge of the note', () => {
  it('makes a line below a quote, a list or a code block that ends the note, and goes there', () => {
    for (const [markdown, outside] of [
      ['> hello', 'blockquote(paragraph("hello"))'],
      ['- one\n  - two', 'bullet_list(list_item(paragraph("one"),bullet_list(list_item(paragraph("two")))))'],
      ['```\ncode\n```', 'code_block("code")'],
    ] as const) {
      const next = run(atEnd(markdown), exitAtEdge(1))!;
      expect(shape(next.doc)).toBe(`doc(${outside},paragraph())`);
      expect(next.selection.$head.depth).toBe(1);
      expect(next.selection.$head.parent.type.name).toBe('paragraph');
    }
  });

  it('makes a line above one that starts the note', () => {
    const next = run(atStart('> hello\n\nafter'), exitAtEdge(-1))!;
    expect(shape(next.doc)).toBe('doc(paragraph(),blockquote(paragraph("hello")),paragraph("after"))');
    expect(next.selection.head).toBe(1);
  });

  it('spends the arrow at a table that ends the note, and makes nothing past it', () => {
    const table = '| a | b |\n| --- | --- |\n| 1 | 2 |';
    const state = atEnd(table);
    // The key is consumed where the table is the edge, and no line is made:
    // the arrows move within the table only.
    let changed = false;
    expect(exitAtEdge(1)(state, () => { changed = true; })).toBe(true);
    expect(changed).toBe(false);
    // In the first cell of the last row, with a cell beside it on the same line.
    const first = state.apply(state.tr.setSelection(TextSelection.near(state.doc.resolve(state.doc.firstChild!.child(0).nodeSize + 3))));
    expect(first.selection.$head.index(1)).toBe(1);
    changed = false;
    expect(exitAtEdge(1)(first, () => { changed = true; })).toBe(true);
    expect(changed).toBe(false);
    // From the header row, Down stays in the table.
    expect(run(atStart(table), exitAtEdge(1))).toBeNull();
  });

  it('spends the arrow at a table that starts the note, and makes nothing above it', () => {
    const state = atStart('| a | b |\n| --- | --- |\n| 1 | 2 |\n\nafter');
    let changed = false;
    expect(exitAtEdge(-1)(state, () => { changed = true; })).toBe(true);
    expect(changed).toBe(false);
  });

  it('does nothing where Down already has somewhere to go, or there is nothing to leave', () => {
    // A paragraph after the quote is where Down goes.
    const quoteFirst = stateOf('> hello\n\nafter');
    const inQuote = quoteFirst.apply(quoteFirst.tr.setSelection(TextSelection.create(quoteFirst.doc, 7)));
    expect(run(inQuote, exitAtEdge(1))).toBeNull();
    // An earlier paragraph inside the quote still has the next one below it.
    const twoLines = stateOf('> one\n>\n> two');
    expect(run(twoLines.apply(twoLines.tr.setSelection(TextSelection.create(twoLines.doc, 4))), exitAtEdge(1))).toBeNull();
    // A plain last paragraph has nothing to step out of.
    expect(run(atEnd('just text'), exitAtEdge(1))).toBeNull();
  });
});

describe('Enter on an empty line steps out one level at a time', () => {
  const enter = notoBindings({ mac: true }).Enter!;
  const presses = (markdown: string, count: number): string[] => {
    let state = atEnd(markdown);
    const shapes: string[] = [];
    for (let i = 0; i < count; i += 1) {
      state = run(state, enter)!;
      shapes.push(shape(state.doc));
    }
    return shapes;
  };

  it('out of a quote on the second Enter', () => {
    expect(presses('> hello', 2)).toEqual([
      'doc(blockquote(paragraph("hello"),paragraph()))',
      'doc(blockquote(paragraph("hello")),paragraph())',
    ]);
  });

  it('up a nested list a level per Enter, then out of the list', () => {
    expect(presses('- a\n  - b', 3)).toEqual([
      'doc(bullet_list(list_item(paragraph("a"),bullet_list(list_item(paragraph("b")),list_item(paragraph())))))',
      'doc(bullet_list(list_item(paragraph("a"),bullet_list(list_item(paragraph("b")))),list_item(paragraph())))',
      'doc(bullet_list(list_item(paragraph("a"),bullet_list(list_item(paragraph("b"))))),paragraph())',
    ]);
  });

  it('out of a list inside a quote, then out of the quote', () => {
    expect(presses('> - a', 3)).toEqual([
      'doc(blockquote(bullet_list(list_item(paragraph("a")),list_item(paragraph()))))',
      'doc(blockquote(bullet_list(list_item(paragraph("a"))),paragraph()))',
      'doc(blockquote(bullet_list(list_item(paragraph("a")))),paragraph())',
    ]);
  });
});

describe('deleting whole rows and columns', () => {
  const table = '| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |';
  const state = stateOf(table);
  const node = state.doc.firstChild!;
  const cell = (row: number, column: number) => {
    let pos = 1;
    for (let r = 0; r < row; r += 1) pos += node.child(r).nodeSize;
    pos += 1;
    for (let c = 0; c < column; c += 1) pos += node.child(row).child(c).nodeSize;
    return state.doc.resolve(pos);
  };
  const texts = (next: EditorState) => next.doc.firstChild!.content.content.map((row) => row.textContent);
  const select = (selection: Selection) => state.apply(state.tr.setSelection(selection));

  it('takes out the rows a row selection covers, several at once', () => {
    const next = run(select(CellSelection.rowSelection(cell(1, 0), cell(2, 0))), deleteSelectedRowsOrColumns)!;
    expect(texts(next)).toEqual(['abc']);
  });

  it('takes out the columns a column selection covers', () => {
    const next = run(select(CellSelection.colSelection(cell(0, 0), cell(0, 1))), deleteSelectedRowsOrColumns)!;
    expect(texts(next)).toEqual(['c', '3', '6']);
  });

  it('leaves the whole table, and a few cells, to the ordinary keys', () => {
    expect(run(select(CellSelection.rowSelection(cell(0, 0), cell(2, 0))), deleteSelectedRowsOrColumns)).toBeNull();
    expect(run(select(new CellSelection(cell(1, 0), cell(1, 1))), deleteSelectedRowsOrColumns)).toBeNull();
    expect(run(select(TextSelection.create(state.doc, 3)), deleteSelectedRowsOrColumns)).toBeNull();
  });
});

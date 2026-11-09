import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { CellSelection } from 'prosemirror-tables';
import { splitBlocks } from '../../src/shared/markdown/v3/blocks';
import { docFromSpans } from '../../src/shared/markdown/v3/pm/from-mdast';
import { tableContextItems } from '../../src/renderer/editor/noto/table-context';
import { EDITOR_COMMANDS } from '../../src/renderer/editor/noto/keymap';

const markdown = 'Before.\n\n| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n\n| x |\n| --- |\n| y |';
const base = EditorState.create({ doc: docFromSpans(splitBlocks(markdown).spans) });
const tablePos = base.doc.child(0).nodeSize;
const table = base.doc.child(1);
const cell = (row: number, column: number) => {
  let pos = tablePos + 1;
  for (let r = 0; r < row; r += 1) pos += table.child(r).nodeSize;
  pos += 1;
  for (let c = 0; c < column; c += 1) pos += table.child(row).child(c).nodeSize;
  return pos;
};
const titles = (state: EditorState, pos: number | null) => tableContextItems(state, pos).map((item) => item.title);

describe('the table lines in the right-click menu', () => {
  it('offer the row and the column under a caret in the table', () => {
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, cell(1, 1) + 2)));
    expect(titles(state, cell(1, 1) + 2)).toEqual([
      'Insert Row Above', 'Insert Row Below', 'Insert Column Left', 'Insert Column Right',
      'Delete Row', 'Delete Column', 'Delete Table',
    ]);
  });

  it('say how many rows or columns a selection holds', () => {
    const rows = base.apply(base.tr.setSelection(CellSelection.rowSelection(base.doc.resolve(cell(1, 0)), base.doc.resolve(cell(2, 0)))));
    expect(titles(rows, cell(1, 1) + 2)).toContain('Delete 2 Rows');
    expect(titles(rows, cell(1, 1) + 2)).toContain('Delete 3 Columns');
    const columns = base.apply(base.tr.setSelection(CellSelection.colSelection(base.doc.resolve(cell(0, 0)), base.doc.resolve(cell(0, 1)))));
    expect(titles(columns, cell(0, 0) + 2)).toEqual(expect.arrayContaining(['Delete 3 Rows', 'Delete 2 Columns']));
  });

  it('offer nothing outside a table, or when the caret is in another one', () => {
    expect(titles(base, 2)).toEqual([]);
    expect(titles(base, null)).toEqual([]);
    const elsewhere = base.apply(base.tr.setSelection(TextSelection.create(base.doc, base.doc.content.size - 3)));
    expect(titles(elsewhere, cell(1, 1) + 2)).toEqual([]);
  });

  it('name only commands the editor has', () => {
    for (const item of tableContextItems(base.apply(base.tr.setSelection(TextSelection.create(base.doc, cell(1, 1) + 2))), cell(1, 1) + 2)) {
      expect(EDITOR_COMMANDS[item.command]).toBeTypeOf('function');
    }
  });
});

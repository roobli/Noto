/**
 * @vitest-environment happy-dom
 *
 * The arrows in a table move within it, and nothing grows a cell at its
 * edge. The gap cursor used to take the arrows at a cell's boundary and
 * typing there made a new column; a table at the note's edge used to make a
 * line past it. Both are gone: the keys are the table's own.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import { NotoEditor } from '../../src/renderer/editor/noto/NotoEditor';
import { moveCellVertically } from '../../src/renderer/editor/noto/block-edges';
import { parseDocument, toWire } from '../../src/shared/markdown/v3/document';
import { blockSpansFromWire, splitBlocks } from '../../src/shared/markdown/v3/blocks';

const encoder = new TextEncoder();

const editors: NotoEditor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.innerHTML = '';
});

function open(text: string) {
  const parsed = parseDocument(encoder.encode(text));
  if (parsed.status !== 'parsed') throw new Error(`parse failed: ${parsed.code}`);
  const wire = toWire(parsed.document);
  const host = document.createElement('div');
  document.body.append(host);
  const editor = new NotoEditor(host, wire, { mac: true }, blockSpansFromWire(wire) ?? splitBlocks(wire.text).spans);
  editors.push(editor);
  return editor;
}

/** The document position at the end (or start) of the text node `wanted`. */
function positionAt(editor: NotoEditor, wanted: string, end: boolean): number {
  const view = editor.getView()!;
  let pos = -1;
  view.state.doc.descendants((node, offset) => {
    if (node.isText && node.text === wanted) pos = offset + (end ? node.text.length : 0);
    return true;
  });
  if (pos < 0) throw new Error(`no text node ${wanted}`);
  return pos;
}

function caret(editor: NotoEditor, pos: number) {
  const view = editor.getView()!;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
}

function pressKey(editor: NotoEditor, key: string): boolean {
  const view = editor.getView()!;
  const event = new KeyboardEvent('keydown', { key });
  return view.someProp('handleKeyDown', (handle) => handle(view, event)) ?? false;
}

const cellCount = (editor: NotoEditor) => {
  const view = editor.getView()!;
  let cells = 0;
  view.state.doc.descendants((node) => {
    const role = node.type.spec.tableRole;
    if (role === 'cell' || role === 'header_cell') cells += 1;
    return true;
  });
  return cells;
};

describe('the up and down arrows move by column, not by the cell\'s number', () => {
  const grid = '| a | b |\n| --- | --- |\n| one | two |\n| three | four |\n';

  it('Down is the cell directly below, and Up the one directly above', () => {
    const editor = open(grid);
    // From anywhere in a single-line cell: its one line is top and bottom.
    caret(editor, positionAt(editor, 'one', true));
    expect(pressKey(editor, 'ArrowDown')).toBe(true);
    expect(editor.getView()!.state.selection.$from.parent.textContent).toBe('three');
    expect(pressKey(editor, 'ArrowUp')).toBe(true);
    expect(editor.getView()!.state.selection.$from.parent.textContent).toBe('one');

    // In the second column, Up reaches the header cell above it.
    caret(editor, positionAt(editor, 'two', false));
    expect(pressKey(editor, 'ArrowUp')).toBe(true);
    expect(editor.getView()!.state.selection.$from.parent.textContent).toBe('b');
    expect(pressKey(editor, 'ArrowDown')).toBe(true);
    expect(editor.getView()!.state.selection.$from.parent.textContent).toBe('two');

    // The command itself, without a view, moves the same way.
    const direct = editor.getView()!.state;
    let moved: number | null = null;
    expect(moveCellVertically(1)(direct, (tr) => { moved = tr.selection.$from.pos; })).toBe(true);
    expect(moved).not.toBeNull();
  });

  it('at the table\'s top or bottom row there is nothing to move to, and nothing is made', () => {
    // This note is only the table, so the edge command spends the key there.
    const editor = open(grid);
    const before = JSON.stringify(editor.getView()!.state.doc.toJSON());
    caret(editor, positionAt(editor, 'a', false));
    pressKey(editor, 'ArrowUp');
    caret(editor, positionAt(editor, 'four', true));
    pressKey(editor, 'ArrowDown');
    expect(JSON.stringify(editor.getView()!.state.doc.toJSON())).toBe(before);
    expect(cellCount(editor)).toBe(6);
  });

  it('at the note\'s edge the key is spent where the table is, and no line grows past it', () => {
    const editor = open('| a | b |\n| --- | --- |\n| one | two |\n');
    const before = JSON.stringify(editor.getView()!.state.doc.toJSON());
    caret(editor, positionAt(editor, 'two', true));
    expect(pressKey(editor, 'ArrowDown')).toBe(true);
    pressKey(editor, 'ArrowRight');
    expect(JSON.stringify(editor.getView()!.state.doc.toJSON())).toBe(before);
    expect(cellCount(editor)).toBe(4);

    caret(editor, positionAt(editor, 'a', false));
    expect(pressKey(editor, 'ArrowUp')).toBe(true);
    pressKey(editor, 'ArrowLeft');
    expect(JSON.stringify(editor.getView()!.state.doc.toJSON())).toBe(before);
  });

  it('a click at a cell\'s inner edge does not make a gap cursor there', () => {
    const editor = open('| a | b |\n| --- | --- |\n| one | two |\n');
    const view = editor.getView()!;
    caret(editor, positionAt(editor, 'two', true));
    const at = view.state.selection.from;
    const event = new MouseEvent('click', { clientX: 10, clientY: 10 });
    const handled = view.someProp('handleClick', (handle) => handle(view, at, event)) ?? false;
    expect(handled).toBe(false);
    expect(view.state.selection).toBeInstanceOf(TextSelection);
  });
});

describe('the gap cursor reads the document the browser just changed', () => {
  // Typing, and an input method composing, report the selection resolved in
  // the document the browser has already changed, which is longer than the
  // state's. Reading those positions against the state threw past its end on
  // every keystroke at the end of a note: the text flickered, only the first
  // letters of a pinyin showed, the characters never landed, and Save said a
  // composition was still active.
  it('answers for positions past the end of the state\'s document without throwing', () => {
    const editor = open('ab');
    const view = editor.getView()!;
    const longer = view.state.doc.replace(3, 3, view.state.doc.slice(1, 3));
    expect(longer.content.size).toBeGreaterThan(view.state.doc.content.size);
    const $end = longer.resolve(longer.content.size - 1);
    expect(() => view.someProp('createSelectionBetween', (make) => make(view, $end, $end))).not.toThrow();
  });

  it('still keeps itself out of a table read from the changed document', () => {
    const editor = open('| a | b |\n| --- | --- |\n| one | two |\n');
    const view = editor.getView()!;
    const $in = view.state.doc.resolve(positionAt(editor, 'two', true));
    expect(view.someProp('createSelectionBetween', (make) => make(view, $in, $in)) ?? null).toBeNull();
  });
});

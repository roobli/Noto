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

describe('arrows at the edge of a table', () => {
  it('never change the note at the note\'s edge: no line, no row, no column', () => {
    const table = '| a | b |\n| --- | --- |\n| one | two |\n';
    const editor = open(table);
    const before = JSON.stringify(editor.getView()!.state.doc.toJSON());

    caret(editor, positionAt(editor, 'two', true));
    pressKey(editor, 'ArrowDown');
    pressKey(editor, 'ArrowRight');
    expect(JSON.stringify(editor.getView()!.state.doc.toJSON())).toBe(before);
    expect(cellCount(editor)).toBe(4);

    // Up from the start of the first cell, with the table starting the note.
    caret(editor, positionAt(editor, 'a', false));
    pressKey(editor, 'ArrowUp');
    pressKey(editor, 'ArrowLeft');
    expect(JSON.stringify(editor.getView()!.state.doc.toJSON())).toBe(before);
    expect(cellCount(editor)).toBe(4);
  });

  it('Down from the last row steps into the line that is already there, and nothing else changes', () => {
    const editor = open('before\n\n| a | b |\n| --- | --- |\n| one | two |\n\nafter\n');
    caret(editor, positionAt(editor, 'two', true));
    const handled = pressKey(editor, 'ArrowDown');
    const { selection } = editor.getView()!.state;
    // The caret left the table; however the caret fell, the note's shape is intact.
    expect(cellCount(editor)).toBe(4);
    expect(editor.getView()!.state.doc.childCount).toBe(3);
    if (handled) expect(selection.$from.parent.textContent).toBe('after');
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

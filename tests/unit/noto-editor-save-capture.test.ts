/**
 * @vitest-environment happy-dom
 *
 * Each save's capture is its own, so overlapping saves cannot vouch for each other.
 *
 * The editor used to keep a single "what the save captured" slot, and every
 * capture overwrote it. If a second save captured the buffer while the first
 * was still in flight (a menu save through a stale closure, a second trigger
 * before React re-rendered), and main then refused the second one, the first
 * save's commit compared the buffer against the second capture. The edits
 * typed in between were reported clean although the file never held them, and
 * closing the note lost them without a prompt.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { NotoEditor } from '../../src/renderer/editor/noto/NotoEditor';
import { parseDocument, toWire } from '../../src/shared/markdown/v3/document';
import { blockSpansFromWire, splitBlocks } from '../../src/shared/markdown/v3/blocks';
import { serializeDocument } from '../../src/shared/markdown/v3/serialize';
import { expandTransaction } from '../../src/shared/markdown/v3/revision-patch';
import type { NotoDocument, NotoTransactionWire } from '../../src/shared/markdown/v3/contracts';

const encoder = new TextEncoder();

function parsed(text: string): NotoDocument {
  const result = parseDocument(encoder.encode(text));
  if (result.status !== 'parsed') throw new Error(`parse failed: ${result.code}`);
  return result.document;
}

const editors: NotoEditor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.innerHTML = '';
});

function open(text: string) {
  const document0 = parsed(text);
  const wire = toWire(document0);
  const host = document.createElement('div');
  document.body.append(host);
  const editor = new NotoEditor(host, wire, { mac: false }, blockSpansFromWire(wire) ?? splitBlocks(wire.text).spans);
  editors.push(editor);
  return { editor, document: document0 };
}

/** What main would accept for this capture, as the reply the renderer commits. */
function accepted(base: NotoDocument, transaction: NotoTransactionWire) {
  const expanded = expandTransaction(transaction, base);
  if (!expanded) throw new Error('transaction did not expand');
  const result = serializeDocument(base, expanded);
  if (result.status !== 'serialized') throw new Error('serialize failed');
  return { ...toWire(result.document), nodes: null };
}

function type(editor: NotoEditor, text: string) {
  const view = editor.getView()!;
  view.dispatch(view.state.tr.insertText(text, 1));
}

describe('overlapping save captures', () => {
  it('keeps edits typed between two captures dirty when the second save is refused', () => {
    const h = open('# Note\n\nAlpha beta.\n');
    type(h.editor, 'A');
    const first = h.editor.captureSaveTicket();
    // Typed before React re-rendered, then a second save captured the buffer.
    type(h.editor, 'B');
    const second = h.editor.captureSaveTicket();
    expect(second.captureId).not.toBe(first.captureId);
    // Main refused the second save as concurrent; the first one lands.
    h.editor.abandonSave(second.captureId);
    h.editor.commit(accepted(h.document, first.transaction), first.captureId);
    expect(h.editor.isDirty).toBe(true);
  });

  it('still reports dirty when the refused save commits nothing and the first lands last', () => {
    const h = open('# Note\n\nAlpha beta.\n');
    type(h.editor, 'A');
    const first = h.editor.captureSaveTicket();
    type(h.editor, 'B');
    h.editor.captureSaveTicket();
    // No abandon at all: a capture that is never resolved must not stand in
    // for the one this commit belongs to.
    h.editor.commit(accepted(h.document, first.transaction), first.captureId);
    expect(h.editor.isDirty).toBe(true);
  });

  it('abandoning one save leaves another save capture intact', () => {
    const h = open('# Note\n\nAlpha beta.\n');
    type(h.editor, 'A');
    const first = h.editor.captureSaveTicket();
    type(h.editor, 'B');
    const second = h.editor.captureSaveTicket();
    // The first save failed in transport; the second carries everything.
    h.editor.abandonSave(first.captureId);
    h.editor.commit(accepted(h.document, second.transaction), second.captureId);
    expect(h.editor.isDirty).toBe(false);
  });

  it('treats a commit for a capture it does not know as leaving the buffer dirty', () => {
    const h = open('# Note\n\nAlpha beta.\n');
    type(h.editor, 'A');
    const first = h.editor.captureSaveTicket();
    h.editor.abandonSave(first.captureId);
    h.editor.commit(accepted(h.document, first.transaction), first.captureId);
    expect(h.editor.isDirty).toBe(true);
  });

  it('a single save with nothing typed during it ends clean', () => {
    const h = open('# Note\n\nAlpha beta.\n');
    type(h.editor, 'A');
    const only = h.editor.captureSaveTicket();
    h.editor.commit(accepted(h.document, only.transaction), only.captureId);
    expect(h.editor.isDirty).toBe(false);
  });
});

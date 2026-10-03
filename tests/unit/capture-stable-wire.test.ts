import { describe, expect, it } from 'vitest';
import type { Node as ProseNode } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { docFromSpans } from '../../src/shared/markdown/v3/pm/from-mdast';
import { splitBlocks } from '../../src/shared/markdown/v3/blocks';
import { parseDocument, toWire } from '../../src/shared/markdown/v3/document';
import { toLf } from '../../src/shared/markdown/v3/line-endings';
import { serializeDocument } from '../../src/shared/markdown/v3/serialize';
import type { NotoDocument } from '../../src/shared/markdown/v3/contracts';
import { compactTransaction, expandTransaction } from '../../src/shared/markdown/v3/revision-patch';
import { captureStableWire, captureTransaction, type PristineBlock } from '../../src/renderer/editor/noto/capture';
import { createOriginPlugin, getBlockOrigins } from '../../src/renderer/editor/noto/origin-plugin';

const encoder = new TextEncoder();

function documentOf(source: string): NotoDocument {
  const result = parseDocument(encoder.encode(source));
  if (result.status !== 'parsed') throw new Error(`parse failed: ${result.code}`);
  return result.document;
}

function editorFrom(document: NotoDocument) {
  const wire = toWire(document);
  const spans = splitBlocks(wire.text).spans;
  const doc = docFromSpans(spans);
  const pristine = new Map<string, PristineBlock>();
  const accepted: ProseNode[] = [];
  doc.forEach((node, _offset, index) => {
    accepted.push(node);
    const origin = wire.origins[index];
    const span = spans[index];
    if (origin && span) pristine.set(origin.blockId, { node, markdown: toLf(span.markdown) });
  });
  const state = EditorState.create({ doc, plugins: [createOriginPlugin(wire.origins)] });
  return { document, wire, state, pristine, accepted };
}

function positionInBlock(doc: ProseNode, index: number): number {
  let position = 0;
  for (let current = 0; current < index; current += 1) position += doc.child(current).nodeSize;
  return position + 1;
}

function expectSameSave(context: ReturnType<typeof editorFrom>, state = context.state) {
  const input = {
    doc: state.doc,
    origins: getBlockOrigins(state),
    document: context.wire,
    pristine: context.pristine,
  };
  const full = captureTransaction(input);
  const compact = compactTransaction(full.transaction, context.wire);
  const stable = captureStableWire(input, context.accepted);
  expect(stable.stats).toEqual(full.stats);
  expect(stable.transaction).toEqual(compact);
  if (full.transaction.mode !== 'blocks') throw new Error('expected blocks');
  expect(expandTransaction(stable.transaction, context.document)).toEqual(full.transaction);
  return full;
}

describe('capture stable wire', () => {
  const source = '# Title\n\nBody text.\n\n- a\n- b\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```ts\nconst a = 1;\n```\n';

  it('is one kept run when nothing was edited', () => {
    const context = editorFrom(documentOf(source));
    const full = expectSameSave(context);
    if (full.transaction.mode !== 'blocks') throw new Error('expected blocks');
    const stable = captureStableWire({
      doc: context.state.doc,
      origins: getBlockOrigins(context.state),
      document: context.wire,
      pristine: context.pristine,
    }, context.accepted);
    if (stable.transaction.mode !== 'blocks') throw new Error('expected blocks');
    expect(stable.transaction.units).toEqual([{ keep: 0, count: context.state.doc.childCount }]);
  });

  it('matches the full capture after one interior edit, bytes included', () => {
    const context = editorFrom(documentOf(source));
    const at = positionInBlock(context.state.doc, 1);
    const state = context.state.apply(context.state.tr.insertText('New ', at));
    const full = expectSameSave(context, state);
    const expanded = expandTransaction(
      captureStableWire({
        doc: state.doc,
        origins: getBlockOrigins(state),
        document: context.wire,
        pristine: context.pristine,
      }, context.accepted).transaction,
      context.document,
    );
    if (!expanded || expanded.mode !== 'blocks' || full.transaction.mode !== 'blocks') throw new Error('expected blocks');
    const viaWire = serializeDocument(context.document, expanded);
    const viaFull = serializeDocument(context.document, full.transaction);
    expect(viaWire).toEqual(viaFull);
    if (viaWire.status !== 'serialized') return;
    expect(Buffer.from(viaWire.outputBytes).toString('utf8')).toContain('New Body text.');
    expect(Buffer.from(viaWire.outputBytes).toString('utf8')).toContain('```ts\nconst a = 1;\n```');
  });

  it('matches across two non-adjacent edits and a deleted block', () => {
    const context = editorFrom(documentOf(source));
    let state = context.state.apply(context.state.tr.insertText('A', positionInBlock(context.state.doc, 0)));
    state = state.apply(state.tr.insertText('B', positionInBlock(state.doc, 2)));
    expectSameSave(context, state);

    const doc = context.state.doc;
    const start = positionInBlock(doc, 1) - 1;
    const deleted = context.state.apply(context.state.tr.delete(start, start + doc.child(1).nodeSize));
    expect(deleted.doc.childCount).toBe(doc.childCount - 1);
    expectSameSave(context, deleted);
  });

  it('stays equal on a few hundred blocks with one edit in the middle', () => {
    const many = `${Array.from({ length: 400 }, (_, index) => `Paragraph number ${index}.`).join('\n\n')}\n`;
    const context = editorFrom(documentOf(many));
    const at = positionInBlock(context.state.doc, 200);
    const state = context.state.apply(context.state.tr.insertText('X', at));
    const full = expectSameSave(context, state);
    expect(full.stats).toEqual({ reused: context.state.doc.childCount - 1, serialized: 1 });
    const stable = captureStableWire({
      doc: state.doc,
      origins: getBlockOrigins(state),
      document: context.wire,
      pristine: context.pristine,
    }, context.accepted);
    if (stable.transaction.mode !== 'blocks') throw new Error('expected blocks');
    expect(stable.transaction.units).toHaveLength(3);
  });
});

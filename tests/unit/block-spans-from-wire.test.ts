import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { blockSpansFromWire, splitBlocks } from '../../src/shared/markdown/v3/blocks';
import { blockToMarkdown } from '../../src/shared/markdown/v3/pm/to-mdast';
import { blockFromSpan, docFromSpans } from '../../src/shared/markdown/v3/pm/from-mdast';
import { parseDocument, toWire } from '../../src/shared/markdown/v3/document';
import { cloneParsedSpans } from '../../src/renderer/editor/noto/parse-document';
import { createEnrichFlags, lazyNodeSpan, splitBlocksViaRoobli } from '../../src/shared/markdown/v3/roobli-md-adapter';
import { canSkipDialectEnrich, collectFootnoteDefinitionIds, withKnownFootnoteIds } from '../../src/shared/markdown/v3/pm/from-engine';
import { isNotoDocumentWire } from '../../src/shared/file-truth/v1/validate';

/**
 * Open ships mdast nodes on the wire so the renderer can skip its Worker parse.
 * These checks are the safety net: wire nodes must build the same ProseMirror
 * document as a fresh splitBlocks, including after the structured clone IPC
 * applies.
 */
describe('blockSpansFromWire', () => {
  const sample = [
    '---',
    'title: Note',
    '---',
    '',
    '# Heading',
    '',
    'A paragraph with **bold** and a [link](https://example.com).',
    '',
    '- bullet',
    '- [ ] task',
    '',
    '```ts',
    'const n = 1;',
    '```',
    '',
    '    indented',
    '',
    '| a | b |',
    '| - | - |',
    '| 1 | 2 |',
    '',
    '$$',
    'x = 1',
    '$$',
    '',
    '> quote',
    '',
    '***',
    '',
    '[id]: https://example.com',
    '',
    '[^fn]: a footnote',
    '',
  ].join('\n');

  it('returns null for an incremental save, which ships neither nodes nor an open shape', () => {
    const parsed = parseDocument(Buffer.from(sample, 'utf8'));
    if (parsed.status !== 'parsed') throw new Error(parsed.message);
    const { nodesEnrichment: _omitted, ...rest } = toWire(parsed.document);
    expect(blockSpansFromWire({ ...rest, nodes: null })).toBeNull();
    // A full open that somehow lost its nodes is not a deferred open either.
    expect(blockSpansFromWire({ ...rest, nodes: null, nodesEnrichment: 'full' })).toBeNull();
  });

  it('derives the same stand-ins main used to ship, without sending them', () => {
    const parsed = parseDocument(Buffer.from(sample, 'utf8'));
    if (parsed.status !== 'parsed') throw new Error(parsed.message);
    const wire = structuredClone(toWire(parsed.document));
    expect(wire.nodesEnrichment).toBe('deferred');
    expect(wire.nodes).toBeNull();
    const derived = blockSpansFromWire(wire)!;
    const eager = splitBlocksViaRoobli(sample, { enrich: 'none' }).spans;
    expect(derived.map((span) => span.node)).toEqual(eager.map((span) => span.node));
    expect(derived.map((span) => span.semanticKey)).toEqual(eager.map((span) => span.semanticKey));
  });

  it('builds the same ProseMirror document as a fresh splitBlocks', () => {
    const parsed = parseDocument(Buffer.from(sample, 'utf8'));
    if (parsed.status !== 'parsed') throw new Error(parsed.message);
    const wire = toWire(parsed.document);

    const fromWire = blockSpansFromWire(wire);
    expect(fromWire).not.toBeNull();
    const fresh = splitBlocks(sample).spans;

    expect(fromWire!).toHaveLength(fresh.length);
    for (let index = 0; index < fresh.length; index += 1) {
      const left = fresh[index]!;
      const right = fromWire![index]!;
      expect(right.kind).toBe(left.kind);
      expect(right.start).toBe(left.start);
      expect(right.end).toBe(left.end);
      expect(right.markdown).toBe(left.markdown);
      expect(right.semanticKey).toBe(left.semanticKey);
      expect(blockToMarkdown(blockFromSpan(right))).toBe(blockToMarkdown(blockFromSpan(left)));
    }

    expect(docFromSpans(fromWire!).toJSON()).toEqual(docFromSpans(fresh).toJSON());
  });

  it('survives structured clone the way Electron IPC does', () => {
    const parsed = parseDocument(Buffer.from(sample, 'utf8'));
    if (parsed.status !== 'parsed') throw new Error(parsed.message);
    const cloned = structuredClone(toWire(parsed.document));
    const spans = blockSpansFromWire(cloned);
    expect(spans).not.toBeNull();
    const again = cloneParsedSpans(spans!);
    expect(docFromSpans(again).toJSON()).toEqual(docFromSpans(spans!).toJSON());
  });

  it('builds a lazy stand-in once, and only when read', () => {
    let built = 0;
    const span = lazyNodeSpan(
      { kind: 'paragraph', start: 0, end: 1, markdown: 'x', semanticKey: 'paragraph' },
      () => { built += 1; return { type: 'paragraph', children: [{ type: 'text', value: 'x' }] }; },
    );
    expect(built).toBe(0);
    expect(span.node.type).toBe('paragraph');
    expect(span.node).toBe(span.node);
    expect(built).toBe(1);
    // Copies see a plain value, the way IPC and spreads do.
    expect(structuredClone(span).node).toEqual(span.node);
    expect({ ...span }.node).toBe(span.node);
  });

  it('derives the stand-ins main used to ship for every golden fixture', () => {
    const dir = path.resolve(__dirname, '../fixtures/markdown-golden');
    const files = readdirSync(dir).filter((name) => name.endsWith('.md') && name !== 'README.md');
    expect(files.length).toBeGreaterThan(50);
    for (const name of files) {
      const text = readFileSync(path.join(dir, name), 'utf8');
      const parsed = parseDocument(new TextEncoder().encode(text));
      if (parsed.status !== 'parsed') throw new Error(parsed.message);
      const wire = structuredClone(toWire(parsed.document));
      const derived = blockSpansFromWire(wire)!;
      const eager = splitBlocksViaRoobli(parsed.document.text, { enrich: 'none' }).spans;
      expect(derived.map((span) => span.node), name).toEqual(eager.map((span) => span.node));
      expect(docFromSpans(derived).toJSON(), name).toEqual(docFromSpans(eager).toJSON());
    }
  });

  it('carries main\'s engine-owned answers, and they match asking again', () => {
    const dir = path.resolve(__dirname, '../fixtures/markdown-golden');
    for (const name of readdirSync(dir).filter((file) => file.endsWith('.md') && file !== 'README.md')) {
      const text = readFileSync(path.join(dir, name), 'utf8');
      const parsed = parseDocument(new TextEncoder().encode(text));
      if (parsed.status !== 'parsed') throw new Error(parsed.message);
      const wire = structuredClone(toWire(parsed.document));
      expect(wire.engineOwned, name).toHaveLength(wire.origins.length);
      expect(isNotoDocumentWire(wire), name).toBe(true);
      const spans = blockSpansFromWire(wire)!;
      const asked = withKnownFootnoteIds(collectFootnoteDefinitionIds(spans),
        () => spans.map((span) => canSkipDialectEnrich(span.kind, span.markdown)));
      expect(spans.map((span) => span.engineOwned), name).toEqual(asked);
      // Flags from the shipped answers are the flags asking would give.
      const plain = spans.map(({ kind, markdown }) => ({ kind, markdown }));
      for (const from of [0, 1, Math.floor(spans.length / 2)]) {
        expect(createEnrichFlags(spans.length, from, spans), name).toEqual(createEnrichFlags(spans.length, from, plain));
      }
    }
  });

  it('refuses engine-owned answers that do not fit the document', () => {
    const parsed = parseDocument(Buffer.from(sample, 'utf8'));
    if (parsed.status !== 'parsed') throw new Error(parsed.message);
    const wire = toWire(parsed.document);
    expect(isNotoDocumentWire(wire)).toBe(true);
    expect(isNotoDocumentWire({ ...wire, engineOwned: `${wire.engineOwned}1` })).toBe(false);
    expect(isNotoDocumentWire({ ...wire, engineOwned: wire.engineOwned!.replace(/./, '2') })).toBe(false);
    expect(isNotoDocumentWire({ ...wire, engineOwned: 7 })).toBe(false);
    const { engineOwned: _gone, ...withoutOwned } = wire;
    expect(isNotoDocumentWire(withoutOwned)).toBe(true);
    const { nodesEnrichment: _none, ...incremental } = wire;
    expect(isNotoDocumentWire(incremental)).toBe(false);
  });
});


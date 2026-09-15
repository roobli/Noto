/**
 * Open-path adapter enrich modes (flagged `@roobli/md`).
 *
 * Bulk attach remains the default adapter enrich; flagged `parseDocument` now
 * ships `enrich: 'none'` (deferred) and the renderer fills a first-paint window
 * via `enrichSpansInRange`. Default product engine stays micromark.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  splitBlocksViaRoobli,
  parseBlocksStructural,
  enrichSpansInRange,
  resolveDeferredOpenSpans,
  OPEN_LAZY_INITIAL_SPANS,
} from '../../src/shared/markdown/v3/roobli-md-adapter';
import { setMarkdownEngineForTests } from '../../src/shared/markdown/v3/engine-flag';
import { parseDocument } from '../../src/shared/markdown/v3/document';
import { splitBlocksMicromark } from '../../src/shared/markdown/v3/blocks';

const fixturesDir = path.join(process.cwd(), 'tests/fixtures/roobli-md-parity');
const corpusSmall = path.join(process.cwd(), 'out/bench/corpus/small.md');

afterEach(() => {
  setMarkdownEngineForTests(null);
});

const SAMPLES = [
  '# Hello\n\nWorld\n',
  '- a\n- b\n\nPara\n',
  '```js\ncode\n```\n\nAfter\n',
  '| a | b |\n| --- | --- |\n| 1 | 2 |\n',
  '- [ ] todo\n- [x] done\n',
  '$$\nx\n$$\n',
  '---\ntitle: x\n---\n\nHi\n',
  '> quote\n\nPara\n',
  readFileSync(path.join(fixturesDir, 'basic.md'), 'utf8'),
  readFileSync(path.join(fixturesDir, 'fences-tight.md'), 'utf8'),
];

describe('open-path SpanEnrichMode', () => {
  it('bulk matches per-span kind / markdown / semanticKey on samples', () => {
    for (const text of SAMPLES) {
      const bulk = splitBlocksViaRoobli(text, { enrich: 'bulk' });
      const perSpan = splitBlocksViaRoobli(text, { enrich: 'per-span' });
      expect(bulk.spans.map((s) => [s.kind, s.start, s.end, s.markdown, s.semanticKey])).toEqual(
        perSpan.spans.map((s) => [s.kind, s.start, s.end, s.markdown, s.semanticKey]),
      );
      expect(bulk.leading).toBe(perSpan.leading);
      expect(bulk.gaps).toEqual(perSpan.gaps);
      expect(bulk.trailing).toBe(perSpan.trailing);
      for (let i = 0; i < bulk.spans.length; i += 1) {
        expect(bulk.spans[i]!.node.type).toBe(perSpan.spans[i]!.node.type);
      }
    }
  });

  it('none keeps native offsets and kind-aware stand-ins without dialect kinds drift on structure', () => {
    const text = '# Hi\n\nPara\n';
    const structural = parseBlocksStructural(text);
    const none = splitBlocksViaRoobli(text, { enrich: 'none' });
    expect(none.spans.map((s) => [s.start, s.end, s.markdown, s.kind])).toEqual(
      structural.spans.map((s) => [s.start, s.end, s.markdown, s.kind]),
    );
    expect(none.spans.every((s) => s.semanticKey === s.kind)).toBe(true);
    expect(none.spans.map((s) => s.node.type)).toEqual(['heading', 'paragraph']);
    expect(none.spans[0]!).toMatchObject({
      kind: 'heading',
      node: { type: 'heading', depth: 1, children: [{ type: 'text', value: 'Hi' }] },
    });
  });

  it('none stand-ins are kind-aware for fence / hr / quote / math shells', () => {
    const samples: Array<{ text: string; types: string[] }> = [
      { text: '```js\ncode\n```\n\nAfter\n', types: ['code', 'paragraph'] },
      { text: '---\n\nPara\n', types: ['thematicBreak', 'paragraph'] },
      { text: '> quote\n\nPara\n', types: ['blockquote', 'paragraph'] },
      { text: '$$\nx\n$$\n\nAfter\n', types: ['math', 'paragraph'] },
    ];
    for (const { text, types } of samples) {
      const none = splitBlocksViaRoobli(text, { enrich: 'none' });
      expect(none.spans.map((s) => s.node.type)).toEqual(types);
      expect(none.spans.every((s) => s.semanticKey === s.kind)).toBe(true);
    }
    const fence = splitBlocksViaRoobli('```ts\nconst x = 1;\n```\n', { enrich: 'none' });
    expect(fence.spans[0]!.node).toMatchObject({ type: 'code', lang: 'ts', value: 'const x = 1;' });
    const fenceMeta = splitBlocksViaRoobli('```rust linenums\nfn main() {}\n```\n', { enrich: 'none' });
    expect(fenceMeta.spans[0]!.node).toMatchObject({
      type: 'code', lang: 'rust', meta: 'linenums', value: 'fn main() {}',
    });
  });

  it('default enrich is bulk (same shape as explicit bulk)', () => {
    const text = '## A\n\nbody\n';
    const def = splitBlocksViaRoobli(text);
    const bulk = splitBlocksViaRoobli(text, { enrich: 'bulk' });
    expect(def.spans.map((s) => s.semanticKey)).toEqual(bulk.spans.map((s) => s.semanticKey));
  });

  it('flagged parseDocument ships deferred structural nodes (enrich none)', () => {
    setMarkdownEngineForTests('roobli-md');
    const text = '# Title\n\nHello **world**\n';
    const bytes = new TextEncoder().encode(text);
    const parsed = parseDocument(bytes);
    expect(parsed.status).toBe('parsed');
    if (parsed.status !== 'parsed') return;
    expect(parsed.document.nodesEnrichment).toBe('deferred');
    expect(parsed.document.nodes).not.toBeNull();
    expect(parsed.document.nodes!.length).toBe(parsed.document.blocks.length);
    // Structural stand-ins: kinds from the native scanner; kind-aware mdast shells.
    expect(parsed.document.blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph']);
    expect(parsed.document.nodes!.map((n) => n.type)).toEqual(['heading', 'paragraph']);
    expect(parsed.document.blocks.every((b) => b.semanticKey === b.kind)).toBe(true);
  });

  it('micromark parseDocument still ships full dialect nodes', () => {
    setMarkdownEngineForTests('micromark');
    const text = '# Title\n\nHello **world**\n';
    const parsed = parseDocument(new TextEncoder().encode(text));
    expect(parsed.status).toBe('parsed');
    if (parsed.status !== 'parsed') return;
    expect(parsed.document.nodesEnrichment).toBe('full');
    expect(parsed.document.nodes![0]!.type).toBe('heading');
    expect(parsed.document.nodes![1]!.type).toBe('paragraph');
  });

  it('enrichSpansInRange attaches dialect with one window parse', () => {
    const text = '# A\n\npara **x**\n\n## B\n\nmore\n';
    const none = splitBlocksViaRoobli(text, { enrich: 'none' });
    const bulk = splitBlocksViaRoobli(text, { enrich: 'bulk' });
    const partial = enrichSpansInRange(none.spans, text, { from: 0, to: 2 });
    expect(partial.slice(0, 2).map((s) => [s.kind, s.node.type, s.semanticKey])).toEqual(
      bulk.spans.slice(0, 2).map((s) => [s.kind, s.node.type, s.semanticKey]),
    );
    // Unenriched tail stays kind-aware structural stand-ins (## B → heading).
    expect(partial[2]!.node.type).toBe('heading');
    expect(partial[2]!.semanticKey).toBe(partial[2]!.kind);
    const full = enrichSpansInRange(partial, text, { from: 2, to: partial.length });
    expect(full.map((s) => [s.kind, s.node.type, s.semanticKey])).toEqual(
      bulk.spans.map((s) => [s.kind, s.node.type, s.semanticKey]),
    );
  });

  it('resolveDeferredOpenSpans enriches the first-paint window only', () => {
    const text = Array.from({ length: OPEN_LAZY_INITIAL_SPANS + 5 }, (_, i) => `Para ${i}\n\n`).join('');
    const none = splitBlocksViaRoobli(text, { enrich: 'none' });
    const prepared = resolveDeferredOpenSpans(none.spans, text, { deferred: true });
    expect(prepared.remainderFrom).toBe(OPEN_LAZY_INITIAL_SPANS);
    expect(prepared.spans.length).toBe(none.spans.length);
    expect(prepared.remainderFrom).toBeLessThan(prepared.spans.length);
    const done = resolveDeferredOpenSpans(none.spans, text, { deferred: false });
    expect(done.remainderFrom).toBeNull();
    expect(done.spans).toBe(none.spans);
  });

  it('bulk structural offsets stay aligned with micromark on small corpus when present', () => {
    let text: string;
    try {
      text = readFileSync(corpusSmall, 'utf8');
    } catch {
      return; // corpus not generated in every CI job
    }
    const bulk = splitBlocksViaRoobli(text, { enrich: 'bulk' });
    const micro = splitBlocksMicromark(text);
    expect(bulk.spans.length).toBe(micro.spans.length);
    expect(bulk.spans.map((s) => [s.start, s.end, s.markdown])).toEqual(
      micro.spans.map((s) => [s.start, s.end, s.markdown]),
    );
  });
});

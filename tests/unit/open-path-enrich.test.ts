/**
 * Open-path adapter enrich modes (flagged `@roobli/md`).
 *
 * Bulk attach is the measured first cut; `none` is scaffolding for the next
 * residual. Default product engine stays micromark — these tests force the
 * adapter explicitly.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  splitBlocksViaRoobli,
  parseBlocksStructural,
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

  it('none keeps native offsets and stand-in nodes without dialect kinds drift on structure', () => {
    const text = '# Hi\n\nPara\n';
    const structural = parseBlocksStructural(text);
    const none = splitBlocksViaRoobli(text, { enrich: 'none' });
    expect(none.spans.map((s) => [s.start, s.end, s.markdown, s.kind])).toEqual(
      structural.spans.map((s) => [s.start, s.end, s.markdown, s.kind]),
    );
    expect(none.spans.every((s) => s.semanticKey === s.kind)).toBe(true);
    expect(none.spans.every((s) => s.node.type === 'paragraph')).toBe(true);
  });

  it('default enrich is bulk (same shape as explicit bulk)', () => {
    const text = '## A\n\nbody\n';
    const def = splitBlocksViaRoobli(text);
    const bulk = splitBlocksViaRoobli(text, { enrich: 'bulk' });
    expect(def.spans.map((s) => s.semanticKey)).toEqual(bulk.spans.map((s) => s.semanticKey));
  });

  it('flagged parseDocument ships nodes with bulk enrich', () => {
    setMarkdownEngineForTests('roobli-md');
    const text = '# Title\n\nHello **world**\n';
    const bytes = new TextEncoder().encode(text);
    const parsed = parseDocument(bytes);
    expect(parsed.status).toBe('parsed');
    if (parsed.status !== 'parsed') return;
    expect(parsed.document.nodes).not.toBeNull();
    expect(parsed.document.nodes!.length).toBe(parsed.document.blocks.length);
    expect(parsed.document.nodes![0]!.type).toBe('heading');
    expect(parsed.document.nodes![1]!.type).toBe('paragraph');
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

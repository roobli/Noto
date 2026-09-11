/**
 * Parity and adapter coverage for `@roobli/md` v0.1.1.
 *
 * Default product path stays micromark. These tests force the adapter and
 * compare structural spans against the micromark baseline on synthetic
 * fixtures (no RooB private content).
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  joinSplit,
  parseBlocksStructural,
  parseSingleBlockViaRoobli,
  reparseBlocks,
  reparseBlocksViaRoobli,
  serializeIdentityViaRoobli,
  splitBlocksViaRoobli,
} from '../../src/shared/markdown/v3/roobli-md-adapter';
import { splitBlocksMicromark, parseSingleBlock, splitBlocks } from '../../src/shared/markdown/v3/blocks';
import { parseDocument, sha256 } from '../../src/shared/markdown/v3/document';
import { identityTransaction, serializeDocument } from '../../src/shared/markdown/v3/serialize';
import { setMarkdownEngineForTests } from '../../src/shared/markdown/v3/engine-flag';
import { parseDocument as engineParseDocument } from '@roobli/md';

const fixturesDir = path.join(process.cwd(), 'tests/fixtures/roobli-md-parity');
const g002Dir = path.join(process.cwd(), 'tests/fixtures/g002-v1');

const SYNTHETIC = [
  '# Hello\n\nWorld\n',
  '- a\n- b\n\nPara\n',
  '```js\ncode\n\nstill\n```\n\nAfter\n',
  '| a | b |\n| --- | --- |\n| 1 | 2 |\n',
  '- [ ] todo\n- [x] done\n',
  '$$\nx\n$$\n',
  '---\ntitle: x\n---\n\nHi\n',
  '***\n\nPara\n',
  '> quote\n\nPara\n',
  '[^1]: note\n\nPara\n',
  '[id]: https://example.com\n\nPara\n',
  '<div>\nhello\n</div>\n\nPara\n',
];

/** g002 fixtures where native offsets currently match micromark. */
const G002_PARITY = [
  'adjacent.md',
  'bullet-list.md',
  'cjk-inline.md',
  'extension.md',
  'fences.md',
  'frontmatter.md',
  'html.md',
  'lists-tasks.md',
  'malformed-extension.md',
  'malformed-fence.md',
  'malformed-html-comment.md',
  'malformed-raw-html.md',
  'quote-callout.md',
  'raw-html.md',
  'table-math.md',
];

afterEach(() => {
  setMarkdownEngineForTests(null);
});

function structuralParity(text: string): void {
  const engine = parseBlocksStructural(text);
  const micro = splitBlocksMicromark(text);
  expect(joinSplit(engine, text)).toBe(text);
  expect(engine.spans.map((s) => [s.start, s.end, s.markdown])).toEqual(
    micro.spans.map((s) => [s.start, s.end, s.markdown]),
  );
  expect(engine.leading).toBe(micro.leading);
  expect(engine.gaps).toEqual([...micro.gaps]);
  expect(engine.trailing).toBe(micro.trailing);
}

describe('@roobli/md adapter — structural parity', () => {
  for (const sample of SYNTHETIC) {
    it(`matches micromark offsets: ${JSON.stringify(sample).slice(0, 48)}`, () => {
      structuralParity(sample);
    });
  }

  for (const name of readdirSync(fixturesDir).filter((f) => f.endsWith('.md'))) {
    it(`parity fixture ${name}`, () => {
      structuralParity(readFileSync(path.join(fixturesDir, name), 'utf8'));
    });
  }

  for (const name of G002_PARITY) {
    it(`g002 parity ${name}`, () => {
      structuralParity(readFileSync(path.join(g002Dir, name), 'utf8'));
    });
  }

  it('matches micromark on g004 tight quote then callout', () => {
    const text = '> A regular quote remains semantically editable.\n\n> [!NOTE]\n> Callout source remains exact and visible.\n';
    structuralParity(text);
  });
});

describe('@roobli/md adapter — flag routing', () => {
  it('defaults to micromark', () => {
    setMarkdownEngineForTests(null);
    const text = '# A\n\nB\n';
    expect(splitBlocks(text).spans.map((s) => s.markdown)).toEqual(
      splitBlocksMicromark(text).spans.map((s) => s.markdown),
    );
  });

  it('routes splitBlocks through the adapter when flagged', () => {
    setMarkdownEngineForTests('roobli-md');
    const text = '# A\n\nB\n';
    const viaFlag = splitBlocks(text);
    const viaAdapter = splitBlocksViaRoobli(text);
    expect(viaFlag.spans.map((s) => [s.kind, s.start, s.end, s.markdown])).toEqual(
      viaAdapter.spans.map((s) => [s.kind, s.start, s.end, s.markdown]),
    );
    expect(viaFlag.spans.every((s) => s.node != null)).toBe(true);
    expect(viaFlag.spans.every((s) => s.semanticKey.length > 0)).toBe(true);
  });

  it('parseSingleBlock agrees on a heading', () => {
    setMarkdownEngineForTests('roobli-md');
    const span = parseSingleBlock('# Title');
    expect(span?.kind).toBe('heading');
    expect(parseSingleBlockViaRoobli('# Title')?.markdown).toBe('# Title');
    expect(parseSingleBlock('# A\n\n# B')).toBeNull();
  });
});

describe('@roobli/md adapter — reparseBlocks window', () => {
  it('reparses a middle window and keeps prefix identity', () => {
    const text = '# One\n\nTwo\n\nThree\n';
    const prior = parseBlocksStructural(text);
    const nextText = '# One\n\nDeux\n\nThree\n';
    const structural = reparseBlocks({
      prior,
      text: nextText,
      replacedBlocks: { from: 1, to: 1 },
      neighborSlack: 0,
    });
    expect(structural.spans).toHaveLength(3);
    expect(structural.spans[0]).toBe(prior.spans[0]); // untouched prefix object identity
    expect(structural.spans[1]!.markdown).toBe('Deux');
    expect(structural.spans[2]!.markdown).toBe(prior.spans[2]!.markdown);
    expect(joinSplit(structural, nextText)).toBe(nextText);

    const enriched = reparseBlocksViaRoobli({
      prior,
      text: nextText,
      replacedBlocks: { from: 1, to: 1 },
      neighborSlack: 0,
    });
    expect(enriched.spans[1]!.markdown).toBe('Deux');
    expect(enriched.spans[1]!.node).toBeTruthy();
    expect(enriched.spans[1]!.semanticKey.length).toBeGreaterThan(0);
  });
});

describe('@roobli/md adapter — serialize identity', () => {
  it('engine identity serialize matches Noto identity bytes on synthetic docs', () => {
    const samples = [
      '# Hello\n\nWorld\n',
      readFileSync(path.join(fixturesDir, 'basic.md'), 'utf8'),
      readFileSync(path.join(fixturesDir, 'frontmatter.md'), 'utf8'),
    ];
    for (const source of samples) {
      const bytes = new TextEncoder().encode(source);
      const noto = parseDocument(bytes);
      expect(noto.status).toBe('parsed');
      if (noto.status !== 'parsed') continue;

      const identity = serializeDocument(noto.document, identityTransaction(noto.document));
      expect(identity.status).toBe('serialized');
      if (identity.status !== 'serialized') continue;

      const engine = engineParseDocument(bytes);
      expect(engine.status).toBe('parsed');
      if (engine.status !== 'parsed') continue;

      const saved = serializeIdentityViaRoobli(engine.document);
      expect(saved.status).toBe('serialized');
      if (saved.status !== 'serialized') continue;

      expect(Buffer.from(saved.outputBytes).equals(Buffer.from(identity.outputBytes))).toBe(true);
      expect(sha256(saved.outputBytes)).toBe(identity.outputSha256);
    }
  });
});

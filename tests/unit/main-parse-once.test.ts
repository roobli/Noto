import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectLineEnding, toLf } from '../../src/shared/markdown/v3/document';
import { parseBlocksStructural } from '../../src/shared/markdown/v3/roobli-md-adapter';
import {
  canSkipDialectEnrich,
  collectFootnoteDefinitionIds,
  engineOwnedSemanticKey,
  engineSemanticKey,
  withKnownFootnoteIds,
} from '../../src/shared/markdown/v3/pm/from-engine';
import { nativeSha256 } from '../../src/main/native-sha256';
import type { NotoBlockKind } from '../../src/shared/markdown/v3/contracts';

const GOLDEN = path.resolve(__dirname, '../fixtures/markdown-golden');
const goldens = readdirSync(GOLDEN)
  .filter((name) => name.endsWith('.md') && name !== 'README.md')
  .map((name) => [name, readFileSync(path.join(GOLDEN, name), 'utf8')] as const);

/** Blocks the engine does not own, so the fused answer has to be null for them too. */
const DIALECT_SAMPLES = [
  '- a\n\n  ```\n  x',
  '| a | b |\n| - | - |\n| <div> | `x |',
  '[^n]: **unclosed\n  - list',
  '[x]: <bad url',
  '> quote with [^undefined] and <span',
  '* item\n\n      code under item\n\n> - mixed',
];

function askedApart(kind: NotoBlockKind, markdown: string): string | null {
  return canSkipDialectEnrich(kind, markdown) ? engineSemanticKey(kind, markdown) : null;
}

describe('asking whether the engine owns a block, and its key, in one parse', () => {
  it.each(goldens)('matches asking the two apart for every block of %s', (_name, text) => {
    const split = parseBlocksStructural(text);
    const ids = collectFootnoteDefinitionIds(split.spans);
    withKnownFootnoteIds(ids, () => {
      for (const span of split.spans) {
        const kind = span.kind as NotoBlockKind;
        expect(engineOwnedSemanticKey(kind, span.markdown)).toBe(askedApart(kind, span.markdown));
      }
    });
  });

  it('matches for blocks that need dialect, under every kind that parses once', () => {
    const kinds: NotoBlockKind[] = [
      'bullet-list', 'ordered-list', 'task-list', 'table', 'footnote-definition', 'link-definition', 'quote', 'paragraph', 'heading',
    ];
    let owned = 0;
    let notOwned = 0;
    for (const kind of kinds) {
      for (const markdown of [...DIALECT_SAMPLES, ...goldens.flatMap(([, text]) => parseBlocksStructural(text).spans.map((span) => span.markdown))]) {
        const apart = askedApart(kind, markdown);
        expect(engineOwnedSemanticKey(kind, markdown)).toBe(apart);
        if (apart === null) notOwned += 1;
        else owned += 1;
      }
    }
    // Both answers are exercised, not only one.
    expect(owned).toBeGreaterThan(100);
    expect(notOwned).toBeGreaterThan(100);
  });
});

describe('the main process hash', () => {
  it.each([
    [''],
    ['hello'],
    ['line\r\nline\n'],
    ['自由度 ✓ 🙂'],
    ['lone \ud800 surrogate \udfff'],
    ['x'.repeat(100_000)],
  ])('gives the digest createHash gives for %j', (value) => {
    const expected = createHash('sha256').update(value).digest('hex');
    expect(nativeSha256(value)).toBe(expected);
    const bytes = new TextEncoder().encode(value);
    expect(nativeSha256(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
});

/** The per-character scan this replaces, kept to compare against. */
function scanned(text: string): string {
  let crlf = 0;
  let bareLf = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\n') continue;
    if (index > 0 && text[index - 1] === '\r') crlf += 1;
    else bareLf += 1;
  }
  if (crlf > 0 && bareLf > 0) return 'mixed';
  return crlf > 0 ? 'crlf' : 'lf';
}

describe('line endings', () => {
  const samples = [
    '', 'no newline', 'a\nb\n', 'a\r\nb\r\n', 'a\r\nb\n', 'a\nb\r\n', '\n\r\n', '\r\n\n',
    'bare\rcarriage', 'a\r\rb\n', '\r', '\r\n', '\n', 'x\r\n'.repeat(1000) + 'y\n',
    ...goldens.map(([, text]) => text),
    ...goldens.map(([, text]) => text.replaceAll('\n', '\r\n')),
  ];

  it.each(samples.map((sample) => [JSON.stringify(sample).slice(0, 40), sample]))('detects %s as the scan did', (_label, text) => {
    expect(detectLineEnding(text)).toBe(scanned(text));
  });

  it('leaves LF text as the same string and converts the rest as before', () => {
    const text = 'a\nb\n';
    expect(toLf(text)).toBe(text);
    for (const sample of samples) {
      expect(toLf(sample)).toBe(sample.replaceAll('\r\n', '\n').replaceAll('\r', '\n'));
    }
  });
});

/**
 * Option B — A/B golden gates for micromark vs `NOTO_MARKDOWN_ENGINE=roobli-md`.
 *
 * These fixtures are the loud fail surface before default-on. Product default
 * stays micromark; this suite forces both engines explicitly and compares:
 *
 * 1. parse/split span boundaries (kind + start/end + markdown + gaps)
 * 2. identity serialize `outputBytes` (Noto #82 flagged path)
 *
 * Fixtures live under `tests/fixtures/markdown-golden/`. Intentional diffs must
 * be documented in that directory's README — silent divergence fails the gate.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { splitBlocksMicromark } from '../../src/shared/markdown/v3/blocks';
import { parseDocument, sha256 } from '../../src/shared/markdown/v3/document';
import { setMarkdownEngineForTests } from '../../src/shared/markdown/v3/engine-flag';
import { splitBlocksViaRoobli } from '../../src/shared/markdown/v3/roobli-md-adapter';
import { identityTransaction, serializeDocument } from '../../src/shared/markdown/v3/serialize';

const fixturesDir = path.join(process.cwd(), 'tests/fixtures/markdown-golden');
const encoder = new TextEncoder();

const FIXTURES = readdirSync(fixturesDir)
  .filter((name) => name.endsWith('.md') && name !== 'README.md')
  .sort();

afterEach(() => {
  setMarkdownEngineForTests(null);
});

function load(name: string): string {
  return readFileSync(path.join(fixturesDir, name), 'utf8');
}

function boundarySnapshot(text: string, engine: 'micromark' | 'roobli-md') {
  const split = engine === 'micromark' ? splitBlocksMicromark(text) : splitBlocksViaRoobli(text);
  return {
    spans: split.spans.map((span) => ({
      kind: span.kind,
      start: span.start,
      end: span.end,
      markdown: span.markdown,
    })),
    leading: split.leading,
    gaps: [...split.gaps],
    trailing: split.trailing,
  };
}

function mustIdentityBytes(source: string, engine: 'micromark' | 'roobli-md'): Uint8Array {
  setMarkdownEngineForTests(engine);
  const parsed = parseDocument(encoder.encode(source));
  if (parsed.status !== 'parsed') {
    throw new Error(`[${engine}] parseDocument failed: ${parsed.code}`);
  }
  const result = serializeDocument(parsed.document, identityTransaction(parsed.document));
  if (result.status !== 'serialized') {
    throw new Error(`[${engine}] identity serialize failed: ${result.code}: ${result.message}`);
  }
  return result.outputBytes;
}

describe('markdown golden gates — fixture inventory', () => {
  it('ships the expected public fixture set (no private vault content)', () => {
    expect(FIXTURES).toEqual([
      'cjk.md',
      'frontmatter.md',
      'headings.md',
      'lists.md',
      'math-fences.md',
      'tables.md',
      'wiki.md',
    ]);
  });
});

describe('markdown golden gates — A/B split boundaries', () => {
  for (const name of FIXTURES) {
    it(`span boundaries match on ${name}`, () => {
      const text = load(name);
      const micromark = boundarySnapshot(text, 'micromark');
      const roobli = boundarySnapshot(text, 'roobli-md');

      expect(
        roobli,
        `GOLDEN GATE FAIL (split): ${name}\n` +
          'micromark and roobli-md disagree on span boundaries / gaps.\n' +
          'If this is intentional, document it in tests/fixtures/markdown-golden/README.md ' +
          'and carve the fixture out of the strict suite — do not leave silent drift.',
      ).toEqual(micromark);
    });
  }
});

describe('markdown golden gates — A/B identity serialize (#82)', () => {
  for (const name of FIXTURES) {
    it(`identity outputBytes match on ${name}`, () => {
      const text = load(name);
      const micromark = mustIdentityBytes(text, 'micromark');
      const roobli = mustIdentityBytes(text, 'roobli-md');

      expect(
        Buffer.from(roobli).equals(Buffer.from(micromark)),
        `GOLDEN GATE FAIL (identity serialize): ${name}\n` +
          `micromark sha256=${sha256(micromark)} roobli-md sha256=${sha256(roobli)}\n` +
          'Flagged serializeDocument (#82) must match micromark identity bytes on this fixture.\n' +
          'If this is intentional, document it in tests/fixtures/markdown-golden/README.md.',
      ).toBe(true);

      // Round-trip sanity: identity bytes equal the UTF-8 source for these fixtures.
      expect(Buffer.from(micromark).toString('utf8')).toBe(text);
    });
  }
});

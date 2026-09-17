/**
 * Option B — A/B golden gates for micromark vs `NOTO_MARKDOWN_ENGINE=roobli-md`.
 *
 * These fixtures are the loud fail surface before default-on. Product default
 * stays micromark; this suite forces both engines explicitly and compares:
 *
 * 1. parse/split span boundaries (kind + start/end + markdown + gaps)
 * 2. identity serialize `outputBytes` (Noto #82 flagged path)
 * 3. multi-block insert / delete / multi-dirty serialize (flagged path extension)
 *
 * Fixtures live under `tests/fixtures/markdown-golden/`. Intentional diffs must
 * be documented in that directory's README — silent divergence fails the gate.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NOTO_MARKDOWN_VERSION,
  type NotoDocument,
  type NotoTransaction,
} from '../../src/shared/markdown/v3/contracts';
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

function mustParse(source: string): NotoDocument {
  const parsed = parseDocument(encoder.encode(source));
  if (parsed.status !== 'parsed') {
    throw new Error(`parseDocument failed: ${parsed.code}`);
  }
  return parsed.document;
}

function mustSerializeBytes(
  document: NotoDocument,
  transaction: NotoTransaction,
  engine: 'micromark' | 'roobli-md',
): Uint8Array {
  setMarkdownEngineForTests(engine);
  const result = serializeDocument(document, transaction);
  if (result.status !== 'serialized') {
    throw new Error(`[${engine}] serialize failed: ${result.code}: ${result.message}`);
  }
  return result.outputBytes;
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
  const document = mustParse(source);
  return mustSerializeBytes(document, identityTransaction(document), engine);
}

type BlocksTransaction = Extract<NotoTransaction, { mode: 'blocks' }>;

function blocksIdentity(document: NotoDocument): BlocksTransaction {
  const tx = identityTransaction(document);
  if (tx.mode !== 'blocks') throw new Error('expected blocks identity');
  return tx;
}

/** Multi-dirty: rewrite first and last block markdown (fixtures with ≥2 blocks). */
function multiDirtyTransaction(document: NotoDocument): BlocksTransaction | null {
  if (document.blocks.length < 2) return null;
  const last = document.blocks.length - 1;
  const firstReplacement = document.blocks[0]!.kind === 'heading' ? '# Golden Renamed' : 'Golden first edit.';
  const lastReplacement = document.blocks[last]!.kind === 'heading' ? '## Golden Last' : 'Golden last edit.';
  return {
    version: NOTO_MARKDOWN_VERSION,
    mode: 'blocks',
    documentId: document.documentId,
    revisionId: document.revisionId,
    units: document.blocks.map((block, index) => ({
      origin: block.origin,
      markdown: index === 0 ? firstReplacement : index === last ? lastReplacement : null,
    })),
    envelope: { lineEnding: 'mixed', hasFinalNewline: document.envelope.hasFinalNewline },
  };
}

/** Insert a paragraph after the first block. */
function insertTransaction(document: NotoDocument): BlocksTransaction | null {
  if (document.blocks.length < 1) return null;
  const identity = blocksIdentity(document);
  return {
    ...identity,
    units: [
      identity.units[0]!,
      { origin: null, markdown: 'Golden inserted paragraph.' },
      ...identity.units.slice(1),
    ],
  };
}

/** Delete the middle block when ≥3 blocks. */
function deleteTransaction(document: NotoDocument): BlocksTransaction | null {
  if (document.blocks.length < 3) return null;
  const identity = blocksIdentity(document);
  const mid = Math.floor(document.blocks.length / 2);
  return {
    ...identity,
    units: identity.units.filter((_, index) => index !== mid),
  };
}

describe('markdown golden gates — fixture inventory', () => {
  it('ships the expected public fixture set (no private vault content)', () => {
    expect(FIXTURES).toEqual([
      'alerts.md',
      'callouts-edge.md',
      'cjk-emphasis.md',
      'cjk-wiki.md',
      'cjk.md',
      'empty-fence.md',
      'empty-footnote-defs.md',
      'escapes.md',
      'fence-meta.md',
      'footnotes.md',
      'frontmatter.md',
      'gfm-inline.md',
      'hard-breaks.md',
      'headings.md',
      'hr-setext.md',
      'html-blocks.md',
      'html-inline.md',
      'images.md',
      'indented-code.md',
      'link-defs.md',
      'lists.md',
      'math-fences.md',
      'nested-lists.md',
      'ordered-start.md',
      'simple-callouts.md',
      'simple-flat-lists.md',
      'simple-footnote-defs.md',
      'simple-gfm-tables.md',
      'simple-hard-breaks-in-footnotes.md',
      'simple-hard-breaks-in-lists.md',
      'simple-hard-breaks-in-quotes.md',
      'simple-lazy-continuations-in-quotes.md',
      'simple-lazy-list-continuations.md',
      'simple-lists-in-quotes.md',
      'simple-marked-phrasing.md',
      'simple-nested-lists.md',
      'simple-nested-quotes.md',
      'simple-no-marker-lazy-in-quotes.md',
      'simple-quotes.md',
      'table-align.md',
      'tables.md',
      'tight-quotes.md',
      'trailing-spaces.md',
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

describe('markdown golden gates — A/B multi-block serialize', () => {
  for (const name of FIXTURES) {
    it(`multi-dirty outputBytes match on ${name}`, () => {
      const document = mustParse(load(name));
      const transaction = multiDirtyTransaction(document);
      if (!transaction) return;
      const micromark = mustSerializeBytes(document, transaction, 'micromark');
      const roobli = mustSerializeBytes(document, transaction, 'roobli-md');
      expect(
        Buffer.from(roobli).equals(Buffer.from(micromark)),
        `GOLDEN GATE FAIL (multi-dirty serialize): ${name}\n` +
          `micromark sha256=${sha256(micromark)} roobli-md sha256=${sha256(roobli)}`,
      ).toBe(true);
    });

    it(`insert outputBytes match on ${name}`, () => {
      const document = mustParse(load(name));
      const transaction = insertTransaction(document);
      if (!transaction) return;
      const micromark = mustSerializeBytes(document, transaction, 'micromark');
      const roobli = mustSerializeBytes(document, transaction, 'roobli-md');
      expect(
        Buffer.from(roobli).equals(Buffer.from(micromark)),
        `GOLDEN GATE FAIL (insert serialize): ${name}\n` +
          `micromark sha256=${sha256(micromark)} roobli-md sha256=${sha256(roobli)}`,
      ).toBe(true);
    });

    it(`delete outputBytes match on ${name}`, () => {
      const document = mustParse(load(name));
      const transaction = deleteTransaction(document);
      if (!transaction) return;
      const micromark = mustSerializeBytes(document, transaction, 'micromark');
      const roobli = mustSerializeBytes(document, transaction, 'roobli-md');
      expect(
        Buffer.from(roobli).equals(Buffer.from(micromark)),
        `GOLDEN GATE FAIL (delete serialize): ${name}\n` +
          `micromark sha256=${sha256(micromark)} roobli-md sha256=${sha256(roobli)}`,
      ).toBe(true);
    });
  }
});

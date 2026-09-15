/**
 * Host wiring: flagged block-mode serialize through `@roobli/md`.
 *
 * Product default stays micromark. These tests force the flag and compare
 * outputBytes (and preserved evidence) against the micromark serializer on
 * synthetic fixtures — no RooB private content. Covers identity, single-block,
 * multi-dirty, insert, and delete.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NOTO_MARKDOWN_VERSION,
  type NotoDocument,
  type NotoTransaction,
} from '../../src/shared/markdown/v3/contracts';
import { parseDocument, sha256 } from '../../src/shared/markdown/v3/document';
import { setMarkdownEngineForTests } from '../../src/shared/markdown/v3/engine-flag';
import {
  isIdentityOrSingleBlockUnits,
  toEngineDocument,
  toSerializeUnits,
} from '../../src/shared/markdown/v3/roobli-md-adapter';
import { identityTransaction, serializeDocument } from '../../src/shared/markdown/v3/serialize';

const fixturesDir = path.join(process.cwd(), 'tests/fixtures/roobli-md-parity');
const encoder = new TextEncoder();

function parsed(source: string): NotoDocument {
  const result = parseDocument(encoder.encode(source));
  if (result.status !== 'parsed') throw new Error(`fixture did not parse: ${result.code}`);
  return result.document;
}

type BlocksTransaction = Extract<NotoTransaction, { mode: 'blocks' }>;

function editing(document: NotoDocument, ordinal: number, markdown: string): BlocksTransaction {
  return {
    version: NOTO_MARKDOWN_VERSION,
    mode: 'blocks',
    documentId: document.documentId,
    revisionId: document.revisionId,
    units: document.blocks.map((block, index) => ({
      origin: block.origin,
      markdown: index === ordinal ? markdown : null,
    })),
    envelope: { lineEnding: 'mixed', hasFinalNewline: document.envelope.hasFinalNewline },
  };
}

function multiEditing(
  document: NotoDocument,
  edits: ReadonlyMap<number, string>,
): BlocksTransaction {
  return {
    version: NOTO_MARKDOWN_VERSION,
    mode: 'blocks',
    documentId: document.documentId,
    revisionId: document.revisionId,
    units: document.blocks.map((block, index) => ({
      origin: block.origin,
      markdown: edits.has(index) ? edits.get(index)! : null,
    })),
    envelope: { lineEnding: 'mixed', hasFinalNewline: document.envelope.hasFinalNewline },
  };
}

function blocksIdentity(document: NotoDocument) {
  const tx = identityTransaction(document);
  if (tx.mode !== 'blocks') throw new Error('expected blocks identity');
  return tx;
}

function mustSerialize(document: NotoDocument, transaction: NotoTransaction) {
  const result = serializeDocument(document, transaction);
  if (result.status !== 'serialized') {
    throw new Error(`serialize failed: ${result.code}: ${result.message}`);
  }
  return result;
}

function abSerialize(document: NotoDocument, transaction: NotoTransaction) {
  setMarkdownEngineForTests('micromark');
  const micromark = mustSerialize(document, transaction);
  setMarkdownEngineForTests('roobli-md');
  const flagged = mustSerialize(document, transaction);
  return { micromark, flagged };
}

afterEach(() => {
  setMarkdownEngineForTests(null);
});

describe('isIdentityOrSingleBlockUnits', () => {
  it('accepts identity and one dirty block; rejects multi-dirty and inserts', () => {
    const document = parsed('# A\n\nB\n\nC\n');
    const identity = blocksIdentity(document);
    expect(isIdentityOrSingleBlockUnits(document, identity.units)).toBe(true);
    expect(isIdentityOrSingleBlockUnits(document, editing(document, 1, 'Bee').units)).toBe(true);

    const twoDirty = editing(document, 0, '# AA');
    const units = twoDirty.units.map((unit, index) => (
      index === 2 ? { ...unit, markdown: 'Cee' } : unit
    ));
    expect(isIdentityOrSingleBlockUnits(document, units)).toBe(false);

    const withInsert = {
      ...identity,
      units: [
        ...identity.units,
        { origin: null, markdown: 'Inserted' },
      ],
    };
    expect(isIdentityOrSingleBlockUnits(document, withInsert.units)).toBe(false);
  });
});

describe('flagged serializeDocument — identity / single-block', () => {
  const samples = [
    '# Hello\n\nWorld\n',
    readFileSync(path.join(fixturesDir, 'basic.md'), 'utf8'),
    readFileSync(path.join(fixturesDir, 'frontmatter.md'), 'utf8'),
    '| a | b |\n| --- | --- |\n| 1 | 2 |\n\nPara\n',
  ];

  it('identity outputBytes match micromark path on the same document', () => {
    for (const source of samples) {
      const document = parsed(source);
      const transaction = identityTransaction(document);
      const { micromark, flagged } = abSerialize(document, transaction);

      expect(Buffer.from(flagged.outputBytes).equals(Buffer.from(micromark.outputBytes))).toBe(true);
      expect(flagged.outputSha256).toBe(micromark.outputSha256);
      expect(flagged.document).toBe(document);
      expect(flagged.preserved.some((range) => range.role === 'block')).toBe(document.blocks.length > 0);
      for (const range of flagged.preserved) {
        expect(range.sha256).toMatch(/^[a-f0-9]{64}$/);
      }
      for (const range of flagged.preserved.filter((r) => r.role === 'block')) {
        const block = document.blocks.find((b) => b.start === range.start && b.end === range.end);
        expect(block?.sha256).toBe(range.sha256);
      }
    }
  });

  it('single-block edit outputBytes match micromark path on the same document', () => {
    for (const source of samples) {
      const document = parsed(source);
      if (document.blocks.length < 2) continue;
      const ordinal = Math.min(1, document.blocks.length - 1);
      const nextMarkdown = document.blocks[ordinal]!.kind === 'heading'
        ? '# Renamed'
        : 'Edited paragraph.';
      const transaction = editing(document, ordinal, nextMarkdown);
      const { micromark, flagged } = abSerialize(document, transaction);

      expect(Buffer.from(flagged.outputBytes).equals(Buffer.from(micromark.outputBytes))).toBe(true);
      expect(flagged.outputSha256).toBe(sha256(flagged.outputBytes));
      expect(flagged.document.documentId).toBe(document.documentId);
      expect(flagged.document.text).not.toBe(document.text);
    }
  });

  it('keeps micromark serialize when the flag is off', () => {
    setMarkdownEngineForTests('micromark');
    const document = parsed('# Hello\n\nWorld\n');
    const result = mustSerialize(document, identityTransaction(document));
    expect(Buffer.from(result.outputBytes).toString('utf8')).toBe('# Hello\n\nWorld\n');
  });

  it('still rejects forged origins before the engine runs', () => {
    setMarkdownEngineForTests('roobli-md');
    const document = parsed('# Hello\n\nWorld\n');
    const identity = identityTransaction(document);
    if (identity.mode !== 'blocks') throw new Error('expected blocks mode');
    const forged = {
      ...identity,
      units: identity.units.map((unit, index) => (
        index === 0
          ? {
              ...unit,
              origin: unit.origin
                ? { ...unit.origin, blockId: 'noto-block-v3:forged' as typeof unit.origin.blockId }
                : null,
            }
          : unit
      )),
    };
    const result = serializeDocument(document, forged);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.code).toBe('FORGED_ORIGIN');
    }
  });

  it('maps toEngineDocument / toSerializeUnits for the engine surface', () => {
    const document = parsed('# A\n\nB\n');
    const engine = toEngineDocument(document);
    expect(engine.blocks).toHaveLength(2);
    expect(engine.gaps).toEqual(document.gaps.map((gap) => gap.text));
    expect(engine.text).toBe(document.text);

    const units = toSerializeUnits(blocksIdentity(document).units);
    expect(units).toEqual([
      { origin: 0, markdown: document.blocks[0]!.markdown },
      { origin: 1, markdown: document.blocks[1]!.markdown },
    ]);
  });
});

describe('flagged serializeDocument — multi-block insert / delete / multi-dirty', () => {
  it('multi-dirty edit outputBytes match micromark', () => {
    const document = parsed('# A\n\nB\n\nC\n');
    const transaction = multiEditing(document, new Map([
      [0, '# AA'],
      [2, 'Cee'],
    ]));
    const { micromark, flagged } = abSerialize(document, transaction);
    expect(Buffer.from(flagged.outputBytes).equals(Buffer.from(micromark.outputBytes))).toBe(true);
    expect(Buffer.from(flagged.outputBytes).toString('utf8')).toBe('# AA\n\nB\n\nCee\n');
    expect(flagged.document.documentId).toBe(document.documentId);
    expect(flagged.outputSha256).toBe(sha256(flagged.outputBytes));
  });

  it('insert outputBytes match micromark and keep branded documentId', () => {
    const document = parsed('# Title\n\nBody.\n');
    const identity = blocksIdentity(document);
    const transaction: BlocksTransaction = {
      ...identity,
      units: [
        identity.units[0]!,
        { origin: null, markdown: 'Inserted.' },
        identity.units[1]!,
      ],
    };
    const { micromark, flagged } = abSerialize(document, transaction);
    expect(Buffer.from(flagged.outputBytes).equals(Buffer.from(micromark.outputBytes))).toBe(true);
    expect(Buffer.from(flagged.outputBytes).toString('utf8')).toBe('# Title\n\nInserted.\n\nBody.\n');
    expect(flagged.document.documentId).toBe(document.documentId);
    // Surviving pristine blocks keep sha256 evidence.
    const preservedBlocks = flagged.preserved.filter((r) => r.role === 'block');
    expect(preservedBlocks.length).toBeGreaterThanOrEqual(2);
    for (const range of preservedBlocks) {
      expect(range.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('delete outputBytes match micromark and re-attach sha256 on survivors', () => {
    const document = parsed('# Title\n\nDoomed.\n\nKept.\n');
    const identity = blocksIdentity(document);
    const transaction: BlocksTransaction = {
      ...identity,
      units: [identity.units[0]!, identity.units[2]!],
    };
    const { micromark, flagged } = abSerialize(document, transaction);
    expect(Buffer.from(flagged.outputBytes).equals(Buffer.from(micromark.outputBytes))).toBe(true);
    expect(Buffer.from(flagged.outputBytes).toString('utf8')).toBe('# Title\n\nKept.\n');
    expect(flagged.document.documentId).toBe(document.documentId);
    for (const range of flagged.preserved.filter((r) => r.role === 'block')) {
      const block = document.blocks.find((b) => b.start === range.start && b.end === range.end);
      expect(block?.sha256).toBe(range.sha256);
    }
  });

  it('insert + delete + edit combined match micromark', () => {
    const document = parsed('# A\n\nB\n\nC\n\nD\n');
    const identity = blocksIdentity(document);
    // Drop B (1), edit C (2), insert between A and C, keep D.
    const transaction: BlocksTransaction = {
      ...identity,
      units: [
        { origin: identity.units[0]!.origin, markdown: '# AA' },
        { origin: null, markdown: 'Inserted.' },
        { origin: identity.units[2]!.origin, markdown: 'Cee' },
        identity.units[3]!,
      ],
    };
    const { micromark, flagged } = abSerialize(document, transaction);
    expect(Buffer.from(flagged.outputBytes).equals(Buffer.from(micromark.outputBytes))).toBe(true);
    expect(Buffer.from(flagged.outputBytes).toString('utf8')).toBe('# AA\n\nInserted.\n\nCee\n\nD\n');
    expect(flagged.document.documentId).toBe(document.documentId);
  });

  it('rejects forged origins on multi-block insert transactions', () => {
    setMarkdownEngineForTests('roobli-md');
    const document = parsed('# Title\n\nBody.\n');
    const identity = blocksIdentity(document);
    const first = identity.units[0]!;
    if (!first.origin) throw new Error('expected origin');
    const forged: BlocksTransaction = {
      ...identity,
      units: [
        {
          origin: { ...first.origin, blockId: 'noto-block-v3:forged' as typeof first.origin.blockId },
          markdown: null,
        },
        { origin: null, markdown: 'Inserted.' },
        identity.units[1]!,
      ],
    };
    const result = serializeDocument(document, forged);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.code).toBe('FORGED_ORIGIN');
  });

  it('source mode stays on the Noto serializer (flag on)', () => {
    setMarkdownEngineForTests('roobli-md');
    const document = parsed('# Title\n');
    const replacement = encoder.encode('---\ntitle: t\n---\n\n# Title\n');
    const result = serializeDocument(document, {
      version: NOTO_MARKDOWN_VERSION,
      mode: 'source',
      documentId: document.documentId,
      revisionId: document.revisionId,
      expectedSourceSha256: document.envelope.sourceSha256,
      sourceBytes: replacement,
    });
    expect(result.status).toBe('serialized');
    if (result.status !== 'serialized') return;
    expect(Buffer.from(result.outputBytes).equals(Buffer.from(replacement))).toBe(true);
    expect(result.document.documentId).toBe(document.documentId);
    expect(result.document.blocks.map((b) => b.kind)).toEqual(['frontmatter', 'heading']);
  });
});

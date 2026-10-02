import { describe, expect, it, afterEach } from 'vitest';
import { parseDocument, sha256 } from '../../src/shared/markdown/v3/document';
import { setMarkdownEngineForTests } from '../../src/shared/markdown/v3/engine-flag';
import { identityTransaction, serializeDocument } from '../../src/shared/markdown/v3/serialize';
import {
  NOTO_MARKDOWN_VERSION,
  type NotoDocument,
  type NotoTransaction,
} from '../../src/shared/markdown/v3/contracts';

const encoder = new TextEncoder();

function parsed(source: string): NotoDocument {
  const result = parseDocument(encoder.encode(source));
  if (result.status !== 'parsed') throw new Error(result.message);
  return result.document;
}

function mustSerialize(document: NotoDocument, transaction: NotoTransaction) {
  const result = serializeDocument(document, transaction);
  if (result.status !== 'serialized') throw new Error(`${result.code}: ${result.message}`);
  return result;
}

afterEach(() => {
  setMarkdownEngineForTests(null);
});

describe('byte-identity save short-circuit', () => {
  for (const engine of ['roobli-md', 'micromark'] as const) {
    it(`${engine}: identity returns original bytes and envelope hash`, () => {
      setMarkdownEngineForTests(engine);
      const document = parsed('# Hello\n\nWorld\n');
      const result = mustSerialize(document, identityTransaction(document));
      expect(Buffer.from(result.outputBytes).equals(Buffer.from(document.originalBytes))).toBe(true);
      expect(result.outputSha256).toBe(document.envelope.sourceSha256);
      expect(result.outputSha256).toBe(sha256(document.originalBytes));
      expect(result.document).toBe(document);
      const blocks = result.preserved.filter((range) => range.role === 'block');
      expect(blocks).toHaveLength(document.blocks.length);
      for (const range of blocks) {
        const block = document.blocks.find((b) => b.start === range.start && b.end === range.end);
        expect(block?.sha256).toBe(range.sha256);
      }
    });

    it(`${engine}: one dirty unit still assembles (not identity)`, () => {
      setMarkdownEngineForTests(engine);
      const document = parsed('# Hello\n\nWorld\n');
      const identity = identityTransaction(document);
      if (identity.mode !== 'blocks') throw new Error('expected blocks');
      const transaction: NotoTransaction = {
        ...identity,
        units: identity.units.map((unit, index) => (
          index === 1 ? { ...unit, markdown: 'Edited paragraph.' } : { ...unit, markdown: null }
        )),
      };
      const result = mustSerialize(document, transaction);
      expect(result.document).not.toBe(document);
      expect(Buffer.from(result.outputBytes).toString('utf8')).toContain('Edited paragraph.');
    });

    it(`${engine}: line-ending conversion skips the short-circuit`, () => {
      setMarkdownEngineForTests(engine);
      const document = parsed('# Hello\n\nWorld\n');
      const identity = identityTransaction(document) as Extract<NotoTransaction, { mode: 'blocks' }>;
      const transaction: NotoTransaction = {
        ...identity,
        envelope: { lineEnding: 'crlf', hasFinalNewline: true },
      };
      const result = mustSerialize(document, transaction);
      expect(Buffer.from(result.outputBytes).toString('utf8')).toContain('\r\n');
      expect(result.outputSha256).not.toBe(document.envelope.sourceSha256);
    });
  }

  it('rejects forged origins before taking the identity door', () => {
    setMarkdownEngineForTests('roobli-md');
    const document = parsed('# Hello\n\nWorld\n');
    const identity = identityTransaction(document);
    if (identity.mode !== 'blocks') throw new Error('expected blocks');
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
    if (result.status === 'failed') expect(result.code).toBe('FORGED_ORIGIN');
  });
});

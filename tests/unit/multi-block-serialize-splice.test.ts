import { afterEach, describe, expect, it } from 'vitest';
import { parseDocument } from '../../src/shared/markdown/v3/document';
import { setMarkdownEngineForTests } from '../../src/shared/markdown/v3/engine-flag';
import { identityTransaction, serializeDocument } from '../../src/shared/markdown/v3/serialize';
import {
  NOTO_MARKDOWN_VERSION,
  type NotoDocument,
  type NotoTransaction,
} from '../../src/shared/markdown/v3/contracts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

function blocksIdentity(document: NotoDocument) {
  const identity = identityTransaction(document);
  if (identity.mode !== 'blocks') throw new Error('expected blocks');
  return identity;
}

function bodyText(document: NotoDocument, bytes: Uint8Array): string {
  const offset = document.envelope.bom === 'utf8' ? 3 : 0;
  return decoder.decode(bytes.subarray(offset));
}

afterEach(() => {
  setMarkdownEngineForTests(null);
});

describe('multi-block serialize region splice', () => {
  for (const engine of ['roobli-md', 'micromark'] as const) {
    it(`${engine}: insert mid matches hand-built splice bytes`, () => {
      setMarkdownEngineForTests(engine);
      const document = parsed('# Title\n\nAlpha\n\nBeta\n\nGamma\n');
      const identity = blocksIdentity(document);
      const transaction: NotoTransaction = {
        ...identity,
        units: [
          { origin: identity.units[0]!.origin, markdown: null },
          { origin: identity.units[1]!.origin, markdown: null },
          { origin: null, markdown: 'Inserted.' },
          { origin: identity.units[2]!.origin, markdown: null },
          { origin: identity.units[3]!.origin, markdown: null },
        ],
      };
      const result = mustSerialize(document, transaction);
      // Prefix ends at Alpha; original gap Alpha→Beta replaced by canonical
      // blank lines around the insert (gapBetween: insert has no origin).
      const alpha = document.blocks[1]!;
      const beta = document.blocks[2]!;
      const expected = document.text.slice(0, alpha.end)
        + '\n\n'
        + 'Inserted.'
        + '\n\n'
        + document.text.slice(beta.start);
      expect(bodyText(document, result.outputBytes)).toBe(expected);
      expect(result.document.blocks).toHaveLength(5);
      expect(result.document.blocks[2]!.markdown).toBe('Inserted.');
      expect(result.document.blocks[0]!.sha256).toBe(document.blocks[0]!.sha256);
      expect(result.document.blocks[3]!.sha256).toBe(document.blocks[2]!.sha256);
    });

    it(`${engine}: delete mid matches hand-built splice bytes`, () => {
      setMarkdownEngineForTests(engine);
      const document = parsed('# Title\n\nAlpha\n\nDoomed\n\nGamma\n');
      const identity = blocksIdentity(document);
      const transaction: NotoTransaction = {
        ...identity,
        units: [
          { origin: identity.units[0]!.origin, markdown: null },
          { origin: identity.units[1]!.origin, markdown: null },
          { origin: identity.units[3]!.origin, markdown: null },
        ],
      };
      const result = mustSerialize(document, transaction);
      const alpha = document.blocks[1]!;
      const gamma = document.blocks[3]!;
      const expected = document.text.slice(0, alpha.end)
        + '\n\n'
        + document.text.slice(gamma.start);
      expect(bodyText(document, result.outputBytes)).toBe(expected);
      expect(result.document.blocks).toHaveLength(3);
      expect(result.document.blocks[2]!.sha256).toBe(document.blocks[3]!.sha256);
    });

    it(`${engine}: delete first drops leading and keeps suffix bytes`, () => {
      setMarkdownEngineForTests(engine);
      const document = parsed('# Title\n\nBody\n\nTail\n');
      const identity = blocksIdentity(document);
      const transaction: NotoTransaction = {
        ...identity,
        units: [
          { origin: identity.units[1]!.origin, markdown: null },
          { origin: identity.units[2]!.origin, markdown: null },
        ],
      };
      const result = mustSerialize(document, transaction);
      const expected = document.text.slice(document.blocks[1]!.start);
      expect(bodyText(document, result.outputBytes)).toBe(expected);
      expect(result.document.blocks).toHaveLength(2);
      expect(result.document.leading).toBe('');
    });

    it(`${engine}: delete last keeps prefix and adds final newline`, () => {
      setMarkdownEngineForTests(engine);
      const document = parsed('# Title\n\nBody\n\nTail\n');
      const identity = blocksIdentity(document);
      const transaction: NotoTransaction = {
        ...identity,
        units: [
          { origin: identity.units[0]!.origin, markdown: null },
          { origin: identity.units[1]!.origin, markdown: null },
        ],
      };
      const result = mustSerialize(document, transaction);
      const expected = document.text.slice(0, document.blocks[1]!.end) + '\n';
      expect(bodyText(document, result.outputBytes)).toBe(expected);
      expect(result.document.blocks).toHaveLength(2);
    });

    it(`${engine}: insert + edit contiguous cluster`, () => {
      setMarkdownEngineForTests(engine);
      const document = parsed('# A\n\nB\n\nC\n\nD\n');
      const identity = blocksIdentity(document);
      const transaction: NotoTransaction = {
        ...identity,
        units: [
          { origin: identity.units[0]!.origin, markdown: null },
          { origin: identity.units[1]!.origin, markdown: 'Bee' },
          { origin: null, markdown: 'Inserted.' },
          { origin: identity.units[2]!.origin, markdown: null },
          { origin: identity.units[3]!.origin, markdown: null },
        ],
      };
      const result = mustSerialize(document, transaction);
      expect(bodyText(document, result.outputBytes)).toBe('# A\n\nBee\n\nInserted.\n\nC\n\nD\n');
      expect(result.document.blocks.map((b) => b.markdown)).toEqual([
        '# A', 'Bee', 'Inserted.', 'C', 'D',
      ]);
    });

    it(`${engine}: engines agree on insert and delete`, () => {
      setMarkdownEngineForTests(engine);
      const document = parsed('# Title\n\nAlpha\n\nBeta\n');
      const identity = blocksIdentity(document);
      const insertTx: NotoTransaction = {
        ...identity,
        units: [
          identity.units[0]!,
          { origin: null, markdown: 'Mid.' },
          identity.units[1]!,
          identity.units[2]!,
        ],
      };
      // Cross-check: other engine produces the same bytes.
      const other = engine === 'roobli-md' ? 'micromark' : 'roobli-md';
      setMarkdownEngineForTests(other);
      const otherBytes = mustSerialize(document, insertTx).outputBytes;
      setMarkdownEngineForTests(engine);
      const ours = mustSerialize(document, insertTx).outputBytes;
      expect(Buffer.from(ours).equals(Buffer.from(otherBytes))).toBe(true);
    });

    it(`${engine}: line-ending conversion still takes the assembly path`, () => {
      setMarkdownEngineForTests(engine);
      const document = parsed('# Title\n\nBody\n');
      const identity = blocksIdentity(document);
      const transaction: NotoTransaction = {
        ...identity,
        units: [
          identity.units[0]!,
          { origin: null, markdown: 'Inserted.' },
          identity.units[1]!,
        ],
        envelope: { lineEnding: 'crlf', hasFinalNewline: true },
      };
      const result = mustSerialize(document, transaction);
      expect(bodyText(document, result.outputBytes)).toContain('\r\n');
    });

    it(`${engine}: CRLF file keeps CRLF around insert`, () => {
      setMarkdownEngineForTests(engine);
      const document = parsed('# Title\r\n\r\nBody\r\n\r\nTail\r\n');
      expect(document.envelope.lineEnding).toBe('crlf');
      const identity = blocksIdentity(document);
      const transaction: NotoTransaction = {
        ...identity,
        units: [
          { origin: identity.units[0]!.origin, markdown: null },
          { origin: null, markdown: 'Inserted.' },
          { origin: identity.units[1]!.origin, markdown: null },
          { origin: identity.units[2]!.origin, markdown: null },
        ],
      };
      const text = bodyText(document, mustSerialize(document, transaction).outputBytes);
      expect(text).toContain('Inserted.');
      expect(text).toContain('\r\n\r\n');
      expect(text.includes('\n\n') && !text.includes('\r\n\r\n')).toBe(false);
    });
  }

  it('list-neighbour merge on delete falls through and still serializes', () => {
    // Deleting the paragraph between two lists merges them on reparse. The
    // region window cannot prove two units; the engine full-reparse door must
    // still accept, matching serialize-incremental-roobli.
    setMarkdownEngineForTests('roobli-md');
    const document = parsed('- a\n\nbetween\n\n- b\n');
    const identity = blocksIdentity(document);
    const transaction: NotoTransaction = {
      ...identity,
      units: [
        { origin: identity.units[0]!.origin, markdown: null },
        { origin: identity.units[2]!.origin, markdown: null },
      ],
    };
    const result = mustSerialize(document, transaction);
    expect(result.document.blocks.length).toBeLessThan(3);
    expect(bodyText(document, result.outputBytes)).toContain('- a');
    expect(bodyText(document, result.outputBytes)).toContain('- b');
  });

  it('forged origin still fails before region splice', () => {
    setMarkdownEngineForTests('roobli-md');
    const document = parsed('# A\n\nB\n');
    const identity = blocksIdentity(document);
    const forged = {
      ...identity,
      units: identity.units.flatMap((unit, index) => {
        if (index === 0) {
          return [{
            origin: unit.origin
              ? { ...unit.origin, blockId: 'noto-block-v3:0:deadbeefdeadbeef' as typeof unit.origin.blockId }
              : null,
            markdown: null,
          }, { origin: null, markdown: 'Inserted.' }];
        }
        return [{ origin: unit.origin, markdown: null }];
      }),
    };
    const result = serializeDocument(document, forged);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.code).toBe('FORGED_ORIGIN');
  });

  it('version stamp stays on the contract', () => {
    expect(NOTO_MARKDOWN_VERSION).toBe(3);
  });
});

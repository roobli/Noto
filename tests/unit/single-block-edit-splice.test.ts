import { afterEach, describe, expect, it } from 'vitest';
import { parseDocument, sha256 } from '../../src/shared/markdown/v3/document';
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

function oneEdit(document: NotoDocument, dirty: number, markdown: string): NotoTransaction {
  const identity = identityTransaction(document);
  if (identity.mode !== 'blocks') throw new Error('expected blocks');
  return {
    ...identity,
    units: identity.units.map((unit, index) =>
      index === dirty ? { origin: unit.origin, markdown } : { origin: unit.origin, markdown: null },
    ),
  };
}

function bodyText(document: NotoDocument, bytes: Uint8Array): string {
  const offset = document.envelope.bom === 'utf8' ? 3 : 0;
  return decoder.decode(bytes.subarray(offset));
}

afterEach(() => {
  setMarkdownEngineForTests(null);
});

describe('single-block edit splice', () => {
  for (const engine of ['roobli-md', 'micromark'] as const) {
    it(`${engine}: mid paragraph splice matches full assembly bytes`, () => {
      setMarkdownEngineForTests(engine);
      const document = parsed('# Title\n\nAlpha\n\nBeta\n\nGamma\n');
      const dirty = 1;
      const markdown = 'Alpha edited';
      const result = mustSerialize(document, oneEdit(document, dirty, markdown));
      const expected = document.text.slice(0, document.blocks[dirty]!.start)
        + markdown
        + document.text.slice(document.blocks[dirty]!.end);
      expect(bodyText(document, result.outputBytes)).toBe(expected);
      expect(result.outputSha256).toBe(sha256(result.outputBytes));
      expect(result.document.blocks).toHaveLength(document.blocks.length);
      expect(result.document.blocks[dirty]!.markdown).toBe(markdown);
      // Untouched blocks keep digests and only move offsets after the edit.
      expect(result.document.blocks[0]!.sha256).toBe(document.blocks[0]!.sha256);
      expect(result.document.blocks[2]!.sha256).toBe(document.blocks[2]!.sha256);
      expect(result.document.blocks[2]!.start).toBe(document.blocks[2]!.start + ' edited'.length);
    });

    it(`${engine}: first and last block edits splice`, () => {
      setMarkdownEngineForTests(engine);
      const document = parsed('# Title\n\nBody paragraph\n\nTail\n');
      for (const dirty of [0, document.blocks.length - 1]) {
        const markdown = dirty === 0 ? '# Title changed' : 'Tail changed';
        const result = mustSerialize(document, oneEdit(document, dirty, markdown));
        const expected = document.text.slice(0, document.blocks[dirty]!.start)
          + markdown
          + document.text.slice(document.blocks[dirty]!.end);
        expect(bodyText(document, result.outputBytes), `dirty=${dirty}`).toBe(expected);
      }
    });

    it(`${engine}: single-newline gap falls through to assembly (rewrites gap)`, () => {
      setMarkdownEngineForTests(engine);
      // Heading then paragraph with only one newline between them. Editing the
      // heading makes gapBetween emit a blank line; a pure splice would keep
      // the single newline. The splice door must stay closed.
      const document = parsed('# A\nB\n');
      expect(document.gaps).toHaveLength(1);
      expect(document.gaps[0]!.text).toBe('\n');
      const result = mustSerialize(document, oneEdit(document, 0, '# AX'));
      const spliced = document.text.slice(0, document.blocks[0]!.start)
        + '# AX'
        + document.text.slice(document.blocks[0]!.end);
      expect(bodyText(document, result.outputBytes)).not.toBe(spliced);
      expect(bodyText(document, result.outputBytes)).toContain('# AX');
      expect(bodyText(document, result.outputBytes)).toContain('\n\n');
    });

    it(`${engine}: CRLF file keeps CRLF around the spliced block`, () => {
      setMarkdownEngineForTests(engine);
      const document = parsed('# Title\r\n\r\nBody\r\n\r\nTail\r\n');
      expect(document.envelope.lineEnding).toBe('crlf');
      const dirty = 1;
      const result = mustSerialize(document, oneEdit(document, dirty, 'Body edited'));
      const text = bodyText(document, result.outputBytes);
      expect(text).toContain('Body edited');
      expect(text).toContain('\r\n\r\n');
      expect(text.includes('\n\n') && !text.includes('\r\n\r\n')).toBe(false);
    });

    it(`${engine}: line-ending conversion still takes the assembly path`, () => {
      setMarkdownEngineForTests(engine);
      const document = parsed('# Title\n\nBody\n');
      const identity = identityTransaction(document);
      if (identity.mode !== 'blocks') throw new Error('expected blocks');
      const transaction: NotoTransaction = {
        ...(oneEdit(document, 1, 'BodyX') as Extract<NotoTransaction, { mode: 'blocks' }>),
        envelope: { lineEnding: 'crlf', hasFinalNewline: true },
      };
      const result = mustSerialize(document, transaction);
      expect(bodyText(document, result.outputBytes)).toContain('\r\n');
    });
  }

  it('forged origin still fails before splice', () => {
    setMarkdownEngineForTests('roobli-md');
    const document = parsed('# A\n\nB\n');
    const identity = identityTransaction(document);
    if (identity.mode !== 'blocks') throw new Error('expected blocks');
    const forged = {
      ...identity,
      units: identity.units.map((unit, index) =>
        index === 1
          ? {
              origin: unit.origin
                ? { ...unit.origin, blockId: 'noto-block-v3:1:deadbeefdeadbeef' as typeof unit.origin.blockId }
                : null,
              markdown: 'BX',
            }
          : { origin: unit.origin, markdown: null },
      ),
    };
    const result = serializeDocument(document, forged);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.code).toBe('FORGED_ORIGIN');
  });

  it('version stamp stays on the contract', () => {
    expect(NOTO_MARKDOWN_VERSION).toBe(3);
  });
});

/**
 * Blank lines a save is asked to leave between blocks (`blankLinesBefore`).
 *
 * The reader's own spacing: empty lines typed between two blocks are written
 * as blank lines, and extra blank lines taken away are taken out of the file.
 * Markdown reads any run of blank lines as one break, so only the spacing
 * moves, and a gap that already has the asked-for count keeps its bytes.
 */

import { describe, expect, it } from 'vitest';
import { parseDocument } from '../../src/shared/markdown/v3/document';
import { blankLinesIn, identityTransaction, serializeDocument } from '../../src/shared/markdown/v3/serialize';
import type { NotoDocument, NotoTransaction, NotoUnit } from '../../src/shared/markdown/v3/contracts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function parsed(source: string): NotoDocument {
  const result = parseDocument(encoder.encode(source));
  if (result.status !== 'parsed') throw new Error(result.message);
  return result.document;
}

function save(document: NotoDocument, edit: (units: NotoUnit[]) => NotoUnit[]) {
  const identity = identityTransaction(document) as Extract<NotoTransaction, { mode: 'blocks' }>;
  const result = serializeDocument(document, { ...identity, units: edit([...identity.units]) });
  if (result.status !== 'serialized') throw new Error(result.message);
  return { text: decoder.decode(result.outputBytes), result };
}

describe('blank lines asked for between blocks', () => {
  it('counts the blank lines in a gap', () => {
    expect(blankLinesIn('\n\n')).toBe(1);
    expect(blankLinesIn('\n\n\n\n')).toBe(3);
    expect(blankLinesIn('\r\n\r\n\r\n')).toBe(2);
    expect(blankLinesIn('\n  \n\t\n')).toBe(2);
    expect(blankLinesIn('\n')).toBe(0);
  });

  it('widens a gap with no other change to the file', () => {
    const document = parsed('one\n\ntwo\n\nthree\n');
    const { text, result } = save(document, (units) => units.map((unit, index) => (index === 1 ? { ...unit, blankLinesBefore: 3 } : unit)));
    expect(text).toBe('one\n\n\n\ntwo\n\nthree\n');
    // The next revision is what the bytes say.
    expect(parsed(text).blocks.map((block) => block.markdown)).toEqual(result.document.blocks.map((block) => block.markdown));
    expect(result.document.text).toBe(text);
    expect(result.document.revisionId).toBe(parsed(text).revisionId);
    expect(result.document.gaps.map((gap) => gap.text)).toEqual(['\n\n\n\n', '\n\n']);
  });

  it('narrows a gap, and keeps one that already has the count byte for byte', () => {
    const document = parsed('one\n\n \n\n\ntwo\n\n\n\nthree\n');
    const { text } = save(document, (units) => units.map((unit, index) => (index === 1 ? { ...unit, blankLinesBefore: 1 } : index === 2 ? { ...unit, blankLinesBefore: 3 } : unit)));
    expect(text).toBe('one\n\ntwo\n\n\n\nthree\n');
    const kept = save(document, (units) => units.map((unit, index) => (index === 1 ? { ...unit, blankLinesBefore: 4 } : unit)));
    expect(kept.text).toBe('one\n\n \n\n\ntwo\n\n\n\nthree\n');
  });

  it('widens a gap in a mixed file with the line ending that gap had', () => {
    const document = parsed('one\r\n\r\ntwo\n\nthree\n');
    const { text } = save(document, (units) => units.map((unit, index) => (index > 0 ? { ...unit, blankLinesBefore: 2 } : unit)));
    expect(text).toBe('one\r\n\r\n\r\ntwo\n\n\nthree\n');
  });

  it('spaces an edited block and a new one as asked', () => {
    const document = parsed('one\n\ntwo\n');
    const { text } = save(document, (units) => [units[0]!, { origin: null, markdown: 'new', blankLinesBefore: 2 }, { ...units[1]!, markdown: 'two!', blankLinesBefore: 3 }]);
    expect(text).toBe('one\n\n\nnew\n\n\n\ntwo!\n');
  });

  it('writes the file\'s own line endings', () => {
    const document = parsed('one\r\n\r\ntwo\r\n');
    const { text } = save(document, (units) => units.map((unit, index) => (index === 1 ? { ...unit, blankLinesBefore: 2 } : unit)));
    expect(text).toBe('one\r\n\r\n\r\ntwo\r\n');
  });
});

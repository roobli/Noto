import { describe, expect, it } from 'vitest';
import { parseDocument } from '../../src/shared/markdown/v3/document';
import { identityTransaction, serializeDocument } from '../../src/shared/markdown/v3/serialize';
import type { NotoDocument, NotoTransaction, NotoUnit } from '../../src/shared/markdown/v3/contracts';

/**
 * A save that looked up each preserved block by scanning the block list was
 * quadratic in the number of blocks (hashPreservedRanges before 0c03516). On
 * the 8 MB benchmark document that was most of a multi-second serialize. This
 * guard times a one-block edit at n and at 4n paragraphs and refuses a ratio
 * that only a super-linear walk explains. Linear is about 4; the old bug was
 * about 16. The bound sits between them with room for noise on a shared CI
 * runner.
 */

const N = 2_000;
const FOUR_N = 8_000;
/** 4× size may cost up to this many times as long. Quadratic is ~16×. */
const MAX_RATIO = 10;

function docWithParagraphs(count: number): NotoDocument {
  const text = `${Array.from({ length: count }, (_, index) => (
    `Paragraph ${index} with enough words to be a real block.`
  )).join('\n\n')}\n`;
  const result = parseDocument(new TextEncoder().encode(text));
  if (result.status !== 'parsed') throw new Error(result.message);
  return result.document;
}

function oneBlockEdit(document: NotoDocument): NotoTransaction {
  const base = identityTransaction(document);
  if (base.mode !== 'blocks') throw new Error('expected a blocks transaction');
  const at = Math.floor(base.units.length / 2);
  const units: NotoUnit[] = base.units.map((unit, index) => (
    index === at
      ? { origin: unit.origin, markdown: `${document.blocks[index]!.markdown} X` }
      : unit
  ));
  return { ...base, units };
}

function medianMs(run: () => void, runs = 5): number {
  // Warm once so first-run JIT noise does not dominate.
  run();
  const samples: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const began = performance.now();
    run();
    samples.push(performance.now() - began);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)]!;
}

function serializeMs(document: NotoDocument, transaction: NotoTransaction): number {
  return medianMs(() => {
    const result = serializeDocument(document, transaction);
    if (result.status !== 'serialized') throw new Error(result.message);
  });
}

describe('serialize cost grows with the note, not with its square', () => {
  it(`keeps a 4× one-block save under ${MAX_RATIO}× at ${N} vs ${FOUR_N} blocks`, { timeout: 60_000 }, () => {
    const small = docWithParagraphs(N);
    const large = docWithParagraphs(FOUR_N);
    expect(small.blocks.length).toBe(N);
    expect(large.blocks.length).toBe(FOUR_N);

    const smallMs = serializeMs(small, oneBlockEdit(small));
    const largeMs = serializeMs(large, oneBlockEdit(large));
    const ratio = largeMs / Math.max(smallMs, 0.5);

    console.log(
      `serialize 1-edit: n=${N} ${smallMs.toFixed(1)}ms, 4n=${FOUR_N} ${largeMs.toFixed(1)}ms, ratio=${ratio.toFixed(2)}`,
    );

    expect(ratio).toBeLessThan(MAX_RATIO);
  });
});

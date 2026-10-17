/**
 * Independent oracle for block-mode saves, replacing the old micromark A/B
 * serializer comparison (the legacy serializer is gone).
 *
 * A save is right when its bytes, parsed again from scratch, are exactly the
 * blocks the transaction asked for: each unit's new markdown, or the original
 * block's markdown when the unit kept it. The revision the save returns must
 * describe those same blocks.
 */
import { expect } from 'vitest';
import type { NotoDocument, NotoTransaction } from '../../src/shared/markdown/v3/contracts';
import { parseDocument } from '../../src/shared/markdown/v3/document';
import { toLf } from '../../src/shared/markdown/v3/line-endings';

export function expectedBlockMarkdown(document: NotoDocument, transaction: NotoTransaction): string[] {
  if (transaction.mode !== 'blocks') throw new Error('expected a blocks transaction');
  return transaction.units.map((unit) => {
    if (unit.markdown !== null) return toLf(unit.markdown);
    if (!unit.origin) throw new Error('kept unit without origin');
    return document.blocks[unit.origin.ordinal]!.markdown;
  });
}

export function expectSaveMatchesOracle(
  document: NotoDocument,
  transaction: NotoTransaction,
  result: { outputBytes: Uint8Array; document: NotoDocument },
  label = '',
): void {
  const expected = expectedBlockMarkdown(document, transaction);
  const reparsed = parseDocument(result.outputBytes);
  if (reparsed.status !== 'parsed') throw new Error(`${label} saved bytes do not parse: ${reparsed.code}`);
  expect(reparsed.document.blocks.map((block) => block.markdown), `${label} re-parsed blocks`).toEqual(expected);
  expect(result.document.blocks.map((block) => block.markdown), `${label} returned revision`).toEqual(expected);
}

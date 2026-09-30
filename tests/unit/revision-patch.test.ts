import { describe, expect, it } from 'vitest';
import { parseDocument, toWire } from '../../src/shared/markdown/v3/document';
import { identityTransaction, serializeDocument } from '../../src/shared/markdown/v3/serialize';
import {
  applyRevisionPatch,
  blockIdAt,
  compactTransaction,
  expandTransaction,
  patchKeepsByteLength,
  revisionPatch,
} from '../../src/shared/markdown/v3/revision-patch';
import { isRevisionPatch } from '../../src/shared/file-truth/v1/validate';
import type {
  NotoDocument,
  NotoDocumentWire,
  NotoRevisionPatch,
  NotoTransaction,
  NotoUnit,
} from '../../src/shared/markdown/v3/contracts';

/**
 * A save's reply carries the next revision as a patch against the one the save
 * started from, and the renderer rebuilds it. That is only sound if the rebuilt
 * revision is exactly the one main holds; these hold it to that over a few
 * hundred generated saves, and check that a patch refuses a base it does not fit.
 */

const SECTION = (n: number) => `## Section ${n}

A paragraph with *emphasis*, **strong**, \`code\` and a [link](https://example.com/${n}).
It runs over a second line, with ünïcödé and 漢字 and an emoji 😀.

- first item
- second item
  - nested item

Between the lists.

- another list

\`\`\`ts
const value${n} = ${n};
\`\`\`

| a | b |
| - | - |
| ${n} | ${n + 1} |

> A quote.

---
`;

const SOURCE = `---
title: Patches
---

# Title

${Array.from({ length: 8 }, (_, n) => SECTION(n)).join('\n')}
Last paragraph.
`;

const encoder = new TextEncoder();

function parsed(text: string, bom = false): NotoDocument {
  const body = encoder.encode(text);
  const result = parseDocument(bom ? Uint8Array.from([0xef, 0xbb, 0xbf, ...body]) : body);
  if (result.status !== 'parsed') throw new Error(result.message);
  return result.document;
}

/** What a save replies with in full: no node cache. */
function wire(document: NotoDocument): NotoDocumentWire {
  const { nodesEnrichment: _unused, ...rest } = document;
  return toWire({ ...rest, nodes: null });
}

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** Every block untouched, sent as the editor sends it: no text, just the origin. */
function untouched(document: NotoDocument): Extract<NotoTransaction, { mode: 'blocks' }> {
  const base = identityTransaction(document);
  if (base.mode !== 'blocks') throw new Error('block transaction expected');
  return { ...base, units: base.units.map((unit) => ({ origin: unit.origin, markdown: null })) };
}

function edited(document: NotoDocument, seed: number): NotoTransaction {
  const random = rng(seed);
  const base = untouched(document);
  const units: NotoUnit[] = [...base.units];
  const operations = 1 + Math.floor(random() * 3);
  for (let op = 0; op < operations && units.length > 2; op += 1) {
    const at = Math.floor(random() * units.length);
    const pick = random();
    const unit = units[at]!;
    if (pick < 0.4 && unit.origin && unit.origin.kind === 'paragraph') {
      const markdown = document.blocks[unit.origin.ordinal]!.markdown;
      units[at] = { origin: unit.origin, markdown: `${markdown} edited ${seed} é` };
    } else if (pick < 0.65) {
      units.splice(at + 1, 0, { origin: null, markdown: `Inserted paragraph ${seed}-${op} 😀.` });
    } else if (pick < 0.9) {
      units.splice(at, 1);
    } else {
      units.splice(at, 1, { origin: null, markdown: `Replacement ${seed}.` });
    }
  }
  return { ...base, units };
}

/** Save, then check the patch rebuilds exactly the saved revision. */
function expectRebuilds(document: NotoDocument, transaction: NotoTransaction, label: string): NotoDocument | null {
  const result = serializeDocument(document, transaction);
  if (result.status !== 'serialized') return null;
  const patch = revisionPatch(document, result.document);
  expect(isRevisionPatch(patch), label).toBe(true);
  expect(patchKeepsByteLength(wire(document), patch), label).toBe(true);
  expect(applyRevisionPatch(wire(document), patch), label).toEqual(wire(result.document));
  return result.document;
}

describe('a saved revision sent as a patch', () => {
  const variants: [string, string, boolean][] = [
    ['LF', SOURCE, false],
    ['CRLF', SOURCE.replace(/\n/g, '\r\n'), false],
    ['BOM', SOURCE, true],
  ];
  for (const [name, text, bom] of variants) {
    it(`rebuilds exactly the saved revision (${name}, 200 generated saves)`, () => {
      const document = parsed(text, bom);
      let saved = 0;
      for (let seed = 1; seed <= 200; seed += 1) {
        if (expectRebuilds(document, edited(document, seed), `${name} seed ${seed}`)) saved += 1;
      }
      expect(saved).toBeGreaterThan(170);
    });
  }

  it('chains: each save patches the revision the previous one built', () => {
    let document = parsed(SOURCE);
    for (let seed = 500; seed < 540; seed += 1) {
      document = expectRebuilds(document, edited(document, seed), `seed ${seed}`) ?? document;
    }
  });

  it('carries only what changed', () => {
    const document = parsed(SOURCE);
    const base = untouched(document);
    const at = document.blocks.findIndex((block) => block.kind === 'paragraph' && block.markdown.startsWith('Between'));
    const units = [...base.units];
    units[at] = { origin: units[at]!.origin, markdown: 'Between the two lists.' };
    const result = serializeDocument(document, { ...base, units });
    if (result.status !== 'serialized') throw new Error(result.message);
    const patch = revisionPatch(document, result.document);
    // Only the words that differ travel, not the block or the file.
    const inserted = document.blocks[at]!.start + 'Between the '.length;
    expect(patch.splices).toEqual([{ start: inserted, end: inserted, text: 'two ' }]);
    expect(patch.blocks.map((block) => ('keep' in block ? `keep ${block.keep}+${block.count}` : 'new'))).toEqual([
      `keep 0+${at}`, 'new', `keep ${at + 1}+${document.blocks.length - at - 1}`,
    ]);
  });

  it('rebuilds a save the full reparse decided, and one that changes nothing', () => {
    // Deleting the paragraph between two lists merges them: the whole-parse path.
    const document = parsed('- a\n\nbetween\n\n- b\n\nafter\n');
    const base = untouched(document);
    expectRebuilds(document, { ...base, units: base.units.filter((_, index) => index !== 1) }, 'merge');
    expectRebuilds(document, base, 'identity');
    // A conversion rewrites every line ending: nothing is kept, and that is exact too.
    expectRebuilds(document, { ...base, envelope: { lineEnding: 'crlf', hasFinalNewline: true } }, 'convert');
  });

  it('refuses a base it does not fit', () => {
    const document = parsed(SOURCE);
    const next = expectRebuilds(document, edited(document, 7), 'seed 7')!;
    const patch = revisionPatch(document, next);
    const other = wire(parsed(SOURCE.replace('Last paragraph.', 'Another last paragraph.')));
    expect(applyRevisionPatch(other, patch)).toBeNull();

    const kept = patch.blocks.findIndex((block) => 'keep' in block);
    const forged = (change: (patch: NotoRevisionPatch) => NotoRevisionPatch) => applyRevisionPatch(wire(document), change(patch));
    expect(forged((p) => ({
      ...p,
      blocks: p.blocks.map((block, index) => (index === kept && 'keep' in block ? { ...block, firstBlockId: blockIdAt(block.firstBlockId, 999)! } : block)),
    }))).toBeNull();
    expect(forged((p) => ({
      ...p,
      blocks: p.blocks.map((block, index) => (index === kept && 'keep' in block ? { ...block, count: 1_000_000 } : block)),
    }))).toBeNull();
    // A splice through a block the patch says is kept.
    const target = document.blocks[3]!;
    expect(forged((p) => ({
      ...p,
      splices: [{ start: target.start + 1, end: target.start + 2, text: 'x' }],
      blocks: [{ keep: 0, count: document.blocks.length, firstBlockId: document.blocks[0]!.id }],
    }))).toBeNull();
    // Splices out of order.
    expect(forged((p) => ({ ...p, splices: [{ start: 10, end: 12, text: '' }, { start: 5, end: 6, text: '' }] }))).toBeNull();
  });

  it('notices a byte length that does not add up', () => {
    const document = parsed(SOURCE);
    const next = expectRebuilds(document, edited(document, 11), 'seed 11')!;
    const patch = revisionPatch(document, next);
    expect(patchKeepsByteLength(wire(document), { ...patch, envelope: { ...patch.envelope, byteLength: patch.envelope.byteLength + 1 } }))
      .toBe(false);
  });
});

describe('untouched units sent as runs', () => {
  it('expands to exactly the units that were compacted', () => {
    const document = parsed(SOURCE);
    for (let seed = 1; seed <= 100; seed += 1) {
      const transaction = edited(document, seed);
      const compact = compactTransaction(transaction, wire(document));
      expect(expandTransaction(compact, document), `seed ${seed}`).toEqual(transaction);
      if (compact.mode === 'blocks' && transaction.mode === 'blocks') {
        expect(compact.units.length).toBeLessThan(transaction.units.length);
      }
    }
  });

  it('sends a note with one edit as a handful of entries', () => {
    const document = parsed(SOURCE);
    const base = untouched(document);
    const units = [...base.units];
    units[10] = { origin: units[10]!.origin, markdown: 'Changed.' };
    const compact = compactTransaction({ ...base, units }, wire(document));
    if (compact.mode !== 'blocks') throw new Error('block transaction expected');
    expect(compact.units).toEqual([
      { keep: 0, count: 10 },
      units[10],
      { keep: 11, count: document.blocks.length - 11 },
    ]);
  });

  it('refuses a run past the end of the document', () => {
    const document = parsed(SOURCE);
    const base = untouched(document);
    expect(expandTransaction({ ...base, units: [{ keep: 0, count: document.blocks.length + 1 }] }, document)).toBeNull();
  });
});

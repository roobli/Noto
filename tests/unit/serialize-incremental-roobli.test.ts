import { describe, expect, it } from 'vitest';
import { parseDocument } from '../../src/shared/markdown/v3/document';
import { identityTransaction, serializeDocument } from '../../src/shared/markdown/v3/serialize';
import type { NotoDocument, NotoTransaction, NotoUnit } from '../../src/shared/markdown/v3/contracts';
import { isRoobliMdEngine } from '../../src/shared/markdown/v3/engine-flag';

/**
 * A `@roobli/md` save builds its next revision from the engine's offsets and a
 * local proof instead of parsing the output again. That is only sound if the
 * revision it builds is the one a full parse of the same bytes would produce.
 * These tests hold it to exactly that, over a few hundred generated edits.
 */

const SECTION = (n: number) => `## Section ${n}

A paragraph with *emphasis*, **strong**, \`code\`, a [link](https://example.com/${n}) and a [ref][r${n}].
It runs over a second line.

- first item
- second item with [[Wiki ${n}]]
  - nested item

1. one
2. two

> A quote that says something.
> And goes on.

\`\`\`ts
const value${n} = ${n};
\`\`\`

| a | b |
| - | - |
| ${n} | ${n + 1} |

$$
x_${n} = y^2
$$

> [!NOTE]
> A callout body.

Text with a footnote.[^f${n}]

[^f${n}]: The footnote.

[r${n}]: https://example.com/ref/${n}

<div align="center">html ${n}</div>

---
`;

const SOURCE = `---
title: Equivalence
---

# Title

${Array.from({ length: 10 }, (_, n) => SECTION(n)).join('\n')}
Last paragraph.
`;

function parsed(text: string): NotoDocument {
  const result = parseDocument(new TextEncoder().encode(text));
  if (result.status !== 'parsed') throw new Error(result.message);
  return result.document;
}

/** A small deterministic generator, so a failure names a reproducible case. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function withUnits(transaction: NotoTransaction, units: NotoUnit[]): NotoTransaction {
  if (transaction.mode !== 'blocks') throw new Error('block transaction expected');
  return { ...transaction, units };
}

function edited(document: NotoDocument, seed: number): NotoTransaction {
  const random = rng(seed);
  const base = identityTransaction(document);
  if (base.mode !== 'blocks') throw new Error('block transaction expected');
  const units: NotoUnit[] = [...base.units];
  const operations = 1 + Math.floor(random() * 3);
  for (let op = 0; op < operations && units.length > 2; op += 1) {
    const at = Math.floor(random() * units.length);
    const pick = random();
    const unit = units[at]!;
    if (pick < 0.45 && unit.origin && unit.origin.kind === 'paragraph') {
      const markdown = document.blocks[unit.origin.ordinal]!.markdown;
      units[at] = { origin: unit.origin, markdown: `${markdown} edited ${seed}` };
    } else if (pick < 0.7) {
      units.splice(at + 1, 0, { origin: null, markdown: `Inserted paragraph ${seed}-${op}.` });
    } else {
      units.splice(at, 1);
    }
  }
  return withUnits(base, units);
}

/** Everything a revision is made of, except the parser's own node cache. */
function shape(document: NotoDocument) {
  return {
    documentId: document.documentId,
    revisionId: document.revisionId,
    envelope: document.envelope,
    text: document.text,
    leading: document.leading,
    trailing: document.trailing,
    gaps: document.gaps,
    blocks: document.blocks.map((block) => ({
      id: block.id,
      kind: block.kind,
      start: block.start,
      end: block.end,
      markdown: block.markdown,
      sha256: block.sha256,
      semanticKey: block.semanticKey,
      origin: block.origin,
    })),
  };
}

describe('a @roobli/md save without a full reparse', () => {
  it('runs on the engine these tests are about', () => {
    expect(isRoobliMdEngine()).toBe(true);
  });

  it('builds the same revision a full parse of the output would', () => {
    const document = parsed(SOURCE);
    expect(document.blocks.length).toBeGreaterThan(100);
    let incremental = 0;
    let refused = 0;
    for (let seed = 1; seed <= 300; seed += 1) {
      const result = serializeDocument(document, edited(document, seed));
      if (result.status !== 'serialized') {
        refused += 1;
        continue;
      }
      // The incremental path leaves the node cache empty; the fallback parses
      // and fills it. Either way the revision must match a full parse.
      if (result.document.nodes === null) incremental += 1;
      const full = parsed(new TextDecoder().decode(result.outputBytes));
      expect(shape(result.document), `seed ${seed}`).toEqual({ ...shape(full), documentId: document.documentId });
    }
    // The point of the change: nearly every save takes the local proof.
    expect(incremental).toBeGreaterThan(250);
    expect(refused).toBeLessThan(30);
  });

  it('chains: the next save starts from the revision this one built', () => {
    let document = parsed(SOURCE);
    for (let seed = 1000; seed < 1040; seed += 1) {
      const result = serializeDocument(document, edited(document, seed));
      if (result.status !== 'serialized') continue;
      const full = parsed(new TextDecoder().decode(result.outputBytes));
      expect(shape(result.document), `seed ${seed}`).toEqual({ ...shape(full), documentId: document.documentId });
      document = result.document;
    }
  });

  it('still refuses an edit that swallows its neighbours', () => {
    const document = parsed(SOURCE);
    const base = identityTransaction(document);
    if (base.mode !== 'blocks') throw new Error('block transaction expected');
    const at = document.blocks.findIndex((block) => block.kind === 'paragraph');
    const units = [...base.units];
    units[at] = { origin: units[at]!.origin, markdown: '```\nnever closed' };
    const result = serializeDocument(document, withUnits(base, units));
    expect(result.status).toBe('failed');
  });

  it('decides a deletion that merges its neighbours exactly as the full parse did', () => {
    // Two lists separated by a paragraph become one list when the paragraph
    // goes. The local proof sees the seam change and hands the decision to the
    // full reparse, which is what every save did before.
    const document = parsed('- a\n\nbetween\n\n- b\n');
    const base = identityTransaction(document);
    if (base.mode !== 'blocks') throw new Error('block transaction expected');
    const units = base.units.filter((_, index) => index !== 1);
    const result = serializeDocument(document, withUnits(base, units));
    expect(result.status).toBe('serialized');
    if (result.status !== 'serialized') return;
    expect(result.document.nodes).not.toBeNull();
    const full = parsed(new TextDecoder().decode(result.outputBytes));
    expect(shape(result.document)).toEqual({ ...shape(full), documentId: document.documentId });
  });
});

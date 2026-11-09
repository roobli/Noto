/**
 * Pandoc's dollar rule for inline math (daily-use audit, finding 12).
 *
 * `$8,000 - $50,000` was math holding `8,000 - `: 694 lines in 124 of the
 * author's notes have prices in that shape. One `$` now opens math only before
 * a non-space and closes it only after a non-space and not before a digit.
 * Both parsers have to agree, or a block would read differently depending on
 * which one owned it, so every case runs through the engine's scanner and
 * through micromark.
 */

import { describe, expect, it } from 'vitest';
import type { Node as ProseNode } from 'prosemirror-model';
import { tryInlineNodesFromSource } from '../../src/shared/markdown/v3/pm/from-engine';
import { blockFromSpan } from '../../src/shared/markdown/v3/pm/from-mdast';
import { splitBlocksMicromark } from '../../src/shared/markdown/v3/blocks';
import { notoSchema } from '../../src/shared/markdown/v3/pm/schema';
import { blockToMarkdown } from '../../src/shared/markdown/v3/pm/to-mdast';

/** The inline content as `text` and `[math]` pieces, so both parsers compare as strings. */
const shape = (nodes: readonly ProseNode[]): string => nodes
  .map((node) => (node.type.name === 'math_inline' ? `[${node.textContent}]` : node.text ?? `<${node.type.name}>`))
  .join('');

const viaEngine = (source: string): string => {
  const nodes = tryInlineNodesFromSource(source);
  if (nodes === null) throw new Error(`engine refused ${source}`);
  return shape(nodes);
};

const viaMicromark = (source: string): string => {
  const block = blockFromSpan(splitBlocksMicromark(source).spans[0]!);
  if (!block) throw new Error(`no block for ${source}`);
  const kids: ProseNode[] = [];
  block.forEach((child) => { kids.push(child); });
  return shape(kids);
};

const cases: readonly (readonly [source: string, expected: string])[] = [
  ['$8,000 - $50,000', '$8,000 - $50,000'],
  ['From $20,000 and $30,000 a year', 'From $20,000 and $30,000 a year'],
  ['Pay $5 or $10.', 'Pay $5 or $10.'],
  ['$x$', '[x]'],
  ['Energy $E=mc^2$ here', 'Energy [E=mc^2] here'],
  ['$\\alpha + 1$ and $\\beta$', '[\\alpha + 1] and [\\beta]'],
  ['$ x $ is not math', '$ x $ is not math'],
  ['$x $ neither', '$x $ neither'],
  ['$x$5 is a price after text', '$x$5 is a price after text'],
  ['$a, $5 then b$', '[a, $5 then b]'],
  ['cost $8 and $y$', 'cost [8 and $y]'],
  ['$$x$$ stays', '[x] stays'],
  ['$$ padded $$ stays', '[padded] stays'],
];

describe("inline math under Pandoc's dollar rule", () => {
  for (const [source, expected] of cases) {
    it(`reads ${JSON.stringify(source)} the same in both parsers`, () => {
      expect(viaEngine(source)).toBe(expected);
      expect(viaMicromark(source)).toBe(expected);
    });
  }
});

describe('saving dollars that were typed as text', () => {
  const save = (text: string) => blockToMarkdown(notoSchema.nodes.paragraph.create(null, notoSchema.text(text)));
  const reads = (markdown: string) => viaMicromark(markdown);

  it('writes prices as they were typed, without backslashes', () => {
    expect(save('$8,000 - $50,000')).toBe('$8,000 - $50,000');
    expect(save('Pay $5 or $10.')).toBe('Pay $5 or $10.');
  });

  it('keeps the escape a dollar needs to stay text', () => {
    for (const text of ['Pay $8 for x$ now', '$x$', 'a $b$ c', '$a, $5 then b$']) {
      const written = save(text);
      expect(reads(written)).toBe(text);
    }
    expect(save('$x$')).toBe('\\$x$');
  });

  it('leaves real math as math', () => {
    const block = notoSchema.nodes.paragraph.create(null, [
      notoSchema.text('so '),
      notoSchema.nodes.math_inline.create(null, notoSchema.text('x+1')),
      notoSchema.text(' costs $5'),
    ]);
    expect(blockToMarkdown(block)).toBe('so $x+1$ costs $5');
  });
});

/**
 * Engine-owned IR → PM for common blocks (leaf + plain / simple-marked
 * paragraph/heading including hard breaks + parseable link-def + simple
 * footnote-def incl. hard breaks + simple marks + simple quote incl. nested
 * plain + hard breaks + lists-in-quotes + simple GFM alerts / callouts with
 * plain or simple-marked bodies + lazy continuation (fewer `>` and true no-`>`)
 * + simple flat / same-family nested list (any depth, incl. hard breaks +
 * simple marks incl. flat underscore + up to nineteen-level nested marks + collapsible/plain-titled/simple-marked-title callouts + unindented lazy
 * soft-wrap) + simple GFM table with plain or simple-marked cells incl.
 * escaped pipes + simple inline links / images + simple reference links /
 * images + simple bare http(s) + angle-bracket http(s) + www. + email
 * autolinks + simple wiki links).
 * Flagged `@roobli/md` path; does not flip product default.
 */

import { describe, expect, it } from 'vitest';
import {
  blockFromEngineSpan,
  canSkipDialectEnrich,
  engineSemanticKey,
  needsDialectInline,
  needsDialectInlineInQuote,
  hasHardBreak,
  inlineNodesFromPlainSource,
  tryInlineNodesFromSource,
  parseFenceSource,
  parseHeadingSource,
  parseLinkDefinitionSource,
  parseSimpleFootnoteDefinitionSource,
  parseSimpleQuoteSource,
  parseSimpleFlatListSource,
  parseSimpleTableSource,
} from '../../src/shared/markdown/v3/pm/from-engine';
import { blockFromSpan, docFromSpans } from '../../src/shared/markdown/v3/pm/from-mdast';
import {
  splitBlocksViaRoobli,
  enrichSpansInRange,
  createEnrichFlags,
  countDeferredFlags,
} from '../../src/shared/markdown/v3/roobli-md-adapter';
import { splitBlocks } from '../../src/shared/markdown/v3/blocks';
import { setMarkdownEngineForTests } from '../../src/shared/markdown/v3/engine-flag';
import { afterEach } from 'vitest';

afterEach(() => {
  setMarkdownEngineForTests(null);
});

describe('from-engine IR helpers', () => {
  it('detects inline dialect markers conservatively', () => {
    expect(needsDialectInline('plain text')).toBe(false);
    expect(needsDialectInline('Hello world')).toBe(false);
    expect(needsDialectInline('has **bold**')).toBe(true);
    expect(needsDialectInline('see [[wiki]]')).toBe(true);
    expect(needsDialectInline('`code`')).toBe(true);
    expect(needsDialectInline('https://example.com')).toBe(true);
    expect(needsDialectInline('one  \ntwo')).toBe(false);
    expect(needsDialectInline('soft\nwrap')).toBe(false);
    expect(hasHardBreak('one  \ntwo')).toBe(true);
    expect(hasHardBreak('soft\nwrap')).toBe(false);
    expect(needsDialectInline('[!NOTE]\nbody')).toBe(true);
    expect(needsDialectInlineInQuote('[!NOTE]\nbody')).toBe(false);
    expect(needsDialectInlineInQuote('[!NOTE]\nhas **bold**')).toBe(false);
    expect(needsDialectInlineInQuote('[!NOTE]\nhas [[wiki]]')).toBe(false);
    expect(needsDialectInlineInQuote('[!NOTE]\nhas __underscore__')).toBe(false);
    expect(needsDialectInlineInQuote('[!NOTE]\nhas _em_')).toBe(false);
    expect(needsDialectInlineInQuote('[!NOTE]\nhas snake_case')).toBe(false);
    expect(needsDialectInlineInQuote('[!NOTE]-\nbody')).toBe(false);
    expect(needsDialectInlineInQuote('[!NOTE]+\nbody')).toBe(false);
    expect(needsDialectInlineInQuote('[!NOTE] Title\nbody')).toBe(false);
    expect(needsDialectInlineInQuote('[!NOTE] Title with **bold**\nbody')).toBe(false);
    expect(needsDialectInlineInQuote('[!NOTE] Title with \\*escape\\*\nbody')).toBe(false);
    expect(needsDialectInlineInQuote('plain')).toBe(false);
  });

  it('canSkipDialectEnrich for leaf + plain phrasing + simple/nested quote + lists-in-quotes + flat/nested list + table + footnote', () => {
    expect(canSkipDialectEnrich('fenced-code', '```js\nx\n```')).toBe(true);
    expect(canSkipDialectEnrich('thematic-break', '---')).toBe(true);
    expect(canSkipDialectEnrich('paragraph', 'Hello')).toBe(true);
    expect(canSkipDialectEnrich('heading', '# Title')).toBe(true);
    expect(canSkipDialectEnrich('heading', 'Setext\n===')).toBe(true);
    expect(canSkipDialectEnrich('paragraph', 'Break  \nline')).toBe(true);
    expect(canSkipDialectEnrich('paragraph', 'Hello **x**')).toBe(true);
    expect(canSkipDialectEnrich('paragraph', 'Backslash \\*not emph\\*')).toBe(true);
    expect(canSkipDialectEnrich('paragraph', 'Pipe \\| in text')).toBe(true);
    expect(canSkipDialectEnrich('table', '| a \\| b |\n| --- |')).toBe(true);
    expect(canSkipDialectEnrich('paragraph', 'Break  \n**x**')).toBe(true);
    expect(canSkipDialectEnrich('paragraph', 'Hello [[wiki]]')).toBe(true);
    expect(canSkipDialectEnrich('paragraph', 'bare https://example.com')).toBe(true);
    expect(canSkipDialectEnrich('paragraph', 'angle <https://example.com>')).toBe(true);
    expect(canSkipDialectEnrich('paragraph', 'see www.example.com')).toBe(true);
    expect(canSkipDialectEnrich('paragraph', 'mail user@example.com')).toBe(true);
    expect(canSkipDialectEnrich('paragraph', 'see <admin@example.com>')).toBe(true);
    expect(canSkipDialectEnrich('paragraph', 'See [ref][id] and [x][]')).toBe(true);
    expect(canSkipDialectEnrich('paragraph', 'Pic ![alt][logo]')).toBe(true);
    expect(canSkipDialectEnrich('paragraph', 'Hello __x__')).toBe(true);
    expect(canSkipDialectEnrich('paragraph', 'Hello _em_')).toBe(true);
    expect(canSkipDialectEnrich('paragraph', 'uses snake_case id')).toBe(true);
    expect(canSkipDialectEnrich('link-definition', '[id]: https://example.com')).toBe(true);
    expect(canSkipDialectEnrich('footnote-definition', '[^1]: plain note')).toBe(true);
    expect(canSkipDialectEnrich('footnote-definition', '[^1]: has *emphasis*')).toBe(true);
    expect(canSkipDialectEnrich('footnote-definition', '[^1]: has [[wiki]]')).toBe(true);
    expect(canSkipDialectEnrich('footnote-definition', '[^1]:')).toBe(true);
    expect(canSkipDialectEnrich('footnote-definition', '[^1]: a  \n  b')).toBe(true);
    expect(canSkipDialectEnrich('quote', '> Hello')).toBe(true);
    expect(canSkipDialectEnrich('quote', '> outer\n> > nested')).toBe(true);
    expect(canSkipDialectEnrich('quote', '> > only nested')).toBe(true);
    expect(canSkipDialectEnrich('quote', '> - item\n> - two')).toBe(true);
    expect(canSkipDialectEnrich('quote', '> intro\n> - a\n> - b')).toBe(true);
    expect(canSkipDialectEnrich('quote', '> a  \n> b')).toBe(true);
    expect(canSkipDialectEnrich('quote', '> Hello **x**')).toBe(true);
    expect(canSkipDialectEnrich('quote', '> [!NOTE]\n> body')).toBe(true);
    expect(canSkipDialectEnrich('quote', '> [!NOTE]-\n> body')).toBe(true);
    expect(canSkipDialectEnrich('quote', '> [!NOTE]+\n> body')).toBe(true);
    expect(canSkipDialectEnrich('quote', '> [!NOTE] Title\n> body')).toBe(true);
    expect(canSkipDialectEnrich('quote', '> [!NOTE] Title **x**\n> body')).toBe(true);
    expect(canSkipDialectEnrich('quote', '> [!NOTE] Title \\*x\\*\n> body')).toBe(true);
    expect(canSkipDialectEnrich('quote', '> [!WARNING]\n> has **bold**')).toBe(true);
    expect(canSkipDialectEnrich('quote', '> [!WARNING]\n> has [[wiki]]')).toBe(true);
    expect(canSkipDialectEnrich('quote', '> > nested\n> lazy')).toBe(true);
    expect(canSkipDialectEnrich('quote', '> foo\nbar')).toBe(true);
    expect(canSkipDialectEnrich('quote', '> - item\nlazy cont')).toBe(true);
    expect(canSkipDialectEnrich('bullet-list', '- foo\nbar')).toBe(true);
    expect(canSkipDialectEnrich('quote', '> outer\n> > nest\n> after')).toBe(true);
    expect(canSkipDialectEnrich('quote', '> > nest\n> **bold**')).toBe(true);
    expect(canSkipDialectEnrich('quote', '> - **bold**')).toBe(true);
    expect(canSkipDialectEnrich('quote', '> > nest\n> [[wiki]]')).toBe(true);
    expect(canSkipDialectEnrich('bullet-list', '- a\n- b')).toBe(true);
    expect(canSkipDialectEnrich('bullet-list', '- a  \n  b')).toBe(true);
    expect(canSkipDialectEnrich('ordered-list', '1. a\n2. b')).toBe(true);
    expect(canSkipDialectEnrich('task-list', '- [ ] a\n- [x] b')).toBe(true);
    expect(canSkipDialectEnrich('bullet-list', '- a\n  - nested')).toBe(true);
    expect(canSkipDialectEnrich('bullet-list', '- a\n  - nested\n    - deep')).toBe(true);
    expect(canSkipDialectEnrich('bullet-list', '- a\n  1. cross')).toBe(true);
    expect(canSkipDialectEnrich('bullet-list', '- **bold**')).toBe(true);
    expect(canSkipDialectEnrich('bullet-list', '- [[wiki]]')).toBe(true);
    expect(canSkipDialectEnrich('table', '| a |\n| - |\n| 1 |')).toBe(true);
    expect(canSkipDialectEnrich('table', '| Left | Right |\n| :--- | ---: |\n| alpha | 1 |')).toBe(true);
    expect(canSkipDialectEnrich('table', '| a |\n| - |\n| **x** |')).toBe(true);
    expect(canSkipDialectEnrich('table', '| a |\n| - |\n| [[wiki]] |')).toBe(true);
    expect(canSkipDialectEnrich('table', '| a | b |\n| - |\n| 1 | 2 |')).toBe(false);
  });

  it('parses fence / heading source', () => {
    expect(parseFenceSource('```ts\nconst x = 1;\n```')).toEqual({
      lang: 'ts', meta: '', value: 'const x = 1;',
    });
    expect(parseFenceSource('```\n```')).toEqual({
      lang: '', meta: '', value: '',
    });
    expect(parseFenceSource('```rust linenums\nfn main() {}\n```')).toEqual({
      lang: 'rust', meta: 'linenums', value: 'fn main() {}',
    });
    expect(parseHeadingSource('# Hi')).toEqual({ level: 1, text: 'Hi' });
    expect(parseHeadingSource('### Nested')).toEqual({ level: 3, text: 'Nested' });
    expect(parseHeadingSource('Setext\n===')).toEqual({ level: 1, text: 'Setext' });
    expect(parseLinkDefinitionSource('[alpha]: https://example.com/alpha "Alpha Title"')).toEqual({
      identifier: 'alpha', label: 'alpha', url: 'https://example.com/alpha', title: 'Alpha Title',
    });
    expect(parseLinkDefinitionSource('[shortcut]: https://example.com/shortcut')).toEqual({
      identifier: 'shortcut', label: 'shortcut', url: 'https://example.com/shortcut', title: null,
    });
    expect(parseLinkDefinitionSource('[angled]: <https://example.com/a> \'T\'')).toEqual({
      identifier: 'angled', label: 'angled', url: 'https://example.com/a', title: 'T',
    });
    expect(parseSimpleQuoteSource('> Hello')).toEqual([
      { type: 'paragraph', text: 'Hello' },
    ]);
    expect(parseSimpleQuoteSource('> line1\n> line2')).toEqual([
      { type: 'paragraph', text: 'line1\nline2' },
    ]);
    expect(parseSimpleQuoteSource('> para1\n>\n> para2')).toEqual([
      { type: 'paragraph', text: 'para1' },
      { type: 'paragraph', text: 'para2' },
    ]);
    expect(parseSimpleQuoteSource('> trailing ')).toEqual([
      { type: 'paragraph', text: 'trailing' },
    ]);
    expect(parseSimpleQuoteSource('>  spaced')).toEqual([
      { type: 'paragraph', text: 'spaced' },
    ]);
    expect(parseSimpleQuoteSource('> > nested')).toEqual([
      { type: 'quote', children: [{ type: 'paragraph', text: 'nested' }] },
    ]);
    expect(parseSimpleQuoteSource('> outer\n> > nested')).toEqual([
      { type: 'paragraph', text: 'outer' },
      { type: 'quote', children: [{ type: 'paragraph', text: 'nested' }] },
    ]);
    expect(parseSimpleQuoteSource('> outer\n> > mid\n> > > deep')).toEqual([
      { type: 'paragraph', text: 'outer' },
      {
        type: 'quote',
        children: [
          { type: 'paragraph', text: 'mid' },
          { type: 'quote', children: [{ type: 'paragraph', text: 'deep' }] },
        ],
      },
    ]);
    expect(parseSimpleQuoteSource('> > a\n> >\n> > b')).toEqual([
      {
        type: 'quote',
        children: [
          { type: 'paragraph', text: 'a' },
          { type: 'paragraph', text: 'b' },
        ],
      },
    ]);
    expect(parseSimpleQuoteSource('> > a\n>\n> > b')).toEqual([
      { type: 'quote', children: [{ type: 'paragraph', text: 'a' }] },
      { type: 'quote', children: [{ type: 'paragraph', text: 'b' }] },
    ]);
    expect(parseSimpleQuoteSource('> - item')).toEqual([
      { type: 'list', list: {
        ordered: false, bullet: '-', delimiter: null, start: 1, spread: false,
        items: [{ checked: null, text: 'item', nested: null }],
      } },
    ]);
    expect(parseSimpleQuoteSource('> intro\n> - a\n> - b\n> out')).toEqual([
      { type: 'paragraph', text: 'intro' },
      { type: 'list', list: {
        ordered: false, bullet: '-', delimiter: null, start: 1, spread: false,
        items: [
          { checked: null, text: 'a', nested: null },
          { checked: null, text: 'b', nested: null },
        ],
      } },
      { type: 'paragraph', text: 'out' },
    ]);
    expect(parseSimpleQuoteSource('> - outer\n>   - nested')).toEqual([
      { type: 'list', list: {
        ordered: false, bullet: '-', delimiter: null, start: 1, spread: false,
        items: [{
          checked: null, text: 'outer',
          nested: {
            ordered: false, bullet: '-', delimiter: null, start: 1, spread: false,
            items: [{ checked: null, text: 'nested', nested: null }],
          },
        }],
      } },
    ]);
    expect(parseSimpleQuoteSource('> a  \n> b')).toEqual([
      { type: 'paragraph', text: 'a  \nb' },
    ]);
    expect(parseSimpleQuoteSource('> outer\n> > nested  \n> > deep')).toEqual([
      { type: 'paragraph', text: 'outer' },
      { type: 'quote', children: [{ type: 'paragraph', text: 'nested  \ndeep' }] },
    ]);
    expect(parseSimpleQuoteSource('> **bold**')).not.toBeNull();
    expect(parseSimpleQuoteSource('> [[wiki]]')).toEqual([
      { type: 'paragraph', text: '[[wiki]]' },
    ]);
    expect(parseSimpleQuoteSource('> > nested\n> lazy')).toEqual([
      { type: 'quote', children: [{ type: 'paragraph', text: 'nested\nlazy' }] },
    ]);

    expect(parseSimpleQuoteSource('> foo\nbar')).toEqual([
      { type: 'paragraph', text: 'foo\nbar' },
    ]);
    expect(parseSimpleQuoteSource('> - item\nlazy cont')).toEqual([
      {
        type: 'list',
        list: {
          ordered: false,
          bullet: '-',
          delimiter: null,
          start: 1,
          spread: false,
          items: [{ checked: null, text: 'item\nlazy cont', nested: null }],
        },
      },
    ]);
    expect(parseSimpleQuoteSource('bar\nonly lazy')).toBeNull();

    expect(parseSimpleQuoteSource('> outer\n> > nest\n> after')).toEqual([
      { type: 'paragraph', text: 'outer' },
      { type: 'quote', children: [{ type: 'paragraph', text: 'nest\nafter' }] },
    ]);
    expect(parseSimpleQuoteSource('> > > deep\n> > mid\n> out')).toEqual([
      {
        type: 'quote',
        children: [{
          type: 'quote',
          children: [{ type: 'paragraph', text: 'deep\nmid\nout' }],
        }],
      },
    ]);
    expect(parseSimpleQuoteSource('> > nest  \n> hard')).toEqual([
      { type: 'quote', children: [{ type: 'paragraph', text: 'nest  \nhard' }] },
    ]);
    expect(parseSimpleQuoteSource('> > nest\n> - item')).toEqual([
      { type: 'quote', children: [{ type: 'paragraph', text: 'nest' }] },
      { type: 'list', list: {
        ordered: false, bullet: '-', delimiter: null, start: 1, spread: false,
        items: [{ checked: null, text: 'item', nested: null }],
      } },
    ]);
    expect(parseSimpleQuoteSource('> > nest\n> **bold**')).not.toBeNull();
    expect(parseSimpleQuoteSource('> - **bold**')).not.toBeNull();
    expect(parseSimpleQuoteSource('> > nest\n> [[wiki]]')).not.toBeNull();
    expect(parseSimpleQuoteSource('> [!NOTE]\n> x')).not.toBeNull();
    expect(parseSimpleQuoteSource('> [!NOTE]-\n> x')).not.toBeNull();
    expect(parseSimpleQuoteSource('> [!NOTE]+\n> x')).not.toBeNull();
    expect(parseSimpleQuoteSource('> [!NOTE] Title\n> x')).not.toBeNull();
    expect(parseSimpleQuoteSource('> [!NOTE] Title **x**\n> x')).not.toBeNull();
    expect(parseSimpleQuoteSource('> [!NOTE] Title \\*x\\*\n> x')).not.toBeNull();
    expect(parseSimpleQuoteSource('> [!WARNING]\n> has **bold**')).not.toBeNull();
    expect(parseSimpleQuoteSource('> [!WARNING]\n> has [[wiki]]')).not.toBeNull();
    expect(parseSimpleFlatListSource('- a\n- b')).toEqual({
      ordered: false, bullet: '-', delimiter: null, start: 1, spread: false,
      items: [
        { checked: null, text: 'a', nested: null },
        { checked: null, text: 'b', nested: null },
      ],
    });
    expect(parseSimpleFlatListSource('* star\n* two')?.bullet).toBe('*');
    expect(parseSimpleFlatListSource('1. a\n2. b')).toMatchObject({
      ordered: true, delimiter: '.', start: 1, spread: false,
    });
    expect(parseSimpleFlatListSource('3. a\n4. b')?.start).toBe(3);
    expect(parseSimpleFlatListSource('1) a\n2) b')?.delimiter).toBe(')');
    expect(parseSimpleFlatListSource('- a\n\n- b')?.spread).toBe(true);
    expect(parseSimpleFlatListSource('- [ ] todo\n- [x] done')?.items).toEqual([
      { checked: false, text: 'todo', nested: null },
      { checked: true, text: 'done', nested: null },
    ]);
    expect(parseSimpleFlatListSource('- a\n  continued')?.items[0]?.text).toBe('a\ncontinued');
    expect(parseSimpleFlatListSource('- a\n  - nested')).toEqual({
      ordered: false, bullet: '-', delimiter: null, start: 1, spread: false,
      items: [{
        checked: null, text: 'a',
        nested: {
          ordered: false, bullet: '-', delimiter: null, start: 1, spread: false,
          items: [{ checked: null, text: 'nested', nested: null }],
        },
      }],
    });
    expect(parseSimpleFlatListSource('- a\n  - nested\n    - deep')).toEqual({
      ordered: false, bullet: '-', delimiter: null, start: 1, spread: false,
      items: [{
        checked: null, text: 'a',
        nested: {
          ordered: false, bullet: '-', delimiter: null, start: 1, spread: false,
          items: [{
            checked: null, text: 'nested',
            nested: {
              ordered: false, bullet: '-', delimiter: null, start: 1, spread: false,
              items: [{ checked: null, text: 'deep', nested: null }],
            },
          }],
        },
      }],
    });
    expect(parseSimpleFlatListSource('- **bold**')).not.toBeNull();
    expect(parseSimpleFlatListSource('- [[wiki]]')).not.toBeNull();
    expect(parseSimpleFlatListSource('- a\n* b')).toBeNull();
    expect(parseSimpleFlatListSource('- multi\n\n  para\n- next')).toBeNull();
    expect(parseSimpleTableSource('| Left | Right |\n| :--- | ---: |\n| alpha | 1 |\n| beta | 2 |')).toEqual({
      align: ['left', 'right'],
      rows: [['Left', 'Right'], ['alpha', '1'], ['beta', '2']],
    });
    expect(parseSimpleTableSource('| a | b | c |\n| --- | :---: | ---: |\n| 1 | 2 | 3 |')).toEqual({
      align: [null, 'center', 'right'],
      rows: [['a', 'b', 'c'], ['1', '2', '3']],
    });
    expect(parseSimpleTableSource('| H1 | H2 |\n| --- | --- |')).toEqual({
      align: [null, null],
      rows: [['H1', 'H2']],
    });
    expect(parseSimpleTableSource('  | a | b |\n  | - | - |\n  | 1 | 2 |')).toEqual({
      align: [null, null],
      rows: [['a', 'b'], ['1', '2']],
    });
    expect(parseSimpleTableSource('| x |\n| - |\n|  |')?.rows[1]).toEqual(['']);
    expect(parseSimpleTableSource('| a |\n| - |\n| **x** |')).not.toBeNull();
    expect(parseSimpleTableSource('| a |\n| - |\n| [[wiki]] |')).toEqual({
      align: [null],
      rows: [['a'], ['[[wiki]]']],
    });
    // Delimiter ≠ header → not a GFM table.
    expect(parseSimpleTableSource('| a | b |\n| - |\n| 1 | 2 |')).toBeNull();
    // Ragged body rows kept as-is (micromark/mdast parity).
    expect(parseSimpleTableSource('| a | b |\n| - | - |\n| 1 |')).toEqual({
      align: [null, null],
      rows: [['a', 'b'], ['1']],
    });
    expect(parseSimpleTableSource('| a | b |\n| - | - |\n| 1 | 2 | 3 |')).toEqual({
      align: [null, null],
      rows: [['a', 'b'], ['1', '2', '3']],
    });
    // Escaped pipes stay inside the cell (split ignores escaped `|`).
    expect(parseSimpleTableSource('| a \\| b |\n| --- |\n| c \\| d |')).toEqual({
      align: [null],
      rows: [['a \\| b'], ['c \\| d']],
    });
    expect(parseSimpleTableSource('| Left \\| Mid | Right |\n| --- | --- |\n| a \\| b | 1 |')).toEqual({
      align: [null, null],
      rows: [['Left \\| Mid', 'Right'], ['a \\| b', '1']],
    });
    // Escaped pipe in header collapses width → delimiter mismatch → dialect.
    expect(parseSimpleTableSource('| a \\| b |\n| - | - |')).toBeNull();
  });
});

describe('blockFromEngineSpan', () => {
  it('builds leaf PM nodes without mdast', () => {
    const fence = blockFromEngineSpan('fenced-code', '```js\ncode\n```');
    expect(fence?.type.name).toBe('code_block');
    expect(fence?.attrs.lang).toBe('js');
    expect(fence?.textContent).toBe('code');

    const hr = blockFromEngineSpan('thematic-break', '---');
    expect(hr?.type.name).toBe('horizontal_rule');

    const math = blockFromEngineSpan('display-math', '$$\nx\n$$');
    expect(math?.type.name).toBe('math_block');
    expect(math?.textContent).toBe('x');

    const fm = blockFromEngineSpan('frontmatter', '---\ntitle: t\n---');
    expect(fm?.type.name).toBe('frontmatter');
    expect(fm?.textContent).toBe('title: t');

    const link = blockFromEngineSpan('link-definition', '[alpha]: https://example.com/alpha "Alpha Title"');
    expect(link?.type.name).toBe('link_definition');
    expect(link?.attrs).toMatchObject({
      identifier: 'alpha', label: 'alpha', url: 'https://example.com/alpha', title: 'Alpha Title',
    });
  });

  it('builds setext heading from underline when source is engine-owned', () => {
    const h = blockFromEngineSpan('heading', 'Setext Title\n============');
    expect(h?.type.name).toBe('heading');
    expect(h?.attrs.level).toBe(1);
    expect(h?.textContent).toBe('Setext Title');
    expect(blockFromEngineSpan('heading', 'Setext *x*\n=======')?.textContent).toBe('Setext x');
    expect(blockFromEngineSpan('heading', 'Setext [[wiki]]\n=======')?.textContent).toBe('Setext [[wiki]]');
    // Phase 15 / @roobli/md ≥ v0.1.12: continuous --- underline is setext h2
    const h2 = blockFromEngineSpan('heading', 'Hello\n---');
    expect(h2?.type.name).toBe('heading');
    expect(h2?.attrs.level).toBe(2);
    expect(h2?.textContent).toBe('Hello');
    expect(canSkipDialectEnrich('heading', 'Hello\n---')).toBe(true);
    expect(canSkipDialectEnrich('heading', 'Short\n-')).toBe(true);
  });

  it('builds simple and nested plain quotes + lists-in-quotes + hard breaks + plain/simple-marked callouts + lazy nest + no-marker lazy; refuses heavy inline', () => {
    const q = blockFromEngineSpan('quote', '> Hello world');
    expect(q?.type.name).toBe('blockquote');
    expect(q?.childCount).toBe(1);
    expect(q?.child(0).type.name).toBe('paragraph');
    expect(q?.textContent).toBe('Hello world');

    const cont = blockFromEngineSpan('quote', '> Second plain quote\n> with a continuation line.');
    expect(cont?.childCount).toBe(1);
    expect(cont?.textContent).toBe('Second plain quote\nwith a continuation line.');

    const multi = blockFromEngineSpan('quote', '> para1\n>\n> para2');
    expect(multi?.childCount).toBe(2);
    expect(multi?.child(0).textContent).toBe('para1');
    expect(multi?.child(1).textContent).toBe('para2');

    const nested = blockFromEngineSpan('quote', '> outer\n> > nested');
    expect(nested?.type.name).toBe('blockquote');
    expect(nested?.childCount).toBe(2);
    expect(nested?.child(0).type.name).toBe('paragraph');
    expect(nested?.child(0).textContent).toBe('outer');
    expect(nested?.child(1).type.name).toBe('blockquote');
    expect(nested?.child(1).childCount).toBe(1);
    expect(nested?.child(1).textContent).toBe('nested');

    const deep = blockFromEngineSpan('quote', '> outer\n> > mid\n> > > deep');
    expect(deep?.childCount).toBe(2);
    expect(deep?.child(1).type.name).toBe('blockquote');
    expect(deep?.child(1).childCount).toBe(2);
    expect(deep?.child(1).child(0).textContent).toBe('mid');
    expect(deep?.child(1).child(1).type.name).toBe('blockquote');
    expect(deep?.child(1).child(1).textContent).toBe('deep');

    expect(blockFromEngineSpan('quote', '> trailing ')?.textContent).toBe('trailing');

    const listed = blockFromEngineSpan('quote', '> - item a\n> - item b');
    expect(listed?.type.name).toBe('blockquote');
    expect(listed?.childCount).toBe(1);
    expect(listed?.child(0).type.name).toBe('bullet_list');
    expect(listed?.child(0).childCount).toBe(2);
    expect(listed?.child(0).child(0).textContent).toBe('item a');
    expect(listed?.child(0).child(1).textContent).toBe('item b');

    const mixed = blockFromEngineSpan('quote', '> intro\n> - a\n> - b\n> out');
    expect(mixed?.childCount).toBe(3);
    expect(mixed?.child(0).type.name).toBe('paragraph');
    expect(mixed?.child(0).textContent).toBe('intro');
    expect(mixed?.child(1).type.name).toBe('bullet_list');
    expect(mixed?.child(2).type.name).toBe('paragraph');
    expect(mixed?.child(2).textContent).toBe('out');

    const nestList = blockFromEngineSpan('quote', '> - outer\n>   - nested');
    expect(nestList?.child(0).type.name).toBe('bullet_list');
    expect(nestList?.child(0).child(0).child(1).type.name).toBe('bullet_list');
    expect(nestList?.child(0).child(0).child(1).child(0).textContent).toBe('nested');

    const ordered = blockFromEngineSpan('quote', '> 1. one\n> 2. two');
    expect(ordered?.child(0).type.name).toBe('ordered_list');
    expect(ordered?.child(0).child(0).textContent).toBe('one');

    const tasks = blockFromEngineSpan('quote', '> - [ ] todo\n> - [x] done');
    expect(tasks?.child(0).child(0).attrs.checked).toBe(false);
    expect(tasks?.child(0).child(1).attrs.checked).toBe(true);

    const hb = blockFromEngineSpan('quote', '> a  \n> b');
    expect(hb?.type.name).toBe('blockquote');
    expect(hb?.childCount).toBe(1);
    expect(hb?.child(0).type.name).toBe('paragraph');
    expect(hb?.child(0).childCount).toBe(3);
    expect(hb?.child(0).child(0).text).toBe('a');
    expect(hb?.child(0).child(1).type.name).toBe('hard_break');
    expect(hb?.child(0).child(2).text).toBe('b');

    const hbNest = blockFromEngineSpan('quote', '> outer\n> > nested  \n> > deep');
    expect(hbNest?.child(1).type.name).toBe('blockquote');
    expect(hbNest?.child(1).child(0).child(1).type.name).toBe('hard_break');
    expect(hbNest?.child(1).textContent).toBe('nesteddeep');

    const hbMulti = blockFromEngineSpan('quote', '> A  \n> B\n> C  \n> D');
    // Soft newlines stay in text; hard breaks are nodes (same as plain paras).
    expect(hbMulti?.child(0).childCount).toBe(5);
    expect(hbMulti?.child(0).child(0).text).toBe('A');
    expect(hbMulti?.child(0).child(1).type.name).toBe('hard_break');
    expect(hbMulti?.child(0).child(2).text).toBe('B\nC');
    expect(hbMulti?.child(0).child(3).type.name).toBe('hard_break');
    expect(hbMulti?.child(0).child(4).text).toBe('D');
    expect(hbMulti?.textContent).toBe('AB\nCD');

    const callout = blockFromEngineSpan('quote', '> [!NOTE]\n> body');
    expect(callout?.type.name).toBe('blockquote');
    expect(callout?.childCount).toBe(1);
    expect(callout?.child(0).type.name).toBe('paragraph');
    expect(callout?.child(0).textContent).toBe('[!NOTE]\nbody');

    const tip = blockFromEngineSpan('quote', '> [!TIP]\n> Tip body stays exact.');
    expect(tip?.textContent).toBe('[!TIP]\nTip body stays exact.');

    const lazyNest = blockFromEngineSpan('quote', '> > nested\n> lazy');
    expect(lazyNest?.type.name).toBe('blockquote');
    expect(lazyNest?.childCount).toBe(1);
    expect(lazyNest?.child(0).type.name).toBe('blockquote');
    expect(lazyNest?.child(0).textContent).toBe('nested\nlazy');

    const lazyAfter = blockFromEngineSpan('quote', '> outer\n> > nest\n> after');
    expect(lazyAfter?.childCount).toBe(2);
    expect(lazyAfter?.child(0).textContent).toBe('outer');
    expect(lazyAfter?.child(1).type.name).toBe('blockquote');
    expect(lazyAfter?.child(1).textContent).toBe('nest\nafter');

    const lazyDeep = blockFromEngineSpan('quote', '> > > deep\n> > mid\n> out');
    expect(lazyDeep?.childCount).toBe(1);
    expect(lazyDeep?.child(0).type.name).toBe('blockquote');
    expect(lazyDeep?.child(0).child(0).type.name).toBe('blockquote');
    expect(lazyDeep?.child(0).child(0).textContent).toBe('deep\nmid\nout');

    const lazyHb = blockFromEngineSpan('quote', '> > nest  \n> hard');
    expect(lazyHb?.child(0).child(0).child(1).type.name).toBe('hard_break');
    expect(lazyHb?.child(0).textContent).toBe('nesthard');

    const nestThenList = blockFromEngineSpan('quote', '> > nest\n> - item');
    expect(nestThenList?.childCount).toBe(2);
    expect(nestThenList?.child(0).type.name).toBe('blockquote');
    expect(nestThenList?.child(0).textContent).toBe('nest');
    expect(nestThenList?.child(1).type.name).toBe('bullet_list');
    expect(nestThenList?.child(1).textContent).toBe('item');

    const noMarker = blockFromEngineSpan('quote', '> quote line\nlazy without marker');
    expect(noMarker?.type.name).toBe('blockquote');
    expect(noMarker?.childCount).toBe(1);
    expect(noMarker?.textContent).toBe('quote line\nlazy without marker');

    const noMarkerNest = blockFromEngineSpan('quote', '> > nest\nlazy into nest');
    expect(noMarkerNest?.childCount).toBe(1);
    expect(noMarkerNest?.child(0).type.name).toBe('blockquote');
    expect(noMarkerNest?.child(0).textContent).toBe('nest\nlazy into nest');

    const lazyIntoList = blockFromEngineSpan('quote', '> - item one\nlazy list cont');
    expect(lazyIntoList?.childCount).toBe(1);
    expect(lazyIntoList?.child(0).type.name).toBe('bullet_list');
    expect(lazyIntoList?.child(0).textContent).toBe('item one\nlazy list cont');

    const markedQuote = blockFromEngineSpan('quote', '> Hello **bold**');
    expect(markedQuote?.type.name).toBe('blockquote');
    expect(markedQuote?.textContent).toBe('Hello bold');
    expect(markedQuote?.child(0).child(1).marks.some((m) => m.type.name === 'strong')).toBe(true);
    const fold = blockFromEngineSpan('quote', '> [!NOTE]-\n> body');
    expect(fold?.type.name).toBe('blockquote');
    expect(fold?.textContent).toBe('[!NOTE]-\nbody');
    const titled = blockFromEngineSpan('quote', '> [!NOTE] Title\n> body');
    expect(titled?.textContent).toBe('[!NOTE] Title\nbody');
    const markedTitle = blockFromEngineSpan('quote', '> [!NOTE] Title **x**\n> body');
    expect(markedTitle?.textContent).toBe('[!NOTE] Title x\nbody');
    const titlePara = markedTitle!.child(0);
    let strongTitle = false;
    titlePara.forEach((node) => {
      if (node.isText && node.text === 'x' && node.marks.some((m) => m.type.name === 'strong')) {
        strongTitle = true;
      }
    });
    expect(strongTitle).toBe(true);
    const escapedTitle = blockFromEngineSpan('quote', '> [!NOTE] Title \\*x\\*\n> body');
    expect(escapedTitle?.textContent).toBe('[!NOTE] Title *x*\nbody');
    const markedAlert = blockFromEngineSpan('quote', '> [!WARNING]\n> has **bold**');
    expect(markedAlert?.textContent).toBe('[!WARNING]\nhas bold');
    expect(blockFromEngineSpan('quote', '> > nest\n> **bold**')?.textContent).toBe('nest\nbold');
    expect(blockFromEngineSpan('quote', '> - **bold**')?.textContent).toBe('bold');
    expect(blockFromEngineSpan('quote', '> Hello [[wiki]]')?.textContent).toBe('Hello [[wiki]]');
    expect(blockFromEngineSpan('quote', '> # heading')).toBeNull();
    expect(blockFromEngineSpan('quote', '>')).toBeNull();
  });

  it('builds simple flat lists incl. hard breaks + simple marks; refuses heavy / mixed markers / multi-para', () => {
    const ul = blockFromEngineSpan('bullet-list', '- bullet a\n- bullet b');
    expect(ul?.type.name).toBe('bullet_list');
    expect(ul?.attrs).toMatchObject({ spread: false, bullet: '-' });
    expect(ul?.childCount).toBe(2);
    expect(ul?.child(0).textContent).toBe('bullet a');
    expect(ul?.child(1).textContent).toBe('bullet b');

    const star = blockFromEngineSpan('bullet-list', '* star a\n* star b');
    expect(star?.attrs.bullet).toBe('*');

    const ol = blockFromEngineSpan('ordered-list', '1. ordered a\n2. ordered b');
    expect(ol?.type.name).toBe('ordered_list');
    expect(ol?.attrs).toMatchObject({ start: 1, spread: false, delimiter: '.' });
    expect(ol?.child(0).textContent).toBe('ordered a');

    const startAt = blockFromEngineSpan('ordered-list', '3. start three\n4. next');
    expect(startAt?.attrs.start).toBe(3);

    const paren = blockFromEngineSpan('ordered-list', '1) paren a\n2) paren b');
    expect(paren?.attrs.delimiter).toBe(')');

    const loose = blockFromEngineSpan('bullet-list', '- a\n\n- b');
    expect(loose?.attrs.spread).toBe(true);

    const tasks = blockFromEngineSpan('task-list', '- [ ] todo\n- [x] done');
    expect(tasks?.type.name).toBe('bullet_list');
    expect(tasks?.child(0).attrs.checked).toBe(false);
    expect(tasks?.child(1).attrs.checked).toBe(true);
    expect(tasks?.child(0).textContent).toBe('todo');
    expect(tasks?.child(1).textContent).toBe('done');

    const wrap = blockFromEngineSpan('bullet-list', '- a\n  continued\n- b');
    expect(wrap?.child(0).textContent).toBe('a\ncontinued');

    const lazyWrap = blockFromEngineSpan('bullet-list', '- a\ncontinued\n- b');
    expect(lazyWrap?.child(0).textContent).toBe('a\ncontinued');
    expect(lazyWrap?.child(1).textContent).toBe('b');

    expect(parseSimpleFlatListSource('- foo\nbar')).toEqual({
      ordered: false,
      bullet: '-',
      delimiter: null,
      start: 1,
      spread: false,
      items: [{ checked: null, text: 'foo\nbar', nested: null }],
    });

    const hb = blockFromEngineSpan('bullet-list', '- a  \n  b');
    expect(hb?.type.name).toBe('bullet_list');
    expect(hb?.child(0).child(0).childCount).toBe(3);
    expect(hb?.child(0).child(0).child(0).textContent).toBe('a');
    expect(hb?.child(0).child(0).child(1).type.name).toBe('hard_break');
    expect(hb?.child(0).child(0).child(2).textContent).toBe('b');
    expect(hb?.child(0).textContent).toBe('ab');

    const hbOrdered = blockFromEngineSpan('ordered-list', '1. one  \n   two\n2. three');
    expect(hbOrdered?.child(0).child(0).child(1).type.name).toBe('hard_break');
    expect(hbOrdered?.child(0).textContent).toBe('onetwo');
    expect(hbOrdered?.child(1).textContent).toBe('three');

    const hbTask = blockFromEngineSpan('task-list', '- [ ] todo  \n  more');
    expect(hbTask?.child(0).attrs.checked).toBe(false);
    expect(hbTask?.child(0).child(0).child(1).type.name).toBe('hard_break');
    expect(hbTask?.child(0).textContent).toBe('todomore');

    const hbNest = blockFromEngineSpan('bullet-list', '- outer  \n  wrap\n  - nested  \n    deep');
    expect(hbNest?.child(0).child(0).child(1).type.name).toBe('hard_break');
    expect(hbNest?.child(0).child(1).child(0).child(0).child(1).type.name).toBe('hard_break');
    expect(hbNest?.child(0).child(1).child(0).textContent).toBe('nesteddeep');

    // Lists-in-quotes inherit list hard-break ownership.
    const hbInQuote = blockFromEngineSpan('quote', '> - a  \n>   b');
    expect(hbInQuote?.child(0).type.name).toBe('bullet_list');
    expect(hbInQuote?.child(0).child(0).child(0).child(1).type.name).toBe('hard_break');

    const markedList = blockFromEngineSpan('bullet-list', '- **bold**');
    expect(markedList?.type.name).toBe('bullet_list');
    expect(markedList?.textContent).toBe('bold');
    expect(markedList?.child(0).child(0).child(0).marks.some((m) => m.type.name === 'strong')).toBe(true);
    expect(blockFromEngineSpan('bullet-list', '- [[wiki]]')?.textContent).toBe('[[wiki]]');
    expect(blockFromEngineSpan('bullet-list', '- a\n* b')).toBeNull();
    expect(blockFromEngineSpan('bullet-list', '- multi\n\n  para\n- next')).toBeNull();
    expect(blockFromEngineSpan('bullet-list', '- a  \n  **b**')?.textContent).toBe('ab');
  });

  it('builds nested lists at any depth including mixed-marker nests', () => {
    const nest = blockFromEngineSpan('bullet-list', '- outer one\n  - nested a\n  - nested b\n- outer two');
    expect(nest?.type.name).toBe('bullet_list');
    expect(nest?.childCount).toBe(2);
    expect(nest?.child(0).childCount).toBe(2);
    expect(nest?.child(0).child(0).type.name).toBe('paragraph');
    expect(nest?.child(0).child(0).textContent).toBe('outer one');
    expect(nest?.child(0).child(1).type.name).toBe('bullet_list');
    expect(nest?.child(0).child(1).childCount).toBe(2);
    expect(nest?.child(0).child(1).child(0).textContent).toBe('nested a');
    expect(nest?.child(0).child(1).child(1).textContent).toBe('nested b');
    expect(nest?.child(1).childCount).toBe(1);
    expect(nest?.child(1).textContent).toBe('outer two');

    const ordered = blockFromEngineSpan(
      'ordered-list',
      '1. ordered outer\n   1. nested ordered a\n   2. nested ordered b\n2. ordered outer two',
    );
    expect(ordered?.type.name).toBe('ordered_list');
    expect(ordered?.child(0).childCount).toBe(2);
    expect(ordered?.child(0).child(1).type.name).toBe('ordered_list');
    expect(ordered?.child(0).child(1).child(0).textContent).toBe('nested ordered a');
    expect(ordered?.child(1).textContent).toBe('ordered outer two');

    const looseNest = blockFromEngineSpan('bullet-list', '- a\n  - n1\n\n  - n2\n- b');
    expect(looseNest?.attrs.spread).toBe(false);
    expect(looseNest?.child(0).child(1).attrs.spread).toBe(true);

    const wrapThenNest = blockFromEngineSpan('bullet-list', '- a\n  continued\n  - nested');
    expect(wrapThenNest?.child(0).child(0).textContent).toBe('a\ncontinued');
    expect(wrapThenNest?.child(0).child(1).child(0).textContent).toBe('nested');

    const tasks = blockFromEngineSpan('task-list', '- [ ] task outer\n  - [ ] nested task');
    expect(tasks?.child(0).attrs.checked).toBe(false);
    expect(tasks?.child(0).child(1).child(0).attrs.checked).toBe(false);
    expect(tasks?.child(0).child(1).child(0).textContent).toBe('nested task');

    // Depth 2+ same-family (nested-lists.md deep three) is engine-owned.
    const deep = blockFromEngineSpan('bullet-list', '- a\n  - nested\n    - deep');
    expect(deep?.type.name).toBe('bullet_list');
    expect(deep?.child(0).child(1).child(0).child(1).type.name).toBe('bullet_list');
    expect(deep?.child(0).child(1).child(0).child(1).child(0).textContent).toBe('deep');

    const deepOuter = blockFromEngineSpan(
      'bullet-list',
      '- outer one\n  - nested a\n  - nested b\n    - deep three\n- outer two',
    );
    expect(deepOuter?.childCount).toBe(2);
    expect(deepOuter?.child(0).child(1).childCount).toBe(2);
    expect(deepOuter?.child(0).child(1).child(1).childCount).toBe(2);
    expect(deepOuter?.child(0).child(1).child(1).child(1).child(0).textContent).toBe('deep three');
    expect(deepOuter?.child(1).textContent).toBe('outer two');

    // Blank before shallower sibling spreads the outer list.
    const blankThenOuter = blockFromEngineSpan('bullet-list', '- a\n  - n1\n\n- b');
    expect(blankThenOuter?.attrs.spread).toBe(true);
    expect(blankThenOuter?.child(0).child(1).attrs.spread).toBe(false);

    // Mixed-marker nest (ordered under bullet) is engine-owned (Phase 16).
    const mixed = blockFromEngineSpan('bullet-list', '- a\n  1. ordered nest');
    expect(mixed?.type.name).toBe('bullet_list');
    expect(mixed?.child(0).child(1).type.name).toBe('ordered_list');
    expect(mixed?.child(0).child(1).child(0).textContent).toBe('ordered nest');

    const mixedOrdered = blockFromEngineSpan(
      'ordered-list',
      '1. outer\n   - nested a\n   - nested b\n2. outer two',
    );
    expect(mixedOrdered?.type.name).toBe('ordered_list');
    expect(mixedOrdered?.childCount).toBe(2);
    expect(mixedOrdered?.child(0).child(1).type.name).toBe('bullet_list');
    expect(mixedOrdered?.child(0).child(1).childCount).toBe(2);
    expect(mixedOrdered?.child(0).child(1).child(0).textContent).toBe('nested a');
    expect(mixedOrdered?.child(1).textContent).toBe('outer two');
  });

  it('builds simple footnote definitions incl. empty + hard breaks + simple marks; refuses heavy', () => {
    expect(parseSimpleFootnoteDefinitionSource('[^1]: plain note')).toEqual({
      identifier: '1', label: '1', text: 'plain note',
    });
    expect(parseSimpleFootnoteDefinitionSource('[^Long-Name]: Hello world')).toEqual({
      identifier: 'long-name', label: 'Long-Name', text: 'Hello world',
    });
    expect(parseSimpleFootnoteDefinitionSource('[^y]: line1\n  continued')).toEqual({
      identifier: 'y', label: 'y', text: 'line1\ncontinued',
    });
    expect(parseSimpleFootnoteDefinitionSource('[^c]:')).toEqual({
      identifier: 'c', label: 'c', text: '',
    });
    expect(parseSimpleFootnoteDefinitionSource('[^c]:  ')).toEqual({
      identifier: 'c', label: 'c', text: '',
    });
    expect(parseSimpleFootnoteDefinitionSource('[^h]: a  \n  b')).toEqual({
      identifier: 'h', label: 'h', text: 'a  \nb',
    });
    expect(parseSimpleFootnoteDefinitionSource('[^x]: has *emphasis*')).not.toBeNull();
    expect(parseSimpleFootnoteDefinitionSource('[^x]: has [[wiki]]')).not.toBeNull();

    const plain = blockFromEngineSpan('footnote-definition', '[^1]: plain note');
    expect(plain?.type.name).toBe('footnote_definition');
    expect(plain?.attrs).toEqual({ identifier: '1', label: '1' });
    expect(plain?.textContent).toBe('plain note');

    const wrap = blockFromEngineSpan('footnote-definition', '[^y]: line1\n  continued');
    expect(wrap?.textContent).toBe('line1\ncontinued');

    const empty = blockFromEngineSpan('footnote-definition', '[^c]:');
    expect(empty?.type.name).toBe('footnote_definition');
    expect(empty?.attrs).toEqual({ identifier: 'c', label: 'c' });
    expect(empty?.childCount).toBe(1);
    expect(empty?.child(0).type.name).toBe('paragraph');
    expect(empty?.textContent).toBe('');

    const hb = blockFromEngineSpan('footnote-definition', '[^h]: a  \n  b');
    expect(hb?.type.name).toBe('footnote_definition');
    expect(hb?.child(0).childCount).toBe(3);
    expect(hb?.child(0).child(0).textContent).toBe('a');
    expect(hb?.child(0).child(1).type.name).toBe('hard_break');
    expect(hb?.child(0).child(2).textContent).toBe('b');
    expect(hb?.textContent).toBe('ab');

    const markedFn = blockFromEngineSpan('footnote-definition', '[^x]: has *emphasis*');
    expect(markedFn?.textContent).toBe('has emphasis');
    expect(blockFromEngineSpan('footnote-definition', '[^x]: has [[wiki]]')?.textContent).toBe('has [[wiki]]');
    expect(blockFromEngineSpan('footnote-definition', '[^m]: a  \n  **b**')?.textContent).toBe('ab');
  });

  it('builds simple GFM tables incl. simple-marked + ragged body rows; refuses heavy / delimiter≠header', () => {
    const t = blockFromEngineSpan('table', '| Left | Right |\n| :--- | ---: |\n| alpha | 1 |\n| beta | 2 |');
    expect(t?.type.name).toBe('table');
    expect(t?.childCount).toBe(3);
    expect(t?.child(0).child(0).type.name).toBe('table_header');
    expect(t?.child(0).child(0).attrs.align).toBe('left');
    expect(t?.child(0).child(0).textContent).toBe('Left');
    expect(t?.child(0).child(1).attrs.align).toBe('right');
    expect(t?.child(1).child(0).type.name).toBe('table_cell');
    expect(t?.child(1).child(0).textContent).toBe('alpha');
    expect(t?.child(2).child(1).textContent).toBe('2');

    const empty = blockFromEngineSpan('table', '| x |\n| - |\n|  |');
    expect(empty?.childCount).toBe(2);
    expect(empty?.child(1).child(0).textContent).toBe('');

    const headerOnly = blockFromEngineSpan('table', '| H1 | H2 |\n| --- | --- |');
    expect(headerOnly?.childCount).toBe(1);

    const markedTable = blockFromEngineSpan('table', '| a |\n| - |\n| **x** |');
    expect(markedTable?.type.name).toBe('table');
    expect(markedTable?.textContent).toBe('ax');
    expect(blockFromEngineSpan('table', '| a |\n| - |\n| [[wiki]] |')?.textContent).toBe('a[[wiki]]');
    const escPipe = blockFromEngineSpan('table', '| a \\| b |\n| --- |\n| c \\| d |');
    expect(escPipe?.type.name).toBe('table');
    expect(escPipe?.child(0).child(0).textContent).toBe('a | b');
    expect(escPipe?.child(1).child(0).textContent).toBe('c | d');
    const escTwo = blockFromEngineSpan('table', '| Left \\| Mid | Right |\n| --- | --- |\n| a \\| b | 1 |');
    expect(escTwo?.child(0).child(0).textContent).toBe('Left | Mid');
    expect(escTwo?.child(0).child(1).textContent).toBe('Right');
    expect(escTwo?.child(1).child(0).textContent).toBe('a | b');
    const escMarked = blockFromEngineSpan('table', '| **bold \\| cell** | plain |\n| --- | --- |\n| x | y |');
    expect(escMarked?.type.name).toBe('table');
    expect(escMarked?.child(0).child(0).textContent).toBe('bold | cell');
    expect(escMarked!.child(0).child(0).child(0).marks.some((m) => m.type.name === 'strong')).toBe(true);
    // Delimiter ≠ header width is not a GFM table (micromark → paragraph; Phase 17
    // split keeps the span a paragraph). Forced table kind still refuses IR→PM.
    expect(blockFromEngineSpan('table', '| a | b |\n| - |\n| 1 | 2 |')).toBeNull();
    // Ragged body rows (short / long) match micromark/mdast cell counts as-is.
    const shortRow = blockFromEngineSpan('table', '| a | b |\n| - | - |\n| 1 |');
    expect(shortRow?.type.name).toBe('table');
    expect(shortRow?.childCount).toBe(2);
    expect(shortRow?.child(0).childCount).toBe(2);
    expect(shortRow?.child(1).childCount).toBe(1);
    expect(shortRow?.child(1).child(0).textContent).toBe('1');
    const longRow = blockFromEngineSpan('table', '| a | b |\n| - | - |\n| 1 | 2 | 3 |');
    expect(longRow?.child(0).childCount).toBe(2);
    expect(longRow?.child(1).childCount).toBe(3);
    expect(longRow?.child(1).child(2).textContent).toBe('3');
    expect(longRow?.child(1).child(2).attrs.align).toBeNull();
    const raggedAlign = blockFromEngineSpan(
      'table',
      '| a | b |\n| :--- | ---: |\n| short |\n| 1 | 2 | 3 | Extra |',
    );
    expect(raggedAlign?.childCount).toBe(3);
    expect(raggedAlign?.child(1).childCount).toBe(1);
    expect(raggedAlign?.child(1).child(0).attrs.align).toBe('left');
    expect(raggedAlign?.child(2).childCount).toBe(4);
    expect(raggedAlign?.child(2).child(0).attrs.align).toBe('left');
    expect(raggedAlign?.child(2).child(1).attrs.align).toBe('right');
    expect(raggedAlign?.child(2).child(2).attrs.align).toBeNull();
    expect(raggedAlign?.child(2).child(3).textContent).toBe('Extra');
    const raggedMarked = blockFromEngineSpan('table', '| a | b |\n| - | - |\n| **x** |');
    expect(raggedMarked?.child(1).childCount).toBe(1);
    expect(raggedMarked?.child(1).child(0).textContent).toBe('x');
    expect(raggedMarked!.child(1).child(0).child(0).marks.some((m) => m.type.name === 'strong')).toBe(true);
  });

  it('builds plain and simple-marked paragraph / heading; refuses heavy inline', () => {
    const p = blockFromEngineSpan('paragraph', 'Hello world');
    expect(p?.type.name).toBe('paragraph');
    expect(p?.textContent).toBe('Hello world');
    const marked = blockFromEngineSpan('paragraph', 'Hello **bold** and *em* plus ~~del~~ and `code`');
    expect(marked?.type.name).toBe('paragraph');
    expect(marked?.textContent).toBe('Hello bold and em plus del and code');
    const strong = marked!.child(1);
    expect(strong.isText).toBe(true);
    expect(strong.text).toBe('bold');
    expect(strong.marks.some((m) => m.type.name === 'strong')).toBe(true);
    expect(blockFromEngineSpan('paragraph', 'Hello [[wiki]]')?.textContent).toBe('Hello [[wiki]]');
    const us = blockFromEngineSpan('paragraph', 'Hello __underscore__ and _em_');
    expect(us?.textContent).toBe('Hello underscore and em');
    expect(us!.child(1).marks.some((m) => m.type.name === 'strong')).toBe(true);
    expect(us!.child(3).marks.some((m) => m.type.name === 'emphasis')).toBe(true);
    const snake = blockFromEngineSpan('paragraph', 'uses snake_case and mcp__claude_api');
    expect(snake?.type.name).toBe('paragraph');
    expect(snake?.textContent).toBe('uses snake_case and mcp__claude_api');
    expect(snake?.childCount).toBe(1);
    const nest = blockFromEngineSpan('paragraph', '**bold _nested_**');
    expect(nest?.type.name).toBe('paragraph');
    expect(nest?.textContent).toBe('bold nested');
    const nestedEm = [...Array(nest!.childCount)].map((_, i) => nest!.child(i)).find((n) => n.text === 'nested');
    expect(nestedEm!.marks.map((m) => m.type.name).sort()).toEqual(['emphasis', 'strong']);
    const emStrong = blockFromEngineSpan('paragraph', '*em **strong** em*');
    expect(emStrong?.textContent).toBe('em strong em');
    const strongBit = [...Array(emStrong!.childCount)].map((_, i) => emStrong!.child(i)).find((n) => n.text === 'strong');
    expect(strongBit!.marks.map((m) => m.type.name).sort()).toEqual(['emphasis', 'strong']);
    // Two-level nests (MAX_MARK_NEST ≥ 2).
    const two = blockFromEngineSpan('paragraph', '**bold *em ~~strike~~ more* bold**');
    expect(two?.textContent).toBe('bold em strike more bold');
    const strikeBit = [...Array(two!.childCount)].map((_, i) => two!.child(i)).find((n) => n.text === 'strike');
    expect(strikeBit!.marks.map((m) => m.type.name).sort()).toEqual(['emphasis', 'strikethrough', 'strong']);
    const twoB = blockFromEngineSpan('paragraph', '*em **bold _nested_** more*');
    expect(twoB?.textContent).toBe('em bold nested more');
    const nestedBit = [...Array(twoB!.childCount)].map((_, i) => twoB!.child(i)).find((n) => n.text === 'nested');
    // Outer `*` and inner `_` both contribute emphasis (micromark parity).
    expect(nestedBit!.marks.map((m) => m.type.name).sort()).toEqual(['emphasis', 'emphasis', 'strong']);
    expect(canSkipDialectEnrich('paragraph', '**a *b `code` c* d**')).toBe(true);
    expect(blockFromEngineSpan('paragraph', '**a *b `code` c* d**')?.textContent).toBe('a b code c d');
    // Three-level nests (MAX_MARK_NEST ≥ 3).
    const three = blockFromEngineSpan('paragraph', '**a *b ~~c _d_ c~~ b* a**');
    expect(three?.textContent).toBe('a b c d c b a');
    const dBit = [...Array(three!.childCount)].map((_, i) => three!.child(i)).find((n) => n.text === 'd');
    expect(dBit!.marks.map((m) => m.type.name).sort()).toEqual([
      'emphasis',
      'emphasis',
      'strikethrough',
      'strong',
    ]);
    const threeB = blockFromEngineSpan('paragraph', '~~del **bold *em* rest** del~~');
    expect(threeB?.textContent).toBe('del bold em rest del');
    const emBit = [...Array(threeB!.childCount)].map((_, i) => threeB!.child(i)).find((n) => n.text === 'em');
    expect(emBit!.marks.map((m) => m.type.name).sort()).toEqual(['emphasis', 'strikethrough', 'strong']);
    expect(canSkipDialectEnrich('paragraph', '**a *b ~~c _d_ c~~ b* a**')).toBe(true);
    // Four-level nests (MAX_MARK_NEST ≥ 4).
    const four = blockFromEngineSpan('paragraph', '**a *b ~~c _d `e` d_ c~~ b* a**');
    expect(four?.textContent).toBe('a b c d e d c b a');
    const eBit = [...Array(four!.childCount)].map((_, i) => four!.child(i)).find((n) => n.text === 'e');
    expect(eBit!.marks.map((m) => m.type.name).sort()).toEqual([
      'emphasis',
      'emphasis',
      'inline_code',
      'strikethrough',
      'strong',
    ]);
    const fourB = blockFromEngineSpan('paragraph', '*em **bold ~~del _x `y` x_~~ more** rest*');
    expect(fourB?.textContent).toBe('em bold del x y x more rest');
    const yBit = [...Array(fourB!.childCount)].map((_, i) => fourB!.child(i)).find((n) => n.text === 'y');
    expect(yBit!.marks.map((m) => m.type.name).sort()).toEqual([
      'emphasis',
      'emphasis',
      'inline_code',
      'strikethrough',
      'strong',
    ]);
    expect(canSkipDialectEnrich('paragraph', '**a *b ~~c _d `e` d_ c~~ b* a**')).toBe(true);
    // Five-level nests (MAX_MARK_NEST ≥ 5).
    const five = blockFromEngineSpan('paragraph', '**v *w ~~x _y *z `a` z* y_ x~~ w* v**');
    expect(five?.textContent).toBe('v w x y z a z y x w v');
    const aBit = [...Array(five!.childCount)].map((_, i) => five!.child(i)).find((n) => n.text === 'a');
    expect(aBit!.marks.map((m) => m.type.name).sort()).toEqual([
      'emphasis',
      'emphasis',
      'emphasis',
      'inline_code',
      'strikethrough',
      'strong',
    ]);
    const fiveB = blockFromEngineSpan('paragraph', '*em **bold ~~del _x *y `z` y* x_~~ more** rest*');
    expect(fiveB?.textContent).toBe('em bold del x y z y x more rest');
    const zBit = [...Array(fiveB!.childCount)].map((_, i) => fiveB!.child(i)).find((n) => n.text === 'z');
    expect(zBit!.marks.map((m) => m.type.name).sort()).toEqual([
      'emphasis',
      'emphasis',
      'emphasis',
      'inline_code',
      'strikethrough',
      'strong',
    ]);
    expect(canSkipDialectEnrich('paragraph', '**v *w ~~x _y *z `a` z* y_ x~~ w* v**')).toBe(true);
    // Six-level nests (MAX_MARK_NEST ≥ 6).
    const six = blockFromEngineSpan('paragraph', '**u *v ~~w _x *y _z `a` z_ y* x_ w~~ v* u**');
    expect(six?.textContent).toBe('u v w x y z a z y x w v u');
    const sixA = [...Array(six!.childCount)].map((_, i) => six!.child(i)).find((n) => n.text === 'a');
    expect(sixA!.marks.map((m) => m.type.name).sort()).toEqual([
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'inline_code',
      'strikethrough',
      'strong',
    ]);
    const sixB = blockFromEngineSpan('paragraph', '*em **bold ~~del _x *y _z `a` z_ y* x_~~ more** rest*');
    expect(sixB?.textContent).toBe('em bold del x y z a z y x more rest');
    const sixBA = [...Array(sixB!.childCount)].map((_, i) => sixB!.child(i)).find((n) => n.text === 'a');
    expect(sixBA!.marks.map((m) => m.type.name).sort()).toEqual([
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'inline_code',
      'strikethrough',
      'strong',
    ]);
    expect(canSkipDialectEnrich('paragraph', '**u *v ~~w _x *y _z `a` z_ y* x_ w~~ v* u**')).toBe(true);
    // Seven-level nests (MAX_MARK_NEST ≥ 7).
    const seven = blockFromEngineSpan('paragraph', '**t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t**');
    expect(seven?.textContent).toBe('t u v w x y z a z y x w v u t');
    const sevenA = [...Array(seven!.childCount)].map((_, i) => seven!.child(i)).find((n) => n.text === 'a');
    expect(sevenA!.marks.map((m) => m.type.name).sort()).toEqual([
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'inline_code',
      'strikethrough',
      'strong',
    ]);
    const sevenB = blockFromEngineSpan('paragraph', '*em **bold ~~del _x *y _z *w `a` w* z_ y* x_~~ more** rest*');
    expect(sevenB?.textContent).toBe('em bold del x y z w a w z y x more rest');
    const sevenBA = [...Array(sevenB!.childCount)].map((_, i) => sevenB!.child(i)).find((n) => n.text === 'a');
    expect(sevenBA!.marks.map((m) => m.type.name).sort()).toEqual([
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'inline_code',
      'strikethrough',
      'strong',
    ]);
    expect(canSkipDialectEnrich('paragraph', '**t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t**')).toBe(true);
    // Eight-level nests (MAX_MARK_NEST = 8).
    const eight = blockFromEngineSpan('paragraph', '**s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s**');
    expect(eight?.textContent).toBe('s t u v w x y z a z y x w v u t s');
    const eightA = [...Array(eight!.childCount)].map((_, i) => eight!.child(i)).find((n) => n.text === 'a');
    expect(eightA!.marks.map((m) => m.type.name).sort()).toEqual([
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'inline_code',
      'strikethrough',
      'strong',
    ]);
    const eightB = blockFromEngineSpan('paragraph', '*em **bold ~~del _x *y _z *w _v `a` v_ w* z_ y* x_~~ more** rest*');
    expect(eightB?.textContent).toBe('em bold del x y z w v a v w z y x more rest');
    const eightBA = [...Array(eightB!.childCount)].map((_, i) => eightB!.child(i)).find((n) => n.text === 'a');
    expect(eightBA!.marks.map((m) => m.type.name).sort()).toEqual([
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'inline_code',
      'strikethrough',
      'strong',
    ]);
    expect(canSkipDialectEnrich('paragraph', '**s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s**')).toBe(true);
    // Nine-level nests (MAX_MARK_NEST ≥ 9).
    const nine = blockFromEngineSpan('paragraph', '*r **s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s** r*');
    expect(nine?.textContent).toBe('r s t u v w x y z a z y x w v u t s r');
    const nineA = [...Array(nine!.childCount)].map((_, i) => nine!.child(i)).find((n) => n.text === 'a');
    expect(nineA!.marks.map((m) => m.type.name).sort()).toEqual([
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'inline_code',
      'strikethrough',
      'strong',
    ]);
    const nineB = blockFromEngineSpan('paragraph', '**em *bold ~~del _x *y _z *w _v *u `a` u* v_ w* z_ y* x_~~ more* rest**');
    expect(nineB?.textContent).toBe('em bold del x y z w v u a u v w z y x more rest');
    const nineBA = [...Array(nineB!.childCount)].map((_, i) => nineB!.child(i)).find((n) => n.text === 'a');
    expect(nineBA!.marks.map((m) => m.type.name).sort()).toEqual([
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'inline_code',
      'strikethrough',
      'strong',
    ]);
    expect(canSkipDialectEnrich('paragraph', '*r **s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s** r*')).toBe(true);
    // Ten-level nests (MAX_MARK_NEST ≥ 10).
    const ten = blockFromEngineSpan('paragraph', '_q *r **s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s** r* q_');
    expect(ten?.textContent).toBe('q r s t u v w x y z a z y x w v u t s r q');
    const tenA = [...Array(ten!.childCount)].map((_, i) => ten!.child(i)).find((n) => n.text === 'a');
    expect(tenA!.marks.map((m) => m.type.name).sort()).toEqual([
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'inline_code',
      'strikethrough',
      'strong',
    ]);
    const tenB = blockFromEngineSpan('paragraph', '*em **bold ~~del _x *y _z *w _v *u _t `a` t_ u* v_ w* z_ y* x_~~ more** rest*');
    expect(tenB?.textContent).toBe('em bold del x y z w v u t a t u v w z y x more rest');
    const tenBA = [...Array(tenB!.childCount)].map((_, i) => tenB!.child(i)).find((n) => n.text === 'a');
    expect(tenBA!.marks.map((m) => m.type.name).sort()).toEqual([
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'inline_code',
      'strikethrough',
      'strong',
    ]);
    expect(canSkipDialectEnrich('paragraph', '_q *r **s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s** r* q_')).toBe(true);
    // Eleven-level nests (MAX_MARK_NEST ≥ 11).
    const eleven = blockFromEngineSpan('paragraph', '**p _q *r **s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s** r* q_ p**');
    expect(eleven?.textContent).toBe('p q r s t u v w x y z a z y x w v u t s r q p');
    const elevenA = [...Array(eleven!.childCount)].map((_, i) => eleven!.child(i)).find((n) => n.text === 'a');
    expect(elevenA!.marks.map((m) => m.type.name).sort()).toEqual([
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'inline_code',
      'strikethrough',
      'strong',
      'strong',
    ]);
    const elevenB = blockFromEngineSpan('paragraph', '_p *em **bold ~~del _x *y _z *w _v *u _t `a` t_ u* v_ w* z_ y* x_~~ more** rest* p_');
    expect(elevenB?.textContent).toBe('p em bold del x y z w v u t a t u v w z y x more rest p');
    const elevenBA = [...Array(elevenB!.childCount)].map((_, i) => elevenB!.child(i)).find((n) => n.text === 'a');
    expect(elevenBA!.marks.map((m) => m.type.name).sort()).toEqual([
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'inline_code',
      'strikethrough',
      'strong',
    ]);
    expect(canSkipDialectEnrich('paragraph', '**p _q *r **s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s** r* q_ p**')).toBe(true);
    // Twelve-level nests (MAX_MARK_NEST = 12).
    const twelve = blockFromEngineSpan('paragraph', '*o **p _q *r **s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s** r* q_ p** o*');
    expect(twelve?.textContent).toBe('o p q r s t u v w x y z a z y x w v u t s r q p o');
    const twelveA = [...Array(twelve!.childCount)].map((_, i) => twelve!.child(i)).find((n) => n.text === 'a');
    expect(twelveA!.marks.map((m) => m.type.name).sort()).toEqual([
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'inline_code',
      'strikethrough',
      'strong',
      'strong',
    ]);
    const twelveB = blockFromEngineSpan('paragraph', '**o _p *em **bold ~~del _x *y _z *w _v *u _t `a` t_ u* v_ w* z_ y* x_~~ more** rest* p_ o**');
    expect(twelveB?.textContent).toBe('o p em bold del x y z w v u t a t u v w z y x more rest p o');
    const twelveBA = [...Array(twelveB!.childCount)].map((_, i) => twelveB!.child(i)).find((n) => n.text === 'a');
    expect(twelveBA!.marks.map((m) => m.type.name).sort()).toEqual([
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'inline_code',
      'strikethrough',
      'strong',
      'strong',
    ]);
    expect(canSkipDialectEnrich('paragraph', '*o **p _q *r **s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s** r* q_ p** o*')).toBe(true);
    // Thirteen-level nests (MAX_MARK_NEST = 13).
    const thirteen = blockFromEngineSpan('paragraph', '_n *o **p _q *r **s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s** r* q_ p** o* n_');
    expect(thirteen?.textContent).toBe('n o p q r s t u v w x y z a z y x w v u t s r q p o n');
    const thirteenA = [...Array(thirteen!.childCount)].map((_, i) => thirteen!.child(i)).find((n) => n.text === 'a');
    expect(thirteenA!.marks.map((m) => m.type.name).sort()).toEqual([
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'inline_code',
      'strikethrough',
      'strong',
      'strong',
    ]);
    const thirteenB = blockFromEngineSpan('paragraph', '*n **o _p *em **bold ~~del _x *y _z *w _v *u _t `a` t_ u* v_ w* z_ y* x_~~ more** rest* p_ o** n*');
    expect(thirteenB?.textContent).toBe('n o p em bold del x y z w v u t a t u v w z y x more rest p o n');
    const thirteenBA = [...Array(thirteenB!.childCount)].map((_, i) => thirteenB!.child(i)).find((n) => n.text === 'a');
    expect(thirteenBA!.marks.map((m) => m.type.name).sort()).toEqual([
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'inline_code',
      'strikethrough',
      'strong',
      'strong',
    ]);
    expect(canSkipDialectEnrich('paragraph', '_n *o **p _q *r **s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s** r* q_ p** o* n_')).toBe(true);
    // Fourteen-level nests (MAX_MARK_NEST = 14).
    const fourteen = blockFromEngineSpan('paragraph', '**m _n *o **p _q *r **s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s** r* q_ p** o* n_ m**');
    expect(fourteen?.textContent).toBe('m n o p q r s t u v w x y z a z y x w v u t s r q p o n m');
    const fourteenA = [...Array(fourteen!.childCount)].map((_, i) => fourteen!.child(i)).find((n) => n.text === 'a');
    expect(fourteenA!.marks.map((m) => m.type.name).sort()).toEqual([
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'inline_code',
      'strikethrough',
      'strong',
      'strong',
      'strong',
    ]);
    const fourteenB = blockFromEngineSpan('paragraph', '_m *n **o _p *em **bold ~~del _x *y _z *w _v *u _t `a` t_ u* v_ w* z_ y* x_~~ more** rest* p_ o** n* m_');
    expect(fourteenB?.textContent).toBe('m n o p em bold del x y z w v u t a t u v w z y x more rest p o n m');
    const fourteenBA = [...Array(fourteenB!.childCount)].map((_, i) => fourteenB!.child(i)).find((n) => n.text === 'a');
    expect(fourteenBA!.marks.map((m) => m.type.name).sort()).toEqual([
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'inline_code',
      'strikethrough',
      'strong',
      'strong',
    ]);
    expect(canSkipDialectEnrich('paragraph', '**m _n *o **p _q *r **s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s** r* q_ p** o* n_ m**')).toBe(true);
    // Fifteen-level nests (MAX_MARK_NEST = 15).
    const fifteen = blockFromEngineSpan('paragraph', '*l **m _n *o **p _q *r **s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s** r* q_ p** o* n_ m** l*');
    expect(fifteen?.textContent).toBe('l m n o p q r s t u v w x y z a z y x w v u t s r q p o n m l');
    const fifteenA = [...Array(fifteen!.childCount)].map((_, i) => fifteen!.child(i)).find((n) => n.text === 'a');
    expect(fifteenA!.marks.map((m) => m.type.name).sort()).toEqual([
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'inline_code',
      'strikethrough',
      'strong',
      'strong',
      'strong',
    ]);
    const fifteenB = blockFromEngineSpan('paragraph', '**l _m *n **o _p *em **bold ~~del _x *y _z *w _v *u _t `a` t_ u* v_ w* z_ y* x_~~ more** rest* p_ o** n* m_ l**');
    expect(fifteenB?.textContent).toBe('l m n o p em bold del x y z w v u t a t u v w z y x more rest p o n m l');
    const fifteenBA = [...Array(fifteenB!.childCount)].map((_, i) => fifteenB!.child(i)).find((n) => n.text === 'a');
    expect(fifteenBA!.marks.map((m) => m.type.name).sort()).toEqual([
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'inline_code',
      'strikethrough',
      'strong',
      'strong',
      'strong',
    ]);
    expect(canSkipDialectEnrich('paragraph', '*l **m _n *o **p _q *r **s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s** r* q_ p** o* n_ m** l*')).toBe(true);
    // Sixteen-level nests (MAX_MARK_NEST = 16).
    const sixteen = blockFromEngineSpan('paragraph', '_k *l **m _n *o **p _q *r **s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s** r* q_ p** o* n_ m** l* k_');
    expect(sixteen?.textContent).toBe('k l m n o p q r s t u v w x y z a z y x w v u t s r q p o n m l k');
    const sixteenA = [...Array(sixteen!.childCount)].map((_, i) => sixteen!.child(i)).find((n) => n.text === 'a');
    expect(sixteenA!.marks.map((m) => m.type.name).sort()).toEqual([
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'inline_code',
      'strikethrough',
      'strong',
      'strong',
      'strong',
    ]);
    const sixteenB = blockFromEngineSpan('paragraph', '*k **l _m *n **o _p *em **bold ~~del _x *y _z *w _v *u _t `a` t_ u* v_ w* z_ y* x_~~ more** rest* p_ o** n* m_ l** k*');
    expect(sixteenB?.textContent).toBe('k l m n o p em bold del x y z w v u t a t u v w z y x more rest p o n m l k');
    const sixteenBA = [...Array(sixteenB!.childCount)].map((_, i) => sixteenB!.child(i)).find((n) => n.text === 'a');
    expect(sixteenBA!.marks.map((m) => m.type.name).sort()).toEqual([
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'inline_code',
      'strikethrough',
      'strong',
      'strong',
      'strong',
    ]);
    expect(canSkipDialectEnrich('paragraph', '_k *l **m _n *o **p _q *r **s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s** r* q_ p** o* n_ m** l* k_')).toBe(true);
    // Seventeen-level nests (MAX_MARK_NEST = 17).
    const seventeen = blockFromEngineSpan('paragraph', '**j _k *l **m _n *o **p _q *r **s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s** r* q_ p** o* n_ m** l* k_ j**');
    expect(seventeen?.textContent).toBe('j k l m n o p q r s t u v w x y z a z y x w v u t s r q p o n m l k j');
    const seventeenA = [...Array(seventeen!.childCount)].map((_, i) => seventeen!.child(i)).find((n) => n.text === 'a');
    expect(seventeenA!.marks.map((m) => m.type.name).sort()).toEqual([
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'inline_code',
      'strikethrough',
      'strong',
      'strong',
      'strong',
      'strong',
    ]);
    const seventeenB = blockFromEngineSpan('paragraph', '_j *k **l _m *n **o _p *em **bold ~~del _x *y _z *w _v *u _t `a` t_ u* v_ w* z_ y* x_~~ more** rest* p_ o** n* m_ l** k* j_');
    expect(seventeenB?.textContent).toBe('j k l m n o p em bold del x y z w v u t a t u v w z y x more rest p o n m l k j');
    const seventeenBA = [...Array(seventeenB!.childCount)].map((_, i) => seventeenB!.child(i)).find((n) => n.text === 'a');
    expect(seventeenBA!.marks.map((m) => m.type.name).sort()).toEqual([
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'inline_code',
      'strikethrough',
      'strong',
      'strong',
      'strong',
    ]);
    expect(canSkipDialectEnrich('paragraph', '**j _k *l **m _n *o **p _q *r **s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s** r* q_ p** o* n_ m** l* k_ j**')).toBe(true);
    // Eighteen-level nests (MAX_MARK_NEST = 18).
    const eighteen = blockFromEngineSpan('paragraph', '*i **j _k *l **m _n *o **p _q *r **s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s** r* q_ p** o* n_ m** l* k_ j** i*');
    expect(eighteen?.textContent).toBe('i j k l m n o p q r s t u v w x y z a z y x w v u t s r q p o n m l k j i');
    const eighteenA = [...Array(eighteen!.childCount)].map((_, i) => eighteen!.child(i)).find((n) => n.text === 'a');
    expect(eighteenA!.marks.map((m) => m.type.name).sort()).toEqual([
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'inline_code',
      'strikethrough',
      'strong',
      'strong',
      'strong',
      'strong',
    ]);
    const eighteenB = blockFromEngineSpan('paragraph', '**i _j *k **l _m *n **o _p *em **bold ~~del _x *y _z *w _v *u _t `a` t_ u* v_ w* z_ y* x_~~ more** rest* p_ o** n* m_ l** k* j_ i**');
    expect(eighteenB?.textContent).toBe('i j k l m n o p em bold del x y z w v u t a t u v w z y x more rest p o n m l k j i');
    const eighteenBA = [...Array(eighteenB!.childCount)].map((_, i) => eighteenB!.child(i)).find((n) => n.text === 'a');
    expect(eighteenBA!.marks.map((m) => m.type.name).sort()).toEqual([
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'inline_code',
      'strikethrough',
      'strong',
      'strong',
      'strong',
      'strong',
    ]);
    expect(canSkipDialectEnrich('paragraph', '*i **j _k *l **m _n *o **p _q *r **s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s** r* q_ p** o* n_ m** l* k_ j** i*')).toBe(true);
    // Nineteen-level nests (MAX_MARK_NEST = 19).
    const nineteen = blockFromEngineSpan('paragraph', '_h *i **j _k *l **m _n *o **p _q *r **s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s** r* q_ p** o* n_ m** l* k_ j** i* h_');
    expect(nineteen?.textContent).toBe('h i j k l m n o p q r s t u v w x y z a z y x w v u t s r q p o n m l k j i h');
    const nineteenA = [...Array(nineteen!.childCount)].map((_, i) => nineteen!.child(i)).find((n) => n.text === 'a');
    expect(nineteenA!.marks.map((m) => m.type.name).sort()).toEqual([
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'inline_code',
      'strikethrough',
      'strong',
      'strong',
      'strong',
      'strong',
    ]);
    const nineteenB = blockFromEngineSpan('paragraph', '_h **i _j *k **l _m *n **o _p *em **bold ~~del _x *y _z *w _v *u _t `a` t_ u* v_ w* z_ y* x_~~ more** rest* p_ o** n* m_ l** k* j_ i** h_');
    expect(nineteenB?.textContent).toBe('h i j k l m n o p em bold del x y z w v u t a t u v w z y x more rest p o n m l k j i h');
    const nineteenBA = [...Array(nineteenB!.childCount)].map((_, i) => nineteenB!.child(i)).find((n) => n.text === 'a');
    expect(nineteenBA!.marks.map((m) => m.type.name).sort()).toEqual([
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'emphasis',
      'inline_code',
      'strikethrough',
      'strong',
      'strong',
      'strong',
      'strong',
    ]);
    expect(canSkipDialectEnrich('paragraph', '_h *i **j _k *l **m _n *o **p _q *r **s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s** r* q_ p** o* n_ m** l* k_ j** i* h_')).toBe(true);
    // Twenty-level + ambiguous / same-delimiter stay dialect.
    expect(blockFromEngineSpan('paragraph', '**g _h *i **j _k *l **m _n *o **p _q *r **s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s** r* q_ p** o* n_ m** l* k_ j** i* h_ g**')).toBeNull();
    expect(blockFromEngineSpan('paragraph', '**t *u ~~v _w *x ~~y _z `a` z_ y~~ x* w_ v~~ u* t**')).toBeNull();
    expect(blockFromEngineSpan('paragraph', '**bold `code`**')?.textContent).toBe('bold code');
    expect(blockFromEngineSpan('paragraph', '***triple***')).toBeNull();
    expect(blockFromEngineSpan('paragraph', '**a **b** c**')).toBeNull();
    expect(blockFromEngineSpan('paragraph', '*a *b* c*')).toBeNull();
    expect(tryInlineNodesFromSource('2 * 3 * 4')?.map((n) => n.textContent ?? n.type.name).join('')).toBe('2 * 3 * 4');

    const link = blockFromEngineSpan('paragraph', 'See [docs](https://example.com/path) please');
    expect(link?.type.name).toBe('paragraph');
    expect(link?.textContent).toBe('See docs please');
    const linkBit = [...Array(link!.childCount)].map((_, i) => link!.child(i)).find((n) => n.text === 'docs');
    expect(linkBit!.marks.some((m) => m.type.name === 'link' && m.attrs.href === 'https://example.com/path')).toBe(true);
    const titled = blockFromEngineSpan('paragraph', '[x](https://example.com "Title")');
    expect(titled?.textContent).toBe('x');
    const titledBit = titled!.child(0);
    expect(titledBit.marks.find((m) => m.type.name === 'link')!.attrs.title).toBe('Title');
    const markedLink = blockFromEngineSpan('paragraph', 'Go [**bold**](https://example.com)');
    expect(markedLink?.textContent).toBe('Go bold');
    const boldLink = [...Array(markedLink!.childCount)].map((_, i) => markedLink!.child(i)).find((n) => n.text === 'bold');
    expect(boldLink!.marks.map((m) => m.type.name).sort()).toEqual(['link', 'strong']);
    const img = blockFromEngineSpan('paragraph', 'Pic ![alt](./a.png) here');
    expect(img?.childCount).toBe(3);
    expect(img?.child(1).type.name).toBe('image');
    expect(img?.child(1).attrs).toMatchObject({ src: './a.png', alt: 'alt', title: null });
    expect(blockFromEngineSpan('paragraph', 'array[0] and [bare]')).toBeTruthy();
    expect(blockFromEngineSpan('paragraph', 'array[0]')?.textContent).toBe('array[0]');
    const wiki = blockFromEngineSpan('paragraph', 'Hello [[wiki]]');
    expect(wiki?.type.name).toBe('paragraph');
    expect(wiki?.textContent).toBe('Hello [[wiki]]');
    const aliased = blockFromEngineSpan('paragraph', 'See [[Note Name|alias]] nearby');
    expect(aliased?.textContent).toBe('See [[Note Name|alias]] nearby');
    const markedWiki = blockFromEngineSpan('paragraph', 'Go **[[Home]]** now');
    expect(markedWiki?.textContent).toBe('Go [[Home]] now');
    const wikiStrong = [...Array(markedWiki!.childCount)].map((_, i) => markedWiki!.child(i)).find((n) => n.text === '[[Home]]');
    expect(wikiStrong!.marks.some((m) => m.type.name === 'strong')).toBe(true);
    expect(blockFromEngineSpan('paragraph', '[[a] [b]]')).toBeNull();
    const fullRef = blockFromEngineSpan('paragraph', 'See [ref link][Alpha] nearby');
    expect(fullRef?.textContent).toBe('See ref link nearby');
    const fullBit = [...Array(fullRef!.childCount)].map((_, i) => fullRef!.child(i)).find((n) => n.text === 'ref link');
    expect(fullBit!.marks.find((m) => m.type.name === 'link')!.attrs).toMatchObject({
      href: '',
      title: null,
      referenceType: 'full',
      identifier: 'alpha',
      label: 'Alpha',
    });
    const collapsed = blockFromEngineSpan('paragraph', '[shortcut][]');
    expect(collapsed?.textContent).toBe('shortcut');
    expect(collapsed!.child(0).marks.find((m) => m.type.name === 'link')!.attrs).toMatchObject({
      href: '',
      referenceType: 'collapsed',
      identifier: 'shortcut',
      label: 'shortcut',
    });
    const markedRef = blockFromEngineSpan('paragraph', 'Go [**bold**][id] now');
    expect(markedRef?.textContent).toBe('Go bold now');
    const boldRef = [...Array(markedRef!.childCount)].map((_, i) => markedRef!.child(i)).find((n) => n.text === 'bold');
    expect(boldRef!.marks.map((m) => m.type.name).sort()).toEqual(['link', 'strong']);
    expect(boldRef!.marks.find((m) => m.type.name === 'link')!.attrs).toMatchObject({
      referenceType: 'full',
      identifier: 'id',
      label: 'id',
    });
    const refImg = blockFromEngineSpan('paragraph', 'Pic ![alt][logo] here');
    expect(refImg?.child(1).type.name).toBe('image');
    expect(refImg?.child(1).attrs).toMatchObject({
      src: '',
      alt: 'alt',
      title: null,
      referenceType: 'full',
      identifier: 'logo',
      label: 'logo',
    });
    const collapsedImg = blockFromEngineSpan('paragraph', '![banner][]');
    expect(collapsedImg?.child(0).attrs).toMatchObject({
      src: '',
      alt: 'banner',
      referenceType: 'collapsed',
      identifier: 'banner',
      label: 'banner',
    });
    const bare = blockFromEngineSpan('paragraph', 'bare https://example.com');
    expect(bare?.textContent).toBe('bare https://example.com');
    const bareBit = [...Array(bare!.childCount)].map((_, i) => bare!.child(i)).find((n) => n.text === 'https://example.com');
    expect(bareBit!.marks.find((m) => m.type.name === 'link')!.attrs).toMatchObject({
      href: 'https://example.com',
      title: null,
      referenceType: null,
    });
    const bareTrail = blockFromEngineSpan('paragraph', 'end https://example.com.');
    expect(bareTrail?.textContent).toBe('end https://example.com.');
    expect([...Array(bareTrail!.childCount)].map((_, i) => bareTrail!.child(i)).find((n) => n.text === 'https://example.com')!
      .marks.find((m) => m.type.name === 'link')!.attrs.href).toBe('https://example.com');
    expect([...Array(bareTrail!.childCount)].map((_, i) => bareTrail!.child(i)).some((n) => n.text === '.')).toBe(true);
    const bareMarked = blockFromEngineSpan('paragraph', 'Go **https://example.com** now');
    expect(bareMarked?.textContent).toBe('Go https://example.com now');
    const bareStrong = [...Array(bareMarked!.childCount)].map((_, i) => bareMarked!.child(i)).find((n) => n.text === 'https://example.com');
    expect(bareStrong!.marks.map((m) => m.type.name).sort()).toEqual(['link', 'strong']);
    expect(blockFromEngineSpan('paragraph', 'ahttps://example.com')?.textContent).toBe('ahttps://example.com');
    expect(blockFromEngineSpan('paragraph', 'ahttps://example.com')!.child(0).marks).toHaveLength(0);
    expect(blockFromEngineSpan('paragraph', 'https://')?.textContent).toBe('https://');
    const angled = blockFromEngineSpan('paragraph', 'see <https://example.com>');
    expect(angled?.textContent).toBe('see https://example.com');
    const angledBit = [...Array(angled!.childCount)].map((_, i) => angled!.child(i)).find((n) => n.text === 'https://example.com');
    expect(angledBit!.marks.find((m) => m.type.name === 'link')!.attrs).toMatchObject({
      href: 'https://example.com',
      title: null,
      referenceType: null,
    });
    const angledMarked = blockFromEngineSpan('paragraph', 'Go **<https://example.com>** now');
    expect(angledMarked?.textContent).toBe('Go https://example.com now');
    const angledStrong = [...Array(angledMarked!.childCount)].map((_, i) => angledMarked!.child(i)).find((n) => n.text === 'https://example.com');
    expect(angledStrong!.marks.map((m) => m.type.name).sort()).toEqual(['link', 'strong']);
    expect(blockFromEngineSpan('paragraph', '<https://>')).toBeNull();
    const www = blockFromEngineSpan('paragraph', 'see www.example.com');
    expect(www?.textContent).toBe('see www.example.com');
    const wwwBit = [...Array(www!.childCount)].map((_, i) => www!.child(i)).find((n) => n.text === 'www.example.com');
    expect(wwwBit!.marks.find((m) => m.type.name === 'link')!.attrs).toMatchObject({
      href: 'http://www.example.com',
      title: null,
      referenceType: null,
    });
    const wwwTrail = blockFromEngineSpan('paragraph', 'end www.example.com.');
    expect(wwwTrail?.textContent).toBe('end www.example.com.');
    expect([...Array(wwwTrail!.childCount)].map((_, i) => wwwTrail!.child(i)).find((n) => n.text === 'www.example.com')!
      .marks.find((m) => m.type.name === 'link')!.attrs.href).toBe('http://www.example.com');
    expect(blockFromEngineSpan('paragraph', 'xwww.example.com')!.child(0).marks).toHaveLength(0);
    const wwwMarked = blockFromEngineSpan('paragraph', 'Go **www.example.com** now');
    expect(wwwMarked?.textContent).toBe('Go www.example.com now');
    const wwwStrong = [...Array(wwwMarked!.childCount)].map((_, i) => wwwMarked!.child(i)).find((n) => n.text === 'www.example.com');
    expect(wwwStrong!.marks.map((m) => m.type.name).sort()).toEqual(['link', 'strong']);

    const bareEmail = blockFromEngineSpan('paragraph', 'mail user@example.com now');
    expect(bareEmail?.textContent).toBe('mail user@example.com now');
    const bareEmailBit = [...Array(bareEmail!.childCount)].map((_, i) => bareEmail!.child(i)).find((n) => n.text === 'user@example.com');
    expect(bareEmailBit!.marks.find((m) => m.type.name === 'link')!.attrs.href).toBe('mailto:user@example.com');
    expect(blockFromEngineSpan('paragraph', 'NDCG@10')!.child(0).marks).toHaveLength(0);
    expect(blockFromEngineSpan('paragraph', 'user@localhost')!.child(0).marks).toHaveLength(0);

    const angleEmail = blockFromEngineSpan('paragraph', 'see <admin@example.com>');
    expect(angleEmail?.textContent).toBe('see admin@example.com');
    const angleEmailBit = [...Array(angleEmail!.childCount)].map((_, i) => angleEmail!.child(i)).find((n) => n.text === 'admin@example.com');
    expect(angleEmailBit!.marks.find((m) => m.type.name === 'link')!.attrs.href).toBe('mailto:admin@example.com');
    const mailtoAngle = blockFromEngineSpan('paragraph', '<mailto:a@b.com>');
    expect(mailtoAngle?.textContent).toBe('mailto:a@b.com');
    expect(mailtoAngle!.child(0).marks.find((m) => m.type.name === 'link')!.attrs.href).toBe('mailto:a@b.com');
    // Simple inline HTML is engine-owned; footnotes stay dialect.
    const loneBr = blockFromEngineSpan('paragraph', '<br>');
    expect(loneBr?.childCount).toBe(1);
    expect(loneBr?.child(0).type.name).toBe('inline_html');
    expect(loneBr?.child(0).attrs.value).toBe('<br>');
    expect(blockFromEngineSpan('paragraph', '[^note]')).toBeNull();
    // Multi-line HTML attribute stays dialect.
    expect(blockFromEngineSpan('paragraph', '<span\nclass="x">')).toBeNull();

    const h = blockFromEngineSpan('heading', '## Title');
    expect(h?.type.name).toBe('heading');
    expect(h?.attrs.level).toBe(2);
    expect(h?.textContent).toBe('Title');
    expect(blockFromEngineSpan('heading', '# *emph*')?.textContent).toBe('emph');
    expect(blockFromEngineSpan('heading', '# [[wiki]]')?.textContent).toBe('[[wiki]]');
  });

  it('strips trailing spaces on plain paragraphs like CommonMark / mdast', () => {
    // Wiki-trigger e2e fixture is `See ` then types ` [[`. Keeping the open
    // space would save `See  [[…]]`. Hard breaks are engine-owned separately.
    expect(blockFromEngineSpan('paragraph', 'See ')?.textContent).toBe('See');
    expect(blockFromEngineSpan('paragraph', 'See  ')?.textContent).toBe('See');
    expect(blockFromEngineSpan('paragraph', 'Hello world\n')?.textContent).toBe('Hello world');
  });

  it('builds plain hard-break paragraphs as hard_break nodes; simple marks + hard breaks owned; heavy dialect', () => {
    const p = blockFromEngineSpan('paragraph', 'Break  \nline');
    expect(p?.type.name).toBe('paragraph');
    expect(p?.childCount).toBe(3);
    expect(p?.child(0).isText).toBe(true);
    expect(p?.child(0).text).toBe('Break');
    expect(p?.child(1).type.name).toBe('hard_break');
    expect(p?.child(2).text).toBe('line');
    expect(p?.textContent).toBe('Breakline');

    const mixed = blockFromEngineSpan('paragraph', 'A  \nB\nC  \nD');
    expect(mixed?.childCount).toBe(5);
    expect(mixed?.child(0).text).toBe('A');
    expect(mixed?.child(1).type.name).toBe('hard_break');
    expect(mixed?.child(2).text).toBe('B\nC');
    expect(mixed?.child(3).type.name).toBe('hard_break');
    expect(mixed?.child(4).text).toBe('D');

    const soft = blockFromEngineSpan('paragraph', 'Soft\nbreak stays soft.');
    expect(soft?.childCount).toBe(1);
    expect(soft?.textContent).toBe('Soft\nbreak stays soft.');

    const markedHb = blockFromEngineSpan('paragraph', 'Break  \n**bold**');
    expect(markedHb?.childCount).toBe(3);
    expect(markedHb?.child(1).type.name).toBe('hard_break');
    expect(markedHb?.child(2).marks.some((m) => m.type.name === 'strong')).toBe(true);
    const wikiHb = blockFromEngineSpan('paragraph', 'see [[wiki]]  \nhere');
    expect(wikiHb?.childCount).toBe(3);
    expect(wikiHb?.child(0).text).toBe('see [[wiki]]');
    expect(wikiHb?.child(1).type.name).toBe('hard_break');
    expect(wikiHb?.child(2).text).toBe('here');

    const inline = inlineNodesFromPlainSource('x  \ny');
    expect(inline).toHaveLength(3);
    expect(inline[1]!.type.name).toBe('hard_break');
  });

  it('matches micromark PM for engine-owned samples via blockFromSpan', () => {
    const samples = [
      '```ts\nconst a = 1;\n```\n',
      '---\n\n',
      '$$\nx\n$$\n',
      '---\ntitle: x\n---\n',
      'Hello world\n',
      'See \n',
      'Line with hard break  \ncontinues here.\n',
      'A  \nB\nC  \nD\n',
      '# Plain title\n',
      'Setext Title\n============\n',
      '[alpha]: https://example.com/alpha "Alpha Title"\n',
      '[^1]: plain note\n',
      '[^Long-Name]: Hello world\n',
      '[^y]: line1\n  continued\n',
      '> Hello world\n',
      '> Second plain quote\n> with a continuation line.\n',
      '> para1\n>\n> para2\n',
      '> trailing \n',
      '   > indented quote\n',
      '> > nested only\n',
      '> outer\n> > nested\n',
      '> a\n>\n> > b\n',
      '> > a\n> >\n> > b\n',
      '> > a\n>\n> > b\n',
      '> outer\n> > mid\n> > > deep\n',
      '> outer\n> > nested\n>\n> outer2\n',
      '- bullet a\n- bullet b\n',
      '* star a\n* star b\n',
      '+ plus a\n+ plus b\n',
      '1. ordered a\n2. ordered b\n',
      '1) paren a\n2) paren b\n',
      '3. start three\n4. next\n',
      '- [ ] todo\n- [x] done\n',
      '- a\n\n- b\n',
      '- a\n  continued\n- b\n',
      '- outer one\n  - nested a\n  - nested b\n- outer two\n',
      '1. ordered outer\n   1. nested ordered a\n   2. nested ordered b\n2. ordered outer two\n',
      '- a\n  - n1\n\n  - n2\n- b\n',
      '- a\n  continued\n  - nested\n',
      '- [ ] task outer\n  - [ ] nested task\n',
      '- a\n  - nested\n    - deep\n',
      '- outer one\n  - nested a\n  - nested b\n    - deep three\n- outer two\n',
      '| Left | Right |\n| :--- | ---: |\n| alpha | 1 |\n| beta | 2 |\n',
      '| a | b | c |\n| --- | :---: | ---: |\n| 1 | 2 | 3 |\n',
      '| H1 | H2 |\n| --- | --- |\n',
      '| x |\n| - |\n|  |\n',
      '  | a | b |\n  | - | - |\n  | 1 | 2 |\n',
      '|a|b|\n|-|-|\n|1|2|\n',
      'Hello **bold** and *em*.\n',
      'Strike ~~this~~ and `code`.\n',
      '**注意：**一定\n',
      '- item **bold**\n- item *em*\n',
      '| A | B |\n| - | - |\n| **x** | y |\n',
      '> [!NOTE]\n> has **bold**\n',
      'Hello __strong__ and _em_\n',
      'uses snake_case and mcp__claude_api\n',
      '**bold with snake_case**\n',
      '_emphasis_ alone\n',
      '[^1]: footnote with __strong__\n',
      '**bold _nested_**\n',
      '*em **strong** em*\n',
      '**bold *em ~~strike~~ more* bold**\n',
      '*em **bold _nested_** more*\n',
      '~~del **bold _em_** del~~\n',
      '**a *b `code` c* d**\n',
      '**a *b ~~c _d_ c~~ b* a**\n',
      '~~del **bold *em* rest** del~~\n',
      '**a *b ~~c _d `e` d_ c~~ b* a**\n',
      '*em **bold ~~del _x `y` x_~~ more** rest*\n',
      '**v *w ~~x _y *z `a` z* y_ x~~ w* v**\n',
      '*em **bold ~~del _x *y `z` y* x_~~ more** rest*\n',
      '**bold `code`**\n',
      '[docs](https://example.com/path)\n',
      '![alt](./a.png)\n',
      'Go [**bold**](https://example.com)\n',
      'See [[Home]] and [[Note Name|alias]]\n',
      'Go **[[Home]]** now\n',
      'bare https://example.com\n',
      'see https://example.com/path please\n',
      'end https://example.com.\n',
      'Go **https://example.com** now\n',
      'angle <https://example.com>\n',
      'see <https://example.com/path> please\n',
      'Go **<https://example.com>** now\n',
      'also <http://example.com/plain>\n',
      '| a \\| b |\n| --- |\n| c \\| d |\n',
      '| Left \\| Mid | Right |\n| --- | --- |\n| a \\| b | 1 |\n',
    ];
    for (const md of samples) {
      setMarkdownEngineForTests('micromark');
      const micro = blockFromSpan(splitBlocks(md).spans[0]!);
      setMarkdownEngineForTests('roobli-md');
      const none = splitBlocksViaRoobli(md, { enrich: 'none' });
      const engine = blockFromSpan(none.spans[0]!);
      expect(engine.type.name).toBe(micro.type.name);
      expect(engine.textContent).toBe(micro.textContent);
      if (engine.type.name === 'paragraph' || engine.type.name === 'heading') {
        const countHard = (n: { forEach: (fn: (c: { type: { name: string } }) => void) => void }) => {
          let c = 0;
          n.forEach((child) => { if (child.type.name === 'hard_break') c += 1; });
          return c;
        };
        expect(countHard(engine)).toBe(countHard(micro));
      }
      if (engine.type.name === 'heading' || micro.type.name === 'heading') {
        expect(engine.attrs.level).toBe(micro.attrs.level);
      }
      if (engine.type.name === 'code_block') {
        expect(engine.attrs.lang).toBe(micro.attrs.lang);
        expect(engine.attrs.fenced).toBe(micro.attrs.fenced);
      }
      if (engine.type.name === 'link_definition') {
        expect(engine.attrs).toEqual(micro.attrs);
      }
      if (engine.type.name === 'footnote_definition') {
        expect(engine.attrs).toEqual(micro.attrs);
        expect(engine.childCount).toBe(micro.childCount);
        expect(engine.textContent).toBe(micro.textContent);
      }
      if (engine.type.name === 'blockquote') {
        const assertQuote = (eng: typeof engine, mic: typeof micro): void => {
          expect(eng.childCount).toBe(mic.childCount);
          for (let i = 0; i < eng.childCount; i += 1) {
            expect(eng.child(i).type.name).toBe(mic.child(i).type.name);
            expect(eng.child(i).textContent).toBe(mic.child(i).textContent);
            if (eng.child(i).type.name === 'blockquote') {
              assertQuote(eng.child(i), mic.child(i));
            }
          }
        };
        assertQuote(engine, micro);
      }
      if (engine.type.name === 'bullet_list' || engine.type.name === 'ordered_list') {
        const assertList = (eng: typeof engine, mic: typeof micro): void => {
          expect(eng.attrs).toEqual(mic.attrs);
          expect(eng.childCount).toBe(mic.childCount);
          for (let i = 0; i < eng.childCount; i += 1) {
            expect(eng.child(i).attrs.checked).toBe(mic.child(i).attrs.checked);
            expect(eng.child(i).textContent).toBe(mic.child(i).textContent);
            expect(eng.child(i).childCount).toBe(mic.child(i).childCount);
            for (let c = 0; c < eng.child(i).childCount; c += 1) {
              const ec = eng.child(i).child(c);
              const mc = mic.child(i).child(c);
              expect(ec.type.name).toBe(mc.type.name);
              if (ec.type.name === 'bullet_list' || ec.type.name === 'ordered_list') {
                assertList(ec, mc);
              } else {
                expect(ec.textContent).toBe(mc.textContent);
              }
            }
          }
        };
        assertList(engine, micro);
      }
      if (engine.type.name === 'table') {
        expect(engine.attrs).toEqual(micro.attrs);
        expect(engine.childCount).toBe(micro.childCount);
        for (let r = 0; r < engine.childCount; r += 1) {
          expect(engine.child(r).childCount).toBe(micro.child(r).childCount);
          for (let c = 0; c < engine.child(r).childCount; c += 1) {
            expect(engine.child(r).child(c).type.name).toBe(micro.child(r).child(c).type.name);
            expect(engine.child(r).child(c).attrs.align).toBe(micro.child(r).child(c).attrs.align);
            expect(engine.child(r).child(c).textContent).toBe(micro.child(r).child(c).textContent);
          }
        }
      }
    }
  });
});

describe('enrich skip for engine-owned spans', () => {

  it('engine-owns simple bare http(s) autolink paragraphs', () => {
    const text = 'Visit https://example.com/path today.\n';
    const none = splitBlocksViaRoobli(text, { enrich: 'none' });
    const enriched = enrichSpansInRange(none.spans, text, { from: 0, to: none.spans.length });
    expect(enriched[0]!.semanticKey).toBe(engineSemanticKey('paragraph', enriched[0]!.markdown));
    const pm = blockFromEngineSpan('paragraph', enriched[0]!.markdown);
    expect(pm?.textContent).toBe('Visit https://example.com/path today.');
    const bit = [...Array(pm!.childCount)].map((_, i) => pm!.child(i)).find((n) => n.text === 'https://example.com/path');
    expect(bit!.marks.find((m) => m.type.name === 'link')!.attrs.href).toBe('https://example.com/path');
  });

  it('engine-owns simple angle-bracket http(s) autolink paragraphs', () => {
    const text = 'Visit <https://example.com/path> today.\n';
    const none = splitBlocksViaRoobli(text, { enrich: 'none' });
    const enriched = enrichSpansInRange(none.spans, text, { from: 0, to: none.spans.length });
    expect(enriched[0]!.semanticKey).toBe(engineSemanticKey('paragraph', enriched[0]!.markdown));
    const pm = blockFromEngineSpan('paragraph', enriched[0]!.markdown);
    expect(pm?.textContent).toBe('Visit https://example.com/path today.');
    const bit = [...Array(pm!.childCount)].map((_, i) => pm!.child(i)).find((n) => n.text === 'https://example.com/path');
    expect(bit!.marks.find((m) => m.type.name === 'link')!.attrs.href).toBe('https://example.com/path');
  });

  it('engine-owns simple www. autolink paragraphs', () => {
    const text = 'Visit www.example.com/path today.\n';
    const none = splitBlocksViaRoobli(text, { enrich: 'none' });
    const enriched = enrichSpansInRange(none.spans, text, { from: 0, to: none.spans.length });
    expect(enriched[0]!.semanticKey).toBe(engineSemanticKey('paragraph', enriched[0]!.markdown));
    const pm = blockFromEngineSpan('paragraph', enriched[0]!.markdown);
    expect(pm?.textContent).toBe('Visit www.example.com/path today.');
    const bit = [...Array(pm!.childCount)].map((_, i) => pm!.child(i)).find((n) => n.text === 'www.example.com/path');
    expect(bit!.marks.find((m) => m.type.name === 'link')!.attrs.href).toBe('http://www.example.com/path');
  });

  it('engine-owns simple backslash escapes', () => {
    const plain = blockFromEngineSpan('paragraph', 'Backslash \\*not emph\\* and \\`not code\\`.');
    expect(plain?.type.name).toBe('paragraph');
    expect(plain?.textContent).toBe('Backslash *not emph* and `not code`.');
    expect(plain?.childCount).toBe(1);
    expect(plain!.child(0).marks).toHaveLength(0);

    const pipe = blockFromEngineSpan('paragraph', 'Pipe \\| in text.');
    expect(pipe?.textContent).toBe('Pipe | in text.');

    const wiki = blockFromEngineSpan('paragraph', 'Escaped \\[[not wiki]].');
    expect(wiki?.textContent).toBe('Escaped [[not wiki]].');

    const doubled = blockFromEngineSpan('paragraph', 'Keep \\\\ backslash');
    expect(doubled?.textContent).toBe('Keep \\ backslash');

    const hbSource = 'line one' + String.fromCharCode(92) + '\nline two';
    const hb = blockFromEngineSpan('paragraph', hbSource);
    expect(hb?.childCount).toBe(3);
    expect(hb?.child(0).textContent).toBe('line one');
    expect(hb?.child(1).type.name).toBe('hard_break');
    expect(hb?.child(2).textContent).toBe('line two');

    const inStrong = blockFromEngineSpan('paragraph', '**bold \\* star**');
    expect(inStrong?.textContent).toBe('bold * star');
    expect(inStrong!.child(0).marks.some((m) => m.type.name === 'strong')).toBe(true);

    const heading = blockFromEngineSpan('heading', '# Escaped \\* heading');
    expect(heading?.textContent).toBe('Escaped * heading');

    const list = blockFromEngineSpan('bullet-list', '- a \\* b');
    expect(list?.child(0).textContent).toBe('a * b');

    // Escaped pipes in simple tables are engine-owned (ragged body rows too).
    expect(parseSimpleTableSource('| a \\| b |\n| --- |')).not.toBeNull();
    expect(blockFromEngineSpan('table', '| a \\| b |\n| --- |')?.child(0).child(0).textContent).toBe('a | b');
    expect(parseSimpleTableSource('| a \\| b |\n| - | - |')).toBeNull();
    // Inline math is engine-owned (see dedicated test below).
    expect(canSkipDialectEnrich('paragraph', 'Has $math$')).toBe(true);
  });

  it('engine-owns simple inline HTML', () => {
    const span = blockFromEngineSpan(
      'paragraph',
      'A line with <span class="x">inline html</span> inside.',
    );
    expect(span?.type.name).toBe('paragraph');
    expect(canSkipDialectEnrich('paragraph', 'A line with <span class="x">inline html</span> inside.')).toBe(true);
    const kinds = [...Array(span!.childCount)].map((_, i) => {
      const n = span!.child(i);
      return n.type.name === 'inline_html' ? `html:${n.attrs.value}` : `text:${n.text}`;
    });
    expect(kinds).toEqual([
      'text:A line with ',
      'html:<span class="x">',
      'text:inline html',
      'html:</span>',
      'text: inside.',
    ]);

    const br = blockFromEngineSpan('paragraph', 'Break<br/>here');
    expect(br?.child(1).type.name).toBe('inline_html');
    expect(br?.child(1).attrs.value).toBe('<br/>');

    const comment = blockFromEngineSpan('paragraph', 'a <!--x--> b');
    expect(comment?.child(1).attrs.value).toBe('<!--x-->');

    const inStrong = blockFromEngineSpan('paragraph', 'Mark **around <br> tag**');
    expect(inStrong?.textContent).toBe('Mark around  tag');
    const htmlKid = [...Array(inStrong!.childCount)].map((_, i) => inStrong!.child(i))
      .find((n) => n.type.name === 'inline_html');
    expect(htmlKid?.attrs.value).toBe('<br>');
    // from-mdast parity: inline_html carries no marks even inside strong.
    expect(htmlKid!.marks).toHaveLength(0);
    const around = [...Array(inStrong!.childCount)].map((_, i) => inStrong!.child(i))
      .find((n) => n.isText && n.text === 'around ');
    expect(around!.marks.some((m) => m.type.name === 'strong')).toBe(true);

    // Bare `<` stays literal (not dialect).
    const bare = blockFromEngineSpan('paragraph', 'a < b');
    expect(bare?.textContent).toBe('a < b');
    expect(canSkipDialectEnrich('paragraph', 'a < b')).toBe(true);

    // Autolink still wins over HTML.
    const auto = blockFromEngineSpan('paragraph', 'See <https://example.com> now.');
    expect(auto?.textContent).toBe('See https://example.com now.');

    // Math + HTML together still owned.
    expect(canSkipDialectEnrich('paragraph', 'Has $math$ and <br>')).toBe(true);
  });

  it('engine-owns simple inline math', () => {
    const span = blockFromEngineSpan('paragraph', 'Has $E=mc^2$ here.');
    expect(span?.type.name).toBe('paragraph');
    expect(canSkipDialectEnrich('paragraph', 'Has $E=mc^2$ here.')).toBe(true);
    const kinds = [...Array(span!.childCount)].map((_, i) => {
      const n = span!.child(i);
      return n.type.name === 'math_inline' ? `math:${n.textContent}` : `text:${n.text}`;
    });
    expect(kinds).toEqual([
      'text:Has ',
      'math:E=mc^2',
      'text: here.',
    ]);

    const padded = blockFromEngineSpan('paragraph', 'Space $ x $ spaced.');
    const padMath = [...Array(padded!.childCount)].map((_, i) => padded!.child(i))
      .find((n) => n.type.name === 'math_inline');
    expect(padMath?.textContent).toBe('x');

    const dbl = blockFromEngineSpan('paragraph', 'Alone $$y$$ on line.');
    const dblMath = [...Array(dbl!.childCount)].map((_, i) => dbl!.child(i))
      .find((n) => n.type.name === 'math_inline');
    expect(dblMath?.textContent).toBe('y');

    const inStrong = blockFromEngineSpan('paragraph', 'Mark **around $x$ tag**');
    expect(inStrong?.textContent).toBe('Mark around x tag');
    const mathKid = [...Array(inStrong!.childCount)].map((_, i) => inStrong!.child(i))
      .find((n) => n.type.name === 'math_inline');
    expect(mathKid?.textContent).toBe('x');
    // from-mdast parity: math_inline carries no marks even inside strong.
    expect(mathKid!.marks).toHaveLength(0);
    const around = [...Array(inStrong!.childCount)].map((_, i) => inStrong!.child(i))
      .find((n) => n.isText && n.text === 'around ');
    expect(around!.marks.some((m) => m.type.name === 'strong')).toBe(true);

    // Escaped dollars stay literal.
    const esc = blockFromEngineSpan('paragraph', 'Escaped \\$notmath\\$.');
    expect(esc?.textContent).toBe('Escaped $notmath$.');
    expect([...Array(esc!.childCount)].some((_, i) => esc!.child(i).type.name === 'math_inline')).toBe(false);

    // Code spans keep dollars.
    const code = blockFromEngineSpan('paragraph', 'Code `$not$` keeps.');
    expect(code?.textContent).toBe('Code $not$ keeps.');
    expect([...Array(code!.childCount)].some((_, i) => code!.child(i).type.name === 'math_inline')).toBe(false);

    // Currency-style greedy match (micromark parity): first $ to next $.
    const price = blockFromEngineSpan('paragraph', 'Price is $5 and $10.');
    const priceMath = [...Array(price!.childCount)].map((_, i) => price!.child(i))
      .find((n) => n.type.name === 'math_inline');
    expect(priceMath?.textContent).toBe('5 and ');

    // Image alt with math is engine-owned (micromark plain alt string).
    expect(canSkipDialectEnrich('paragraph', '![alt $x$](url)')).toBe(true);
    expect(blockFromEngineSpan('paragraph', '![alt $x$](url)')!.child(0).attrs.alt).toBe('alt x');

    // Link label with math is owned.
    const link = blockFromEngineSpan('paragraph', 'See [$link$](https://example.com).');
    expect(link).not.toBeNull();
    const linkMath = [...Array(link!.childCount)].map((_, i) => link!.child(i))
      .find((n) => n.type.name === 'math_inline');
    expect(linkMath?.textContent).toBe('link');
  });


  it('engine-owns simple image alts (math/marks/escapes/HTML)', () => {
    const math = blockFromEngineSpan('paragraph', 'Pic ![alt $x$](./a.png) here');
    expect(canSkipDialectEnrich('paragraph', 'Pic ![alt $x$](./a.png) here')).toBe(true);
    expect(math!.child(1).type.name).toBe('image');
    expect(math!.child(1).attrs.alt).toBe('alt x');

    const marked = blockFromEngineSpan('paragraph', '![**bold**](./b.png)');
    expect(marked!.child(0).attrs.alt).toBe('bold');

    const esc = blockFromEngineSpan('paragraph', '![a \\| b](./c.png)');
    expect(esc!.child(0).attrs.alt).toBe('a | b');

    const html = blockFromEngineSpan('paragraph', '![a <br> b](./d.png)');
    expect(html!.child(0).attrs.alt).toBe('a <br> b');

    const angle = blockFromEngineSpan('paragraph', '![a <https://x.com> b](./e.png)');
    expect(angle!.child(0).attrs.alt).toBe('a https://x.com b');

    const closedBracket = blockFromEngineSpan('paragraph', '![a\\]b](./f.png)');
    expect(closedBracket!.child(0).attrs.alt).toBe('a]b');

    const ref = blockFromEngineSpan('paragraph', '![alt $x$][logo]');
    expect(ref!.child(0).attrs).toMatchObject({ alt: 'alt x', referenceType: 'full', src: '' });

    const collapsed = blockFromEngineSpan('paragraph', '![**bold**][]');
    expect(collapsed!.child(0).attrs.alt).toBe('bold');

    // Nested brackets / *** stay dialect.
    expect(canSkipDialectEnrich('paragraph', '![a [x] b](u.png)')).toBe(false);
    expect(canSkipDialectEnrich('paragraph', '![***x***](u.png)')).toBe(false);

    // Table cells with simple math / HTML already skip dialect.
    const tableMd = '| A | B |\n| - | - |\n| $x$ | <br> |\n';
    expect(canSkipDialectEnrich('table', tableMd)).toBe(true);
    expect(blockFromEngineSpan('table', tableMd)).not.toBeNull();
  });


  it('engine-owns simple email autolink paragraphs', () => {
    const text = 'Contact <admin@example.com> or user@example.com today.\n';
    const none = splitBlocksViaRoobli(text, { enrich: 'none' });
    const enriched = enrichSpansInRange(none.spans, text, { from: 0, to: none.spans.length });
    expect(enriched[0]!.semanticKey).toBe(engineSemanticKey('paragraph', enriched[0]!.markdown));
    const pm = blockFromEngineSpan('paragraph', enriched[0]!.markdown);
    expect(pm?.textContent).toBe('Contact admin@example.com or user@example.com today.');
    const angled = [...Array(pm!.childCount)].map((_, i) => pm!.child(i)).find((n) => n.text === 'admin@example.com');
    expect(angled!.marks.find((m) => m.type.name === 'link')!.attrs.href).toBe('mailto:admin@example.com');
    const bare = [...Array(pm!.childCount)].map((_, i) => pm!.child(i)).find((n) => n.text === 'user@example.com');
    expect(bare!.marks.find((m) => m.type.name === 'link')!.attrs.href).toBe('mailto:user@example.com');
  });

  it('engine-owns simple reference link paragraphs (skip dialect when defs elsewhere)', () => {
    const text = 'See [ref][alpha] nearby.\n\n[alpha]: https://example.com/a\n';
    const none = splitBlocksViaRoobli(text, { enrich: 'none' });
    const enriched = enrichSpansInRange(none.spans, text, { from: 0, to: none.spans.length });
    expect(enriched[0]!.kind).toBe('paragraph');
    expect(enriched[0]!.semanticKey).toBe(engineSemanticKey('paragraph', enriched[0]!.markdown));
    const pm = blockFromEngineSpan('paragraph', enriched[0]!.markdown);
    expect(pm?.textContent).toBe('See ref nearby.');
    const bit = [...Array(pm!.childCount)].map((_, i) => pm!.child(i)).find((n) => n.text === 'ref');
    expect(bit!.marks.find((m) => m.type.name === 'link')!.attrs.referenceType).toBe('full');
  });


  it('enrichSpansInRange finalizes leaf / plain without changing dialect peers', () => {
    const text = '# Plain\n\n```js\nx\n```\n\nHas [[wiki]]\n\nAfter\n';
    const none = splitBlocksViaRoobli(text, { enrich: 'none' });
    const bulk = splitBlocksViaRoobli(text, { enrich: 'bulk' });
    const enriched = enrichSpansInRange(none.spans, text, { from: 0, to: none.spans.length });

    expect(enriched.map((s) => s.kind)).toEqual(bulk.spans.map((s) => s.kind));
    // Plain heading + fence: engine semantic keys match bulk.
    expect(enriched[0]!.semanticKey).toBe(engineSemanticKey('heading', enriched[0]!.markdown));
    expect(enriched[0]!.semanticKey).toBe(bulk.spans[0]!.semanticKey);
    expect(enriched[1]!.semanticKey).toBe(bulk.spans[1]!.semanticKey);
    // Simple wiki paragraph is engine-owned (literal text; decoration displays).
    expect(enriched[2]!.node.type).toBe('paragraph');
    expect(enriched[2]!.semanticKey).toBe(engineSemanticKey('paragraph', enriched[2]!.markdown));
    expect(enriched[2]!.semanticKey).toBe(bulk.spans[2]!.semanticKey);
    expect(JSON.stringify(enriched[2]!.node)).toContain('wiki');
  });

  it('createEnrichFlags marks engine-owned remainder as already done', () => {
    const text = [
      'Para with [[wiki]].\n\n',
      '```js\ncode\n```\n\n',
      'Plain para\n\n',
      '# Heading\n\n',
      '[id]: https://example.com\n\n',
      '> Simple quote\n\n',
      '- flat a\n- flat b\n\n',
      '| A | B |\n| - | - |\n| 1 | 2 |\n\n',
      'More [[wiki]]\n\n',
      'Simple **bold** owned\n\n',
    ].join('');
    const none = splitBlocksViaRoobli(text, { enrich: 'none' });
    // Prefix 0 enriched; remainder should skip leaf + plain + simple-marked + link-def + quote + flat list + table.
    const flags = createEnrichFlags(none.spans.length, 0, none.spans);
    // Indices: 0 wiki, 1 fence, 2 plain, 3 heading, 4 link-def, 5 quote, 6 list, 7 table, 8 wiki, 9 bold
    // Simple wiki is now engine-owned alongside leaf / plain / marked.
    expect(flags[0]).toBe(1);
    expect(flags[1]).toBe(1);
    expect(flags[2]).toBe(1);
    expect(flags[3]).toBe(1);
    expect(flags[4]).toBe(1);
    expect(flags[5]).toBe(1);
    expect(flags[6]).toBe(1);
    expect(flags[7]).toBe(1);
    expect(flags[8]).toBe(1);
    expect(flags[9]).toBe(1);
    expect(countDeferredFlags(flags)).toBe(0);
  });

  it('docFromSpans uses engine path for mixed leaf + plain + simple quote + flat list + table + footnote under enrich none', () => {
    const text = '# Title\n\n```\nbody\n```\n\nHello\n\n> quoted\n\n- a\n- b\n\n| A | B |\n| - | - |\n| 1 | 2 |\n';
    const none = splitBlocksViaRoobli(text, { enrich: 'none' });
    const doc = docFromSpans(none.spans as never);
    expect(doc.childCount).toBe(6);
    expect(doc.child(0).type.name).toBe('heading');
    expect(doc.child(0).textContent).toBe('Title');
    expect(doc.child(1).type.name).toBe('code_block');
    expect(doc.child(1).textContent).toBe('body');
    expect(doc.child(2).type.name).toBe('paragraph');
    expect(doc.child(2).textContent).toBe('Hello');
    expect(doc.child(3).type.name).toBe('blockquote');
    expect(doc.child(3).textContent).toBe('quoted');
    expect(doc.child(4).type.name).toBe('bullet_list');
    expect(doc.child(4).childCount).toBe(2);
    expect(doc.child(4).textContent).toBe('ab');
    expect(doc.child(5).type.name).toBe('table');
    expect(doc.child(5).childCount).toBe(2);
    expect(doc.child(5).textContent).toBe('AB12');
  });
});

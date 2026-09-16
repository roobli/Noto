/**
 * Engine-owned IR → PM for common blocks (leaf + plain paragraph/heading
 * including hard breaks + parseable link-def + simple footnote-def + simple
 * quote incl. nested plain + simple flat / same-family nested list (any depth)
 * + simple GFM table). Flagged `@roobli/md` path; does not flip product default.
 */

import { describe, expect, it } from 'vitest';
import {
  blockFromEngineSpan,
  canSkipDialectEnrich,
  engineSemanticKey,
  needsDialectInline,
  hasHardBreak,
  inlineNodesFromPlainSource,
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
  });

  it('canSkipDialectEnrich for leaf + plain phrasing + simple/nested quote + flat/nested list + table + footnote', () => {
    expect(canSkipDialectEnrich('fenced-code', '```js\nx\n```')).toBe(true);
    expect(canSkipDialectEnrich('thematic-break', '---')).toBe(true);
    expect(canSkipDialectEnrich('paragraph', 'Hello')).toBe(true);
    expect(canSkipDialectEnrich('heading', '# Title')).toBe(true);
    expect(canSkipDialectEnrich('heading', 'Setext\n===')).toBe(true);
    expect(canSkipDialectEnrich('paragraph', 'Break  \nline')).toBe(true);
    expect(canSkipDialectEnrich('paragraph', 'Hello **x**')).toBe(false);
    expect(canSkipDialectEnrich('paragraph', 'Break  \n**x**')).toBe(false);
    expect(canSkipDialectEnrich('link-definition', '[id]: https://example.com')).toBe(true);
    expect(canSkipDialectEnrich('footnote-definition', '[^1]: plain note')).toBe(true);
    expect(canSkipDialectEnrich('footnote-definition', '[^1]: has *emphasis*')).toBe(false);
    expect(canSkipDialectEnrich('footnote-definition', '[^1]:')).toBe(true);
    expect(canSkipDialectEnrich('quote', '> Hello')).toBe(true);
    expect(canSkipDialectEnrich('quote', '> outer\n> > nested')).toBe(true);
    expect(canSkipDialectEnrich('quote', '> > only nested')).toBe(true);
    expect(canSkipDialectEnrich('quote', '> Hello **x**')).toBe(false);
    expect(canSkipDialectEnrich('quote', '> [!NOTE]\n> body')).toBe(false);
    expect(canSkipDialectEnrich('quote', '> > nested\n> lazy')).toBe(false);
    expect(canSkipDialectEnrich('bullet-list', '- a\n- b')).toBe(true);
    expect(canSkipDialectEnrich('ordered-list', '1. a\n2. b')).toBe(true);
    expect(canSkipDialectEnrich('task-list', '- [ ] a\n- [x] b')).toBe(true);
    expect(canSkipDialectEnrich('bullet-list', '- a\n  - nested')).toBe(true);
    expect(canSkipDialectEnrich('bullet-list', '- a\n  - nested\n    - deep')).toBe(true);
    expect(canSkipDialectEnrich('bullet-list', '- a\n  1. cross')).toBe(false);
    expect(canSkipDialectEnrich('bullet-list', '- **bold**')).toBe(false);
    expect(canSkipDialectEnrich('table', '| a |\n| - |\n| 1 |')).toBe(true);
    expect(canSkipDialectEnrich('table', '| Left | Right |\n| :--- | ---: |\n| alpha | 1 |')).toBe(true);
    expect(canSkipDialectEnrich('table', '| a |\n| - |\n| **x** |')).toBe(false);
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
    expect(parseSimpleQuoteSource('> **bold**')).toBeNull();
    expect(parseSimpleQuoteSource('> > nested\n> lazy')).toBeNull();
    expect(parseSimpleQuoteSource('> - item')).toBeNull();
    expect(parseSimpleQuoteSource('> [!NOTE]\n> x')).toBeNull();
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
    expect(parseSimpleFlatListSource('- **bold**')).toBeNull();
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
    expect(parseSimpleTableSource('| a |\n| - |\n| **x** |')).toBeNull();
    expect(parseSimpleTableSource('| a | b |\n| - |\n| 1 | 2 |')).toBeNull();
    expect(parseSimpleTableSource('| a | b |\n| - | - |\n| 1 |')).toBeNull();
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
    expect(blockFromEngineSpan('heading', 'Setext *x*\n=======')).toBeNull();
  });

  it('builds simple and nested plain quotes; refuses callout / list / marked / lazy', () => {
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
    expect(blockFromEngineSpan('quote', '> Hello **bold**')).toBeNull();
    expect(blockFromEngineSpan('quote', '> [!NOTE]\n> body')).toBeNull();
    expect(blockFromEngineSpan('quote', '> > nested\n> lazy')).toBeNull();
    expect(blockFromEngineSpan('quote', '> - item')).toBeNull();
    expect(blockFromEngineSpan('quote', '> # heading')).toBeNull();
    expect(blockFromEngineSpan('quote', '> a  \n> b')).toBeNull();
    expect(blockFromEngineSpan('quote', '>')).toBeNull();
  });

  it('builds simple flat lists; refuses marked / mixed markers / multi-para', () => {
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

    expect(blockFromEngineSpan('bullet-list', '- **bold**')).toBeNull();
    expect(blockFromEngineSpan('bullet-list', '- a\n* b')).toBeNull();
    expect(blockFromEngineSpan('bullet-list', '- multi\n\n  para\n- next')).toBeNull();
    expect(blockFromEngineSpan('bullet-list', '- a  \n  b')).toBeNull();
  });

  it('builds same-family nested lists at any depth; refuses cross-family nest', () => {
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

    // Cross-family nest (ordered under bullet) refused.
    expect(blockFromEngineSpan('bullet-list', '- a\n  1. ordered nest')).toBeNull();
  });

  it('builds simple footnote definitions incl. empty; refuses marked / hard-break', () => {
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
    expect(parseSimpleFootnoteDefinitionSource('[^x]: has *emphasis*')).toBeNull();
    expect(parseSimpleFootnoteDefinitionSource('[^h]: a  \n  b')).toBeNull();

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

    expect(blockFromEngineSpan('footnote-definition', '[^x]: has *emphasis*')).toBeNull();
  });

  it('builds simple GFM tables; refuses marked / ragged / no delimiter', () => {
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

    expect(blockFromEngineSpan('table', '| a |\n| - |\n| **x** |')).toBeNull();
    expect(blockFromEngineSpan('table', '| a | b |\n| - |\n| 1 | 2 |')).toBeNull();
    expect(blockFromEngineSpan('table', '| a | b |\n| - | - |\n| 1 |')).toBeNull();
  });

  it('builds plain paragraph / heading; refuses marked-up phrasing', () => {
    const p = blockFromEngineSpan('paragraph', 'Hello world');
    expect(p?.type.name).toBe('paragraph');
    expect(p?.textContent).toBe('Hello world');
    expect(blockFromEngineSpan('paragraph', 'Hello **bold**')).toBeNull();

    const h = blockFromEngineSpan('heading', '## Title');
    expect(h?.type.name).toBe('heading');
    expect(h?.attrs.level).toBe(2);
    expect(h?.textContent).toBe('Title');
    expect(blockFromEngineSpan('heading', '# *emph*')).toBeNull();
  });

  it('strips trailing spaces on plain paragraphs like CommonMark / mdast', () => {
    // Wiki-trigger e2e fixture is `See ` then types ` [[`. Keeping the open
    // space would save `See  [[…]]`. Hard breaks are engine-owned separately.
    expect(blockFromEngineSpan('paragraph', 'See ')?.textContent).toBe('See');
    expect(blockFromEngineSpan('paragraph', 'See  ')?.textContent).toBe('See');
    expect(blockFromEngineSpan('paragraph', 'Hello world\n')?.textContent).toBe('Hello world');
  });

  it('builds plain hard-break paragraphs as hard_break nodes; marked still dialect', () => {
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

    expect(blockFromEngineSpan('paragraph', 'Break  \n**bold**')).toBeNull();
    expect(blockFromEngineSpan('paragraph', 'see [[wiki]]  \nhere')).toBeNull();

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
  it('enrichSpansInRange finalizes leaf / plain without changing dialect peers', () => {
    const text = '# Plain\n\n```js\nx\n```\n\nHas **bold**\n\nAfter\n';
    const none = splitBlocksViaRoobli(text, { enrich: 'none' });
    const bulk = splitBlocksViaRoobli(text, { enrich: 'bulk' });
    const enriched = enrichSpansInRange(none.spans, text, { from: 0, to: none.spans.length });

    expect(enriched.map((s) => s.kind)).toEqual(bulk.spans.map((s) => s.kind));
    // Plain heading + fence: engine semantic keys match bulk.
    expect(enriched[0]!.semanticKey).toBe(engineSemanticKey('heading', enriched[0]!.markdown));
    expect(enriched[0]!.semanticKey).toBe(bulk.spans[0]!.semanticKey);
    expect(enriched[1]!.semanticKey).toBe(bulk.spans[1]!.semanticKey);
    // Marked paragraph still dialect-enriched.
    expect(enriched[2]!.node.type).toBe('paragraph');
    expect(enriched[2]!.semanticKey).toBe(bulk.spans[2]!.semanticKey);
    expect(JSON.stringify(enriched[2]!.node)).toContain('strong');
  });

  it('createEnrichFlags marks engine-owned remainder as already done', () => {
    const text = [
      'Para with **bold**.\n\n',
      '```js\ncode\n```\n\n',
      'Plain para\n\n',
      '# Heading\n\n',
      '[id]: https://example.com\n\n',
      '> Simple quote\n\n',
      '- flat a\n- flat b\n\n',
      '| A | B |\n| - | - |\n| 1 | 2 |\n\n',
      'More **marks**\n\n',
    ].join('');
    const none = splitBlocksViaRoobli(text, { enrich: 'none' });
    // Prefix 0 enriched; remainder should skip leaf + plain + link-def + footnote-def + simple quote + flat list + table.
    const flags = createEnrichFlags(none.spans.length, 0, none.spans);
    // Indices: 0 bold, 1 fence, 2 plain, 3 heading, 4 link-def, 5 quote, 6 list, 7 table, 8 bold
    expect(flags[0]).toBe(0);
    expect(flags[1]).toBe(1);
    expect(flags[2]).toBe(1);
    expect(flags[3]).toBe(1);
    expect(flags[4]).toBe(1);
    expect(flags[5]).toBe(1);
    expect(flags[6]).toBe(1);
    expect(flags[7]).toBe(1);
    expect(flags[8]).toBe(0);
    expect(countDeferredFlags(flags)).toBe(2);
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

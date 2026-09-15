/**
 * Engine-owned IR → PM for common blocks (leaf + plain paragraph/heading +
 * parseable link-def + simple quote + simple flat list). Flagged `@roobli/md`
 * path; does not flip product default.
 */

import { describe, expect, it } from 'vitest';
import {
  blockFromEngineSpan,
  canSkipDialectEnrich,
  engineSemanticKey,
  needsDialectInline,
  parseFenceSource,
  parseHeadingSource,
  parseLinkDefinitionSource,
  parseSimpleQuoteSource,
  parseSimpleFlatListSource,
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
    expect(needsDialectInline('one  \ntwo')).toBe(true);
    expect(needsDialectInline('soft\nwrap')).toBe(false);
  });

  it('canSkipDialectEnrich for leaf + plain phrasing + simple quote + flat list', () => {
    expect(canSkipDialectEnrich('fenced-code', '```js\nx\n```')).toBe(true);
    expect(canSkipDialectEnrich('thematic-break', '---')).toBe(true);
    expect(canSkipDialectEnrich('paragraph', 'Hello')).toBe(true);
    expect(canSkipDialectEnrich('heading', '# Title')).toBe(true);
    expect(canSkipDialectEnrich('heading', 'Setext\n===')).toBe(true);
    expect(canSkipDialectEnrich('paragraph', 'Hello **x**')).toBe(false);
    expect(canSkipDialectEnrich('link-definition', '[id]: https://example.com')).toBe(true);
    expect(canSkipDialectEnrich('quote', '> Hello')).toBe(true);
    expect(canSkipDialectEnrich('quote', '> Hello **x**')).toBe(false);
    expect(canSkipDialectEnrich('quote', '> [!NOTE]\n> body')).toBe(false);
    expect(canSkipDialectEnrich('bullet-list', '- a\n- b')).toBe(true);
    expect(canSkipDialectEnrich('ordered-list', '1. a\n2. b')).toBe(true);
    expect(canSkipDialectEnrich('task-list', '- [ ] a\n- [x] b')).toBe(true);
    expect(canSkipDialectEnrich('bullet-list', '- a\n  - nested')).toBe(false);
    expect(canSkipDialectEnrich('bullet-list', '- **bold**')).toBe(false);
    expect(canSkipDialectEnrich('table', '| a |\n| - |\n| 1 |')).toBe(false);
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
    expect(parseSimpleQuoteSource('> Hello')).toEqual(['Hello']);
    expect(parseSimpleQuoteSource('> line1\n> line2')).toEqual(['line1\nline2']);
    expect(parseSimpleQuoteSource('> para1\n>\n> para2')).toEqual(['para1', 'para2']);
    expect(parseSimpleQuoteSource('> trailing ')).toEqual(['trailing']);
    expect(parseSimpleQuoteSource('>  spaced')).toEqual(['spaced']);
    expect(parseSimpleQuoteSource('> **bold**')).toBeNull();
    expect(parseSimpleQuoteSource('> > nested')).toBeNull();
    expect(parseSimpleQuoteSource('> - item')).toBeNull();
    expect(parseSimpleQuoteSource('> [!NOTE]\n> x')).toBeNull();
    expect(parseSimpleFlatListSource('- a\n- b')).toEqual({
      ordered: false, bullet: '-', delimiter: null, start: 1, spread: false,
      items: [{ checked: null, text: 'a' }, { checked: null, text: 'b' }],
    });
    expect(parseSimpleFlatListSource('* star\n* two')?.bullet).toBe('*');
    expect(parseSimpleFlatListSource('1. a\n2. b')).toMatchObject({
      ordered: true, delimiter: '.', start: 1, spread: false,
    });
    expect(parseSimpleFlatListSource('3. a\n4. b')?.start).toBe(3);
    expect(parseSimpleFlatListSource('1) a\n2) b')?.delimiter).toBe(')');
    expect(parseSimpleFlatListSource('- a\n\n- b')?.spread).toBe(true);
    expect(parseSimpleFlatListSource('- [ ] todo\n- [x] done')?.items).toEqual([
      { checked: false, text: 'todo' }, { checked: true, text: 'done' },
    ]);
    expect(parseSimpleFlatListSource('- a\n  continued')?.items[0]?.text).toBe('a\ncontinued');
    expect(parseSimpleFlatListSource('- a\n  - nested')).toBeNull();
    expect(parseSimpleFlatListSource('- **bold**')).toBeNull();
    expect(parseSimpleFlatListSource('- a\n* b')).toBeNull();
    expect(parseSimpleFlatListSource('- multi\n\n  para\n- next')).toBeNull();
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

  it('builds simple quotes; refuses nested / marked / callout / list', () => {
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

    expect(blockFromEngineSpan('quote', '> trailing ')?.textContent).toBe('trailing');
    expect(blockFromEngineSpan('quote', '> Hello **bold**')).toBeNull();
    expect(blockFromEngineSpan('quote', '> [!NOTE]\n> body')).toBeNull();
    expect(blockFromEngineSpan('quote', '> > nested')).toBeNull();
    expect(blockFromEngineSpan('quote', '> - item')).toBeNull();
    expect(blockFromEngineSpan('quote', '> # heading')).toBeNull();
    expect(blockFromEngineSpan('quote', '> a  \n> b')).toBeNull();
    expect(blockFromEngineSpan('quote', '>')).toBeNull();
  });

  it('builds simple flat lists; refuses nest / marked / mixed markers', () => {
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

    expect(blockFromEngineSpan('bullet-list', '- a\n  - nested')).toBeNull();
    expect(blockFromEngineSpan('bullet-list', '- **bold**')).toBeNull();
    expect(blockFromEngineSpan('bullet-list', '- a\n* b')).toBeNull();
    expect(blockFromEngineSpan('bullet-list', '- multi\n\n  para\n- next')).toBeNull();
    expect(blockFromEngineSpan('bullet-list', '- a  \n  b')).toBeNull();
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
    // space would save `See  [[…]]`. Hard breaks (two spaces + newline) still
    // refuse the engine path.
    expect(blockFromEngineSpan('paragraph', 'See ')?.textContent).toBe('See');
    expect(blockFromEngineSpan('paragraph', 'See  ')?.textContent).toBe('See');
    expect(blockFromEngineSpan('paragraph', 'Hello world\n')?.textContent).toBe('Hello world');
    expect(blockFromEngineSpan('paragraph', 'Break  \nline')).toBeNull();
  });

  it('matches micromark PM for engine-owned samples via blockFromSpan', () => {
    const samples = [
      '```ts\nconst a = 1;\n```\n',
      '---\n\n',
      '$$\nx\n$$\n',
      '---\ntitle: x\n---\n',
      'Hello world\n',
      'See \n',
      '# Plain title\n',
      'Setext Title\n============\n',
      '[alpha]: https://example.com/alpha "Alpha Title"\n',
      '> Hello world\n',
      '> Second plain quote\n> with a continuation line.\n',
      '> para1\n>\n> para2\n',
      '> trailing \n',
      '   > indented quote\n',
      '- bullet a\n- bullet b\n',
      '* star a\n* star b\n',
      '+ plus a\n+ plus b\n',
      '1. ordered a\n2. ordered b\n',
      '1) paren a\n2) paren b\n',
      '3. start three\n4. next\n',
      '- [ ] todo\n- [x] done\n',
      '- a\n\n- b\n',
      '- a\n  continued\n- b\n',
    ];
    for (const md of samples) {
      setMarkdownEngineForTests('micromark');
      const micro = blockFromSpan(splitBlocks(md).spans[0]!);
      setMarkdownEngineForTests('roobli-md');
      const none = splitBlocksViaRoobli(md, { enrich: 'none' });
      const engine = blockFromSpan(none.spans[0]!);
      expect(engine.type.name).toBe(micro.type.name);
      expect(engine.textContent).toBe(micro.textContent);
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
      if (engine.type.name === 'blockquote') {
        expect(engine.childCount).toBe(micro.childCount);
        for (let i = 0; i < engine.childCount; i += 1) {
          expect(engine.child(i).type.name).toBe(micro.child(i).type.name);
          expect(engine.child(i).textContent).toBe(micro.child(i).textContent);
        }
      }
      if (engine.type.name === 'bullet_list' || engine.type.name === 'ordered_list') {
        expect(engine.attrs).toEqual(micro.attrs);
        expect(engine.childCount).toBe(micro.childCount);
        for (let i = 0; i < engine.childCount; i += 1) {
          expect(engine.child(i).attrs.checked).toBe(micro.child(i).attrs.checked);
          expect(engine.child(i).textContent).toBe(micro.child(i).textContent);
          expect(engine.child(i).childCount).toBe(micro.child(i).childCount);
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
      'More **marks**\n\n',
    ].join('');
    const none = splitBlocksViaRoobli(text, { enrich: 'none' });
    // Prefix 0 enriched; remainder should skip leaf + plain + link-def + simple quote + flat list.
    const flags = createEnrichFlags(none.spans.length, 0, none.spans);
    // Indices: 0 bold, 1 fence, 2 plain, 3 heading, 4 link-def, 5 quote, 6 list, 7 bold
    expect(flags[0]).toBe(0);
    expect(flags[1]).toBe(1);
    expect(flags[2]).toBe(1);
    expect(flags[3]).toBe(1);
    expect(flags[4]).toBe(1);
    expect(flags[5]).toBe(1);
    expect(flags[6]).toBe(1);
    expect(flags[7]).toBe(0);
    expect(countDeferredFlags(flags)).toBe(2);
  });

  it('docFromSpans uses engine path for mixed leaf + plain + simple quote + flat list under enrich none', () => {
    const text = '# Title\n\n```\nbody\n```\n\nHello\n\n> quoted\n\n- a\n- b\n';
    const none = splitBlocksViaRoobli(text, { enrich: 'none' });
    const doc = docFromSpans(none.spans as never);
    expect(doc.childCount).toBe(5);
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
  });
});

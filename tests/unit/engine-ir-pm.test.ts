/**
 * Engine-owned IR → PM for common blocks (leaf + plain paragraph/heading).
 * Flagged `@roobli/md` path; does not flip product default.
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

  it('canSkipDialectEnrich for leaf + plain phrasing only', () => {
    expect(canSkipDialectEnrich('fenced-code', '```js\nx\n```')).toBe(true);
    expect(canSkipDialectEnrich('thematic-break', '---')).toBe(true);
    expect(canSkipDialectEnrich('paragraph', 'Hello')).toBe(true);
    expect(canSkipDialectEnrich('heading', '# Title')).toBe(true);
    expect(canSkipDialectEnrich('paragraph', 'Hello **x**')).toBe(false);
    expect(canSkipDialectEnrich('link-definition', '[id]: https://example.com')).toBe(true);
    expect(canSkipDialectEnrich('bullet-list', '- a')).toBe(false);
    expect(canSkipDialectEnrich('table', '| a |\n| - |\n| 1 |')).toBe(false);
  });

  it('parses fence / heading source', () => {
    expect(parseFenceSource('```ts\nconst x = 1;\n```')).toEqual({
      lang: 'ts', meta: '', value: 'const x = 1;',
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

  it('matches micromark PM for engine-owned samples via blockFromSpan', () => {
    const samples = [
      '```ts\nconst a = 1;\n```\n',
      '---\n\n',
      '$$\nx\n$$\n',
      '---\ntitle: x\n---\n',
      'Hello world\n',
      '# Plain title\n',
      '[alpha]: https://example.com/alpha "Alpha Title"\n',
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
      'More **marks**\n\n',
    ].join('');
    const none = splitBlocksViaRoobli(text, { enrich: 'none' });
    // Prefix 0 enriched; remainder should skip leaf + plain + link-def.
    const flags = createEnrichFlags(none.spans.length, 0, none.spans);
    // Indices: 0 bold, 1 fence (skip), 2 plain (skip), 3 heading (skip), 4 link-def (skip), 5 bold
    expect(flags[0]).toBe(0);
    expect(flags[1]).toBe(1);
    expect(flags[2]).toBe(1);
    expect(flags[3]).toBe(1);
    expect(flags[4]).toBe(1);
    expect(flags[5]).toBe(0);
    expect(countDeferredFlags(flags)).toBe(2);
  });

  it('docFromSpans uses engine path for mixed leaf + plain under enrich none', () => {
    const text = '# Title\n\n```\nbody\n```\n\nHello\n';
    const none = splitBlocksViaRoobli(text, { enrich: 'none' });
    const doc = docFromSpans(none.spans as never);
    expect(doc.childCount).toBe(3);
    expect(doc.child(0).type.name).toBe('heading');
    expect(doc.child(0).textContent).toBe('Title');
    expect(doc.child(1).type.name).toBe('code_block');
    expect(doc.child(1).textContent).toBe('body');
    expect(doc.child(2).type.name).toBe('paragraph');
    expect(doc.child(2).textContent).toBe('Hello');
  });
});

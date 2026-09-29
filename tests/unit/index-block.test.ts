/**
 * Reading a generated index out of the document it sits in.
 *
 * The vault pipeline writes these between two comments and rewrites them on
 * every run; the parser's only job is to say what is between the markers, and
 * to keep saying it after the generator renamed them.
 */

import { describe, expect, it } from 'vitest';
import { parseSingleBlock, splitBlocks } from '../../src/shared/markdown/v3/blocks';
import { blockFromSpan } from '../../src/shared/markdown/v3/pm/from-mdast';
import { notoSchema } from '../../src/shared/markdown/v3/pm/schema';
import {
  findIndexRegions, findRelatedRegions, parseIndexBlock,
} from '../../src/renderer/editor/noto/index-block';

const docOf = (markdown: string) => notoSchema.nodes.doc.create(
  null,
  splitBlocks(markdown).spans.map((span) => blockFromSpan(parseSingleBlock(span.markdown)!)),
);

const INDEX = [
  '# Acme 索引',
  '',
  '<!-- note-assistant:index:start -->',
  '',
  '## 目录索引',
  '',
  '自动生成，勿手改；由索引脚本维护。',
  '',
  '### 子目录',
  '',
  '- 格式对比（4 篇）',
  '  - [[格式对比/构建与部署|构建与部署]]',
  '  - [[格式对比/columnar_formats|columnar formats]]',
  '- [[合作方/00_索引|合作方]]（2 篇）',
  '',
  '### 日志',
  '',
  '- [[搜索笔记|搜索笔记]]',
  '- [[git_使用笔记|git 使用笔记]]',
  '',
  '<!-- note-assistant:index:end -->',
  '',
  'A paragraph after it.',
  '',
].join('\n');

describe('findIndexRegions', () => {
  it('finds the region between the markers, by top-level block', () => {
    const regions = findIndexRegions(docOf(INDEX));
    expect(regions).toHaveLength(1);
    // Block 0 is the H1 before the region; the start marker is block 1.
    expect(regions[0].from).toBe(1);
    expect(docOf(INDEX).child(regions[0].to).textContent.trim()).toBe('<!-- note-assistant:index:end -->');
  });

  it('keeps index and related marker families distinct', () => {
    const regions = findIndexRegions(docOf(INDEX));
    expect(regions).toHaveLength(1);
    expect(regions[0].family).toBe('index');

    const related = [
      '<!-- note-assistant:start -->',
      '',
      '## Note Assistant',
      '',
      'Tags: #vpn #linux',
      '',
      'Related Notes:',
      '',
      '- [[../A_topics/systems/00_系统总览|系统总览]] - hub',
      '- [[同目录笔记|另一篇]] - explicit link',
      '',
      '<!-- note-assistant:end -->',
      '',
    ].join('\n');
    const found = findIndexRegions(docOf(related));
    expect(found).toHaveLength(1);
    expect(found[0].family).toBe('related');
    expect(findRelatedRegions(docOf(related))).toHaveLength(1);
  });

  it('ignores a start with no matching end, rather than swallowing the rest of the note', () => {
    const unclosed = INDEX.replace('<!-- note-assistant:index:end -->', '');
    expect(findIndexRegions(docOf(unclosed))).toHaveLength(0);
  });

  it('is empty for a note with no index in it', () => {
    expect(findIndexRegions(docOf('# Plain\n\nWords.\n'))).toHaveLength(0);
  });
});

describe('parseIndexBlock', () => {
  const region = () => findIndexRegions(docOf(INDEX))[0].block;

  it('names the block after its first heading and sections after the rest', () => {
    const block = region();
    expect(block.title).toBe('目录索引');
    expect(block.sections.map((section) => section.title)).toEqual(['子目录', '日志']);
  });

  it('reads a wiki link into a title and a target, and keeps what followed it', () => {
    const items = region().sections[0].items;
    expect(items[1]).toEqual({
      target: '格式对比/构建与部署',
      title: '构建与部署',
      trailing: '',
      depth: 1,
    });
    expect(items[3]).toEqual({ target: '合作方/00_索引', title: '合作方', trailing: '（2 篇）', depth: 0 });
  });

  it('keeps a label with no link, with its children under it', () => {
    const items = region().sections[0].items;
    expect(items[0]).toEqual({ target: null, title: '格式对比（4 篇）', trailing: '', depth: 0 });
    expect(items[1].depth).toBe(1);
    expect(items[2].depth).toBe(1);
  });

  it('counts the lines that link somewhere, not the labels', () => {
    expect(region().linkCount).toBe(5);
  });

  it('uses the last path segment as the title when none was written', () => {
    const block = parseIndexBlock(docOf('- [[a/b/c]]\n').content.content);
    expect(block.sections[0].items[0]).toMatchObject({ target: 'a/b/c', title: 'c' });
  });
});

describe('parseRelatedBlock', () => {
  const RELATED = [
    '<!-- note-assistant:start -->',
    '',
    '## Note Assistant',
    '',
    'Tags: #vpn #tunnel',
    '',
    'Related Notes:',
    '',
    '- [[../systems/缓存调优|缓存调优]] - same theme',
    '- [[网络索引|网络索引]] - explicit link',
    '',
    '<!-- note-assistant:end -->',
    '',
  ].join('\n');

  it('reads title, tags, and reasons without looking like an index', () => {
    const block = findRelatedRegions(docOf(RELATED))[0].block;
    expect(block.title).toBe('Note Assistant');
    expect(block.tags).toEqual(['vpn', 'tunnel']);
    expect(block.items).toEqual([
      { target: '../systems/缓存调优', title: '缓存调优', reason: 'same theme' },
      { target: '网络索引', title: '网络索引', reason: 'explicit link' },
    ]);
  });

  it('stays a related region, not an index family', () => {
    const region = findIndexRegions(docOf(RELATED))[0];
    expect(region.family).toBe('related');
    expect(findRelatedRegions(docOf(RELATED))[0].block.tags).toContain('vpn');
  });
});

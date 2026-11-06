/**
 * Quick Open's preview: a note as it reads, from its first kilobytes or the
 * lines around a match, and a search line as a person reads it.
 */

import { describe, expect, it } from 'vitest';
import { previewBlocks, readable, readableHit, readableLine } from '../../src/renderer/quick-preview';

describe('the preview of a note', () => {
  it('draws the opening without its frontmatter, headings as headings and links by their words', () => {
    const text = [
      '---', 'tags: [es, argus]', 'status: ing', '---', '',
      '# Argus 审计', '', 'Argus 是审计服务，见 [[00_索引|索引]] 和 [设计](./design.md)。', '',
      '<!-- note-assistant:index:start -->', '## 接入', '- [x] 接入 **ES**', '- 写 `routing`', '> [!NOTE] 别名切换要带日期', '',
      '```sql', 'select 1;', '```', '---', '| a | b |', '| --- | --- |', '| 1 | 2 |',
    ].join('\n');
    expect(previewBlocks(text).map((block) => [block.kind, block.text, block.line])).toEqual([
      ['h1', 'Argus 审计', 6],
      ['p', 'Argus 是审计服务，见 索引 和 设计。', 8],
      ['h2', '接入', 11],
      ['li', '接入 ES', 12],
      ['li', '写 routing', 13],
      ['quote', '别名切换要带日期', 14],
      ['code', 'select 1;', 17],
      ['rule', '', 19],
      ['p', 'a · b', 20],
      ['p', '1 · 2', 22],
    ]);
  });

  it('numbers lines from where a match\'s window begins, and keeps a long code block short', () => {
    const blocks = previewBlocks(['---', 'not frontmatter here', '```', ...Array.from({ length: 10 }, (_, i) => `line ${i}`), '```', 'after'].join('\n'), 40);
    expect(blocks[0]).toEqual({ kind: 'rule', text: '', line: 40 });
    expect(blocks.filter((block) => block.kind === 'code')).toHaveLength(6);
    expect(blocks[1]).toEqual({ kind: 'p', text: 'not frontmatter here', line: 41 });
    expect(blocks.at(-1)).toEqual({ kind: 'p', text: 'after', line: 54 });
  });
});

describe('a line found inside notes', () => {
  it('reads an escaped path in its own letters, a link by its words, and a table row by its cells', () => {
    expect(readableLine('| **argus** | 26 | [Argus](../01_%E9%A1%B9%E7%9B%AE/Argus.md) |')).toBe('argus · 26 · Argus');
    // The match is found again in the line as shown, and a table keeps its first separator.
    const line = '| **argus** | 26 | [Argus](../01_%E9%A1%B9%E7%9B%AE/Argus.md) |';
    expect(readableHit(line, line.indexOf('argus'), 5)).toEqual({ text: 'argus · 26 · Argus', at: 0, length: 5 });
    expect(readableHit('see [here](./a%20b.md)', 11, 1).at).toBe(-1);
    expect(readableLine('see %ZZ and [[a|b]]')).toBe('see %ZZ and b');
    expect(readable('![shot](a.png) and ![[pic.png]]')).toBe('[shot] and [pic.png]');
  });
});

describe('the edges of a preview', () => {
  it('reads a window that starts inside a code block as code until its own fence closes', () => {
    const text = ['x = 1', '```', '## Real heading', '- an item'].join('\n');
    expect(previewBlocks(text, 20, '```').map((block) => [block.kind, block.text])).toEqual([
      ['code', 'x = 1'], ['h2', 'Real heading'], ['li', 'an item'],
    ]);
    // Without the fence it would take the closing one for an opening.
    expect(previewBlocks(text, 20).map((block) => block.kind)).toEqual(['p', 'code', 'code']);
  });

  it('closes a fence only with the same character, at least as long, and nothing after it', () => {
    const text = ['````md', '```', '```js', 'still code', '````', 'after'].join('\n');
    expect(previewBlocks(text).map((block) => [block.kind, block.text])).toEqual([
      ['code', '```'], ['code', '```js'], ['code', 'still code'], ['p', 'after'],
    ]);
  });

  it('drops a byte-order mark before frontmatter, and all of frontmatter the read did not finish', () => {
    expect(previewBlocks('\uFEFF---\ntitle: x\n---\nBody').map((block) => block.text)).toEqual(['Body']);
    expect(previewBlocks('---\ntitle: x\ntags: [a, b]')).toEqual([]);
  });

  it('marks the occurrence of a match where it was found, not the first one', () => {
    const line = 'a cat and a hat';
    expect(readableHit(line, line.indexOf('hat') + 1, 2).at).toBe(line.indexOf('hat') + 1);
    const marked = '**bold** cat, then cat';
    expect(readableHit(marked, marked.lastIndexOf('cat'), 3).at).toBe('bold cat, then '.length);
  });

  it('says which fence is still open after a run of lines', async () => {
    const { fenceAfter } = await import('../../src/shared/markdown-fence');
    expect(fenceAfter(['text', '~~~~', 'code'])).toEqual({ char: '~', length: 4 });
    expect(fenceAfter(['```', 'code', '```'])).toBeNull();
    expect(fenceAfter(['``` not `a fence`'])).toBeNull();
  });
});


describe('the preview reply main sends', () => {
  it('carries the fence a window starts inside, and nothing that is not one', async () => {
    const { isWorkspaceNotePreviewReplyV1 } = await import('../../src/shared/workspace/v1/validate');
    const reply = { version: 1, text: 'x', from: 3, modified: 1, fence: '````' };
    expect(isWorkspaceNotePreviewReplyV1(reply)).toBe(true);
    expect(isWorkspaceNotePreviewReplyV1({ ...reply, fence: null })).toBe(true);
    expect(isWorkspaceNotePreviewReplyV1({ ...reply, fence: '```js' })).toBe(false);
    expect(isWorkspaceNotePreviewReplyV1({ ...reply, fence: '`'.repeat(33) })).toBe(false);
    const { fence: _fence, ...older } = reply;
    expect(isWorkspaceNotePreviewReplyV1(older)).toBe(false);
  });
});

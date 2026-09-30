import { describe, expect, it } from 'vitest';
import type { Node as ProseNode } from 'prosemirror-model';
import { splitBlocks } from '../../src/shared/markdown/v3/blocks';
import { docFromSpans } from '../../src/shared/markdown/v3/pm/from-mdast';
import {
  blockDrawnText,
  composeBlockCounts,
  countDocumentWords,
  countWords,
  type DocumentCount,
} from '../../src/renderer/editor/noto/word-count';

const words = (text: string) => countWords(text).words;

describe('counting the words in a note', () => {
  it('counts a run of letters or digits once', () => {
    expect(words('one two three')).toBe(3);
    expect(words('  spaced   out  ')).toBe(2);
    expect(words('')).toBe(0);
    expect(words('2026 and 40%')).toBe(3);
  });

  it('keeps a word together through the marks that live inside one', () => {
    expect(words("don't")).toBe(1);
    expect(words('mcp__claude_api')).toBe(1);
    expect(words('well-known')).toBe(1);
    expect(words('naïve café')).toBe(2);
  });

  it('does not count punctuation as a word', () => {
    expect(words('...')).toBe(0);
    expect(words('a, b; c.')).toBe(3);
    expect(words('-- —')).toBe(0);
  });

  it('counts a Han, kana or Hangul character on its own', () => {
    // Chinese and Japanese put no spaces between words, so a run would be one
    // word per sentence.
    expect(words('自由度')).toBe(3);
    expect(words('机器性能')).toBe(4);
    expect(words('ひらがな')).toBe(4);
    expect(words('한국어')).toBe(3);
  });

  it('counts each half of a mixed run its own way', () => {
    expect(words('IPQuality测试')).toBe(3);
    expect(words('第2章')).toBe(3);
  });

  it('counts characters as the document draws them, not as bytes', () => {
    expect(countWords('héllo').characters).toBe(5);
    expect(countWords('自由度').characters).toBe(3);
    // An emoji outside the basic plane is one character, not two.
    expect(countWords('a🙂b').characters).toBe(3);
  });
});

describe('the rest of the numbers', () => {
  it('counts characters without spaces, lines and blocks', () => {
    const count = countWords('第一行 one\n\n第二行\n第三行 two', 2);
    expect(count.characters).toBe(20);
    expect(count.charactersNoSpaces).toBe(15);
    expect(count.lines).toBe(3);
    expect(count.blocks).toBe(2);
    expect(countWords('').lines).toBe(0);
  });
});

function docOf(markdown: string): ProseNode {
  return docFromSpans(splitBlocks(markdown).spans);
}

function fullCount(doc: ProseNode): DocumentCount {
  return countWords(doc.textBetween(0, doc.content.size, '\n', '\n'), doc.childCount);
}

describe('counting a document by its blocks', () => {
  it.each([
    ['# Title\n\nHello world.\n\n- a\n- b\n\n```\ncode\nline\n```\n\n自由度测试\n'],
    ['Only one paragraph.'],
    ['a\n\nb\n\nc'],
    ['Para with **bold** and `code`.\n\n> quote\n> more\n\n1. one\n2. two\n'],
    ['```js\nconst x = 1;\nconst y = 2;\n```\n\nAfter.\n'],
    ['---\ntitle: hi\n---\n\nBody.\n'],
    ['![alt](http://example.com/x.png)\n\nText.\n'],
    ['Line one\\\ncontinues.\n\nNext.\n'],
  ])('matches a whole-document count for %j', (markdown) => {
    const doc = docOf(markdown);
    expect(countDocumentWords(doc)).toEqual(fullCount(doc));
  });

  it('reuses a cached block count when the node is unchanged', () => {
    const doc = docOf('One.\n\nTwo.\n\nThree.\n');
    const cache = new WeakMap<ProseNode, DocumentCount>();
    const first = countDocumentWords(doc, cache);
    expect(first).toEqual(fullCount(doc));
    expect(cache.get(doc.child(0))).toEqual(countWords(blockDrawnText(doc.child(0))));

    let recounted = 0;
    const probing = {
      get: (node: ProseNode) => cache.get(node),
      set: (node: ProseNode, count: DocumentCount) => {
        recounted += 1;
        cache.set(node, count);
        return probing;
      },
      has: (node: ProseNode) => cache.has(node),
      delete: (node: ProseNode) => cache.delete(node),
    } as WeakMap<ProseNode, DocumentCount>;

    // A second count with a full cache measures no block again.
    recounted = 0;
    expect(countDocumentWords(doc, probing)).toEqual(first);
    expect(recounted).toBe(0);

    // Drop the middle block's entry: only that block is measured again.
    cache.delete(doc.child(1));
    recounted = 0;
    expect(countDocumentWords(doc, probing)).toEqual(first);
    expect(recounted).toBe(1);
  });

  it('composeBlockCounts adds the separators textBetween inserts', () => {
    const parts = [countWords('One'), countWords('Two'), countWords('Three')];
    expect(composeBlockCounts(parts)).toEqual({
      words: 3,
      characters: 3 + 3 + 5 + 2, // texts plus two newlines
      charactersNoSpaces: 3 + 3 + 5,
      lines: 3,
      blocks: 3,
    });
    expect(composeBlockCounts([])).toEqual({
      words: 0, characters: 0, charactersNoSpaces: 0, lines: 0, blocks: 0,
    });
  });
});

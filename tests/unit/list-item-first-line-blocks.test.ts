import { describe, expect, it } from 'vitest';
import type { Node as ProseNode } from 'prosemirror-model';
import { splitBlocks } from '../../src/shared/markdown/v3/blocks';
import { docFromSpans } from '../../src/shared/markdown/v3/pm/from-mdast';
import { blockToMarkdown } from '../../src/shared/markdown/v3/pm/to-mdast';

/** The document's structure, text in quotes, so a test reads as the tree it means. */
const shape = (node: ProseNode): string => (node.isText
  ? JSON.stringify(node.text)
  : `${node.type.name}(${node.content.content.map(shape).join(',')})`);

const read = (markdown: string) => docFromSpans(splitBlocks(markdown).spans);

describe('a block on a list item\'s own line', () => {
  it('is that block, as CommonMark reads it, and is written back as it was', () => {
    for (const [markdown, tree] of [
      ['- > a', 'doc(bullet_list(list_item(blockquote(paragraph("a")))))'],
      ['- plain\n- > second', 'doc(bullet_list(list_item(paragraph("plain")),list_item(blockquote(paragraph("second")))))'],
      ['1. > quoted\n   > more', 'doc(ordered_list(list_item(blockquote(paragraph("quoted\\nmore")))))'],
      ['- # heading', 'doc(bullet_list(list_item(heading("heading"))))'],
      ['- - nested', 'doc(bullet_list(list_item(bullet_list(list_item(paragraph("nested"))))))'],
      ['- ```\n  code\n  ```', 'doc(bullet_list(list_item(code_block("code"))))'],
      ['> - > deep', 'doc(blockquote(bullet_list(list_item(blockquote(paragraph("deep"))))))'],
    ] as const) {
      const doc = read(markdown);
      expect(shape(doc), markdown).toBe(tree);
      expect(doc.content.content.map((block) => blockToMarkdown(block)).join('\n\n')).toBe(markdown);
    }
  });

  it('after a task box is text, as GFM has it', () => {
    expect(shape(read('- [ ] > not a quote'))).toBe('doc(bullet_list(list_item(paragraph("> not a quote"))))');
  });

  it('leaves plain items to the fast path unchanged', () => {
    expect(shape(read('- a\n- b'))).toBe('doc(bullet_list(list_item(paragraph("a")),list_item(paragraph("b"))))');
    expect(shape(read('- a\n  > b'))).toBe('doc(bullet_list(list_item(paragraph("a"),blockquote(paragraph("b")))))');
  });
});

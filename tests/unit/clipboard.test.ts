import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { splitBlocks } from '../../src/shared/markdown/v3/blocks';
import { docFromSpans } from '../../src/shared/markdown/v3/pm/from-mdast';
import { inlineCopySlice, inlineCopyText, sliceToMarkdown } from '../../src/renderer/editor/noto/clipboard';

/**
 * Copy `length` characters starting where `needle` begins.
 *
 * `needle` has to sit inside one text node, because that is what is searched;
 * `length` may run past it, which is how a selection spanning a mark boundary
 * is expressed here.
 */
function copied(markdown: string, needle: string, length = needle.length): string {
  const state = EditorState.create({ doc: docFromSpans(splitBlocks(markdown).spans) });
  let at = -1;
  state.doc.descendants((node, pos) => {
    if (at >= 0 || !node.isText) return true;
    const index = node.text!.indexOf(needle);
    if (index >= 0) at = pos + index;
    return true;
  });
  if (at < 0) throw new Error(`no "${needle}" in the document`);
  const selected = state.apply(state.tr.setSelection(TextSelection.create(state.doc, at, at + length)));
  // As the editor does: the text for a selection inside one block, else the slice's markdown.
  return inlineCopyText(selected) ?? sliceToMarkdown(selected.selection.content());
}

describe('what copying puts on the clipboard', () => {
  it('keeps the markdown of a mark the selection holds whole, with more beside it', () => {
    expect(copied('Some **bold** words here.', 'bold', 10)).toBe('**bold** words');
    expect(copied('See [the paper](https://e.com/x) today.', 'See ', 13)).toBe('See [the paper](https://e.com/x)');
  });

  it('copies the words alone when the selection is inside a mark, or cuts it', () => {
    expect(copied('Read `kubectl get pods -A` now.', 'kubectl', 16)).toBe('kubectl get pods');
    expect(copied('Read `the code` now.', 'the code', 8)).toBe('the code');
    expect(copied('Some **bold** words here.', 'bold', 4)).toBe('bold');
    expect(copied('Some **bold** words here.', 'old', 7)).toBe('old wor');
    expect(copied('See [the paper](https://e.com/x) today.', 'the paper', 9)).toBe('the paper');
  });

  it('copies part of a table cell as its words, with no table around them', () => {
    const table = '| 问题 | 处理 |\n| --- | --- |\n| 账号被封、换厂商、换区域；系统盘没有快照 | 重建 |';
    expect(copied(table, '账号被封', 10)).toBe('账号被封、换厂商、换');
  });

  it('copies part of a list item, a heading or a fence as the words selected', () => {
    expect(copied('- 第一项里有一段比较长的文字\n- 第二项', '项里有一段', 8)).toBe('项里有一段比较长');
    expect(copied('1. first item here\n2. second', 'item', 4)).toBe('item');
    expect(copied('## A heading here', 'heading', 7)).toBe('heading');
    expect(copied('```sh\necho one\necho two\n```', 'echo one', 13)).toBe('echo one\necho');
  });

  it('keeps no markdown escape on words copied plain', () => {
    expect(copied('| a | b |\n| --- | --- |\n| 2*3 = 6 and a_b | x |', '2*3', 15)).toBe('2*3 = 6 and a_b');
  });

  it('hands rich-text targets the words with their marks and no block around them', () => {
    const table = '| a | b |\n| --- | --- |\n| some **bold** text | x |';
    const state = EditorState.create({ doc: docFromSpans(splitBlocks(table).spans) });
    let at = -1;
    state.doc.descendants((node, pos) => {
      if (at < 0 && node.isText && node.text === 'some ') at = pos;
      return true;
    });
    const selected = state.apply(state.tr.setSelection(TextSelection.create(state.doc, at, at + 12)));
    const slice = inlineCopySlice(selected)!;
    expect(slice.openStart).toBe(1);
    expect(slice.content.childCount).toBe(1);
    expect(slice.content.firstChild!.type.name).toBe('paragraph');
    expect(slice.content.firstChild!.textContent).toBe('some bold te');
  });

  it('keeps the block a whole block was copied from', () => {
    const doc = '## A heading\n\nAnd a paragraph.';
    const state = EditorState.create({ doc: docFromSpans(splitBlocks(doc).spans) });
    const all = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 0, state.doc.content.size)));
    expect(sliceToMarkdown(all.selection.content())).toBe('## A heading\n\nAnd a paragraph.');
  });

  it('copies a fence\'s code without its fence when the drag runs onto the next line\'s start', () => {
    const doc = 'Before.\n\n```bash\nnpm install\nnpm test\n```\n\nAfter.';
    const state = EditorState.create({ doc: docFromSpans(splitBlocks(doc).spans) });
    let fence = -1;
    let after = -1;
    let before = -1;
    state.doc.forEach((node, offset) => {
      if (node.type.name === 'code_block') fence = offset;
      if (node.textContent === 'After.') after = offset;
      if (node.textContent === 'Before.') before = offset;
    });
    const code = state.doc.nodeAt(fence)!;
    const select = (from: number, to: number) => {
      const selected = state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
      return inlineCopyText(selected) ?? sliceToMarkdown(selected.selection.content());
    };
    // From the code's start to the start of "After.": the code alone.
    expect(select(fence + 1, after + 1)).toBe('npm install\nnpm test');
    // From the end of "Before." into the code: the code alone.
    const beforeEnd = before + 1 + state.doc.nodeAt(before)!.content.size;
    expect(select(beforeEnd, fence + 1 + code.content.size)).toBe('npm install\nnpm test');
    // Taking a word of the next paragraph is taking two blocks, fence and all.
    expect(select(fence + 1, after + 3)).toBe('```bash\nnpm install\nnpm test\n```\n\nAf');
  });

  it('keeps the markdown of a whole line selected onto the next line\'s start, outside code', () => {
    const doc = '## Title\n\nNext.';
    const state = EditorState.create({ doc: docFromSpans(splitBlocks(doc).spans) });
    const next = state.doc.child(0).nodeSize;
    const selected = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, next + 1)));
    expect(inlineCopyText(selected)).toBeNull();
    expect(sliceToMarkdown(selected.selection.content()).trimEnd()).toBe('## Title');
  });

  it('copies the code of a fence inside a list item without its fence', () => {
    const doc = '- item\n\n  ```sh\n  ls -la\n  ```\n\n  after\n';
    const state = EditorState.create({ doc: docFromSpans(splitBlocks(doc).spans) });
    let fence = -1;
    let after = -1;
    state.doc.descendants((node, pos) => {
      if (node.type.name === 'code_block') fence = pos;
      if (node.isTextblock && node.textContent === 'after') after = pos;
      return true;
    });
    expect(fence).toBeGreaterThan(0);
    expect(after).toBeGreaterThan(fence);
    const selected = state.apply(state.tr.setSelection(TextSelection.create(state.doc, fence + 1, after + 1)));
    expect(inlineCopyText(selected)).toBe('ls -la');
  });

  it('gives nothing back for an empty selection', () => {
    const state = EditorState.create({ doc: docFromSpans(splitBlocks('text').spans) });
    expect(sliceToMarkdown(state.selection.content())).toBe('');
  });
});

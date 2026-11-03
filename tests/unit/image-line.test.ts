/**
 * Which paragraphs stand a picture on a line of its own.
 *
 * Pinned through the plugin's decorations on a real state, so what is tested
 * is what the stylesheet will see: the class on the paragraph or its absence.
 */

import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import type { Node as ProseNode } from 'prosemirror-model';
import { notoSchema } from '../../src/shared/markdown/v3/pm/schema';
import { IMAGE_LINE_CLASS, imageLineKey, imageLinePlugin, isImageLine } from '../../src/renderer/editor/noto/image-line';

const { nodes } = notoSchema;
const image = (src = 'a.png') => nodes.image.create({ src });
const tag = (html: string) => nodes.inline_html.create({ value: html });
const text = (value: string) => notoSchema.text(value);
const paragraph = (...children: ProseNode[]) => nodes.paragraph.create(null, children);

function centred(...blocks: ProseNode[]): boolean[] {
  const doc = nodes.doc.create(null, blocks);
  const state = EditorState.create({ doc, plugins: [imageLinePlugin()] });
  const set = imageLineKey.getState(state)!;
  const result: boolean[] = [];
  doc.forEach((block, offset) => {
    // `find` also returns a decoration that only touches the range, so the
    // span has to lie inside this block: its own, or a paragraph within it.
    const end = offset + block.nodeSize;
    result.push(set.find(offset, end).some((d) => d.from >= offset && d.to <= end && d.from < end
      && (d as unknown as { type: { attrs: { class: string } } }).type.attrs.class === IMAGE_LINE_CLASS));
  });
  return result;
}

describe('a picture on a line of its own', () => {
  it('centres a paragraph that is only a picture, or pictures with breaks and spaces between them', () => {
    expect(isImageLine(paragraph(image()))).toBe(true);
    expect(isImageLine(paragraph(image(), nodes.hard_break.create(), image('b.png')))).toBe(true);
    expect(isImageLine(paragraph(image(), text(' '), image('b.png')))).toBe(true);
  });

  it('counts the <img> tag Typora pastes, and only a tag that is a picture', () => {
    expect(isImageLine(paragraph(tag('<img src="a.png" alt="x" style="zoom:50%;" />')))).toBe(true);
    expect(isImageLine(paragraph(tag('<span>not a picture</span>')))).toBe(false);
  });

  it('leaves a picture with words beside it in their run', () => {
    expect(isImageLine(paragraph(text('Before '), image()))).toBe(false);
    expect(isImageLine(paragraph(image(), text(' after')))).toBe(false);
    expect(isImageLine(paragraph(text('only words')))).toBe(false);
    expect(isImageLine(paragraph())).toBe(false);
  });

  it('marks the paragraph at the top of the note and in a quote, and not in a list', () => {
    const quote = nodes.blockquote.create(null, [paragraph(image())]);
    const list = nodes.bullet_list.create(null, [nodes.list_item.create(null, [paragraph(image())])]);
    expect(centred(paragraph(image()), paragraph(text('words')), quote, list)).toEqual([true, false, true, false]);
  });

  it('follows an edit: words typed beside the picture take the centring off, and deleting them puts it back', () => {
    const doc = nodes.doc.create(null, [paragraph(image())]);
    let state = EditorState.create({ doc, plugins: [imageLinePlugin()] });
    const has = () => imageLineKey.getState(state)!.find().length > 0;
    expect(has()).toBe(true);
    state = state.apply(state.tr.insertText(' caption', 2));
    expect(has()).toBe(false);
    state = state.apply(state.tr.delete(2, 2 + ' caption'.length));
    expect(has()).toBe(true);
  });
});

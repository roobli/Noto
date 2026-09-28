/**
 * Pasted text is markdown, and is read as such.
 *
 * Typora reads a pasted `# Heading` as a heading, and so does anyone who
 * copies a note out of a terminal, a chat, or another editor. ProseMirror's
 * own text paste made paragraphs of the lines, hashes and all. The text is
 * split into blocks the way a file is and each block is parsed, so what
 * arrives is what the same text would be as a note. Inside a fence or maths
 * the text is source and stays exactly as it was.
 *
 * The slice is open at an end that is a paragraph, so one pasted sentence
 * joins the paragraph the caret is in rather than making a new one, which
 * is what a paste in the middle of a sentence means.
 */

import { Fragment, Slice, type ResolvedPos } from 'prosemirror-model';
import { splitBlocks } from '../../../shared/markdown/v3/blocks';
import { blocksFromSpans } from '../../../shared/markdown/v3/pm/from-mdast';
import { notoSchema } from '../../../shared/markdown/v3/pm/schema';

const toLf = (text: string): string => text.replace(/\r\n?/g, '\n');

export function sliceFromText(text: string, $context: ResolvedPos): Slice {
  const normalised = toLf(text);
  if ($context.parent.type.spec.code === true) {
    return normalised.length === 0
      ? Slice.empty
      : new Slice(Fragment.from(notoSchema.text(normalised)), 0, 0);
  }
  const nodes = blocksFromSpans(splitBlocks(normalised).spans);
  if (nodes.length === 0) return Slice.empty;
  const paragraph = notoSchema.nodes.paragraph;
  if (nodes.length === 1 && nodes[0].type === paragraph && !normalised.includes('\n')) {
    // One line, pasted into a line: the spaces at its ends are part of what
    // was copied, and markdown's parser, which reads a paragraph, drops them.
    // "and then " pasted before "after" has to keep its space.
    const leading = /^[ \t]+/.exec(normalised)?.[0] ?? '';
    const trailing = /[ \t]+$/.exec(normalised)?.[0] ?? '';
    const inline = [
      ...(leading ? [notoSchema.text(leading)] : []),
      ...nodes[0].content.content,
      ...(trailing ? [notoSchema.text(trailing)] : []),
    ];
    return new Slice(Fragment.from(paragraph.create(null, inline)), 1, 1);
  }
  const openStart = nodes[0].type === paragraph ? 1 : 0;
  const openEnd = nodes[nodes.length - 1].type === paragraph ? 1 : 0;
  return new Slice(Fragment.from(nodes), openStart, openEnd);
}

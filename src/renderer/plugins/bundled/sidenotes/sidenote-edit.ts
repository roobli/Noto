/**
 * Finding, writing and removing sidenotes in a ProseMirror document.
 *
 * Each note is inline HTML nodes and text in a paragraph, so writing one is a
 * matter of inserting tag nodes in the right places and removing one of
 * deleting them again. Kept apart from the plugin that draws them so the
 * document side is tested without a view.
 */

import type { Node as ProseNode } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import { notoSchema } from '../../../../shared/markdown/v3/pm/schema';
import {
  SIDENOTE_TAG_CLOSE,
  SIDENOTE_TAG_OPEN,
  SIDENOTE_TARGET_OPEN,
  sidenoteRangesInBlock,
  type SidenoteChild,
  type SidenoteRange,
} from './sidenote';

const { nodes } = notoSchema;

function childrenOf(block: ProseNode): SidenoteChild[] {
  const children: SidenoteChild[] = [];
  block.forEach((child) => {
    children.push(child.type === nodes.inline_html
      ? { type: 'inline_html', value: child.attrs.value as string, size: child.nodeSize }
      : { type: child.type.name, size: child.nodeSize });
  });
  return children;
}

/** Every note in the document, numbered in reading order. */
export function rangesInDoc(doc: ProseNode): SidenoteRange[] {
  const ranges: SidenoteRange[] = [];
  let index = 0;
  doc.descendants((node, position) => {
    if (!node.isTextblock || node.type.spec.code) return !node.isTextblock;
    const found = sidenoteRangesInBlock(childrenOf(node), position + 1, index);
    if (found.length > 0) {
      ranges.push(...found);
      index = found[found.length - 1]!.index;
    }
    return false;
  });
  return ranges;
}

/** Whether a text block holds a note's opening tag, for the cheap check before a full pass. */
export function blockHasSidenote(block: ProseNode): boolean {
  return sidenoteRangesInBlock(childrenOf(block), 0, 0).length > 0;
}

/** Where a note's words begin: its target's text, or the note's own text when it has none. */
export function sidenoteStart(range: SidenoteRange): number {
  return range.target ? range.target.contentFrom : range.contentFrom;
}

/** The note whose target or text holds `pos`, edges included. */
export function sidenoteAt(ranges: readonly SidenoteRange[], pos: number): SidenoteRange | null {
  return ranges.find((range) => pos >= sidenoteStart(range) && pos <= range.contentTo) ?? null;
}

/**
 * The words a note can be put on, trimmed of the spaces at either end, or
 * null where one cannot go: across paragraphs, in code, over nothing but
 * spaces, or over part of a note already there, since one note does not nest
 * in another.
 */
export function noteableRange(state: EditorState, from: number, to: number): { from: number; to: number } | null {
  const $from = state.doc.resolve(from);
  if (!$from.parent.isTextblock || $from.parent.type.spec.code || !$from.sameParent(state.doc.resolve(to))) return null;
  // One placeholder per inline node, so offsets in the text are positions.
  const text = state.doc.textBetween(from, to, '', '￼');
  let start = from;
  let end = to;
  while (start < end && /\s/.test(text[start - from]!)) start += 1;
  while (end > start && /\s/.test(text[end - from - 1]!)) end -= 1;
  if (start === end) return null;

  // Any span tag inside the words, a note's or another: its `</span>` would
  // close the target early and part the words from their note.
  let tagged = false;
  state.doc.nodesBetween(start, end, (node) => {
    if (node.type === nodes.inline_html && /^<\/?span\b/i.test((node.attrs.value as string).trim())) tagged = true;
  });
  if (tagged) return null;
  const overlaps = rangesInDoc(state.doc).some((range) =>
    start < range.closeTo && end > (range.target ? range.target.openFrom : range.openFrom));
  return overlaps ? null : { from: start, to: end };
}

/**
 * Write a note with `body` as its text: around the words from `from` to `to`
 * as its target, or on its own at `from` when the two are equal. Returns the
 * position just after the note, where the caret goes.
 */
export function insertSidenote(tr: Transaction, from: number, to: number, body: string): number {
  const tag = (value: string) => nodes.inline_html.create({ value });
  const note = [tag(SIDENOTE_TAG_OPEN), notoSchema.text(body), tag(SIDENOTE_TAG_CLOSE)];
  if (from === to) {
    tr.insert(from, note);
    return from + body.length + 2;
  }
  tr.insert(to, [tag(SIDENOTE_TAG_CLOSE), ...note]);
  tr.insert(from, tag(SIDENOTE_TARGET_OPEN));
  return to + body.length + 4;
}

/** Take a note out, its text with it, and unwrap its target, keeping the target's words. */
export function removeSidenote(tr: Transaction, range: SidenoteRange): void {
  // Back to front, so each deletion leaves the earlier positions where they were.
  tr.delete(range.openFrom, range.closeTo);
  if (range.target) {
    tr.delete(range.target.closeFrom, range.target.closeTo);
    tr.delete(range.target.openFrom, range.target.openTo);
  }
}

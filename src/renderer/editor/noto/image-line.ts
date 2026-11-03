/**
 * A picture on a line of its own, centred.
 *
 * A paragraph that holds nothing but pictures, a markdown image or a lone
 * `<img>` tag with only breaks and spaces between them, carries
 * `noto-image-line`, and the stylesheet centres it. A picture with words
 * beside it stays in the run of the text where the author put it.
 *
 * A decoration rather than a selector, because the paragraph's text is bare
 * text nodes: `:only-child` does not count them, so a picture after a
 * sentence looks to CSS exactly like a picture alone.
 *
 * Only paragraphs at the top of the note and inside a quote or a callout. In
 * a list item the picture belongs to its bullet, and in a table to its cell;
 * centring it there would pull it away from what it hangs from.
 *
 * Kept up to date incrementally, as the alert decorations are: a change
 * rechecks only the top-level blocks it touched, so a keystroke in a long note
 * does not walk the whole document.
 */

import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import type { Node as ProseNode } from 'prosemirror-model';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { parseImageTag } from './html-image';

export const IMAGE_LINE_CLASS = 'noto-image-line';

export const imageLineKey = new PluginKey<DecorationSet>('noto-image-line');

/** Whether a paragraph holds pictures and nothing else that shows. */
export function isImageLine(node: ProseNode): boolean {
  if (node.type.name !== 'paragraph') return false;
  let pictures = 0;
  let alone = true;
  node.forEach((child) => {
    if (!alone) return;
    const name = child.type.name;
    if (name === 'image') pictures += 1;
    else if (name === 'inline_html' && parseImageTag(String(child.attrs.value ?? '')) !== null) pictures += 1;
    else if (name === 'hard_break') return;
    else if (child.isText && (child.text ?? '').trim() === '') return;
    else alone = false;
  });
  return alone && pictures > 0;
}

/** The containers whose own paragraphs may stand a picture on its own line. */
const CONTAINERS = new Set(['blockquote']);

function decorationsIn(doc: ProseNode, from: number, to: number): Decoration[] {
  const found: Decoration[] = [];
  doc.nodesBetween(from, to, (node, position, parent) => {
    if (node.type.name === 'paragraph') {
      const placed = parent === doc || (parent !== null && CONTAINERS.has(parent.type.name));
      if (placed && isImageLine(node)) {
        found.push(Decoration.node(position, position + node.nodeSize, { class: IMAGE_LINE_CLASS }));
      }
      return false;
    }
    return CONTAINERS.has(node.type.name);
  });
  return found;
}

/** The top-level blocks a changed range falls in, so a whole block is rechecked. */
function topLevelRange(doc: ProseNode, from: number, to: number): [number, number] {
  const size = doc.content.size;
  const start = doc.resolve(Math.max(0, Math.min(from, size)));
  const end = doc.resolve(Math.min(size, Math.max(0, to)));
  return [start.depth === 0 ? start.pos : start.before(1), end.depth === 0 ? end.pos : end.after(1)];
}

function apply(transaction: Transaction, current: DecorationSet, _old: EditorState, state: EditorState): DecorationSet {
  if (!transaction.docChanged) return current;
  let next = current.map(transaction.mapping, transaction.doc);
  transaction.mapping.maps.forEach((map, index) => {
    const rest = transaction.mapping.slice(index + 1);
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      const [from, to] = topLevelRange(state.doc, rest.map(newStart, -1), rest.map(newEnd, 1));
      const stale = next.find(from, to).filter((decoration) => decoration.from >= from && decoration.to <= to);
      if (stale.length > 0) next = next.remove(stale);
      const fresh = decorationsIn(state.doc, from, to);
      if (fresh.length > 0) next = next.add(state.doc, fresh);
    });
  });
  return next;
}

export function imageLinePlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: imageLineKey,
    state: {
      init: (_config, state) => DecorationSet.create(state.doc, decorationsIn(state.doc, 0, state.doc.content.size)),
      apply,
    },
    props: {
      decorations: (state) => imageLineKey.getState(state),
    },
  });
}

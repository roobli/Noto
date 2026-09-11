/**
 * The footnote's text, on the reference, for the pointer to find.
 *
 * Typora shows what a footnote says when the pointer rests on its number,
 * so a reader need not go to the foot of the note and back. The text is
 * put on the reference as its title, which the browser shows as a tooltip
 * with nothing more to build, and it is recomputed when the note changes so
 * the tooltip says what the footnote says now.
 */

import { Plugin, PluginKey, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as ProseNode } from 'prosemirror-model';

export const footnoteHoverKey = new PluginKey<DecorationSet>('noto-footnote-hover');

/** The most of a footnote a tooltip is asked to hold. */
const MAX_TITLE = 400;

function definitions(doc: ProseNode): Map<string, string> {
  const found = new Map<string, string>();
  doc.descendants((node) => {
    if (node.type.name === 'footnote_definition') {
      const identifier = String(node.attrs.identifier ?? '');
      const text = node.textBetween(0, node.content.size, ' ', ' ').trim();
      if (identifier && !found.has(identifier)) {
        found.set(identifier, text.length > MAX_TITLE ? `${text.slice(0, MAX_TITLE)}…` : text);
      }
      return false;
    }
    return true;
  });
  return found;
}

export function footnoteTitles(doc: ProseNode): DecorationSet {
  const texts = definitions(doc);
  if (texts.size === 0) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'footnote_reference') return true;
    const text = texts.get(String(node.attrs.identifier ?? ''));
    if (text) decorations.push(Decoration.node(pos, pos + node.nodeSize, { title: text }));
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

/** Whether the transaction's new ranges touch a footnote node. */
function changedTouchesFootnote(tr: Transaction, doc: ProseNode): boolean {
  let found = false;
  tr.mapping.maps.forEach((map, index) => {
    if (found) return;
    const rest = tr.mapping.slice(index + 1);
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      if (found) return;
      const from = rest.map(newStart, -1);
      const to = rest.map(newEnd, 1);
      doc.nodesBetween(Math.min(from, to), Math.max(from, to), (node) => {
        if (node.type.name === 'footnote_definition' || node.type.name === 'footnote_reference') {
          found = true;
          return false;
        }
        return !found;
      });
    });
  });
  return found;
}

export function footnoteHoverPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: footnoteHoverKey,
    state: {
      init: (_config, state) => footnoteTitles(state.doc),
      apply: (tr, previous) => {
        if (!tr.docChanged) return previous;
        // Notes without footnotes used to rescan the whole doc every keystroke.
        if (previous.find().length === 0 && !changedTouchesFootnote(tr, tr.doc)) return previous;
        return footnoteTitles(tr.doc);
      },
    },
    props: {
      decorations: (state) => footnoteHoverKey.getState(state) ?? null,
    },
  });
}

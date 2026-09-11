/**
 * `[TOC]` drawn as the table of contents it stands for.
 *
 * Typora draws the marker as a nested list of the note's headings, kept up
 * to date as the headings change, and a click on an entry goes to that
 * heading. Here the marker's paragraph is hidden and a widget drawn after
 * it, the way the generated index is drawn, so the file still holds the
 * four characters and nothing else. The moment the caret enters the
 * paragraph the marker is shown to edit, which is Typora's rule too.
 */

import { Plugin, PluginKey, TextSelection } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as ProseNode } from 'prosemirror-model';

export const tocBlockKey = new PluginKey<DecorationSet>('noto-toc-block');

const MARKER = /^\[toc\]$/i;

export interface TocEntry {
  readonly level: number;
  readonly text: string;
  /** The heading's index among the document's top-level blocks. */
  readonly blockIndex: number;
}

/** Every heading in order, as the list will show them. */
export function headingsOf(doc: ProseNode): TocEntry[] {
  const entries: TocEntry[] = [];
  doc.forEach((node, _offset, index) => {
    if (node.type.name === 'heading') {
      entries.push({ level: Number(node.attrs.level ?? 1), text: node.textContent, blockIndex: index });
    }
  });
  return entries;
}

/** The top-level index and position of each marker paragraph. */
export function findMarkers(doc: ProseNode): { index: number; pos: number; node: ProseNode }[] {
  const found: { index: number; pos: number; node: ProseNode }[] = [];
  doc.forEach((node, pos, index) => {
    if (node.type.name === 'paragraph' && MARKER.test(node.textContent.trim())) found.push({ index, pos, node });
  });
  return found;
}

function render(
  entries: readonly TocEntry[],
  onGo: (blockIndex: number) => void,
  onEdit: () => void,
): HTMLElement {
  const section = document.createElement('nav');
  section.className = 'noto-toc';
  section.setAttribute('contenteditable', 'false');
  section.setAttribute('aria-label', 'Table of contents');
  section.title = 'Click beside the list to edit the [TOC] marker';
  // The list is drawn in place of a paragraph the caret cannot otherwise
  // reach, since a hidden paragraph is skipped by the arrow keys. A click on
  // the list itself, not on an entry, puts the caret in the marker, which
  // is how Typora's own table of contents is edited.
  section.addEventListener('mousedown', (event) => {
    if (event.target !== section) return;
    event.preventDefault();
    onEdit();
  });
  if (entries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'noto-toc-empty';
    empty.textContent = 'No headings yet.';
    section.append(empty);
    return section;
  }
  // The shallowest heading sets the left edge, so a note whose headings all
  // start at h2 is not indented one level for nothing.
  const shallowest = Math.min(...entries.map((entry) => entry.level));
  for (const entry of entries) {
    const line = document.createElement('button');
    line.type = 'button';
    line.className = 'noto-toc-item';
    line.style.setProperty('--toc-depth', String(entry.level - shallowest));
    line.textContent = entry.text.length > 0 ? entry.text : '(untitled)';
    line.addEventListener('mousedown', (event) => event.preventDefault());
    line.addEventListener('click', () => onGo(entry.blockIndex));
    section.append(line);
  }
  return section;
}

function decorate(doc: ProseNode, selFrom: number, selTo: number, onGo: (blockIndex: number) => void): DecorationSet {
  const markers = findMarkers(doc);
  if (markers.length === 0) return DecorationSet.empty;
  const entries = headingsOf(doc);
  const decorations: Decoration[] = [];
  for (const marker of markers) {
    const end = marker.pos + marker.node.nodeSize;
    // The caret inside the marker shows the marker.
    if (selFrom <= end && selTo >= marker.pos) continue;
    decorations.push(Decoration.node(marker.pos, end, { class: 'noto-toc-source' }));
    decorations.push(Decoration.widget(end, (view, getPos) => render(entries, onGo, () => {
      const pos = getPos();
      if (pos === undefined) return;
      // Just inside the marker's paragraph, at its end.
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos - 1)).scrollIntoView());
      view.focus();
    }), {
      side: 1,
      key: `noto-toc:${marker.pos}:${entries.map((entry) => `${entry.level}${entry.text}`).join('|')}`,
    }));
  }
  return DecorationSet.create(doc, decorations);
}

export function tocBlockPlugin(options: { onGo: (blockIndex: number) => void }): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: tocBlockKey,
    state: {
      init: (_config, state) => decorate(state.doc, state.selection.from, state.selection.to, options.onGo),
      apply: (tr, previous, _old, state) => {
        if (!tr.docChanged && !tr.selectionSet) return previous;
        // Notes without a [TOC] marker used to walk every top-level block on
        // each keystroke just to discover they still had none.
        if (previous.find().length === 0 && tr.docChanged) {
          let introduced = false;
          tr.mapping.maps.forEach((map, index) => {
            if (introduced) return;
            const rest = tr.mapping.slice(index + 1);
            map.forEach((_a, _b, newStart, newEnd) => {
              if (introduced) return;
              const from = rest.map(newStart, -1);
              const to = rest.map(newEnd, 1);
              state.doc.nodesBetween(Math.min(from, to), Math.max(from, to), (node) => {
                if (node.type.name === 'paragraph' && MARKER.test(node.textContent.trim())) {
                  introduced = true;
                }
                return false;
              });
            });
          });
          if (!introduced) return previous;
        } else if (previous.find().length === 0 && !tr.docChanged) {
          return previous;
        }
        return decorate(state.doc, state.selection.from, state.selection.to, options.onGo);
      },
    },
    props: {
      decorations: (state) => tocBlockKey.getState(state) ?? null,
    },
  });
}

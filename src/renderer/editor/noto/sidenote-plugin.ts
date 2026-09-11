/**
 * Draws `<span class="sidenote">` (and `marginnote`) as numbered margin notes.
 *
 * Everything here is a decoration. The file keeps every tag; the editor hides
 * them while the caret is elsewhere, paints a superscript number and the note
 * itself, and shows the tags again, muted, while the selection touches the
 * block — the same rule the other inline HTML syntax follows.
 *
 * Numbers run across the whole document, so any edit or caret move that could
 * change what is drawn rescans it. A note holds a handful of sidenotes, so the
 * pass is cheap beside a parse.
 */

import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Node as ProseNode } from 'prosemirror-model';
import {
  SIDENOTE_CLASS,
  SIDENOTE_MARKER_CLASS,
  sidenoteRangesInBlock,
  type SidenoteRange,
} from './sidenote';

export const sidenoteKey = new PluginKey<DecorationSet>('noto-sidenote');
export const SIDENOTE_RESCAN = 'rescan';

interface TagChild {
  readonly type: string;
  readonly value?: string;
  readonly size: number;
}

function childrenOf(block: ProseNode): TagChild[] {
  const children: TagChild[] = [];
  block.forEach((child) => {
    if (child.type.name === 'inline_html') {
      children.push({ type: 'inline_html', value: child.attrs.value as string, size: child.nodeSize });
    } else {
      children.push({ type: child.type.name, size: child.nodeSize });
    }
  });
  return children;
}

function rangesInDoc(doc: ProseNode): SidenoteRange[] {
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

function markerWidget(index: number): HTMLElement {
  const marker = document.createElement('span');
  marker.className = SIDENOTE_MARKER_CLASS;
  marker.setAttribute('data-sidenote-index', String(index));
  marker.setAttribute('contenteditable', 'false');
  marker.setAttribute('aria-hidden', 'true');
  return marker;
}

function touches(state: EditorState, from: number, to: number): boolean {
  const { from: selFrom, to: selTo } = state.selection;
  return selFrom <= to && selTo >= from;
}

function decorationsFor(
  state: EditorState,
  ranges: readonly SidenoteRange[],
): Decoration[] {
  const decorations: Decoration[] = [];
  const editingBlocks = new Set<number>();

  for (const range of ranges) {
    const $open = state.doc.resolve(range.openFrom);
    const blockPos = $open.before($open.depth);
    const block = $open.node($open.depth);
    const editing = touches(state, blockPos, blockPos + block.nodeSize);
    if (editing) editingBlocks.add(blockPos);

    decorations.push(Decoration.node(range.openFrom, range.openTo, {
      class: 'noto-inline-tag noto-sidenote-tag',
    }));
    decorations.push(Decoration.node(range.closeFrom, range.closeTo, {
      class: 'noto-inline-tag noto-sidenote-tag',
    }));

    if (!editing) {
      decorations.push(Decoration.widget(range.openFrom, () => markerWidget(range.index), {
        side: -1,
        key: `sidenote-num-${range.index}-${range.openFrom}`,
      }));
    }

    if (range.contentTo > range.contentFrom) {
      decorations.push(Decoration.inline(range.contentFrom, range.contentTo, {
        class: SIDENOTE_CLASS,
        'data-sidenote-index': String(range.index),
      }));
    }
  }

  for (const position of editingBlocks) {
    const block = state.doc.nodeAt(position);
    if (block) {
      decorations.push(Decoration.node(position, position + block.nodeSize, {
        class: 'noto-sidenote-editing',
      }));
    }
  }
  return decorations;
}

function fullScan(state: EditorState): DecorationSet {
  const ranges = rangesInDoc(state.doc);
  const list = decorationsFor(state, ranges);
  return list.length > 0 ? DecorationSet.create(state.doc, list) : DecorationSet.empty;
}

function changedMayAddSidenote(tr: Transaction, state: EditorState): boolean {
  let found = false;
  tr.mapping.maps.forEach((map, index) => {
    if (found) return;
    const rest = tr.mapping.slice(index + 1);
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      if (found) return;
      const from = rest.map(newStart, -1);
      const to = rest.map(newEnd, 1);
      state.doc.nodesBetween(Math.min(from, to), Math.max(from, to), (node, position) => {
        if (!node.isTextblock || node.type.spec.code) return !node.isTextblock;
        if (sidenoteRangesInBlock(childrenOf(node), position + 1, 0).length > 0) {
          found = true;
        }
        return false;
      });
    });
  });
  return found;
}

function apply(
  tr: Transaction,
  set: DecorationSet,
  oldState: EditorState,
  state: EditorState,
): DecorationSet {
  if (!tr.docChanged && !tr.selectionSet) return set;
  // Numbers run across the whole document, so an edit that could add or
  // remove a note forces a full pass. An empty set stays empty on caret
  // moves and on edits that do not introduce a sidenote tag: most notes
  // have none, and a full descendants walk was on the caret-in-viewport path.
  if (set.find().length === 0) {
    if (!tr.docChanged) return set;
    if (!changedMayAddSidenote(tr, state)) return set;
  }
  if (tr.docChanged || tr.selectionSet) return fullScan(state);
  return set.map(tr.mapping, tr.doc);
}

/**
 * `enabled` is read at each scan rather than captured, so the preference
 * switch takes effect without rebuilding the editor.
 */
export function sidenotePlugin(enabled: () => boolean = () => true): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: sidenoteKey,
    state: {
      init: (_config, state) => (enabled() ? fullScan(state) : DecorationSet.empty),
      apply: (tr, set, oldState, state) => {
        if (tr.getMeta(sidenoteKey) === SIDENOTE_RESCAN) {
          return enabled() ? fullScan(state) : DecorationSet.empty;
        }
        if (!enabled()) return DecorationSet.empty;
        return apply(tr, set, oldState, state);
      },
    },
    props: {
      decorations(state) {
        return this.getState(state) ?? DecorationSet.empty;
      },
    },
    view() {
      let known: boolean | null = null;
      return {
        update(view: EditorView) {
          const host = view.dom.closest('.noto-editor-host') ?? view.dom;
          // Derive from the decoration set already computed for this state —
          // do not walk the document again on every keystroke.
          const set = sidenoteKey.getState(view.state);
          const has = enabled() && !!set && set.find().length > 0;
          if (has === known) return;
          known = has;
          host.classList.toggle('noto-has-sidenotes', has);
        },
        destroy() {
          /* the host is torn down with the editor */
        },
      };
    },
  });
}

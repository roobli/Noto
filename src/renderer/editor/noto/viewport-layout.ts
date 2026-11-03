/**
 * Long-document painting without breaking markdown input rules.
 *
 * Layout dominates a keystroke on a multi-megabyte file (see
 * `docs/performance/measurements.md`). Blanket `content-visibility: auto` on
 * every top-level block cut that cost by about forty percent on the two
 * megabyte corpus, and then broke input rules: the property implies style
 * containment, and with that set on the block being typed into ProseMirror can
 * no longer read the DOM back after a keystroke. Heading and task markers stop
 * converting.
 *
 * The fix is the same paint deferral, applied only to blocks that are not
 * being edited. Off-screen blocks keep `content-visibility: auto` from the
 * stylesheet; the blocks around the selection carry `noto-layout-live`, which
 * forces them fully painted. The active-block class already marks the selection
 * for other reasons; this plugin widens that to a two-block neighbourhood so a
 * split, a join, or a one-step block move still has a fully painted
 * neighbour for the DOM read and on-screen paint.
 *
 * This is not a virtual scroller. The DOM still holds every block. What it
 * removes is the engine's obligation to lay out and paint the ones nobody can
 * see. Far-off blocks are dropped from the tree by `viewport-stub.ts` once a
 * document is large enough that DOM size itself dominates a keystroke.
 */

import { Plugin, PluginKey, type EditorState, type Selection } from 'prosemirror-state';
import type { Node as ProseNode } from 'prosemirror-model';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';

export const viewportLayoutKey = new PluginKey<DecorationSet>('noto-viewport-layout');

/** Forced fully painted; paired with the rule in `noto-editor.scss`. */
export const LAYOUT_LIVE_CLASS = 'noto-layout-live';

/**
 * How many top-level neighbours of the selection stay fully painted.
 *
 * One neighbour is enough for a split or a join to still have a painted
 * sibling for the DOM read. Two is what a block move needs: after Alt+Up
 * swaps a paragraph with the one above, the paragraph that used to sit
 * immediately below is now two indices away from the selection, and with
 * only radius 1 Chromium's `content-visibility: auto` leaves it unpainted
 * (empty `innerText`, 1.6em intrinsic gap) even while it stays on screen.
 */
export const LAYOUT_LIVE_RADIUS = 2;

/**
 * Top-level block indices that must stay fully painted.
 *
 * The selection's own blocks, plus `radius` neighbours on each side. Indices
 * rather than positions, so a later decoration pass can walk the doc once.
 */
export function liveTopLevelIndices(
  doc: ProseNode,
  selection: Selection,
  radius: number = LAYOUT_LIVE_RADIUS,
): number[] {
  const last = doc.childCount - 1;
  if (last < 0) return [];

  let fromIndex = selection.$from.index(0);
  let toIndex = selection.$to.index(0);
  if (fromIndex > toIndex) {
    const swap = fromIndex;
    fromIndex = toIndex;
    toIndex = swap;
  }

  const start = Math.max(0, fromIndex - radius);
  const end = Math.min(last, toIndex + radius);
  const indices: number[] = [];
  for (let index = start; index <= end; index += 1) indices.push(index);
  return indices;
}

/**
 * How many blocks keep the height they were last painted at. A block is kept
 * by its node, which an edit replaces, so the entries are the blocks a reader
 * has visited and not changed since; the oldest go first.
 */
const PAINTED_LIMIT = 512;

/*
 * The height a block had while it was painted, kept for when it is skipped.
 *
 * A block that leaves the painted set goes back to `content-visibility: auto`
 * and, off screen, is drawn at its intrinsic size: the browser's last
 * remembered size if it recorded one, else the one-line guess. On macOS the
 * browser lays every block out once when a note opens and remembers them all.
 * On Windows and Linux it skips the blocks off screen from the start, and the
 * blocks painted since the note opened (frontmatter, an opening fence) came
 * back at the guess when the caret left them: everything below rose by the
 * difference and a click far down the note scrolled the page. Each block now
 * carries the height it was painted at as the fallback after `auto`, so the
 * browser's own memory still wins where it has one, and the guess is only for
 * a block nobody has seen.
 */
function liveDecorations(state: EditorState, painted: ReadonlyMap<ProseNode, number>): DecorationSet {
  const indices = liveTopLevelIndices(state.doc, state.selection);
  if (indices.length === 0 && painted.size === 0) return DecorationSet.empty;

  const decorations: Decoration[] = [];
  let position = 0;
  let index = 0;
  const wanted = new Set(indices);
  state.doc.forEach((child) => {
    if (wanted.has(index)) {
      decorations.push(Decoration.node(position, position + child.nodeSize, {
        class: LAYOUT_LIVE_CLASS,
      }));
    } else {
      const height = painted.get(child);
      if (height !== undefined) {
        decorations.push(Decoration.node(position, position + child.nodeSize, {
          style: `contain-intrinsic-size: auto ${height}px`,
        }));
      }
    }
    position += child.nodeSize;
    index += 1;
  });
  return DecorationSet.create(state.doc, decorations);
}

export function viewportLayoutPlugin(): Plugin<DecorationSet> {
  // Per editor: each editor builds its own plugin.
  const painted = new Map<ProseNode, number>();
  const remember = (node: ProseNode, height: number) => {
    painted.delete(node);
    painted.set(node, height);
    if (painted.size > PAINTED_LIMIT) painted.delete(painted.keys().next().value as ProseNode);
  };
  /*
   * Measured while painted: a block as it joins the set, and the block being
   * typed in after each change. One or two blocks per update, and only those,
   * since reading a height makes the browser lay out what changed.
   */
  const measure = (view: EditorView, indices: readonly number[]) => {
    for (const index of indices) {
      if (index >= view.state.doc.childCount) continue;
      let position = 0;
      for (let before = 0; before < index; before += 1) position += view.state.doc.child(before).nodeSize;
      const dom = view.nodeDOM(position);
      if (!(dom instanceof HTMLElement)) continue;
      // The intrinsic size is the content box's, so padding and border come off.
      const style = getComputedStyle(dom);
      const frame = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth']
        .reduce((sum, key) => sum + (Number.parseFloat(style[key as 'paddingTop']) || 0), 0);
      const height = dom.getBoundingClientRect().height - frame;
      if (height > 0) remember(view.state.doc.child(index), Math.round(height * 100) / 100);
    }
  };
  return new Plugin<DecorationSet>({
    key: viewportLayoutKey,
    state: {
      init: (_config, state) => liveDecorations(state, painted),
      apply: (transaction, previous, _oldState, newState) =>
        (transaction.docChanged || transaction.selectionSet ? liveDecorations(newState, painted) : previous),
    },
    props: {
      decorations: (state) => viewportLayoutKey.getState(state),
    },
    view: (view) => {
      let measured = new Set(liveTopLevelIndices(view.state.doc, view.state.selection));
      measure(view, [...measured]);
      return {
        update: (current, previous) => {
          if (current.state.doc === previous.doc && current.state.selection.eq(previous.selection)) return;
          const live = liveTopLevelIndices(current.state.doc, current.state.selection);
          const due = new Set(live.filter((index) => !measured.has(index)));
          // After an edit, the block typed in has a new height too.
          if (current.state.doc !== previous.doc) {
            due.add(current.state.selection.$from.index(0));
            due.add(current.state.selection.$to.index(0));
          }
          if (due.size > 0) measure(current, [...due]);
          measured = new Set(live);
        },
      };
    },
  });
}

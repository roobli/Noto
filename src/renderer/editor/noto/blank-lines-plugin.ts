/**
 * The reader's own blank lines between blocks, kept and shown.
 *
 * Markdown reads any number of blank lines as one break, and an empty
 * paragraph has no markdown of its own, so empty lines typed between two
 * blocks were dropped on save and a file's extra blank lines were drawn as an
 * ordinary break. Someone who leaves three blank lines before a new section
 * means something by it. Now:
 *
 * - A file's extra blank lines are drawn as the space they take (a widget
 *   before the block, so the document's blocks stay one to one with the
 *   file's), and saved as they were while nobody touches that gap.
 * - Empty lines typed between two blocks are saved as that many more blank
 *   lines (`NotoUnit.blankLinesBefore`, set by the capture).
 * - A gap is taken over by its empty paragraphs the moment the reader changes
 *   it: typing an empty line where the file already had extra blank lines
 *   turns those into empty paragraphs too, so they add up, and Backspace at the
 *   start of a block below extra blank lines takes one of them away. From then
 *   until the next save the gap is exactly its empty paragraphs (`explicit`).
 *
 * The very start and end of the note are left alone: blank lines there carry
 * no meaning between two things, and the save keeps or drops them as before.
 */

import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Node as ProseNode } from 'prosemirror-model';
import { getBlockOrigins, originKey } from './origin-plugin';
import { isUnwritableBlock } from './capture';

/** Blank lines the accepted file has after the block at `ordinal`; one for a plain break. */
export type GapLines = (ordinal: number) => number;

interface BlankLinesState {
  /** Origin block ids of blocks whose gap above is exactly the empty paragraphs before them. */
  readonly explicit: ReadonlySet<string>;
  readonly decorations: DecorationSet;
}

export const blankLinesKey = new PluginKey<BlankLinesState>('noto-blank-lines');

const isEmptyLine = (node: ProseNode): boolean => node.type.name === 'paragraph' && isUnwritableBlock(node);

interface Gap {
  /** Top-level index of the block below the gap. */
  readonly index: number;
  /** Its position in the document. */
  readonly pos: number;
  readonly blockId: string;
  /** Empty paragraphs between it and the written block above. */
  readonly empties: number;
  /** Position just after the written block above. */
  readonly afterAbove: number;
  /** Extra blank lines the file has there, when the two blocks are neighbours in it; 0 otherwise. */
  readonly extra: number;
}

/** Every gap between two written blocks, top to bottom. */
function gapsOf(state: EditorState, gapLines: GapLines): Gap[] {
  const origins = getBlockOrigins(state);
  const gaps: Gap[] = [];
  let above: { ordinal: number | null; end: number } | null = null;
  let empties = 0;
  state.doc.forEach((node, offset, index) => {
    if (isUnwritableBlock(node)) {
      if (isEmptyLine(node) && above) empties += 1;
      return;
    }
    const origin = origins[index] ?? null;
    if (above && origin) {
      const neighbours = above.ordinal !== null && above.ordinal === origin.ordinal - 1;
      gaps.push({
        index,
        pos: offset,
        blockId: origin.blockId,
        empties,
        afterAbove: above.end,
        extra: neighbours ? Math.max(0, gapLines(above.ordinal!) - 1) : 0,
      });
    }
    above = { ordinal: origin?.ordinal ?? null, end: offset + node.nodeSize };
    empties = 0;
  });
  return gaps;
}

function spacer(lines: number): HTMLElement {
  const element = document.createElement('div');
  element.className = 'noto-blank-lines';
  element.contentEditable = 'false';
  element.setAttribute('aria-hidden', 'true');
  element.style.setProperty('--blank-lines', String(lines));
  element.dataset.lines = String(lines);
  return element;
}

function decorate(state: EditorState, explicit: ReadonlySet<string>, gapLines: GapLines): DecorationSet {
  const decorations: Decoration[] = [];
  for (const gap of gapsOf(state, gapLines)) {
    if (gap.extra === 0 || gap.empties > 0 || explicit.has(gap.blockId)) continue;
    decorations.push(Decoration.widget(gap.pos, () => spacer(gap.extra), {
      side: -1, ignoreSelection: true, key: `blank:${gap.blockId}:${gap.extra}`,
    }));
  }
  return DecorationSet.create(state.doc, decorations);
}

/** Empty paragraphs before the block whose origin is `blockId`, in `state`; null when it is not there. */
function emptiesBefore(state: EditorState, blockId: string): number | null {
  const origins = getBlockOrigins(state);
  const index = origins.findIndex((origin) => origin?.blockId === blockId);
  if (index < 0) return null;
  let count = 0;
  for (let at = index - 1; at >= 0 && isUnwritableBlock(state.doc.child(at)); at -= 1) {
    if (isEmptyLine(state.doc.child(at))) count += 1;
  }
  return count;
}

const isRebase = (transaction: Transaction): boolean => transaction.getMeta(originKey) !== undefined;

/** Top-level indices, in the final document, of what the transactions' steps touched. */
function touchedTopLevel(transactions: readonly Transaction[], doc: ProseNode): number[] {
  const touched = new Set<number>();
  const size = doc.content.size;
  transactions.forEach((transaction, which) => {
    const maps = transaction.mapping.maps;
    maps.forEach((map, step) => {
      map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
        let from = newStart;
        let to = newEnd;
        for (let later = step + 1; later < maps.length; later += 1) { from = maps[later]!.map(from, -1); to = maps[later]!.map(to, 1); }
        for (const after of transactions.slice(which + 1)) { from = after.mapping.map(from, -1); to = after.mapping.map(to, 1); }
        const first = doc.resolve(Math.max(0, Math.min(from, size))).index(0);
        const last = doc.resolve(Math.max(0, Math.min(to, size))).index(0);
        for (let index = first; index <= Math.min(last, doc.childCount - 1); index += 1) touched.add(index);
      });
    });
  });
  return [...touched];
}

/** The explicit set, for the capture: these gaps are their empty paragraphs and nothing more. */
export function explicitGaps(state: EditorState): ReadonlySet<string> {
  return blankLinesKey.getState(state)?.explicit ?? new Set();
}

export function blankLinesPlugin(gapLines: () => GapLines): Plugin<BlankLinesState> {
  return new Plugin<BlankLinesState>({
    key: blankLinesKey,
    state: {
      init: (_config, state) => ({ explicit: new Set(), decorations: decorate(state, new Set(), gapLines()) }),
      apply(transaction, previous, oldState, newState) {
        const meta = transaction.getMeta(blankLinesKey) as { explicit: readonly string[] } | undefined;
        // A save rebases every block onto the new revision, whose gaps are
        // what the reader made: nothing is explicit any more.
        let explicit = isRebase(transaction) ? new Set<string>() : previous.explicit;
        if (meta) explicit = new Set([...explicit, ...meta.explicit]);
        const structural = isRebase(transaction) || meta !== undefined
          || (transaction.docChanged && oldState.doc.childCount !== newState.doc.childCount);
        const decorations = structural
          ? decorate(newState, explicit, gapLines())
          : previous.decorations.map(transaction.mapping, transaction.doc);
        return { explicit, decorations };
      },
    },
    props: {
      decorations: (state) => blankLinesKey.getState(state)?.decorations ?? null,
      handleKeyDown(view: EditorView, event: KeyboardEvent) {
        if (event.key !== 'Backspace' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
        return takeOneBlankLine(view, gapLines());
      },
    },
    appendTransaction(transactions, oldState, newState) {
      if (!transactions.some((transaction) => transaction.docChanged) || transactions.some(isRebase)) return null;
      // Typing inside a block leaves every gap as it was. Only a change in the
      // number of blocks, or a block becoming empty or not, can touch one, and
      // checking just the blocks the steps touched keeps a keystroke cheap.
      if (oldState.doc.childCount === newState.doc.childCount
        && touchedTopLevel(transactions, newState.doc).every((index) => index >= oldState.doc.childCount
          || isEmptyLine(newState.doc.child(index)) === isEmptyLine(oldState.doc.child(index)))) return null;
      const explicit = explicitGaps(newState);
      const gaps = gapsOf(newState, gapLines());
      const taken: string[] = [];
      const materialize: { at: number; count: number }[] = [];
      for (const gap of gaps) {
        if (explicit.has(gap.blockId)) continue;
        const before = emptiesBefore(oldState, gap.blockId);
        if (before === null || before === gap.empties) continue;
        taken.push(gap.blockId);
        // The first empty line typed into a gap the file already widened: its
        // extra blank lines become empty paragraphs too, so the two add up.
        if (before === 0 && gap.extra > 0) materialize.push({ at: gap.afterAbove, count: gap.extra });
      }
      if (taken.length === 0) return null;
      const transaction = newState.tr.setMeta(blankLinesKey, { explicit: taken }).setMeta('addToHistory', false);
      for (const { at, count } of materialize.sort((a, b) => b.at - a.at)) {
        for (let line = 0; line < count; line += 1) transaction.insert(at, newState.schema.nodes.paragraph.create());
      }
      return transaction;
    },
  });
}

/**
 * Backspace at the very start of a block below extra blank lines: take one
 * of them away. They become empty paragraphs less one, and the gap is
 * explicit from then on.
 */
export function takeOneBlankLine(view: EditorView, gapLines: GapLines): boolean {
  const { state } = view;
  const { selection } = state;
  if (!selection.empty) return false;
  const $from = selection.$from;
  if ($from.depth < 1 || $from.parentOffset !== 0) return false;
  // At the start of the block's first textblock, and that is where the top-level block starts.
  const top = $from.index(0);
  const start = $from.before(1);
  for (let depth = 1; depth <= $from.depth; depth += 1) {
    if ($from.before(depth) !== start + depth - 1) return false;
  }
  const plugin = blankLinesKey.getState(state);
  const origin = getBlockOrigins(state)[top];
  if (!plugin || !origin || plugin.explicit.has(origin.blockId)) return false;
  const gap = gapsOf(state, gapLines).find((candidate) => candidate.index === top);
  if (!gap || gap.extra === 0 || gap.empties > 0) return false;
  const transaction = state.tr.setMeta(blankLinesKey, { explicit: [origin.blockId] });
  for (let line = 0; line < gap.extra - 1; line += 1) transaction.insert(start, state.schema.nodes.paragraph.create());
  view.dispatch(transaction.scrollIntoView());
  return true;
}

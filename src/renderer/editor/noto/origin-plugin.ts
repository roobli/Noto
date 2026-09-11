/**
 * Tracks which accepted source block each top level node came from.
 *
 * This is what makes byte exact saves possible while the user edits freely. A
 * node that still carries its origin and still holds identical text is written
 * back as the original bytes; a node whose origin was lost is re-serialized.
 *
 * The v2 version of this plugin also had to shepherd opaque source ids and a
 * separate source-mode history basis. v3 has no opaque nodes, so all that is
 * left is mapping origins through transactions.
 */

import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import type { Node as ProseNode } from 'prosemirror-model';
import type { StepMap } from 'prosemirror-transform';
import type { NotoBlockOrigin } from '../../../shared/markdown/v3/contracts';

type Origins = readonly (NotoBlockOrigin | null)[];

interface OriginState {
  readonly origins: Origins;
}

interface RebaseMeta {
  readonly origins: Origins;
}

export const originKey = new PluginKey<OriginState>('noto-block-origins');

interface TopLevelRange {
  readonly index: number;
  readonly from: number;
  readonly to: number;
}

function topLevelRanges(doc: ProseNode): TopLevelRange[] {
  const ranges: TopLevelRange[] = [];
  let from = 0;
  for (let index = 0; index < doc.childCount; index += 1) {
    const to = from + doc.child(index).nodeSize;
    ranges.push({ index, from, to });
    from = to;
  }
  return ranges;
}

function overlaps(from: number, to: number, range: TopLevelRange): boolean {
  return from < range.to && to > range.from;
}

/** First top-level range that contains `pos`, or null if none. */
function rangeContaining(ranges: readonly TopLevelRange[], pos: number): TopLevelRange | null {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const range = ranges[mid]!;
    if (pos < range.from) high = mid - 1;
    else if (pos >= range.to) low = mid + 1;
    else return range;
  }
  return null;
}

/**
 * Carry origins across one replacement step.
 *
 * An origin survives only if some part of its block survived. Two old blocks
 * that merge into one leave a single origin, which is correct: the merged block
 * is new text and will be re-serialized.
 *
 * Target lookup is binary search on the new top-level ranges. A linear
 * `find` here was O(blocks²) on every keystroke and dominated caret-in-viewport
 * time on the two-megabyte corpus.
 */
function mapStep(oldDoc: ProseNode, newDoc: ProseNode, map: StepMap, previous: Origins): Origins {
  const oldRanges = topLevelRanges(oldDoc);
  const newRanges = topLevelRanges(newDoc);
  const mapped: (NotoBlockOrigin | null)[] = new Array(newRanges.length).fill(null);

  for (const old of oldRanges) {
    const origin = previous[old.index] ?? null;
    if (!origin) continue;
    const start = map.mapResult(old.from, 1);
    const end = map.mapResult(old.to, -1);
    if (start.deletedAcross && end.deletedAcross) continue;
    const from = Math.min(start.pos, end.pos);
    const to = Math.max(start.pos, end.pos);
    const target = rangeContaining(newRanges, from)
      ?? (to > from ? rangeContaining(newRanges, to - 1) : null);
    if (!target || !overlaps(from, to, target) || mapped[target.index]) continue;
    mapped[target.index] = origin;
  }

  return mapped;
}

function mapTransaction(transaction: Transaction, previous: Origins): Origins {
  let origins = previous;
  for (let index = 0; index < transaction.mapping.maps.length; index += 1) {
    const oldDoc = transaction.docs[index];
    const newDoc = transaction.docs[index + 1] ?? transaction.doc;
    origins = mapStep(oldDoc, newDoc, transaction.mapping.maps[index], origins);
  }
  return origins;
}

export function createOriginPlugin(initialOrigins: Origins): Plugin<OriginState> {
  return new Plugin<OriginState>({
    key: originKey,
    state: {
      init: (_config, state) => ({
        origins: topLevelRanges(state.doc).map((range) => initialOrigins[range.index] ?? null),
      }),
      apply: (transaction, previous) => {
        const rebase = transaction.getMeta(originKey) as RebaseMeta | undefined;
        if (rebase) {
          const base = transaction.docChanged ? mapTransaction(transaction, previous.origins) : previous.origins;
          return { origins: base.map((_origin, index) => rebase.origins[index] ?? null) };
        }
        if (!transaction.docChanged) return previous;
        return { origins: mapTransaction(transaction, previous.origins) };
      },
    },
  });
}

export function getBlockOrigins(state: EditorState): Origins {
  const pluginState = originKey.getState(state);
  if (!pluginState) throw new Error('ORIGIN_STATE_MISSING: the block origin plugin is not installed');
  return pluginState.origins;
}

/**
 * Re-point the editor at a freshly accepted document after a save, without
 * adding an entry to the undo history.
 */
export function rebaseOrigins(transaction: Transaction, origins: Origins): Transaction {
  return transaction
    .setMeta(originKey, { origins } satisfies RebaseMeta)
    .setMeta('addToHistory', false);
}

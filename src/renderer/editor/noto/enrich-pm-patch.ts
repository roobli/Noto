/**
 * Incremental ProseMirror patch for flagged deferred dialect enrich.
 *
 * Viewport / idle enrich used to rebuild the whole `EditorState` on every tick
 * (`docFromSpans` + `EditorState.create`). That discarded plugin state mid-
 * scroll and rebuilt every top-level node when only a budgeted window changed.
 *
 * This helper computes a `replaceWith` range for one enriched window so the
 * host can dispatch on the live state. Flagged `@roobli/md` only; callers keep
 * the dirty / length guards.
 */

import type { Node as ProseNode } from 'prosemirror-model';
import type { BlockSpan } from '../../../shared/markdown/v3/blocks';
import { blockFromSpan } from '../../../shared/markdown/v3/pm/from-mdast';

export interface EnrichPmWindow {
  readonly from: number;
  readonly to: number;
}

export interface EnrichPmPatch {
  /** Character offset of the first replaced top-level node. */
  readonly from: number;
  /** Character offset after the last replaced top-level node. */
  readonly to: number;
  readonly nodes: ProseNode[];
}

/**
 * Build a top-level `replaceWith` patch for `window` (exclusive `to`).
 *
 * Returns null when the window is empty, out of range, or the live doc's
 * child count does not match `spans` (caller should fall back to a full rebuild).
 */
export function enrichPmPatchForWindow(
  doc: ProseNode,
  spans: readonly BlockSpan[],
  window: EnrichPmWindow,
): EnrichPmPatch | null {
  if (doc.childCount !== spans.length) return null;
  const fromIndex = Math.max(0, Math.min(window.from, spans.length));
  const toIndex = Math.max(fromIndex, Math.min(window.to, spans.length));
  if (fromIndex >= toIndex) return null;

  let from = 0;
  for (let i = 0; i < fromIndex; i += 1) from += doc.child(i).nodeSize;
  let to = from;
  for (let i = fromIndex; i < toIndex; i += 1) to += doc.child(i).nodeSize;

  return {
    from,
    to,
    nodes: spans.slice(fromIndex, toIndex).map(blockFromSpan),
  };
}

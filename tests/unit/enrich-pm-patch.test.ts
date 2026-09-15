/**
 * Incremental PM patch for flagged deferred enrich ticks.
 *
 * Full `EditorState.create(docFromSpans(all))` per tick was correct but rebuilt
 * every top-level node and reset plugins. The patch must match a full rebuild
 * for the enriched window and refuse mismatched doc shapes.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { EditorState } from 'prosemirror-state';
import {
  splitBlocksViaRoobli,
  resolveDeferredOpenSpans,
  createEnrichFlags,
  enrichNextDeferredInRange,
  enrichRangeFromVisibleInclusive,
  OPEN_VIEWPORT_ENRICH_BUDGET,
} from '../../src/shared/markdown/v3/roobli-md-adapter';
import { docFromSpans } from '../../src/shared/markdown/v3/pm/from-mdast';
import { setMarkdownEngineForTests } from '../../src/shared/markdown/v3/engine-flag';
import { enrichPmPatchForWindow } from '../../src/renderer/editor/noto/enrich-pm-patch';

afterEach(() => {
  setMarkdownEngineForTests(null);
});

function manyParas(count: number): string {
  return Array.from({ length: count }, (_, i) => `Para ${i} with **bold**.\n\n`).join('');
}

describe('enrichPmPatchForWindow', () => {
  it('returns null for empty / out-of-range windows and childCount mismatch', () => {
    setMarkdownEngineForTests('roobli-md');
    const text = '# A\n\npara\n';
    const spans = splitBlocksViaRoobli(text).spans;
    const doc = docFromSpans(spans);
    expect(enrichPmPatchForWindow(doc, spans, { from: 0, to: 0 })).toBeNull();
    expect(enrichPmPatchForWindow(doc, spans, { from: 2, to: 2 })).toBeNull();
    expect(enrichPmPatchForWindow(doc, spans.slice(0, 1), { from: 0, to: 1 })).toBeNull();
  });

  it('matches a full docFromSpans rebuild for a mid-document enrich window', () => {
    setMarkdownEngineForTests('roobli-md');
    const text = manyParas(200);
    const none = splitBlocksViaRoobli(text, { enrich: 'none' });
    const prepared = resolveDeferredOpenSpans(none.spans, text, { deferred: true });
    expect(prepared.remainderFrom).not.toBeNull();

    const flags = createEnrichFlags(prepared.spans.length, prepared.remainderFrom!);
    const visible = enrichRangeFromVisibleInclusive(95, 110, prepared.spans.length, 5);
    const once = enrichNextDeferredInRange(prepared.spans, text, flags, visible, {
      budget: OPEN_VIEWPORT_ENRICH_BUDGET,
    });
    expect(once.window).not.toBeNull();
    const window = once.window!;

    const standInDoc = docFromSpans(prepared.spans);
    const patch = enrichPmPatchForWindow(standInDoc, once.spans, window);
    expect(patch).not.toBeNull();
    expect(patch!.nodes.length).toBe(window.to - window.from);

    const state = EditorState.create({ doc: standInDoc });
    const next = state.apply(state.tr.replaceWith(patch!.from, patch!.to, patch!.nodes));
    const full = docFromSpans(once.spans);
    expect(next.doc.toJSON()).toEqual(full.toJSON());
  });
});

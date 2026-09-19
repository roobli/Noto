/**
 * Viewport / idle deferred enrich for flagged lazy open.
 *
 * Pure planning stays in the adapter; this file covers window selection,
 * budget caps, and that mid-document enrich matches bulk for the window.
 */

import { describe, expect, it } from 'vitest';
import {
  OPEN_LAZY_INITIAL_SPANS,
  OPEN_VIEWPORT_ENRICH_BUDGET,
  OPEN_VIEWPORT_ENRICH_PAD,
  splitBlocksViaRoobli,
  createEnrichFlags,
  countDeferredFlags,
  nextDeferredEnrichWindow,
  nextDeferredEnrichWindowFrom,
  enrichNextDeferredInRange,
  enrichRangeFromVisibleInclusive,
  enrichSpansInRange,
  resolveDeferredOpenSpans,
} from '../../src/shared/markdown/v3/roobli-md-adapter';

/** Dialect-heavy paras (inline math) so deferred enrich still has work after simple HTML became engine-owned. */
function manyParas(count: number): string {
  return Array.from({ length: count }, (_, i) => `Para ${i} with $math_${i}$ here.\n\n`).join('');
}

describe('deferred enrich flags / windows', () => {
  it('createEnrichFlags marks the first-paint prefix enriched', () => {
    const flags = createEnrichFlags(100, OPEN_LAZY_INITIAL_SPANS);
    expect(flags.length).toBe(100);
    expect(countDeferredFlags(flags)).toBe(100 - OPEN_LAZY_INITIAL_SPANS);
    expect(flags[0]).toBe(1);
    expect(flags[OPEN_LAZY_INITIAL_SPANS - 1]).toBe(1);
    expect(flags[OPEN_LAZY_INITIAL_SPANS]).toBe(0);
  });

  it('nextDeferredEnrichWindow finds the first hole in range and respects budget', () => {
    const flags = createEnrichFlags(50, 10);
    expect(nextDeferredEnrichWindow(flags, 0, 50, 5)).toEqual({ from: 10, to: 15 });
    expect(nextDeferredEnrichWindow(flags, 0, 12, 20)).toEqual({ from: 10, to: 12 });
    expect(nextDeferredEnrichWindow(flags, 0, 10, 20)).toBeNull();
  });

  it('nextDeferredEnrichWindowFrom scans from a hint for idle drain', () => {
    const flags = createEnrichFlags(40, 5);
    flags.fill(1, 5, 20); // mid hole closed
    expect(nextDeferredEnrichWindowFrom(flags, 0, 10)).toEqual({ from: 20, to: 30 });
  });

  it('enrichRangeFromVisibleInclusive pads and converts inclusive→exclusive', () => {
    expect(enrichRangeFromVisibleInclusive(100, 120, 500, 40)).toEqual({
      from: 60,
      to: 161,
    });
    expect(enrichRangeFromVisibleInclusive(0, 10, 50, OPEN_VIEWPORT_ENRICH_PAD)).toEqual({
      from: 0,
      to: Math.min(50, 11 + OPEN_VIEWPORT_ENRICH_PAD),
    });
  });
});

describe('enrichNextDeferredInRange', () => {
  it('enriches only deferred spans overlapping the visible window', () => {
    const text = manyParas(200);
    const none = splitBlocksViaRoobli(text, { enrich: 'none' });
    const bulk = splitBlocksViaRoobli(text, { enrich: 'bulk' });
    const prepared = resolveDeferredOpenSpans(none.spans, text, { deferred: true });
    expect(prepared.remainderFrom).toBe(OPEN_LAZY_INITIAL_SPANS);

    const flags = createEnrichFlags(prepared.spans.length, prepared.remainderFrom!, prepared.spans);
    // Scroll into stand-ins around index 100 (pad 5 → exclusive [90, 116)).
    const visible = enrichRangeFromVisibleInclusive(95, 110, prepared.spans.length, 5);
    expect(visible).toEqual({ from: 90, to: 116 });
    const once = enrichNextDeferredInRange(prepared.spans, text, flags, visible, {
      budget: OPEN_VIEWPORT_ENRICH_BUDGET,
    });
    expect(once.window).not.toBeNull();
    // Only the overlap with the visible pad is enriched; earlier deferred
    // indices (80–89) wait for idle drain or a later scroll.
    expect(once.window!.from).toBe(90);
    expect(once.window!.to).toBe(116);
    expect(once.window!.to - once.window!.from).toBeLessThanOrEqual(OPEN_VIEWPORT_ENRICH_BUDGET);

    // Enriched window matches bulk dialect shape.
    for (let i = once.window!.from; i < once.window!.to; i += 1) {
      expect([once.spans[i]!.kind, once.spans[i]!.node.type, once.spans[i]!.semanticKey]).toEqual([
        bulk.spans[i]!.kind,
        bulk.spans[i]!.node.type,
        bulk.spans[i]!.semanticKey,
      ]);
      expect(once.flags[i]).toBe(1);
    }
    // First-paint stays enriched; gap before the visible pad stays deferred; tail stays deferred.
    expect(once.flags[0]).toBe(1);
    expect(once.flags[OPEN_LAZY_INITIAL_SPANS]).toBe(0);
    expect(once.flags[89]).toBe(0);
    expect(once.flags[116]).toBe(0);
  });

  it('mid-document hole enrich matches bulk for that window only', () => {
    const text = manyParas(200);
    const none = splitBlocksViaRoobli(text, { enrich: 'none' });
    const bulk = splitBlocksViaRoobli(text, { enrich: 'bulk' });
    // Simulate first-paint + prior idle leaving a hole at 120–140.
    let spans = enrichSpansInRange(none.spans, text, { from: 0, to: 120 });
    spans = enrichSpansInRange(spans, text, { from: 140, to: 200 });
    const flags = createEnrichFlags(200, 0);
    flags.fill(1, 0, 120);
    flags.fill(1, 140, 200);

    const result = enrichNextDeferredInRange(spans, text, flags, { from: 100, to: 160 }, {
      budget: 25,
    });
    expect(result.window).toEqual({ from: 120, to: 140 });
    for (let i = 120; i < 140; i += 1) {
      expect(result.spans[i]!.node.type).toBe(bulk.spans[i]!.node.type);
      expect(result.flags[i]).toBe(1);
    }
    expect(countDeferredFlags(result.flags)).toBe(0);
  });

  it('does not re-parse already enriched indices', () => {
    const text = '# A\n\npara\n\n## B\n\nmore\n';
    const none = splitBlocksViaRoobli(text, { enrich: 'none' });
    const prepared = resolveDeferredOpenSpans(none.spans, text, { deferred: true });
    // Small doc: remainderFrom null when length <= initial.
    if (prepared.remainderFrom === null) {
      const flags = createEnrichFlags(prepared.spans.length, prepared.spans.length);
      const again = enrichNextDeferredInRange(prepared.spans, text, flags, {
        from: 0,
        to: prepared.spans.length,
      });
      expect(again.window).toBeNull();
      expect(again.spans).toEqual(prepared.spans.slice());
      return;
    }
    const flags = createEnrichFlags(prepared.spans.length, prepared.remainderFrom!, prepared.spans);
    const first = enrichNextDeferredInRange(prepared.spans, text, flags, {
      from: prepared.remainderFrom,
      to: prepared.spans.length,
    });
    expect(first.window).not.toBeNull();
    const second = enrichNextDeferredInRange(first.spans, text, first.flags, {
      from: first.window!.from,
      to: first.window!.to,
    });
    expect(second.window).toBeNull();
  });
});


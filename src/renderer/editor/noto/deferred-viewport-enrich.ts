/**
 * Viewport-driven dialect enrich for flagged deferred open.
 *
 * After the first-paint window (`OPEN_LAZY_INITIAL_SPANS`), structural stand-ins
 * remain until this controller enriches them:
 *
 * 1. On scroll / mount — enrich the visible band (+ pad), preferring
 *    `viewport-stub`'s membership window when stubbing is on.
 * 2. Idle chunks — drain remaining deferred indices without one full-document
 *    dialect pass on the critical post-paint frame.
 * 3. Each tick passes the enriched window to the host for an incremental PM
 *    patch (avoid full `EditorState` rebuild per tick).
 *
 * Enrichment keeps running while the document is dirty: the host swaps a
 * stand-in only while it is still the very node open created, so an edited
 * block is never replaced. It has to keep running, because an edit made to a
 * stand-in would be an edit to raw markdown shown as text, and saving that
 * escapes the markdown (`***a***` became `\*\*\*a\*\*\*`). The host enriches the
 * block under the caret, and the whole document before find and replace, with
 * `enrichNow` so that no edit ever lands in a stand-in.
 */

import type { EditorView } from 'prosemirror-view';
import type { BlockSpan } from '../../../shared/markdown/v3/blocks';
import {
  OPEN_VIEWPORT_ENRICH_BUDGET,
  OPEN_VIEWPORT_ENRICH_PAD,
  countDeferredFlags,
  createEnrichFlags,
  enrichNextDeferredInRange,
  enrichRangeFromVisibleInclusive,
  nextDeferredEnrichWindow,
  nextDeferredEnrichWindowFrom,
} from '../../../shared/markdown/v3/roobli-md-adapter';
import {
  findScroller,
  visibleBlockRangeFromScroll,
  viewportStubKey,
  type BlockRange,
} from './viewport-stub';

export interface DeferredViewportEnrichHost {
  getView(): EditorView | null;
  /**
   * Swap in the enriched window. Returning false means nothing was applied
   * (for example mid-composition), so the window stays deferred and is
   * retried on a later tick.
   */
  applyDialectEnrichedSpans(
    spans: readonly BlockSpan[],
    window?: { readonly from: number; readonly to: number },
  ): boolean | void;
}

export interface DeferredViewportEnrichOptions {
  readonly spans: readonly BlockSpan[];
  readonly text: string;
  /** First index still deferred after `resolveDeferredOpenSpans`. */
  readonly remainderFrom: number;
  readonly onError?: (message: string) => void;
}

type IdleHandle = number;

function scheduleIdle(run: () => void): IdleHandle {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
    .requestIdleCallback;
  if (typeof ric === 'function') {
    return ric(run, { timeout: 120 });
  }
  return globalThis.setTimeout(run, 32) as unknown as IdleHandle;
}

function cancelIdle(handle: IdleHandle): void {
  const cic = (globalThis as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
  if (typeof cic === 'function') {
    cic(handle);
    return;
  }
  globalThis.clearTimeout(handle);
}

/**
 * Resolve the inclusive block window that should be dialect-enriched next.
 *
 * Prefer viewport-stub's buffered `viewport` when enabled; otherwise estimate
 * from live DOM geometry (+ one screen buffer).
 */
export function resolveEnrichVisibleRange(view: EditorView): BlockRange | null {
  const stub = viewportStubKey.getState(view.state);
  if (stub?.enabled) return stub.viewport;
  return visibleBlockRangeFromScroll(view, 1);
}

export class DeferredViewportEnrichController {
  private spans: BlockSpan[];
  private flags: Uint8Array;
  private readonly text: string;
  private readonly host: DeferredViewportEnrichHost;
  private readonly onError?: (message: string) => void;
  private scroller: HTMLElement | null = null;
  private scrollFrame = 0;
  private idleHandle: IdleHandle | null = null;
  private destroyed = false;
  private applying = false;

  constructor(host: DeferredViewportEnrichHost, options: DeferredViewportEnrichOptions) {
    this.host = host;
    this.text = options.text;
    this.onError = options.onError;
    this.spans = options.spans.slice();
    this.flags = createEnrichFlags(options.spans.length, options.remainderFrom, options.spans);
  }

  /** Remaining structural stand-in count (for tests / profiling). */
  deferredCount(): number {
    return countDeferredFlags(this.flags);
  }

  start(): void {
    if (this.destroyed) return;
    this.ensureScroll();
    // First frame: enrich whatever is on screen before idle drain begins.
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = 0;
      this.enrichVisible();
      this.scheduleIdleDrain();
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.detachScroll();
    if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame);
    this.scrollFrame = 0;
    if (this.idleHandle !== null) cancelIdle(this.idleHandle);
    this.idleHandle = null;
  }

  /** Test / profile hook: enrich one deferred window overlapping `range`. */
  enrichRangeForTests(from: number, toExclusive: number): boolean {
    return this.applyEnrichWindow(from, toExclusive);
  }

  /**
   * Enrich every stand-in in `[from, toExclusive)` (opened indexes) now,
   * one budget-sized window at a time. Returns false when one could not be
   * applied (mid-composition, or re-entered while a window is applying), so
   * the range may still hold stand-ins.
   */
  enrichNow(from: number, toExclusive: number): boolean {
    const to = Math.min(toExclusive, this.spans.length);
    // Each applied window flips at least one flag, so this terminates; the
    // bound only guards against a host that reports success without applying.
    for (let guard = 0; guard <= to - from; guard += 1) {
      if (nextDeferredEnrichWindow(this.flags, from, to, OPEN_VIEWPORT_ENRICH_BUDGET) === null) return true;
      if (!this.applyEnrichWindow(from, to)) return false;
    }
    return nextDeferredEnrichWindow(this.flags, from, to, OPEN_VIEWPORT_ENRICH_BUDGET) === null;
  }

  private ensureScroll(): void {
    const view = this.host.getView();
    if (!view) return;
    const next = findScroller(view);
    if (next === this.scroller) return;
    this.detachScroll();
    this.scroller = next;
    this.scroller?.addEventListener('scroll', this.onScroll, { passive: true });
  }

  private detachScroll(): void {
    this.scroller?.removeEventListener('scroll', this.onScroll);
    this.scroller = null;
  }

  private readonly onScroll = (): void => {
    if (this.destroyed || this.scrollFrame) return;
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = 0;
      this.ensureScroll();
      this.enrichVisible();
    });
  };

  private enrichVisible(): void {
    const view = this.host.getView();
    if (!view || this.destroyed) return;
    const visible = resolveEnrichVisibleRange(view);
    if (!visible) return;
    const range = enrichRangeFromVisibleInclusive(
      visible.from,
      visible.to,
      this.spans.length,
      OPEN_VIEWPORT_ENRICH_PAD,
    );
    // Drain overlapping deferred holes until the visible pad is clean or budget
    // would require another tick (one window per call keeps layout calm).
    this.applyEnrichWindow(range.from, range.to);
  }

  private scheduleIdleDrain(): void {
    if (this.destroyed || this.idleHandle !== null) return;
    if (countDeferredFlags(this.flags) === 0) return;
    this.idleHandle = scheduleIdle(() => {
      this.idleHandle = null;
      if (this.destroyed) return;
      const window = nextDeferredEnrichWindowFrom(this.flags, 0, OPEN_VIEWPORT_ENRICH_BUDGET);
      if (!window) return;
      this.applyEnrichWindow(window.from, window.to);
      if (countDeferredFlags(this.flags) > 0) this.scheduleIdleDrain();
    });
  }

  private applyEnrichWindow(from: number, toExclusive: number): boolean {
    if (this.destroyed || this.applying) return false;
    const result = enrichNextDeferredInRange(this.spans, this.text, this.flags, {
      from,
      to: toExclusive,
    }, { budget: OPEN_VIEWPORT_ENRICH_BUDGET });
    if (!result.window) return false;
    this.applying = true;
    try {
      const applied = this.host.applyDialectEnrichedSpans(result.spans, result.window);
      if (applied === false) return false;
      this.spans = result.spans;
      this.flags = result.flags;
    } catch (error) {
      this.onError?.(error instanceof Error ? error.message : 'Dialect enrich after open failed.');
      return false;
    } finally {
      this.applying = false;
    }
    return true;
  }
}

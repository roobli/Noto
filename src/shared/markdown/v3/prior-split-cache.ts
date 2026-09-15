/**
 * Host cache of the last structural `@roobli/md` split for incremental
 * `reparseFromText` on flagged `replaceMarkdown`.
 *
 * Only used when `NOTO_MARKDOWN_ENGINE=roobli-md` (or the test override). The
 * micromark path never consults this cache.
 *
 * Lifecycle (host design):
 * - **Seed** on open / external reload / after a successful replace (or full
 *   fallback split), so the next full-buffer replace can reparse incrementally.
 * - **Invalidate** when the ProseMirror document changes outside
 *   `replaceMarkdown` (WYSIWYG typing, paste, etc.). A stale prior whose
 *   `joinSplit` no longer matches any buffer the host would pass next is
 *   unsafe to reuse for edit derivation — the next replace falls back to a
 *   full split and reseeds.
 * - **Invalidate** on destroy. Commit does not need a special path: typing
 *   already cleared the cache, and a replace-then-save leaves a prior that
 *   still matches the accepted text.
 */

import { toLf } from './line-endings';
import {
  parseBlocksStructural,
  reparseFromTextViaRoobli,
  splitBlocksViaRoobli,
  type AdapterBlockSpan,
  type EngineSplitDocument,
} from './roobli-md-adapter';
import type { NotoBlockKind } from './contracts';

export type PriorSplitSource = 'reparse' | 'full';

export interface PriorSplitReplaceResult {
  readonly spans: readonly AdapterBlockSpan[];
  readonly source: PriorSplitSource;
  readonly dirtyFrom: number;
  readonly dirtyTo: number;
}

/** Minimal span shape needed to rebuild a structural engine split without reparsing. */
export interface StructuralSpanInput {
  readonly kind: NotoBlockKind;
  readonly start: number;
  readonly end: number;
  readonly markdown: string;
}

/** Build an engine `SplitDocument` from known offsets (open / wire), no parse. */
export function structuralSplitFromSpans(
  text: string,
  spans: readonly StructuralSpanInput[],
): EngineSplitDocument {
  const lf = toLf(text);
  if (spans.length === 0) {
    return { spans: [], leading: '', gaps: [], trailing: lf };
  }

  const engineSpans = spans.map((span) => ({
    kind: span.kind,
    start: span.start,
    end: span.end,
    markdown: span.markdown,
    node: null,
  }));

  const gaps: string[] = [];
  for (let index = 0; index + 1 < engineSpans.length; index += 1) {
    gaps.push(lf.slice(engineSpans[index]!.end, engineSpans[index + 1]!.start));
  }

  return {
    spans: engineSpans,
    leading: lf.slice(0, engineSpans[0]!.start),
    gaps,
    trailing: lf.slice(engineSpans[engineSpans.length - 1]!.end),
  };
}

function toStructural(result: {
  readonly spans: readonly { readonly kind: NotoBlockKind; readonly start: number; readonly end: number; readonly markdown: string }[];
  readonly leading: string;
  readonly gaps: readonly string[];
  readonly trailing: string;
}): EngineSplitDocument {
  return {
    leading: result.leading,
    gaps: result.gaps,
    trailing: result.trailing,
    spans: result.spans.map((span) => ({
      kind: span.kind,
      start: span.start,
      end: span.end,
      markdown: span.markdown,
      node: null,
    })),
  };
}

/**
 * Mutable cache owned by `NotoEditor` (one per editor instance).
 *
 * Unit tests exercise this class directly; the editor only seeds / invalidates
 * and calls {@link spansForReplace}.
 */
export class PriorSplitCache {
  private prior: EngineSplitDocument | null = null;

  get hasPrior(): boolean {
    return this.prior !== null;
  }

  /** Drop the prior so the next replace does a full split. */
  invalidate(): void {
    this.prior = null;
  }

  /** Replace any prior with a known structural split (open / reload). */
  seedFromSplit(split: EngineSplitDocument): void {
    this.prior = split;
  }

  /** Open / reload: seed from already-resolved block spans + text. */
  seedFromSpans(text: string, spans: readonly StructuralSpanInput[]): void {
    this.prior = structuralSplitFromSpans(text, spans);
  }

  /**
   * Spans for a full-buffer replace.
   *
   * When a prior exists, routes through `reparseFromTextViaRoobli` (Phase 11).
   * Otherwise full `splitBlocksViaRoobli`, then seeds. Always leaves the cache
   * holding a structural split of `nextText`.
   */
  spansForReplace(
    nextText: string,
    options?: { readonly neighborSlack?: number },
  ): PriorSplitReplaceResult {
    const lf = toLf(nextText);

    if (this.prior !== null) {
      const result = reparseFromTextViaRoobli(
        this.prior,
        lf,
        options?.neighborSlack !== undefined
          ? { neighborSlack: options.neighborSlack }
          : { neighborSlack: 1 },
      );
      this.prior = toStructural(result);
      return {
        spans: result.spans,
        source: 'reparse',
        dirtyFrom: result.dirtyFrom,
        dirtyTo: result.dirtyTo,
      };
    }

    const full = splitBlocksViaRoobli(lf);
    this.prior = toStructural(full);
    return {
      spans: full.spans,
      source: 'full',
      // Full parse: every span is "dirty" for observability; empty docs use the
      // same empty-window convention as reparseFromText identity.
      dirtyFrom: 0,
      dirtyTo: Math.max(-1, full.spans.length - 1),
    };
  }
}

/** Test helper: structural parse without touching a cache instance. */
export function parseStructuralForTests(text: string): EngineSplitDocument {
  return parseBlocksStructural(toLf(text));
}

/**
 * Thin host adapter from `@roobli/md` into Noto markdown v3 shapes.
 *
 * The engine owns block offsets / kinds / gaps / reparse / serialize primitives.
 * Noto keeps branded IDs, sha256, envelope hashing, `semanticKey`, and wire
 * `nodes` (mdast) in this layer: native spans ship `node: null`, so we attach
 * mdast via Noto's dialect when a span needs a ProseMirror-ready node.
 * Full-document splits default to one bulk dialect parse (not N× per span).
 * Flagged open uses `enrich: 'none'` on main then `enrichSpansInRange` in the
 * renderer for a first-paint window (and the remainder after paint) — see
 * `SpanEnrichMode` and docs/performance/open-path-first-cut.md. Engine-owned
 * leaf / plain paragraph+heading / simple quote (incl. nested plain + lists-in-quotes + hard breaks) / flat or same-family nested list (any depth) / simple table skip mdast (IR → PM via `pm/from-engine.ts`).
 *
 * Flagged block-mode saves (identity, single-block, multi-block insert/delete)
 * map into engine shapes, call `serializeDocument`, then the host re-attaches
 * hashes and branded revision ids (see `serialize.ts`). Source mode stays in
 * Noto.
 */

import {
  joinSplit,
  parseBlocks as engineParseBlocks,
  parseSingleBlock as engineParseSingleBlock,
  reparseBlocks as engineReparseBlocks,
  reparseFromText as engineReparseFromText,
  serializeDocument as engineSerializeDocument,
  sourceEditBetween,
  identityUnits,
  type ReparseBlocksOptions,
  type ReparseBlocksResult,
  type SerializeOptions,
  type SerializeResult,
  type SerializeUnit,
  type SerializeEnvelope,
  type PreservedRange as EnginePreservedRange,
  type SplitDocument as EngineSplitDocument,
  type BlockSpan as EngineBlockSpan,
  type EngineDocument,
  type SourceEdit,
} from '@roobli/md';
import type { BlockContent, DefinitionContent, RootContent } from 'mdast';
import type {
  NotoBlockKind,
  NotoDocument,
  NotoTargetEnvelope,
  NotoUnit,
} from './contracts';
import { parseMarkdown, topLevelNodes } from './syntax';
import {
  canSkipDialectEnrich,
  engineSemanticKey,
  parseLinkDefinitionSource,
  parseSimpleQuoteSource,
  type ParsedFlatList,
  type ParsedQuoteChild,
} from './pm/from-engine';

export interface AdapterBlockSpan {
  readonly kind: NotoBlockKind;
  readonly start: number;
  readonly end: number;
  readonly markdown: string;
  readonly semanticKey: string;
  readonly node: RootContent;
}

export interface AdapterSplitDocument {
  readonly spans: readonly AdapterBlockSpan[];
  readonly leading: string;
  readonly gaps: readonly string[];
  readonly trailing: string;
}

function isTaskList(node: Extract<RootContent, { type: 'list' }>): boolean {
  return node.children.some((item) => item.checked !== null && item.checked !== undefined);
}

function kindOf(node: RootContent, source: string): NotoBlockKind {
  switch (node.type) {
    case 'heading':
      return 'heading';
    case 'paragraph':
      return 'paragraph';
    case 'list':
      if (isTaskList(node)) return 'task-list';
      return node.ordered ? 'ordered-list' : 'bullet-list';
    case 'blockquote':
      return 'quote';
    case 'code':
      return /^\s{0,3}(?:`{3,}|~{3,})/.test(source) ? 'fenced-code' : 'indented-code';
    case 'table':
      return 'table';
    case 'math':
      return 'display-math';
    case 'yaml':
      return 'frontmatter';
    case 'html':
      return 'html';
    case 'thematicBreak':
      return 'thematic-break';
    case 'footnoteDefinition':
      return 'footnote-definition';
    case 'definition':
      return 'link-definition';
    default:
      return 'paragraph';
  }
}

function semanticKeyOf(node: RootContent, kind: NotoBlockKind): string {
  const parts: (string | number | boolean)[] = [kind];
  switch (node.type) {
    case 'heading':
      parts.push(node.depth);
      break;
    case 'list':
      parts.push(node.ordered === true, node.start ?? 1, node.spread === true, node.children.length);
      break;
    case 'code':
      parts.push(node.lang ?? '', node.meta ?? '');
      break;
    case 'table':
      parts.push(node.children.length, node.children[0]?.children.length ?? 0,
        (node.align ?? []).map((value) => value ?? '-').join(''));
      break;
    case 'footnoteDefinition':
    case 'definition':
      parts.push(node.identifier);
      break;
    default:
      break;
  }
  return parts.join('\u0000');
}

/**
 * How full-document adapter splits attach mdast for the wire / ProseMirror.
 *
 * - `bulk` (default): one dialect `parseMarkdown` over the whole text, then zip
 *   top-level nodes onto native spans. Same asymptotic cost as micromark open,
 *   without N× per-span reparses (see docs/performance/open-path-first-cut.md).
 * - `per-span`: legacy path — `parseMarkdown` each span.markdown. Kept for
 *   PROFILE_OPEN A/B and as the fallback when bulk counts disagree.
 * - `none`: structural only — kind-aware stand-in nodes (heading/fence/hr/…;
 *   paragraph fallback), `semanticKey === kind`. Flagged `parseDocument` open
 *   uses this on main; renderer calls `enrichSpansInRange` for the first-paint
 *   window, then viewport / idle `enrichNextDeferredInRange` for deferred
 *   stand-ins.
 */
export type SpanEnrichMode = 'bulk' | 'per-span' | 'none';

export interface SplitBlocksViaRoobliOptions {
  readonly enrich?: SpanEnrichMode;
}

/**
 * First-paint span window for flagged lazy open.
 *
 * Long enough to cover a typical viewport of top-level blocks; short enough
 * that the one dialect parse for the window stays far below a full-document
 * bulk attach on medium/large corpus files.
 */
export const OPEN_LAZY_INITIAL_SPANS = 80;

export interface EnrichSpansInRangeOptions {
  /** Inclusive start index into `spans`. */
  readonly from: number;
  /** Exclusive end index into `spans`. */
  readonly to: number;
}

/**
 * Finalize an engine-owned span without dialect parse (leaf / plain phrasing).
 * Keeps the kind-aware stand-in node and stamps a dialect-aligned semanticKey.
 */
function finalizeEngineAdapterSpan(span: AdapterBlockSpan): AdapterBlockSpan {
  return {
    kind: span.kind,
    start: span.start,
    end: span.end,
    markdown: span.markdown,
    semanticKey: engineSemanticKey(span.kind, span.markdown),
    node: span.node,
  };
}

function enrichDialectRun(
  run: readonly AdapterBlockSpan[],
  text: string,
): AdapterBlockSpan[] {
  if (run.length === 0) return [];
  const sliceStart = run[0]!.start;
  const sliceEnd = run[run.length - 1]!.end;
  const slice = text.slice(sliceStart, sliceEnd);
  const nodes = topLevelNodes(parseMarkdown(slice));
  if (nodes.length === run.length) {
    return run.map((span, index) => attachDialectNode(
      {
        kind: span.kind,
        start: span.start,
        end: span.end,
        markdown: span.markdown,
        node: null,
      },
      nodes[index]!,
    ));
  }
  return run.map((span) => enrichSpan({
    kind: span.kind,
    start: span.start,
    end: span.end,
    markdown: span.markdown,
    node: null,
  }));
}

/**
 * Fill dialect mdast for `spans[from..to)` — but **skip** engine-owned leaf /
 * link-definition / plain paragraph+heading / simple-quote (incl. nested) / flat-or-nested-list spans (IR → final stand-in + semanticKey, no
 * micromark). Contiguous needs-dialect runs still use one `parseMarkdown` each.
 *
 * Spans outside the range are returned unchanged. When a dialect run's
 * top-level node count disagrees with the run length, falls back to per-span
 * enrich for that run only (never silent).
 */
export function enrichSpansInRange<T extends AdapterBlockSpan>(
  spans: readonly T[],
  text: string,
  range: EnrichSpansInRangeOptions,
): T[] {
  const from = Math.max(0, Math.min(range.from, spans.length));
  const to = Math.max(from, Math.min(range.to, spans.length));
  if (from === to || spans.length === 0) return spans.slice() as T[];

  const out = spans.slice() as AdapterBlockSpan[];
  let i = from;
  while (i < to) {
    const span = out[i]!;
    if (canSkipDialectEnrich(span.kind, span.markdown)) {
      out[i] = finalizeEngineAdapterSpan(span);
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < to && !canSkipDialectEnrich(out[j]!.kind, out[j]!.markdown)) {
      j += 1;
    }
    const enriched = enrichDialectRun(out.slice(i, j), text);
    for (let k = 0; k < enriched.length; k += 1) {
      out[i + k] = enriched[k]!;
    }
    i = j;
  }
  return out as T[];
}


export interface ResolveDeferredOpenSpansResult<T extends AdapterBlockSpan = AdapterBlockSpan> {
  readonly spans: readonly T[];
  /**
   * When non-null, indices `[remainderFrom, length)` still need dialect enrich.
   * Prefer viewport / idle `enrichNextDeferredInRange` over one full remainder
   * pass (see docs/performance/open-path-first-cut.md).
   */
  readonly remainderFrom: number | null;
}

/**
 * First consumer for flagged lazy open: enrich `[0, initial)` with one range
 * parse. Caller mounts with the result, then fills deferred stand-ins via
 * viewport-driven / idle enrich (not one full-document remainder parse).
 */
export function resolveDeferredOpenSpans<T extends AdapterBlockSpan>(
  spans: readonly T[],
  text: string,
  options?: { readonly initialSpans?: number; readonly deferred?: boolean },
): ResolveDeferredOpenSpansResult<T> {
  if (!options?.deferred) {
    return { spans, remainderFrom: null };
  }
  const initialTo = Math.min(options.initialSpans ?? OPEN_LAZY_INITIAL_SPANS, spans.length);
  const enriched = enrichSpansInRange(spans, text, { from: 0, to: initialTo });
  return {
    spans: enriched,
    remainderFrom: initialTo < enriched.length ? initialTo : null,
  };
}

/**
 * Spans enriched in one viewport or idle tick (one contiguous dialect window).
 *
 * Sized so a mid-document scroll enrich stays far below a full-document bulk
 * attach on the medium corpus, while covering more than one typical viewport.
 */
export const OPEN_VIEWPORT_ENRICH_BUDGET = 120;

/**
 * Extra top-level blocks around the visible band to enrich ahead of scroll.
 * Exclusive-range pad applied on both sides of an inclusive visible window.
 */
export const OPEN_VIEWPORT_ENRICH_PAD = 40;

/**
 * Parallel to spans: `1` = dialect-enriched or engine-owned (no further enrich),
 * `0` = structural stand-in still needing dialect.
 *
 * When `spans` is provided, leaf / link-definition / plain paragraph+heading /
 * simple-quote / flat-or-nested-list indices past the first-paint prefix are marked enriched immediately — IR → PM needs no mdast.
 */
export function createEnrichFlags(
  length: number,
  enrichedExclusiveTo: number,
  spans?: readonly { readonly kind: NotoBlockKind; readonly markdown: string }[],
): Uint8Array {
  const flags = new Uint8Array(Math.max(0, length));
  const to = Math.max(0, Math.min(enrichedExclusiveTo, flags.length));
  if (to > 0) flags.fill(1, 0, to);
  if (spans) {
    const n = Math.min(spans.length, flags.length);
    for (let i = to; i < n; i += 1) {
      const span = spans[i]!;
      if (canSkipDialectEnrich(span.kind, span.markdown)) flags[i] = 1;
    }
  }
  return flags;
}

export function countDeferredFlags(flags: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i] === 0) n += 1;
  }
  return n;
}

/**
 * First contiguous deferred run overlapping `[from, to)`, capped to `budget`.
 */
export function nextDeferredEnrichWindow(
  flags: Uint8Array,
  from: number,
  to: number,
  budget = OPEN_VIEWPORT_ENRICH_BUDGET,
): EnrichSpansInRangeOptions | null {
  const start = Math.max(0, Math.min(from, flags.length));
  const end = Math.max(start, Math.min(to, flags.length));
  let i = start;
  while (i < end && flags[i] === 1) i += 1;
  if (i >= end) return null;
  const windowFrom = i;
  const limit = Math.min(end, windowFrom + Math.max(1, budget));
  let windowTo = windowFrom + 1;
  while (windowTo < limit && flags[windowTo] === 0) windowTo += 1;
  return { from: windowFrom, to: windowTo };
}

/**
 * Scan for the next deferred window anywhere, starting at `fromHint`
 * (idle remainder path). Does not wrap.
 */
export function nextDeferredEnrichWindowFrom(
  flags: Uint8Array,
  fromHint = 0,
  budget = OPEN_VIEWPORT_ENRICH_BUDGET,
): EnrichSpansInRangeOptions | null {
  return nextDeferredEnrichWindow(flags, fromHint, flags.length, budget);
}

/**
 * Inclusive visible block indices → exclusive enrich range with pad.
 */
export function enrichRangeFromVisibleInclusive(
  visibleFrom: number,
  visibleToInclusive: number,
  spanCount: number,
  pad = OPEN_VIEWPORT_ENRICH_PAD,
): EnrichSpansInRangeOptions {
  const from = Math.max(0, visibleFrom - pad);
  const to = Math.min(spanCount, visibleToInclusive + 1 + pad);
  return { from, to };
}

export interface EnrichNextDeferredResult<T extends AdapterBlockSpan = AdapterBlockSpan> {
  readonly spans: T[];
  readonly flags: Uint8Array;
  /** Window that was enriched, or null when nothing deferred overlapped. */
  readonly window: EnrichSpansInRangeOptions | null;
}

/**
 * Enrich at most one deferred contiguous window overlapping `range`
 * (budget-capped). Leaves already-enriched indices untouched.
 */
export function enrichNextDeferredInRange<T extends AdapterBlockSpan>(
  spans: readonly T[],
  text: string,
  flags: Uint8Array,
  range: EnrichSpansInRangeOptions,
  options?: { readonly budget?: number },
): EnrichNextDeferredResult<T> {
  if (flags.length !== spans.length) {
    throw new Error('enrich flags length must match spans');
  }
  const window = nextDeferredEnrichWindow(
    flags,
    range.from,
    range.to,
    options?.budget ?? OPEN_VIEWPORT_ENRICH_BUDGET,
  );
  if (!window) {
    return { spans: spans.slice() as T[], flags: flags.slice(), window: null };
  }
  const nextSpans = enrichSpansInRange(spans, text, window);
  const nextFlags = flags.slice();
  nextFlags.fill(1, window.from, window.to);
  return { spans: nextSpans, flags: nextFlags, window };
}


/**
 * Cheap mdast stand-in from engine kind + source slice (no dialect parse).
 *
 * Flagged deferred open ships these until viewport/idle enrich attaches real
 * dialect trees. Kind-aware shapes (heading / fence / hr / …) keep a long
 * remainder gap from looking like raw paragraph soup when the user scrolls
 * ahead of enrich — see docs/performance/open-path-first-cut.md.
 */
function mdastListFromParsed(list: ParsedFlatList): Extract<RootContent, { type: 'list' }> {
  return {
    type: 'list',
    ordered: list.ordered,
    start: list.ordered ? list.start : null,
    spread: list.spread,
    children: list.items.map((item) => {
      const kids: BlockContent[] = [{
        type: 'paragraph',
        children: item.text.length > 0 ? [{ type: 'text', value: item.text }] : [],
      }];
      if (item.nested) kids.push(mdastListFromParsed(item.nested));
      return {
        type: 'listItem' as const,
        checked: item.checked,
        spread: false,
        children: kids,
      };
    }),
  };
}

function mdastQuoteChildren(
  children: readonly ParsedQuoteChild[],
): Array<BlockContent | DefinitionContent> {
  return children.map((child) => {
    if (child.type === 'paragraph') {
      return {
        type: 'paragraph' as const,
        children: child.text.length > 0 ? [{ type: 'text' as const, value: child.text }] : [],
      };
    }
    if (child.type === 'list') {
      return mdastListFromParsed(child.list);
    }
    return {
      type: 'blockquote' as const,
      children: mdastQuoteChildren(child.children),
    };
  });
}

function standInNode(span: EngineBlockSpan): RootContent {
  const md = span.markdown;
  const kind = span.kind as NotoBlockKind;
  switch (kind) {
    case 'heading': {
      const atx = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/s.exec(md.trimEnd());
      if (atx) {
        const depth = Math.min(6, atx[1]!.length) as 1 | 2 | 3 | 4 | 5 | 6;
        return {
          type: 'heading',
          depth,
          children: [{ type: 'text', value: atx[2]! }],
        };
      }
      const setext = /^([\s\S]+?)\n([=-])\2*[ \t]*$/s.exec(md.trimEnd());
      if (setext) {
        return {
          type: 'heading',
          depth: setext[2] === '=' ? 1 : 2,
          children: [{ type: 'text', value: setext[1]!.replace(/\s+$/u, '') }],
        };
      }
      return {
        type: 'heading',
        depth: 1,
        children: md.length > 0 ? [{ type: 'text', value: md }] : [],
      };
    }
    case 'fenced-code': {
      const fence = /^(?: {0,3})(`{3,}|~{3,})([^\n]*)\r?\n(?:([\s\S]*?)\r?\n)?(?: {0,3})\1[ \t]*\r?$/s.exec(md);
      if (fence) {
        const info = fence[2]!.trim();
        const infoMatch = info.length > 0 ? /^(\S+)(?:[ \t]+(.*))?$/u.exec(info) : null;
        const lang = infoMatch?.[1] ?? null;
        const meta = infoMatch?.[2]?.trim() || null;
        return { type: 'code', lang, meta, value: fence[3] ?? '' };
      }
      // Unclosed / odd fence: still a code block so PM paints a fence shell.
      return { type: 'code', lang: null, meta: null, value: md };
    }
    case 'indented-code': {
      const value = md.replace(/^(?: {4}|\t)/gm, '').replace(/\r?\n$/u, '');
      return { type: 'code', lang: null, meta: null, value };
    }
    case 'thematic-break':
      return { type: 'thematicBreak' };
    case 'display-math': {
      const m = /^\$\$\r?\n?([\s\S]*?)\r?\n?\$\$$/u.exec(md.trim());
      return { type: 'math', value: m ? m[1]! : md, meta: null } as RootContent;
    }
    case 'html':
      return { type: 'html', value: md };
    case 'frontmatter': {
      const m = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*$/u.exec(md);
      return { type: 'yaml', value: m ? m[1]! : md } as RootContent;
    }
    case 'link-definition': {
      const d = parseLinkDefinitionSource(md);
      if (d) {
        return {
          type: 'definition',
          identifier: d.identifier,
          label: d.label,
          url: d.url,
          title: d.title,
        };
      }
      return {
        type: 'paragraph',
        children: md.length > 0 ? [{ type: 'text', value: md }] : [],
      };
    }
    case 'quote': {
      const children = parseSimpleQuoteSource(md);
      if (children) {
        return {
          type: 'blockquote',
          children: mdastQuoteChildren(children),
        };
      }
      // Complex / marked quotes stay a single-paragraph shell until dialect enrich.
      const body = md.replace(/^(?: {0,3}>[ \t]?)/gm, '');
      return {
        type: 'blockquote',
        children: [{
          type: 'paragraph',
          children: body.length > 0 ? [{ type: 'text', value: body }] : [],
        }],
      };
    }
    default:
      return {
        type: 'paragraph',
        children: md.length > 0 ? [{ type: 'text', value: md }] : [],
      };
  }
}

function attachDialectNode(span: EngineBlockSpan, node: RootContent): AdapterBlockSpan {
  const dialectKind = kindOf(node, span.markdown);
  return {
    kind: dialectKind,
    start: span.start,
    end: span.end,
    markdown: span.markdown,
    semanticKey: semanticKeyOf(node, dialectKind),
    node,
  };
}

/**
 * Attach mdast + semanticKey for a native engine span (per-span path).
 *
 * Native hot path leaves `node` null. Prefer the engine's kind (offsets came
 * from it); derive semanticKey from the dialect node when the slice is exactly
 * one top-level construct.
 */
function enrichSpan(span: EngineBlockSpan): AdapterBlockSpan {
  const kind = span.kind as NotoBlockKind;
  if (span.node) {
    return {
      kind,
      start: span.start,
      end: span.end,
      markdown: span.markdown,
      semanticKey: semanticKeyOf(span.node, kind),
      node: span.node,
    };
  }

  const root = parseMarkdown(span.markdown);
  const nodes = topLevelNodes(root);
  if (nodes.length === 1) {
    return attachDialectNode(span, nodes[0]!);
  }

  // Multi-node or empty slice: keep engine kind and a kind-aware stand-in so
  // the BlockSpan contract stays satisfied for paste / source toggles.
  return {
    kind,
    start: span.start,
    end: span.end,
    markdown: span.markdown,
    semanticKey: kind,
    node: standInNode(span),
  };
}

/**
 * Structural adapter spans: no dialect parse. Prep for deferred wire nodes.
 * Engine-owned leaf / link-definition / plain phrasing / simple quotes (incl. nested plain) / flat or same-family nested lists / simple tables get a final semanticKey so enrich can skip them.
 */
function enrichSpanNone(span: EngineBlockSpan): AdapterBlockSpan {
  const kind = span.kind as NotoBlockKind;
  const skip = canSkipDialectEnrich(kind, span.markdown);
  return {
    kind,
    start: span.start,
    end: span.end,
    markdown: span.markdown,
    semanticKey: skip ? engineSemanticKey(kind, span.markdown) : kind,
    node: standInNode(span),
  };
}

/**
 * One full-document dialect parse, zipped onto native spans by ordinal.
 *
 * Falls back to per-span enrich when top-level node count disagrees with the
 * native scanner (should be rare on golden / corpus; never silent on open).
 */
function enrichSplitBulk(split: EngineSplitDocument, text: string): readonly AdapterBlockSpan[] {
  const nodes = topLevelNodes(parseMarkdown(text));
  if (nodes.length !== split.spans.length) {
    return split.spans.map(enrichSpan);
  }
  return split.spans.map((span, index) => attachDialectNode(span, nodes[index]!));
}

/** Structural split only (no mdast). For parity / coverage checks. */
export function parseBlocksStructural(text: string): EngineSplitDocument {
  return engineParseBlocks(text);
}

/**
 * Full Noto-shaped split via `@roobli/md` + dialect enrichment.
 *
 * Default enrich mode is `bulk` (measured open-path cut). Pass `enrich: 'none'`
 * for structural-only scaffolding, or `per-span` for the legacy A/B path.
 */
export function splitBlocksViaRoobli(
  text: string,
  options?: SplitBlocksViaRoobliOptions,
): AdapterSplitDocument {
  const split = engineParseBlocks(text);
  const mode: SpanEnrichMode = options?.enrich ?? 'bulk';
  const spans =
    mode === 'none' ? split.spans.map(enrichSpanNone)
    : mode === 'per-span' ? split.spans.map(enrichSpan)
    : enrichSplitBulk(split, text);
  return {
    spans,
    leading: split.leading,
    gaps: split.gaps,
    trailing: split.trailing,
  };
}

export function parseSingleBlockViaRoobli(markdown: string): AdapterBlockSpan | null {
  const span = engineParseSingleBlock(markdown);
  if (!span) return null;
  const enriched = enrichSpan(span);
  // Mirror Noto's trim check: engine already enforces single-block + blank
  // leading/trailing, but enrichment must not invent multi-block structure.
  return enriched;
}

export function reparseBlocksViaRoobli(options: ReparseBlocksOptions): ReparseBlocksResult & {
  readonly spans: readonly AdapterBlockSpan[];
} {
  const result = engineReparseBlocks(options);
  return {
    ...result,
    spans: result.spans.map(enrichSpan),
  };
}

/** Phase 11: prior split + full next text → incremental reparse + enrichment. */
export function reparseFromTextViaRoobli(
  prior: EngineSplitDocument,
  text: string,
  options?: { readonly neighborSlack?: number },
): ReparseBlocksResult & { readonly spans: readonly AdapterBlockSpan[] } {
  const result = engineReparseFromText(
    prior,
    text,
    options?.neighborSlack !== undefined ? { neighborSlack: options.neighborSlack } : undefined,
  );
  return {
    ...result,
    spans: result.spans.map(enrichSpan),
  };
}

/** Identity / single-block save helper used by parity tests. */
export function serializeIdentityViaRoobli(document: EngineDocument): SerializeResult {
  return engineSerializeDocument(document, {
    units: identityUnits(document),
    envelope: { lineEnding: 'mixed', hasFinalNewline: document.envelope.hasFinalNewline },
  });
}

export function serializeViaRoobli(
  document: EngineDocument,
  options: SerializeOptions,
): SerializeResult {
  return engineSerializeDocument(document, options);
}


/**
 * Project a Noto document into the thinner engine document the serializer
 * accepts. Offsets stay on `text`; `markdown` keeps Noto's LF-normalised form
 * so pristine comparisons match identity and edit transactions.
 */
export function toEngineDocument(document: NotoDocument): EngineDocument {
  return {
    envelope: {
      byteLength: document.envelope.byteLength,
      bom: document.envelope.bom,
      lineEnding: document.envelope.lineEnding,
      hasFinalNewline: document.envelope.hasFinalNewline,
    },
    text: document.text,
    blocks: document.blocks.map((block) => ({
      kind: block.kind,
      start: block.start,
      end: block.end,
      markdown: block.markdown,
      node: null,
    })),
    gaps: document.gaps.map((gap) => gap.text),
    leading: document.leading,
    trailing: document.trailing,
  };
}

/** Map Noto editing units onto engine `SerializeUnit`s (ordinal + markdown). */
export function toSerializeUnits(units: readonly NotoUnit[]): SerializeUnit[] {
  return units.map((unit) => ({
    origin: unit.origin ? unit.origin.ordinal : null,
    markdown: unit.markdown,
  }));
}

export function toSerializeEnvelope(envelope: NotoTargetEnvelope): SerializeEnvelope {
  return {
    lineEnding: envelope.lineEnding,
    hasFinalNewline: envelope.hasFinalNewline,
  };
}

/**
 * Classification helper: every unit is a surviving origin (no inserts/deletes)
 * and at most one unit is dirty. The flagged host path now routes *all*
 * block-mode saves through `@roobli/md`; this remains useful for tests and
 * callers that want the narrower identity / single-block shape.
 */
export function isIdentityOrSingleBlockUnits(
  document: NotoDocument,
  units: readonly NotoUnit[],
): boolean {
  if (units.length !== document.blocks.length) return false;
  let dirty = 0;
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index]!;
    if (!unit.origin || unit.origin.ordinal !== index) return false;
    const block = document.blocks[index];
    if (block === undefined) return false;
    const pristine = unit.markdown === null || unit.markdown === block.markdown;
    if (!pristine) dirty += 1;
    if (dirty > 1) return false;
  }
  return true;
}

export type { SerializeUnit, SerializeEnvelope, EnginePreservedRange };

export {
  joinSplit,
  identityUnits,
  engineParseBlocks as parseBlocks,
  engineReparseBlocks as reparseBlocks,
  engineReparseFromText as reparseFromText,
  sourceEditBetween,
};

export type { EngineDocument, EngineSplitDocument, ReparseBlocksOptions, SerializeResult, SourceEdit };

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
 * `SpanEnrichMode` and docs/performance/open-path-first-cut.md.
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
import type { RootContent } from 'mdast';
import type {
  NotoBlockKind,
  NotoDocument,
  NotoTargetEnvelope,
  NotoUnit,
} from './contracts';
import { parseMarkdown, topLevelNodes } from './syntax';

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
 * - `none`: structural only — paragraph stand-in nodes, `semanticKey === kind`.
 *   Flagged `parseDocument` open uses this on main; renderer calls
 *   `enrichSpansInRange` for the first-paint window and remainder.
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
 * Fill dialect mdast for `spans[from..to)` with **one** `parseMarkdown` over
 * the contiguous source covering that range (not N× per span).
 *
 * Spans outside the range are returned unchanged. When top-level node count
 * disagrees with the window length, falls back to per-span enrich for the
 * window only (never silent).
 */
export function enrichSpansInRange<T extends AdapterBlockSpan>(
  spans: readonly T[],
  text: string,
  range: EnrichSpansInRangeOptions,
): T[] {
  const from = Math.max(0, Math.min(range.from, spans.length));
  const to = Math.max(from, Math.min(range.to, spans.length));
  if (from === to || spans.length === 0) return spans.slice() as T[];

  const windowSpans = spans.slice(from, to);
  const sliceStart = windowSpans[0]!.start;
  const sliceEnd = windowSpans[windowSpans.length - 1]!.end;
  const slice = text.slice(sliceStart, sliceEnd);
  const nodes = topLevelNodes(parseMarkdown(slice));

  const enrichedWindow: AdapterBlockSpan[] =
    nodes.length === windowSpans.length
      ? windowSpans.map((span, index) => attachDialectNode(
          {
            kind: span.kind,
            start: span.start,
            end: span.end,
            markdown: span.markdown,
            node: null,
          },
          nodes[index]!,
        ))
      : windowSpans.map((span) => enrichSpan({
          kind: span.kind,
          start: span.start,
          end: span.end,
          markdown: span.markdown,
          node: null,
        }));

  const out = spans.slice() as AdapterBlockSpan[];
  for (let i = 0; i < enrichedWindow.length; i += 1) {
    out[from + i] = enrichedWindow[i]!;
  }
  return out as T[];
}


export interface ResolveDeferredOpenSpansResult<T extends AdapterBlockSpan = AdapterBlockSpan> {
  readonly spans: readonly T[];
  /** When non-null, call `enrichSpansInRange` from this index to length after first paint. */
  readonly remainderFrom: number | null;
}

/**
 * First consumer for flagged lazy open: enrich `[0, initial)` with one range
 * parse. Caller mounts with the result, then enriches the remainder.
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


function standInNode(span: EngineBlockSpan): RootContent {
  return {
    type: 'paragraph',
    children: span.markdown.length > 0 ? [{ type: 'text', value: span.markdown }] : [],
  };
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

  // Multi-node or empty slice: keep engine kind and a paragraph stand-in so
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

/** Structural adapter spans: no dialect parse. Prep for deferred wire nodes. */
function enrichSpanNone(span: EngineBlockSpan): AdapterBlockSpan {
  const kind = span.kind as NotoBlockKind;
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

/**
 * Thin host adapter from `@roobli/md` into Noto markdown v3 shapes.
 *
 * The engine owns block offsets / kinds / gaps / reparse / serialize primitives.
 * Noto keeps branded IDs, sha256, envelope hashing, `semanticKey`, and wire
 * `nodes` (mdast) in this layer: native spans ship `node: null`, so we attach
 * mdast via Noto's dialect when a span needs a ProseMirror-ready node.
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
  type SplitDocument as EngineSplitDocument,
  type BlockSpan as EngineBlockSpan,
  type EngineDocument,
  type SourceEdit,
} from '@roobli/md';
import type { RootContent } from 'mdast';
import type { NotoBlockKind } from './contracts';
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
 * Attach mdast + semanticKey for a native engine span.
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
    const node = nodes[0]!;
    // Prefer dialect kind when the slice itself is unambiguous — keeps
    // ProseMirror / semanticKey aligned with existing micromark behaviour.
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

  // Multi-node or empty slice: keep engine kind and a paragraph stand-in so
  // the BlockSpan contract stays satisfied for paste / source toggles.
  const node: RootContent = {
    type: 'paragraph',
    children: span.markdown.length > 0 ? [{ type: 'text', value: span.markdown }] : [],
  };
  return {
    kind,
    start: span.start,
    end: span.end,
    markdown: span.markdown,
    semanticKey: kind,
    node,
  };
}

/** Structural split only (no mdast). For parity / coverage checks. */
export function parseBlocksStructural(text: string): EngineSplitDocument {
  return engineParseBlocks(text);
}

/** Full Noto-shaped split via `@roobli/md` + dialect enrichment. */
export function splitBlocksViaRoobli(text: string): AdapterSplitDocument {
  const split = engineParseBlocks(text);
  return {
    spans: split.spans.map(enrichSpan),
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

export {
  joinSplit,
  identityUnits,
  engineParseBlocks as parseBlocks,
  engineReparseBlocks as reparseBlocks,
  engineReparseFromText as reparseFromText,
  sourceEditBetween,
};

export type { EngineDocument, EngineSplitDocument, ReparseBlocksOptions, SerializeResult, SourceEdit };

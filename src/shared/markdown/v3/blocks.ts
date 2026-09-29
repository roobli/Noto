/**
 * Splits a markdown document into top level blocks with exact source spans.
 *
 * This is the layer that replaced v1's regular expression classifier. Because
 * micromark does the parsing, a construct is never "unrecognised": tables,
 * task lists, math, frontmatter and raw HTML all arrive as ordinary blocks with
 * a kind, and the editor decides how to present them rather than whether the
 * user may touch them.
 *
 * No Node builtins here. The renderer imports this module to build its
 * ProseMirror document.
 *
 * Product default is `@roobli/md` via `roobli-md-adapter.ts`. Set
 * `NOTO_MARKDOWN_ENGINE=micromark` (or the test override) to force the
 * legacy micromark path.
 */

import type { List, RootContent } from 'mdast';
import { isRoobliMdEngine } from './engine-flag';
import { parseSingleBlockViaRoobli, splitBlocksViaRoobli } from './roobli-md-adapter';
import { parseMarkdown, topLevelNodes } from './syntax';
import type { NotoBlockKind, NotoDocumentWire } from './contracts';

export interface BlockSpan {
  readonly kind: NotoBlockKind;
  readonly start: number;
  readonly end: number;
  readonly markdown: string;
  readonly semanticKey: string;
  readonly node: RootContent;
}

export interface SplitDocument {
  readonly spans: readonly BlockSpan[];
  /** Text before the first block. */
  readonly leading: string;
  /** Text between block i and block i+1, indexed by i. */
  readonly gaps: readonly string[];
  /** Text after the last block. */
  readonly trailing: string;
}

function isTaskList(node: List): boolean {
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
      // mdast does not record the fence style, so read it back off the source.
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
      // mdast's root content union is open ended. Anything we have not given a
      // dedicated kind still round trips through its exact source slice, so
      // treating it as a paragraph only affects presentation, never fidelity.
      return 'paragraph';
  }
}

/**
 * A compact structural fingerprint used to detect that a block reparsed into a
 * different shape than the editor intended. It deliberately describes structure
 * rather than content, because content equality is already checked by comparing
 * the serialized source text.
 */
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

/** Trailing newlines belong to the gap, not to the block. */
function trimTrailingNewlines(text: string, end: number): number {
  let cursor = end;
  while (cursor > 0) {
    const previous = text[cursor - 1];
    if (previous !== '\n' && previous !== '\r') break;
    cursor -= 1;
  }
  return cursor;
}

/**
 * Micromark-backed split (historical default). Exported for parity tests that
 * must pin the baseline even when the process env selects `@roobli/md`.
 */
export function splitBlocksMicromark(text: string): SplitDocument {
  const root = parseMarkdown(text);
  const spans: BlockSpan[] = [];

  for (const node of topLevelNodes(root)) {
    const position = node.position;
    if (position?.start.offset === undefined || position.end.offset === undefined) continue;
    const start = position.start.offset;
    const end = trimTrailingNewlines(text, position.end.offset);
    if (end <= start) continue;
    const markdown = text.slice(start, end);
    const kind = kindOf(node, markdown);
    spans.push({ kind, start, end, markdown, semanticKey: semanticKeyOf(node, kind), node });
  }

  if (spans.length === 0) {
    return { spans: [], leading: '', gaps: [], trailing: text };
  }

  const gaps: string[] = [];
  for (let index = 0; index + 1 < spans.length; index += 1) {
    gaps.push(text.slice(spans[index]!.end, spans[index + 1]!.start));
  }

  return {
    spans,
    leading: text.slice(0, spans[0]!.start),
    gaps,
    trailing: text.slice(spans[spans.length - 1]!.end),
  };
}

/**
 * Split `text` into blocks and the literal whitespace between them.
 *
 * Every character of `text` appears in exactly one of `leading`, a span's
 * `markdown`, a gap, or `trailing`. That total coverage is what lets the
 * serializer rebuild an untouched document byte for byte.
 */
export function splitBlocks(text: string): SplitDocument {
  if (isRoobliMdEngine()) {
    return splitBlocksViaRoobli(text);
  }
  return splitBlocksMicromark(text);
}

/**
 * Parse a candidate block and confirm it is exactly one block.
 *
 * Used to reject an edit that would silently split into several blocks, for
 * example a paragraph the user began with `- `, which would become a list and
 * quietly change the document structure.
 */
export function parseSingleBlock(markdown: string): BlockSpan | null {
  if (isRoobliMdEngine()) {
    return parseSingleBlockViaRoobli(markdown);
  }
  const split = splitBlocksMicromark(markdown);
  if (split.spans.length !== 1) return null;
  if (split.leading.trim().length > 0 || split.trailing.trim().length > 0) return null;
  return split.spans[0]!;
}

/**
 * Rebuild `BlockSpan`s from a wire document that still carries mdast nodes.
 *
 * Returns null when `nodes` is absent (incremental save replies), so callers
 * can fall back to `parseDocumentSpans` / the Worker. Kept here rather than in
 * `document.ts` so the renderer can use it without pulling in `node:crypto`.
 */
export function blockSpansFromWire(document: NotoDocumentWire): readonly BlockSpan[] | null {
  const { nodes } = document;
  if (!nodes || nodes.length !== document.spans.length || nodes.length !== document.origins.length) {
    return null;
  }
  return document.spans.map((span, index) => {
    const origin = document.origins[index]!;
    return {
      kind: origin.kind,
      start: span.start,
      end: span.end,
      markdown: document.text.slice(span.start, span.end),
      semanticKey: origin.semanticKey,
      node: nodes[index]!,
    };
  });
}

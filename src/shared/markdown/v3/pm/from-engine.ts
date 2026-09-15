/**
 * Engine-owned IR → ProseMirror for common blocks (flagged `@roobli/md` path).
 *
 * Native spans are kind + source offsets only. For leaf kinds (fence, hr, math,
 * frontmatter, html), parseable link-definitions, **simple footnote-definitions**
 * (plain or empty single-paragraph body; optional soft-wrap continuations), plain
 * paragraph/heading with no inline dialect markers (hard breaks — two+ spaces
 * before newline — are engine-owned as `hard_break` nodes), **simple** blockquotes
 * (every line `>`-prefixed, inner content is plain paragraphs only), **simple
 * flat lists** (no nest, consistent markers, plain single-paragraph items), and
 * **simple GFM tables** (alignment row; plain text cells; no nested blocks /
 * marked phrasing), the PM node is fully determined by that IR — no micromark /
 * mdast pass. Nested lists, multi-block items, nested/marked quotes, complex
 * tables, marked footnote bodies, and marked-up phrasing still go through
 * `from-mdast.ts` after dialect enrich.
 *
 * See docs/performance/open-path-first-cut.md and docs/design/roobli-md-engine.md.
 */

import type { Node as ProseNode } from 'prosemirror-model';
import type { NotoBlockKind } from '../contracts';
import { notoSchema } from './schema';

const schema = notoSchema;

/** Kinds whose editable shape needs no inline dialect parse. */
export const ENGINE_LEAF_KINDS: ReadonlySet<NotoBlockKind> = new Set([
  'fenced-code',
  'indented-code',
  'thematic-break',
  'frontmatter',
  'html',
  'display-math',
]);

/**
 * Conservative scan for markers that need the host dialect (emphasis, wiki,
 * links, code, math, HTML, autolink). Hard breaks alone do **not** force dialect
 * for plain paragraph/heading — those become engine-owned `hard_break` nodes
 * (serialize still writes two trailing spaces via `hardBreakAsTwoSpaces`).
 */
const INLINE_DIALECT_RE = /[*_~`[\]<!$:\\]|https?:\/\//u;
/** CommonMark / vault hard break: two+ spaces before newline. */
const HARD_BREAK_RE = / {2,}\r?\n/;

export function needsDialectInline(markdown: string): boolean {
  return INLINE_DIALECT_RE.test(markdown);
}

/** True when the source contains a CommonMark hard break (two+ spaces + newline). */
export function hasHardBreak(markdown: string): boolean {
  return HARD_BREAK_RE.test(markdown);
}

/**
 * True when dialect enrich can be skipped: leaf kinds always; parseable
 * link-definitions; simple footnote-definitions; simple quotes; simple flat
 * lists; simple GFM tables; paragraph / heading when the source has no inline
 * dialect markers (hard breaks allowed — engine-owned).
 */
export function canSkipDialectEnrich(kind: NotoBlockKind, markdown: string): boolean {
  if (ENGINE_LEAF_KINDS.has(kind)) return true;
  if (kind === 'link-definition') {
    return parseLinkDefinitionSource(markdown) !== null;
  }
  if (kind === 'footnote-definition') {
    return parseSimpleFootnoteDefinitionSource(markdown) !== null;
  }
  if (kind === 'quote') {
    return parseSimpleQuoteSource(markdown) !== null;
  }
  if (kind === 'bullet-list' || kind === 'ordered-list' || kind === 'task-list') {
    return parseSimpleFlatListSource(markdown) !== null;
  }
  if (kind === 'table') {
    return parseSimpleTableSource(markdown) !== null;
  }
  if (kind === 'paragraph' || kind === 'heading') {
    return !needsDialectInline(markdown);
  }
  return false;
}

function textNodes(value: string): ProseNode[] {
  return value.length === 0 ? [] : [schema.text(value)];
}

/**
 * Plain paragraph/heading inline content: soft newlines stay in text (pre-wrap);
 * CommonMark hard breaks (` {2,}\n`) become `hard_break` nodes so serialize
 * keeps vault form (two trailing spaces). Trailing spaces with no following
 * newline are dropped like CommonMark / mdast.
 */
export function inlineNodesFromPlainSource(md: string): ProseNode[] {
  const normalized = md.replace(/\r\n/g, '\n');
  if (!HARD_BREAK_RE.test(normalized)) {
    const body = normalized.trimEnd();
    return textNodes(body);
  }
  const nodes: ProseNode[] = [];
  const re = / {2,}\n/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(normalized)) !== null) {
    const before = normalized.slice(lastIndex, match.index);
    if (before.length > 0) nodes.push(...textNodes(before));
    nodes.push(schema.nodes.hard_break.create());
    lastIndex = match.index + match[0].length;
  }
  const after = normalized.slice(lastIndex).replace(/[ \t\r\n]+$/u, '');
  if (after.length > 0) nodes.push(...textNodes(after));
  return nodes;
}

export interface ParsedFence {
  readonly lang: string;
  readonly meta: string;
  readonly value: string;
}

/** Parse a fenced code source slice (ATX fence open/close). */
export function parseFenceSource(md: string): ParsedFence | null {
  // Empty fence is open\\nclose (no content line). Content fences keep the
  // newline before the closing fence out of `value`.
  const fence = /^(?: {0,3})(`{3,}|~{3,})([^\n]*)\r?\n(?:([\s\S]*?)\r?\n)?(?: {0,3})\1[ \t]*\r?$/s.exec(md);
  if (!fence) return null;
  const info = fence[2]!.trim();
  const infoMatch = info.length > 0 ? /^(\S+)(?:[ \t]+(.*))?$/u.exec(info) : null;
  return {
    lang: infoMatch?.[1] ?? '',
    meta: infoMatch?.[2]?.trim() ?? '',
    value: fence[3] ?? '',
  };
}

export interface ParsedHeading {
  readonly level: number;
  readonly text: string;
}

/** ATX or setext heading body text (no inline marks). */
export function parseHeadingSource(md: string): ParsedHeading | null {
  const trimmed = md.trimEnd();
  const atx = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/s.exec(trimmed);
  if (atx) {
    return { level: Math.min(6, atx[1]!.length), text: atx[2]! };
  }
  const setext = /^([\s\S]+?)\n([=-])\2*[ \t]*$/s.exec(trimmed);
  if (setext) {
    return {
      level: setext[2] === '=' ? 1 : 2,
      text: setext[1]!.replace(/\s+$/u, ''),
    };
  }
  return null;
}

const QUOTE_LINE_RE = /^( {0,3})>([ \t]?)(.*)$/u;

/**
 * Inner line (after `>` + optional space) that is still paragraph text.
 * Nested quotes, lists, ATX, fences, HTML, tables, hr/setext, link-defs,
 * and indented-code fall through to dialect enrich.
 */
function quoteInnerIsParagraphLine(rest: string): boolean {
  if (/^[ \t]*$/u.test(rest)) return true;
  if (/^(?: {4}|\t)/u.test(rest)) return false;
  const t = rest.replace(/^ {0,3}/u, '');
  if (t.startsWith('>')) return false;
  if (/^#{1,6}(?:[ \t]|$)/u.test(t)) return false;
  if (/^(`{3,}|~{3,})/u.test(t)) return false;
  if (/^([-+*])(?:[ \t]|$)/u.test(t)) return false;
  if (/^[0-9]{1,9}[.)](?:[ \t]|$)/u.test(t)) return false;
  if (t.startsWith('<')) return false;
  if (t.startsWith('|')) return false;
  if (/^\[([^\]]+)\]:/u.test(t)) return false;
  if (/^([*\-_])(?:[ \t]*\1){2,}[ \t]*$/u.test(t)) return false;
  if (/^=+[ \t]*$/u.test(t)) return false;
  return true;
}

/**
 * Simple blockquote: every line is `>`-prefixed (no lazy continuation), inner
 * content is one or more plain paragraphs. Returns paragraph bodies matching
 * CommonMark / mdast (leading indent skipped, trailing spaces trimmed), or
 * `null` when the span still needs dialect enrich.
 */
export function parseSimpleQuoteSource(md: string): string[] | null {
  const trimmed = md.replace(/\r\n/g, '\n').trimEnd();
  if (trimmed.length === 0) return null;
  const lines = trimmed.split('\n');
  const inner: string[] = [];
  for (const line of lines) {
    const m = QUOTE_LINE_RE.exec(line);
    if (!m) return null;
    const rest = m[3]!;
    if (!quoteInnerIsParagraphLine(rest)) return null;
    inner.push(rest);
  }
  const paragraphs: string[] = [];
  let buf: string[] = [];
  const flush = (): void => {
    if (buf.length === 0) return;
    const text = buf.map((l) => l.replace(/^ {0,3}/u, '')).join('\n').trimEnd();
    if (text.length > 0) paragraphs.push(text);
    buf = [];
  };
  for (const rest of inner) {
    if (/^[ \t]*$/u.test(rest)) flush();
    else buf.push(rest);
  }
  flush();
  if (paragraphs.length === 0) return null;
  if (paragraphs.some((p) => needsDialectInline(p) || hasHardBreak(p))) return null;
  return paragraphs;
}

export type FlatListBullet = '-' | '*' | '+';
export type FlatListDelimiter = '.' | ')';

export interface ParsedFlatListItem {
  readonly checked: boolean | null;
  readonly text: string;
}

export interface ParsedFlatList {
  readonly ordered: boolean;
  readonly bullet: FlatListBullet | null;
  readonly delimiter: FlatListDelimiter | null;
  readonly start: number;
  readonly spread: boolean;
  readonly items: readonly ParsedFlatListItem[];
}

/** Marker line without task/content yet: indent + bullet or ordered. */
const BULLET_MARKER_RE = /^( {0,3})([-+*])(?:([ \t]+)|$)/u;
const ORDERED_MARKER_RE = /^( {0,3})([0-9]{1,9})([.)])(?:([ \t]+)|$)/u;

/**
 * Nested list / fence / quote / heading / hr / table / HTML on a continuation
 * line — fall through to dialect.
 */
function listContinuationLooksStructural(line: string): boolean {
  if (/^[ \t]*$/u.test(line)) return false;
  const t = line.replace(/^ {0,3}/u, '');
  if (/^([-+*])(?:[ \t]|$)/u.test(t)) return true;
  if (/^[0-9]{1,9}[.)](?:[ \t]|$)/u.test(t)) return true;
  if (t.startsWith('>')) return true;
  if (/^#{1,6}(?:[ \t]|$)/u.test(t)) return true;
  if (/^(`{3,}|~{3,})/u.test(t)) return true;
  if (t.startsWith('<')) return true;
  if (t.startsWith('|')) return true;
  if (/^([*\-_])(?:[ \t]*\1){2,}[ \t]*$/u.test(t)) return true;
  if (/^(?: {4}|\t)/u.test(line)) return true;
  return false;
}

/**
 * GFM task checkbox after the list marker padding. Requires EOL or whitespace
 * after `]` (`[x]done` stays literal).
 */
function splitTaskPrefix(rest: string): { checked: boolean | null; text: string } {
  const m = /^\[([ xX])\](?:([ \t]+)|$)/u.exec(rest);
  if (!m) return { checked: null, text: rest };
  return {
    checked: m[1]!.toLowerCase() === 'x',
    text: rest.slice(m[0].length),
  };
}

/**
 * Simple flat list: top-level items only (no nest), consistent bullet or
 * ordered delimiter, each item a single plain paragraph (optional soft-wrap
 * continuation). Loose lists (blank between items) set `spread`. Task
 * checkboxes are allowed. Returns `null` when dialect enrich is still needed.
 */
export function parseSimpleFlatListSource(md: string): ParsedFlatList | null {
  const trimmed = md.replace(/\r\n/g, '\n').trimEnd();
  if (trimmed.length === 0) return null;
  const lines = trimmed.split('\n');

  type DraftItem = { checked: boolean | null; lines: string[] };
  const items: DraftItem[] = [];
  let ordered: boolean | null = null;
  let bullet: FlatListBullet | null = null;
  let delimiter: FlatListDelimiter | null = null;
  let start = 1;
  let baseIndent: string | null = null;
  let pendingBlank = false;
  let spread = false;
  let sawItem = false;

  for (const line of lines) {
    if (/^[ \t]*$/u.test(line)) {
      if (!sawItem) return null;
      pendingBlank = true;
      continue;
    }

    const bulletMatch = BULLET_MARKER_RE.exec(line);
    const orderedMatch = bulletMatch ? null : ORDERED_MARKER_RE.exec(line);

    if (bulletMatch || orderedMatch) {
      const indent = (bulletMatch ?? orderedMatch)![1]!;
      if (baseIndent === null) baseIndent = indent;
      if (indent !== baseIndent) return null;

      let rest: string;
      if (bulletMatch) {
        const marker = bulletMatch[2] as FlatListBullet;
        if (ordered === true) return null;
        if (bullet !== null && bullet !== marker) return null;
        ordered = false;
        bullet = marker;
        rest = line.slice(bulletMatch[0].length);
      } else {
        const m = orderedMatch!;
        const num = Number(m[2]!);
        const delim = m[3] as FlatListDelimiter;
        if (ordered === false) return null;
        if (delimiter !== null && delimiter !== delim) return null;
        if (ordered === null) start = num;
        ordered = true;
        delimiter = delim;
        bullet = null;
        rest = line.slice(m[0].length);
      }

      const { checked, text: rawText } = splitTaskPrefix(rest);
      // Match CommonMark/mdast: padding spaces after the marker are not content.
      const text = rawText.replace(/^[ \t]+/u, '');
      if (pendingBlank && sawItem) spread = true;
      pendingBlank = false;
      sawItem = true;
      items.push({ checked, lines: [text] });
      continue;
    }

    // Indented soft-wrap continuation of the current item only.
    if (!sawItem || items.length === 0) return null;
    if (pendingBlank) return null; // blank then non-marker = multi-para item
    if (listContinuationLooksStructural(line)) return null;
    if (baseIndent !== null && line.startsWith(baseIndent) && line.length > baseIndent.length
      && /[ \t]/.test(line[baseIndent.length]!)) {
      const rest = line.slice(baseIndent.length).replace(/^[ \t]+/u, '');
      if (needsDialectInline(rest) || HARD_BREAK_RE.test(line)) return null;
      items[items.length - 1]!.lines.push(rest);
      continue;
    }
    return null;
  }

  if (items.length === 0 || ordered === null) return null;

  const parsedItems: ParsedFlatListItem[] = [];
  for (const item of items) {
    const joined = item.lines.join('\n');
    const text = joined.trimEnd();
    if (needsDialectInline(text) || HARD_BREAK_RE.test(joined)) return null;
    parsedItems.push({ checked: item.checked, text });
  }

  return {
    ordered,
    bullet: ordered ? null : bullet,
    delimiter: ordered ? delimiter : null,
    start: ordered ? start : 1,
    spread,
    items: parsedItems,
  };
}

export type TableAlign = 'left' | 'right' | 'center' | null;

export interface ParsedSimpleTable {
  readonly align: readonly TableAlign[];
  /** Row 0 is the header; remaining rows are body. */
  readonly rows: readonly (readonly string[])[];
}

const TABLE_DELIMITER_CELL = /^:?-+:?$/u;

/**
 * Split one GFM table row on unescaped, non-code `|` (mirrors table-align).
 * Outer pipes are optional. Returns trimmed cell strings.
 */
function splitTableRow(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let escaped = false;
  let inCode = false;
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (const character of body) {
    if (escaped) { current += character; escaped = false; continue; }
    if (character === '\\') { current += character; escaped = true; continue; }
    if (character === '`') { inCode = !inCode; current += character; continue; }
    if (character === '|' && !inCode) { cells.push(current); current = ''; continue; }
    current += character;
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

function alignmentOfDelimiterCell(cell: string): TableAlign | undefined {
  if (!TABLE_DELIMITER_CELL.test(cell)) return undefined;
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

/**
 * Simple GFM table: header + alignment row + optional body rows; every cell
 * plain text (no inline dialect markers); consistent column counts; no blank
 * lines inside the span. Ragged columns, escaped pipes, code/marks in cells,
 * and missing delimiter fall through to dialect. Returns `null` when enrich
 * is still needed.
 */
export function parseSimpleTableSource(md: string): ParsedSimpleTable | null {
  const trimmed = md.replace(/\r\n/g, '\n').trimEnd();
  if (trimmed.length === 0) return null;
  const lines = trimmed.split('\n');
  if (lines.length < 2) return null;

  // Require a leading `|` after optional CommonMark indent (0–3 spaces).
  const normalized: string[] = [];
  for (const line of lines) {
    if (/^[ \t]*$/u.test(line)) return null; // blank ends a GFM table
    const m = /^( {0,3})(\|.*)$/u.exec(line);
    if (!m) return null;
    normalized.push(m[2]!);
  }

  const header = splitTableRow(normalized[0]!);
  if (header.length === 0) return null;
  const delimCells = splitTableRow(normalized[1]!);
  if (delimCells.length !== header.length) return null;

  const align: TableAlign[] = [];
  for (const cell of delimCells) {
    const a = alignmentOfDelimiterCell(cell);
    if (a === undefined) return null;
    align.push(a);
  }

  const rows: string[][] = [header];
  for (let i = 2; i < normalized.length; i += 1) {
    const cells = splitTableRow(normalized[i]!);
    if (cells.length !== header.length) return null;
    rows.push(cells);
  }

  for (const row of rows) {
    for (const cell of row) {
      if (needsDialectInline(cell)) return null;
    }
  }

  return { align, rows };
}

function parseIndentedCode(md: string): string {
  return md.replace(/^(?: {4}|\t)/gm, '').replace(/\r?\n$/u, '');
}

function parseDisplayMath(md: string): string {
  const m = /^\$\$\r?\n?([\s\S]*?)\r?\n?\$\$$/u.exec(md.trim());
  return m ? m[1]! : md;
}

function parseFrontmatter(md: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*$/u.exec(md);
  return m ? m[1]! : md;
}

export interface ParsedLinkDefinition {
  readonly identifier: string;
  readonly label: string;
  readonly url: string;
  readonly title: string | null;
}

/**
 * Single-line CommonMark link reference definition.
 * Multiline / exotic titles fall through to dialect enrich.
 */
export function parseLinkDefinitionSource(md: string): ParsedLinkDefinition | null {
  const trimmed = md.replace(/\r\n/g, '\n').trimEnd();
  const m = /^\[([^\]]+)\]:[ \t]+(?:<([^>\n]*)>|(\S+))(?:[ \t]+(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|\(((?:\\.|[^)\\])*)\)))?[ \t]*$/u.exec(trimmed);
  if (!m) return null;
  const label = m[1]!;
  const url = (m[2] ?? m[3] ?? '').replace(/\\([\\()])/g, '$1');
  const titleRaw = m[4] ?? m[5] ?? m[6] ?? null;
  const title = titleRaw === null ? null : titleRaw.replace(/\\(["'()\\])/g, '$1');
  return {
    identifier: label.toLowerCase(),
    label,
    url,
    title,
  };
}

export interface ParsedFootnoteDefinition {
  readonly identifier: string;
  readonly label: string;
  readonly text: string;
}

/**
 * Simple footnote definition: `[^label]:` + plain (or empty) single-paragraph body.
 * Optional soft-wrap continuation lines (indented) are joined with a newline
 * after leading whitespace is stripped (mdast parity). Hard breaks, marked
 * phrasing, and structural continuation lines fall through to dialect.
 */
export function parseSimpleFootnoteDefinitionSource(md: string): ParsedFootnoteDefinition | null {
  const trimmed = md.replace(/\r\n/g, '\n').trimEnd();
  if (trimmed.length === 0) return null;
  const lines = trimmed.split('\n');
  const first = /^\[(\^[^\]]+)\]:[ \t]?(.*)$/u.exec(lines[0]!);
  if (!first) return null;
  const label = first[1]!.slice(1); // drop leading ^
  if (label.length === 0) return null;
  const parts: string[] = [first[2]!];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^[ \t]*$/u.test(line)) return null;
    if (!/^(?: {1,}|\t)/u.test(line)) return null;
    if (listContinuationLooksStructural(line.replace(/^(?: {1,}|\t)+/u, ''))) return null;
    // Footnote body soft-wrap: strip leading indent like mdast.
    parts.push(line.replace(/^[ \t]+/u, ''));
  }
  const text = parts.join('\n').trimEnd();
  // Empty body (`[^id]:` / whitespace-only) is still engine-owned: one empty
  // paragraph child (schema `block+`). Marked / hard-break / structural stay out.
  if (needsDialectInline(text) || hasHardBreak(text) || HARD_BREAK_RE.test(parts.join('\n'))) return null;
  return {
    identifier: label.toLowerCase(),
    label,
    text,
  };
}

/**
 * Structural fingerprint matching dialect `semanticKeyOf` for engine-owned
 * kinds so save / reparse checks stay aligned when enrich is skipped.
 */
export function engineSemanticKey(kind: NotoBlockKind, markdown: string): string {
  const parts: (string | number | boolean)[] = [kind];
  switch (kind) {
    case 'heading': {
      const h = parseHeadingSource(markdown);
      if (h) parts.push(h.level);
      break;
    }
    case 'fenced-code': {
      const f = parseFenceSource(markdown);
      parts.push(f?.lang ?? '', f?.meta ?? '');
      break;
    }
    case 'indented-code':
      parts.push('', '');
      break;
    case 'link-definition': {
      const d = parseLinkDefinitionSource(markdown);
      if (d) parts.push(d.identifier);
      break;
    }
    case 'footnote-definition': {
      const f = parseSimpleFootnoteDefinitionSource(markdown);
      if (f) parts.push(f.identifier);
      break;
    }
    case 'bullet-list':
    case 'ordered-list':
    case 'task-list': {
      const list = parseSimpleFlatListSource(markdown);
      if (list) parts.push(list.ordered, list.start, list.spread, list.items.length);
      break;
    }
    case 'table': {
      const table = parseSimpleTableSource(markdown);
      if (table) {
        parts.push(
          table.rows.length,
          table.rows[0]?.length ?? 0,
          table.align.map((value) => value ?? '-').join(''),
        );
      }
      break;
    }
    default:
      break;
  }
  return parts.join('\u0000');
}

/**
 * Build a ProseMirror block from engine kind + source when feasible.
 * Returns `null` when the span still needs dialect / mdast.
 */
export function blockFromEngineSpan(kind: NotoBlockKind, markdown: string): ProseNode | null {
  if (!canSkipDialectEnrich(kind, markdown)) return null;

  switch (kind) {
    case 'thematic-break':
      return schema.nodes.horizontal_rule.create();
    case 'fenced-code': {
      const f = parseFenceSource(markdown);
      if (f) {
        return schema.nodes.code_block.create(
          { lang: f.lang, fenced: true },
          textNodes(f.value),
        );
      }
      return schema.nodes.code_block.create(
        { lang: '', fenced: true },
        textNodes(markdown),
      );
    }
    case 'indented-code':
      return schema.nodes.code_block.create(
        { lang: '', fenced: false },
        textNodes(parseIndentedCode(markdown)),
      );
    case 'display-math':
      return schema.nodes.math_block.create(null, textNodes(parseDisplayMath(markdown)));
    case 'frontmatter':
      return schema.nodes.frontmatter.create(null, textNodes(parseFrontmatter(markdown)));
    case 'html':
      return schema.nodes.html_block.create(null, textNodes(markdown));
    case 'heading': {
      const h = parseHeadingSource(markdown);
      if (!h) {
        return schema.nodes.heading.create({ level: 1 }, inlineNodesFromPlainSource(markdown));
      }
      return schema.nodes.heading.create({ level: h.level }, inlineNodesFromPlainSource(h.text));
    }
    case 'paragraph': {
      // Soft newlines stay in text (pre-wrap). Hard breaks (` {2,}\n`) become
      // `hard_break` nodes. Trailing spaces without a following newline are
      // dropped like CommonMark / mdast (avoids `See  [[` after open+type).
      return schema.nodes.paragraph.create(null, inlineNodesFromPlainSource(markdown));
    }
    case 'link-definition': {
      const d = parseLinkDefinitionSource(markdown);
      if (!d) return null;
      return schema.nodes.link_definition.create({
        identifier: d.identifier,
        label: d.label,
        url: d.url,
        title: d.title,
      });
    }
    case 'footnote-definition': {
      const f = parseSimpleFootnoteDefinitionSource(markdown);
      if (!f) return null;
      return schema.nodes.footnote_definition.create(
        { identifier: f.identifier, label: f.label },
        [schema.nodes.paragraph.create(null, textNodes(f.text))],
      );
    }
    case 'quote': {
      const paras = parseSimpleQuoteSource(markdown);
      if (!paras) return null;
      const children = paras.map((p) => schema.nodes.paragraph.create(null, textNodes(p)));
      return schema.nodes.blockquote.create(null, children);
    }
    case 'bullet-list':
    case 'ordered-list':
    case 'task-list': {
      const list = parseSimpleFlatListSource(markdown);
      if (!list) return null;
      const items = list.items.map((item) => schema.nodes.list_item.create(
        { checked: item.checked },
        [schema.nodes.paragraph.create(null, textNodes(item.text))],
      ));
      if (list.ordered) {
        return schema.nodes.ordered_list.create({
          start: list.start,
          spread: list.spread,
          delimiter: list.delimiter ?? '.',
        }, items);
      }
      return schema.nodes.bullet_list.create({
        spread: list.spread,
        bullet: list.bullet ?? '-',
      }, items);
    }
    case 'table': {
      const table = parseSimpleTableSource(markdown);
      if (!table) return null;
      const pmRows = table.rows.map((row, rowIndex) => {
        const cellType = rowIndex === 0 ? schema.nodes.table_header : schema.nodes.table_cell;
        const cells = row.map((cell, columnIndex) => cellType.create(
          { align: table.align[columnIndex] ?? null },
          textNodes(cell),
        ));
        return schema.nodes.table_row.create(null, cells);
      });
      return schema.nodes.table.create(null, pmRows);
    }
    default:
      return null;
  }
}

/**
 * Engine-owned IR → ProseMirror for common blocks (flagged `@roobli/md` path).
 *
 * Native spans are kind + source offsets only. For leaf kinds (fence, hr, math,
 * frontmatter, html), parseable link-definitions, **simple footnote-definitions**
 * (plain / empty / simple-marked single-paragraph body; optional soft-wrap /
 * hard-break), paragraph/heading with plain or **simple marked** phrasing
 * (`**strong**` / `*em*` / `__strong__` / `_em_` / `~~del~~` / `` `code` ``;
 * one-level nested marks e.g. `**bold _italic_**` / `*em **strong** em*`;
 * hard breaks engine-owned; snake_case underscores stay literal),
 * **simple** blockquotes (every line `>`-prefixed; plain or simple-marked
 * paragraphs incl. hard breaks, nested quotes, simple lists-in-quotes,
 * plain-body GFM alerts / callouts incl. simple-marked bodies and
 * simple-marked same-line titles, and CommonMark
 * lazy continuation via fewer `>` **or true no-`>` lazy lines**), **simple
 * flat / nested lists** (same-family or mixed-marker nests at every depth;
 * plain or simple-marked single-paragraph items incl. hard breaks and
 * unindented lazy soft-wrap), and **simple GFM tables** (alignment row; plain or simple-marked
 * cells incl. escaped pipes; consistent **or ragged** body columns — micromark keeps
 * short/long body rows as-is), the PM node is fully
 * determined by that IR — no micromark / mdast pass. Multi-block items, deep /
 * ambiguous nested marks / multi-line HTML, and complex tables (HTML / math
 * in cells, delimiter≠header) still go
 * through `from-mdast.ts` after dialect enrich. **Simple backslash escapes**
 * (ASCII punctuation + trailing-`\\` hard breaks), including **escaped pipes
 * inside simple GFM table cells**, are engine-owned. **Simple inline HTML**
 * (open/close/self-closing tags, comments, PI, declarations, CDATA; single-line)
 * is engine-owned as `inline_html` atoms.
 * **Simple inline links** (`[text](url)` /
 * optional title) and **images** (`![alt](url)`) with plain or simple-marked link text are
 * engine-owned. **Simple reference links / images** (`[text][id]` / `[text][]` /
 * `![alt][id]` / `![alt][]`) are engine-owned (empty href/src; mirror from-mdast).
 * **Simple bare http(s) autolinks** (`https://…` / `http://…`; text === href; GFM-ish
 * trailing punct trim; ASCII-letter previous blocks) are engine-owned.
 * **Simple angle-bracket http(s) autolinks** (`<https://…>` / `<http://…>`; text === href;
 * brackets not in text) are engine-owned.
 * **Simple www. autolinks** (`www.…`; href `http://www.…`; GFM-ish trail trim; alnum previous blocks)
 * and **simple email autolinks** (bare `user@host.tld` + angle `<user@host.tld>` /
 * `<mailto:…>`; href `mailto:…`) are engine-owned. **Simple inline HTML** is
 * engine-owned as `inline_html` atoms. **Simple inline math** (`$…$` / `$$…$$`)
 * is engine-owned as `math_inline` (multi-line HTML / exotic constructs stay dialect).
 * **Simple wiki links** (`[[target]]` / `[[target|alias]]`) are engine-owned
 * as literal text (decoration plugin owns display).
 * **Simple GFM alerts / callouts** (incl. collapsible / plain-titled /
 * simple-marked titles) keep the marker as plain text for the alert
 * decoration plugin; title marks are real PM marks after the marker.
 *
 * See docs/performance/open-path-first-cut.md and docs/design/roobli-md-engine.md.
 */

import type { Mark, Node as ProseNode } from 'prosemirror-model';
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
 * Simple `*` / `**` / `_` / `__` / `~~` / `` ` `` marks (incl. one-level
 * nesting), simple inline links / images, simple reference links / images,
 * simple bare http(s) + angle-bracket http(s) + www. + email autolinks, and
 * simple wiki `[[…]]` (literal text) are engine-owned via `tryInlineNodesFromSource`;
 * deep / ambiguous nests and heavier constructs stay on dialect. Snake_case
 * underscores are literal (CommonMark flanking).
 */
const INLINE_DIALECT_RE = /[*_~`[\]<!$:\\@]|https?:\/\/|www\./iu;
/**
 * No remaining single-character "always dialect" gate: math (`$`) and simple
 * inline HTML are engine-owned. Multi-line / exotic HTML is refused in the
 * scanner when `<` is not a simple `<http(s)://…>` / email / mailto autolink
 * or simple HTML tag. Bare `http(s)://`, `www.`, email, and angle-bracket
 * http(s)/email are engine-owned (URLs inside `[text](url)` destinations are
 * consumed by the link branch).
 * Do **not** put `:` in a refuse class — it would refuse every `https://`
 * destination.
 * Brackets are scanned for simple `[text](url)` / `![alt](url)`, simple
 * `[text][id]` / `[text][]` / `![alt][id]` / `![alt][]`, and simple wiki
 * `[[target]]` / `[[target|alias]]` (footnotes stay dialect). Underscore
 * emphasis is owned (snake_case-safe flanking).
 */
/** CommonMark / vault hard break: two+ spaces before newline. */
const HARD_BREAK_RE = / {2,}\r?\n/;
/** CommonMark escapable ASCII punctuation (backslash escapes). */
const ESCAPABLE_ASCII_PUNCT = /[!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~]/;

export function needsDialectInline(markdown: string): boolean {
  return INLINE_DIALECT_RE.test(markdown);
}

/**
 * GFM alert / callout marker at the start of a quote paragraph.
 *
 * Owns plain `[!NOTE]`, collapsible `[!NOTE]-` / `[!NOTE]+`, optional same-line
 * plain titles (`[!NOTE] Title`), and **simple-marked titles** (`[!NOTE] Title
 * **x**`, wiki / links / autolinks / simple escapes / simple inline math in the
 * title). Heavy titles (deep nests / multi-line HTML) stay dialect. The
 * alert-plugin decorates from the
 * leading `[!NOTE]` token either way.
 */
const ALERT_MARKER_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]([+-])?[ \t]*([^\n]*)(?:\n|$)/;

/**
 * Dialect check for quote paragraph text: a leading GFM alert marker is plain
 * text (alert-plugin decorates it). The remainder may be plain or simple-marked.
 */
export function needsDialectInlineInQuote(markdown: string): boolean {
  return tryInlineNodesFromSource(markdown, { quoteAlert: true }) === null;
}

/** True when the source contains a CommonMark hard break (two+ spaces + newline). */
export function hasHardBreak(markdown: string): boolean {
  return HARD_BREAK_RE.test(markdown);
}

/**
 * True when dialect enrich can be skipped: leaf kinds always; parseable
 * link-definitions; simple footnote-definitions (incl. hard breaks + simple
 * marks); simple quotes (incl. nested, hard breaks, lists-in-quotes, plain /
 * simple-marked / collapsible / plain-titled / simple-marked-title GFM alerts / callouts, lazy nest + no-`>` lazy); simple flat
 * or nested lists (same-family or mixed-marker, any depth, incl. hard breaks + simple marks);
 * simple GFM tables (plain or simple-marked cells incl. escaped pipes; ragged body rows); paragraph / heading when
 * plain or simple-marked (hard breaks + simple inline links / images +
 * simple reference links / images + simple bare http(s) + angle-bracket
 * http(s) + www. + email autolinks + simple wiki links + simple backslash
 * escapes + simple inline HTML + simple inline math allowed — engine-owned).
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
    return tryInlineNodesFromSource(markdown) !== null;
  }
  return false;
}

function textNodes(value: string, marks: readonly Mark[] = []): ProseNode[] {
  return value.length === 0 ? [] : [schema.text(value, marks)];
}

/**
 * Plain paragraph/heading inline content: soft newlines stay in text (pre-wrap);
 * CommonMark hard breaks (` {2,}\n`) become `hard_break` nodes so serialize
 * keeps vault form (two trailing spaces). Trailing spaces with no following
 * newline are dropped like CommonMark / mdast.
 */
export function inlineNodesFromPlainSource(md: string, marks: readonly Mark[] = []): ProseNode[] {
  return plainRunNodes(md, marks, true);
}

/**
 * Plain / hard-break inline nodes. When `trimTrailing` is true (standalone
 * plain paragraphs), trailing spaces without a following newline are dropped
 * like CommonMark / mdast. Mid-phrase plain runs between marks pass
 * `trimTrailing: false` so spaces around `**bold**` survive.
 */
function plainRunNodes(
  md: string,
  marks: readonly Mark[] = [],
  trimTrailing = false,
): ProseNode[] {
  const normalized = md.replace(/\r\n/g, '\n');
  if (!HARD_BREAK_RE.test(normalized)) {
    const body = trimTrailing ? normalized.trimEnd() : normalized;
    return textNodes(body, marks);
  }
  const nodes: ProseNode[] = [];
  const re = / {2,}\n/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(normalized)) !== null) {
    const before = normalized.slice(lastIndex, match.index);
    if (before.length > 0) nodes.push(...textNodes(before, marks));
    nodes.push(schema.nodes.hard_break.create(null, null, marks));
    lastIndex = match.index + match[0].length;
  }
  let after = normalized.slice(lastIndex);
  if (trimTrailing) after = after.replace(/[ \t\r\n]+$/u, '');
  if (after.length > 0) nodes.push(...textNodes(after, marks));
  return nodes;
}

export interface TryInlineOptions {
  /** Allow a leading GFM alert marker (`[!NOTE]` …) as plain text prefix. */
  readonly quoteAlert?: boolean;
}

/**
 * Engine-owned inline IR: plain text, hard breaks, and a simple subset of marks
 * (`**strong**`, `*emphasis*`, `__strong__`, `_emphasis_`, `~~strikethrough~~`,
 * `` `inline code` ``) plus **one-level nesting** (e.g. `**bold _italic_**`,
 * `*em **strong** em*`, `` **`code`** ``), **simple inline links / images**
 * (`[text](url)`, `[text](url "title")`, `![alt](url)`), **simple reference**
 * (`[text][id]` / `[text][]` / `![alt][id]` / `![alt][]`), **simple bare
 * http(s) autolinks** (text === href), **simple angle-bracket http(s)
 * autolinks** (`<https://…>`; text === href), **simple www. autolinks**,
 * **simple email autolinks** (bare + angle / mailto), and **simple wiki**
 * (`[[target]]` / `[[target|alias]]` as literal text). Deep / ambiguous nests
 * (`***`, same-delimiter stacks), multi-line HTML, nested-bracket wiki,
 * and unmatched delimiters
 * return `null` (dialect enrich). Simple backslash escapes (ASCII punctuation
 * + trailing-`\\` hard breaks), **simple inline HTML**, and **simple inline math**
 * (`$…$` / `$$…$$`) are owned. Snake_case underscores (`mcp_register`) stay
 * literal via CommonMark-ish flanking. Bare `[…]` / `array[0]` (no trailing
 * `[]` / `[id]` / `(url)`) stay literal text. Footnotes `[^…]` stay dialect.
 */

/** CommonMark link-reference identifier: collapse whitespace, lowercase. */
function normalizeReferenceIdentifier(label: string): string {
  return label.replace(/[\t\n\r ]+/g, ' ').trim().toLowerCase();
}

export function tryInlineNodesFromSource(
  md: string,
  options: TryInlineOptions = {},
): ProseNode[] | null {
  const normalized = md.replace(/\r\n/g, '\n');
  if (options.quoteAlert) {
    const match = ALERT_MARKER_RE.exec(normalized);
    if (match) {
      const title = match[3] ?? '';
      const prefix = match[0];
      const rest = normalized.slice(prefix.length);
      // Same-line title may be plain (whole prefix as text) or simple-marked /
      // wiki / autolink / link (split marker+fold / spaces / title / newline).
      // Deep / unparseable nests stay dialect; simple math / HTML / marks owned.
      if (title.length > 0 && INLINE_DIALECT_RE.test(title)) {
        const markerAndFold = `[!${match[1]}]${match[2] ?? ''}`;
        const afterMarker = prefix.slice(markerAndFold.length);
        const spaceMatch = /^[ \t]*/.exec(afterMarker);
        const spaces = spaceMatch ? spaceMatch[0] : '';
        const titleAndNl = afterMarker.slice(spaces.length);
        const hasNl = titleAndNl.endsWith('\n');
        const titleOnly = hasNl ? titleAndNl.slice(0, -1) : titleAndNl;
        const titleNodes = tryInlineNodesFromSource(titleOnly);
        if (!titleNodes) return null;
        const nodes: ProseNode[] = [
          ...textNodes(markerAndFold),
          ...(spaces.length > 0 ? textNodes(spaces) : []),
          ...titleNodes,
          ...(hasNl ? textNodes('\n') : []),
        ];
        if (rest.length === 0) return nodes;
        const restNodes = tryInlineNodesFromSource(rest);
        if (!restNodes) return null;
        return [...nodes, ...restNodes];
      }
      const prefixNodes = prefix.length > 0 ? textNodes(prefix) : [];
      if (rest.length === 0) return prefixNodes;
      const restNodes = tryInlineNodesFromSource(rest);
      if (!restNodes) return null;
      return [...prefixNodes, ...restNodes];
    }
  }
  if (!INLINE_DIALECT_RE.test(normalized)) {
    return inlineNodesFromPlainSource(normalized);
  }
  return parseSimpleAsteriskTildeCode(normalized);
}

/**
 * Simple `*` / `**` / `_` / `__` / `~~` / `` ` `` scanner with optional
 * one-level nesting. Prefer longer delimiters. `***` / `___` / bare unmatched
 * markers / deep nests fall through to dialect. Underscores use a
 * CommonMark-ish word-flanking rule so `snake_case` stays literal while
 * `__strong__` / `_em_` are owned.
 */
function isWordChar(ch: string | undefined): boolean {
  if (!ch) return false;
  // Match syntax.ts WORD: ASCII alnum + Latin-1 supplement + CJK ideographs.
  return /[0-9A-Za-z\u00C0-\u024F\u3400-\u4DBF\u4E00-\u9FFF]/u.test(ch);
}



/**
 * Exclusive end of a simple GFM bare http(s) autolink at `at`, or -1.
 *
 * Owns `http://` / `https://` (scheme case-insensitive; text preserves source
 * casing). ASCII-letter previous blocks (GFM `previousProtocol`). Trailing
 * punctuation from the GFM trail set is stripped. `https://` alone and
 * angle-bracket forms are not owned here (see `endOfSimpleWwwAutolink` /
 * `endOfSimpleAngleAutolink` / email helpers).
 */
function endOfSimpleBareAutolink(input: string, at: number): number {
  const m = /^(https?):\/\//i.exec(input.slice(at));
  if (!m) return -1;
  if (at > 0 && /[A-Za-z]/.test(input[at - 1]!)) return -1;
  const schemeEnd = at + m[0].length;
  let end = schemeEnd;
  const len = input.length;
  while (end < len) {
    const ch = input[end]!;
    if (ch === '\n' || ch === '\r' || ch === ' ' || ch === '\t' || ch === '<' || ch === '>') break;
    end += 1;
  }
  // GFM trail punctuation (simplified; no HTML-entity `&…;` handling).
  while (end > schemeEnd && /[!"'()*+,.:;?\]_~]/.test(input[end - 1]!)) {
    end -= 1;
  }
  if (end <= schemeEnd) return -1;
  return end;
}

/**
 * Exclusive end (past `>`) of a simple CommonMark angle-bracket http(s)
 * autolink at `at`, or -1. Owns `<http://…>` / `<https://…>` only (scheme
 * case-insensitive; text preserves source casing). No spaces / newlines /
 * `<` inside; empty `<https://>` refused. Email / mailto / HTML tags /
 * other schemes return -1 (see `endOfSimpleAngleEmail`).
 */
function endOfSimpleAngleAutolink(input: string, at: number): number {
  if (input[at] !== '<') return -1;
  const m = /^(https?):\/\//i.exec(input.slice(at + 1));
  if (!m) return -1;
  const schemeEnd = at + 1 + m[0].length;
  let end = schemeEnd;
  const len = input.length;
  while (end < len) {
    const ch = input[end]!;
    if (ch === '>') break;
    if (ch === '\n' || ch === '\r' || ch === ' ' || ch === '\t' || ch === '<') return -1;
    end += 1;
  }
  if (end >= len || input[end] !== '>') return -1;
  if (end <= schemeEnd) return -1;
  return end + 1;
}


/**
 * Exclusive end of a simple GFM `www.` autolink at `at`, or -1.
 *
 * Owns `www.…` (prefix case-insensitive; text preserves source casing).
 * Alphanumeric previous blocks (GFM). Trailing punctuation from the GFM trail
 * set is stripped. Href is `http://` + text. Bare `www.` alone refused.
 */
function endOfSimpleWwwAutolink(input: string, at: number): number {
  if (!/^www\./i.test(input.slice(at))) return -1;
  if (at > 0 && /[0-9A-Za-z]/i.test(input[at - 1]!)) return -1;
  const afterPrefix = at + 4;
  let end = afterPrefix;
  const len = input.length;
  while (end < len) {
    const ch = input[end]!;
    if (ch === '\n' || ch === '\r' || ch === ' ' || ch === '\t' || ch === '<' || ch === '>') break;
    end += 1;
  }
  while (end > afterPrefix && /[!"'()*+,.:;?\]_~]/.test(input[end - 1]!)) {
    end -= 1;
  }
  if (end <= afterPrefix) return -1;
  return end;
}

/** GFM-ish email local@domain with at least one dot in the domain. */
const SIMPLE_EMAIL_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9._-]*\.[A-Za-z0-9._-]+/;

/**
 * Exclusive end of a simple GFM bare email autolink at `at`, or -1.
 *
 * Owns `local@domain.tld` (domain must contain a `.`). Trailing GFM trail
 * punctuation is stripped. `user@localhost` / `NDCG@10` refused. Href is
 * `mailto:` + text.
 */
function endOfSimpleBareEmail(input: string, at: number): number {
  const m = SIMPLE_EMAIL_RE.exec(input.slice(at));
  if (!m) return -1;
  const localAt = m[0].indexOf('@');
  let end = at + m[0].length;
  while (end > at + localAt + 1 && /[!"'()*+,.:;?\]_~]/.test(input[end - 1]!)) {
    end -= 1;
  }
  const email = input.slice(at, end);
  if (!/@[^@\s]*\.[^@\s]*$/.test(email)) return -1;
  return end;
}

/**
 * Exclusive end (past `>`) of a simple CommonMark angle email / mailto
 * autolink at `at`, or -1. Owns `<user@host.tld>` and `<mailto:user@host.tld>`
 * (no spaces / newlines / `<` inside). Text is the inner slice; href is
 * `mailto:…` (existing mailto: prefix kept). HTML tags return -1.
 */
function endOfSimpleAngleEmail(input: string, at: number): number {
  if (input[at] !== '<') return -1;
  const close = input.indexOf('>', at + 1);
  if (close < 0) return -1;
  const inner = input.slice(at + 1, close);
  if (inner.length === 0 || /[\s<]/.test(inner)) return -1;
  if (/^mailto:/i.test(inner)) {
    const addr = inner.slice(inner.indexOf(':') + 1);
    if (!SIMPLE_EMAIL_RE.test(addr) || SIMPLE_EMAIL_RE.exec(addr)![0] !== addr) return -1;
    return close + 1;
  }
  if (!SIMPLE_EMAIL_RE.test(inner) || SIMPLE_EMAIL_RE.exec(inner)![0] !== inner) return -1;
  return close + 1;
}

/**
 * Exclusive end (past terminator) of simple CommonMark inline HTML at `at`, or
 * -1. Owns single-line open/close/self-closing tags, comments, processing
 * instructions, declarations, and CDATA. No newlines inside. Autolinks are
 * handled separately — call after those fail.
 */
function endOfSimpleInlineHtml(input: string, at: number): number {
  if (input[at] !== '<') return -1;
  const len = input.length;
  if (at + 1 >= len) return -1;

  // HTML comment <!-- ... -->
  if (input.startsWith('<!--', at)) {
    const start = at + 4;
    if (input[start] === '>' || (input[start] === '-' && input[start + 1] === '>')) return -1;
    let i = start;
    while (i < len) {
      if (input[i] === '\n' || input[i] === '\r') return -1;
      if (input.startsWith('--', i)) {
        if (input[i + 2] === '>') return i + 3;
        return -1;
      }
      i += 1;
    }
    return -1;
  }

  // CDATA section
  if (input.startsWith('<![CDATA[', at)) {
    const close = input.indexOf(']]>', at + 9);
    if (close < 0) return -1;
    const body = input.slice(at + 9, close);
    if (body.includes('\n') || body.includes('\r')) return -1;
    return close + 3;
  }

  // Declaration <!LETTER ... >
  if (input[at + 1] === '!' && /[A-Za-z]/.test(input[at + 2] ?? '')) {
    let i = at + 2;
    while (i < len) {
      if (input[i] === '\n' || input[i] === '\r') return -1;
      if (input[i] === '>') return i + 1;
      i += 1;
    }
    return -1;
  }

  // Processing instruction <? ... ?>
  if (input.startsWith('<?', at)) {
    let i = at + 2;
    while (i < len) {
      if (input[i] === '\n' || input[i] === '\r') return -1;
      if (input[i] === '?' && input[i + 1] === '>') return i + 2;
      i += 1;
    }
    return -1;
  }

  // Closing tag </tagname optional-ws>
  if (input[at + 1] === '/') {
    if (!/[A-Za-z]/.test(input[at + 2] ?? '')) return -1;
    let i = at + 3;
    while (i < len && /[A-Za-z0-9-]/.test(input[i]!)) i += 1;
    while (i < len && (input[i] === ' ' || input[i] === '\t')) i += 1;
    if (input[i] === '>') return i + 1;
    return -1;
  }

  // Open / self-closing tag <tagname attrs? /?>
  if (!/[A-Za-z]/.test(input[at + 1] ?? '')) return -1;
  let i = at + 2;
  while (i < len && /[A-Za-z0-9-]/.test(input[i]!)) i += 1;

  while (i < len) {
    if (input[i] === '\n' || input[i] === '\r') return -1;
    if (input[i] === ' ' || input[i] === '\t') {
      while (i < len && (input[i] === ' ' || input[i] === '\t')) i += 1;
      if (i >= len) return -1;
      if (input[i] === '/') {
        i += 1;
        return input[i] === '>' ? i + 1 : -1;
      }
      if (input[i] === '>') return i + 1;
      // attribute name
      if (!/[A-Za-z_:]/.test(input[i]!)) return -1;
      i += 1;
      while (i < len && /[A-Za-z0-9_.:-]/.test(input[i]!)) i += 1;
      if (input[i] === '=') {
        i += 1;
        if (input[i] === '"' || input[i] === "'") {
          const q = input[i]!;
          i += 1;
          while (i < len && input[i] !== q) {
            if (input[i] === '\n' || input[i] === '\r') return -1;
            i += 1;
          }
          if (input[i] !== q) return -1;
          i += 1;
        } else {
          if (i >= len || /[\s"'=<>`]/.test(input[i]!)) return -1;
          while (i < len && !/[\s"'=<>`]/.test(input[i]!)) i += 1;
        }
      }
      continue;
    }
    if (input[i] === '/') {
      i += 1;
      return input[i] === '>' ? i + 1 : -1;
    }
    if (input[i] === '>') return i + 1;
    return -1;
  }
  return -1;
}

/** True when `<` at `at` looks like the start of HTML (not `a < b`). */

/**
 * Trim one leading and one trailing space/EOL from inline-math content when
 * both ends are pad chars and the body holds non-whitespace (micromark
 * mathText padding). `$ $` / `$ \n $` stay untrimmed.
 */
function padTrimMathValue(raw: string): string {
  if (raw.length < 2) return raw;
  const lead = raw[0]!;
  const trail = raw[raw.length - 1]!;
  const isPad = (c: string): boolean => c === ' ' || c === '\n' || c === '\r';
  if (!isPad(lead) || !isPad(trail)) return raw;
  if (!/[^ \t\r\n]/.test(raw)) return raw;
  return raw.slice(1, -1);
}

/**
 * Exclusive end (past closing `$` run) of simple micromark-extension-math
 * inline math at `at`, or -1. Owns `$…$` and `$$…$$` (and longer equal-length
 * runs) with `singleDollarTextMath: true` parity: closing run must match open
 * length exactly; a longer/shorter `$` run mid-span is data. Newlines allowed
 * in content. Returns -1 when unclosed. Value is pad-trimmed.
 *
 * Caller should emit `math_inline` with the returned value (no parent marks;
 * from-mdast parity).
 */
function endOfSimpleInlineMath(input: string, at: number): { end: number; value: string } | null {
  if (input[at] !== '$') return null;
  // micromark `previous`: a `$` cannot start math when the previous code is `$`
  // (unless that `$` was an escape — escapes are consumed before we reach here).
  if (at > 0 && input[at - 1] === '$') return null;

  let sizeOpen = 0;
  let i = at;
  const len = input.length;
  while (i < len && input[i] === '$') {
    sizeOpen += 1;
    i += 1;
  }
  if (sizeOpen < 1) return null;

  const contentStart = i;
  while (i < len) {
    if (input[i] !== '$') {
      i += 1;
      continue;
    }
    // Potential close run.
    let size = 0;
    const closeStart = i;
    while (i < len && input[i] === '$') {
      size += 1;
      i += 1;
    }
    if (size === sizeOpen) {
      const raw = input.slice(contentStart, closeStart);
      return { end: i, value: padTrimMathValue(raw) };
    }
    // Longer/shorter run → data; keep scanning (i already past the run).
  }
  return null;
}

function looksLikeInlineHtmlStart(input: string, at: number): boolean {
  const next = input[at + 1];
  if (next === undefined) return false;
  return /[A-Za-z]/.test(next) || next === '/' || next === '!' || next === '?';
}

/**
 * End index (exclusive) of a simple wiki link starting at `at`.
 * Returns -1 when unclosed / not `[[`, -2 when nested `[` / lone `]` / newline
 * (dialect). Matches decoration rules in wiki-link-plugin: no nested `[`, no
 * newline inside. Empty `[[]]` still returns the span (plain text; decoration
 * ignores empty targets).
 */
function endOfSimpleWiki(input: string, at: number): number {
  if (!input.startsWith('[[', at)) return -1;
  const len = input.length;
  let k = at + 2;
  while (k < len) {
    const ch = input[k]!;
    if (ch === '\n') return -2;
    if (ch === '[') return -2;
    if (ch === ']') {
      if (input[k + 1] === ']') return k + 2;
      // Lone `]` inside (e.g. `[[a] [b]]`) — not a simple wiki.
      return -2;
    }
    k += 1;
  }
  return -1;
}

/** Max inner mark depth (1 = outer + one nested, e.g. `**bold _em_**`). */
const MAX_MARK_NEST = 1;

function parseSimpleAsteriskTildeCode(
  md: string,
  parentMarks: readonly Mark[] = [],
  depth = 0,
): ProseNode[] | null {
  let input = md;
  if (!HARD_BREAK_RE.test(input)) {
    input = input.trimEnd();
  }
  const nodes: ProseNode[] = [];
  let i = 0;
  const len = input.length;

  const emitPlain = (from: number, to: number): void => {
    if (to <= from) return;
    nodes.push(...plainRunNodes(input.slice(from, to), parentMarks, false));
  };

  const isWs = (ch: string | undefined): boolean =>
    ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

  /**
   * Advance past a CommonMark backslash escape at `at`. Escaped punctuation
   * (and any following char for closer-scan) must not act as a delimiter.
   * Returns the index after the escape pair, or `at + 1` for a lone trailing `\\`.
   */
  const afterEscape = (at: number): number => {
    if (input[at] !== '\\') return at;
    if (at + 1 >= len) return at + 1;
    return at + 2;
  };

  /** Content of a leaf (no further nest) may not hold delimiter / link characters. */
  const ASTERISK_TILDE_FORBIDDEN = /[*`~\[\\]/u;
  const UNDERSCORE_FORBIDDEN = /[*_`~\[\\]/u;

  /**
   * True when content holds an underscore that is not mid-snake_case — those
   * would be `_em_` / `__strong__` (or unmatched) and need nest parse or dialect.
   */
  const hasNonSnakeUnderscore = (content: string): boolean => {
    for (let k = 0; k < content.length; k += 1) {
      if (content[k] !== '_') continue;
      if (content.startsWith('__', k)) {
        if (isWordChar(content[k - 1]) && isWordChar(content[k + 2])) {
          k += 1;
          continue;
        }
        return true;
      }
      if (isWordChar(content[k - 1]) && isWordChar(content[k + 1])) continue;
      return true;
    }
    return false;
  };

  const contentNeedsNest = (content: string, underscoreOuter: boolean): boolean => {
    // Bare / angle http(s) / www. / email / math / HTML inside a mark needs a
    // nest pass so those branches run (plainRunNodes alone would keep marks
    // without the nested atoms).
    if (/https?:\/\//i.test(content) || /www\./i.test(content) || content.includes('@') || content.includes('<') || content.includes('$')) return true;
    if (underscoreOuter) return UNDERSCORE_FORBIDDEN.test(content);
    return ASTERISK_TILDE_FORBIDDEN.test(content) || hasNonSnakeUnderscore(content);
  };

  /**
   * Emit mark content: plain when delimiter-free; one-level recursive nest when
   * `depth < MAX_MARK_NEST`; otherwise dialect (`null`).
   */
  const emitMarked = (
    content: string,
    mark: Mark,
    underscoreOuter: boolean,
  ): boolean => {
    const childMarks = [...parentMarks, mark];
    if (!contentNeedsNest(content, underscoreOuter)) {
      nodes.push(...plainRunNodes(content, childMarks, false));
      return true;
    }
    if (depth >= MAX_MARK_NEST) return false;
    const inner = parseSimpleAsteriskTildeCode(content, childMarks, depth + 1);
    if (!inner) return false;
    nodes.push(...inner);
    return true;
  };

  /**
   * Skip a balanced nested span starting at `at` (code / ~~ / ** / * / __ / _).
   * Returns end index exclusive, or -1 if unmatched / ambiguous.
   */
  const skipNestedSpan = (at: number): number => {
    if (input[at] === '$') {
      const math = endOfSimpleInlineMath(input, at);
      if (!math) return -1;
      return math.end;
    }
    if (input[at] === '<') {
      const httpEnd = endOfSimpleAngleAutolink(input, at);
      if (httpEnd >= 0) return httpEnd;
      const emailEnd = endOfSimpleAngleEmail(input, at);
      if (emailEnd >= 0) return emailEnd;
      const htmlEnd = endOfSimpleInlineHtml(input, at);
      if (htmlEnd >= 0) return htmlEnd;
      if (looksLikeInlineHtmlStart(input, at)) return -1;
      return at + 1;
    }
    if (input.startsWith('[[', at)) {
      const end = endOfSimpleWiki(input, at);
      if (end < 0) return -1;
      return end;
    }
    if (input[at] === '`') {
      const close = input.indexOf('`', at + 1);
      if (close < 0 || input.slice(at + 1, close).includes('\n')) return -1;
      return close + 1;
    }
    if (input.startsWith('~~', at)) {
      if (isWs(input[at + 2])) return -1;
      let search = at + 2;
      while (search < len) {
        if (input[search] === '\\') {
          search = afterEscape(search);
          continue;
        }
        if (input.startsWith('~~', search)) {
          if (search === at + 2 || isWs(input[search - 1])) return -1;
          return search + 2;
        }
        search += 1;
      }
      return -1;
    }
    if (input.startsWith('**', at)) {
      if (isWs(input[at + 2])) return -1;
      // Nested ** content must not itself hold ** (one-level / no same-delimiter).
      let search = at + 2;
      while (search < len) {
        if (input[search] === '\\') {
          search = afterEscape(search);
          continue;
        }
        if (input[search] === '`') {
          const next = skipNestedSpan(search);
          if (next < 0) return -1;
          search = next;
          continue;
        }
        if (input.startsWith('~~', search)) {
          const next = skipNestedSpan(search);
          if (next < 0) return -1;
          search = next;
          continue;
        }
        if (input.startsWith('**', search)) {
          if (search === at + 2 || isWs(input[search - 1])) return -1;
          return search + 2;
        }
        search += 1;
      }
      return -1;
    }
    if (input.startsWith('__', at)) {
      if (isWordChar(input[at - 1]) && isWordChar(input[at + 2])) return -1;
      if (isWs(input[at + 2])) return -1;
      let search = at + 2;
      while (search < len) {
        if (input[search] === '\\') {
          search = afterEscape(search);
          continue;
        }
        if (input.startsWith('__', search)) {
          if (search === at + 2 || isWs(input[search - 1])) return -1;
          if (isWordChar(input[search - 1]) && isWordChar(input[search + 2])) {
            search += 2;
            continue;
          }
          return search + 2;
        }
        search += 1;
      }
      return -1;
    }
    if (input[at] === '*') {
      if (isWs(input[at + 1])) return -1;
      let search = at + 1;
      while (search < len) {
        if (input[search] === '\\') {
          search = afterEscape(search);
          continue;
        }
        if (input.startsWith('**', search)) {
          const next = skipNestedSpan(search);
          if (next < 0) return -1;
          search = next;
          continue;
        }
        if (input[search] === '`') {
          const next = skipNestedSpan(search);
          if (next < 0) return -1;
          search = next;
          continue;
        }
        if (input.startsWith('~~', search)) {
          const next = skipNestedSpan(search);
          if (next < 0) return -1;
          search = next;
          continue;
        }
        if (input.startsWith('__', search) || input[search] === '_') {
          const next = skipNestedSpan(search);
          if (next < 0) return -1;
          search = next;
          continue;
        }
        if (input[search] === '*') {
          if (search === at + 1 || isWs(input[search - 1])) return -1;
          return search + 1;
        }
        search += 1;
      }
      return -1;
    }
    if (input[at] === '_') {
      if (isWordChar(input[at - 1]) && isWordChar(input[at + 1])) return -1;
      if (isWs(input[at + 1])) return -1;
      let search = at + 1;
      while (search < len) {
        if (input[search] === '\\') {
          search = afterEscape(search);
          continue;
        }
        if (input.startsWith('__', search)) {
          search += 2;
          continue;
        }
        if (input[search] === '`') {
          const next = skipNestedSpan(search);
          if (next < 0) return -1;
          search = next;
          continue;
        }
        if (input.startsWith('~~', search) || input.startsWith('**', search) || input[search] === '*') {
          const next = skipNestedSpan(search);
          if (next < 0) return -1;
          search = next;
          continue;
        }
        if (input[search] === '_') {
          if (search === at + 1 || isWs(input[search - 1])) {
            search += 1;
            continue;
          }
          if (isWordChar(input[search - 1]) && isWordChar(input[search + 1])) {
            search += 1;
            continue;
          }
          return search + 1;
        }
        search += 1;
      }
      return -1;
    }
    return -1;
  };

  /**
   * Find closer for `**` / `~~` / `__`. Skip code and cross-family nests that
   * may embed the delimiter. The first non-skipped `delim` is the closer
   * (same-delimiter stacks with a space before an inner `**` fail the ws check
   * and fall through to dialect).
   */
  const findDoubleClose = (openAt: number, delim: '**' | '~~' | '__'): number => {
    const dlen = delim.length;
    let search = openAt + dlen;
    while (search < len) {
      if (input[search] === '\\') {
        search = afterEscape(search);
        continue;
      }
      if (input[search] === '$') {
        const math = endOfSimpleInlineMath(input, search);
        if (!math) return -1;
        search = math.end;
        continue;
      }
      if (input[search] === '<') {
        const httpEnd = endOfSimpleAngleAutolink(input, search);
        if (httpEnd >= 0) {
          search = httpEnd;
          continue;
        }
        const emailEnd = endOfSimpleAngleEmail(input, search);
        if (emailEnd >= 0) {
          search = emailEnd;
          continue;
        }
        const htmlEnd = endOfSimpleInlineHtml(input, search);
        if (htmlEnd >= 0) {
          search = htmlEnd;
          continue;
        }
        if (looksLikeInlineHtmlStart(input, search)) return -1;
        search += 1;
        continue;
      }
      if (input.startsWith('[[', search)) {
        const next = skipNestedSpan(search);
        if (next < 0) return -1;
        search = next;
        continue;
      }
      if (input[search] === '`') {
        const next = skipNestedSpan(search);
        if (next < 0) return -1;
        search = next;
        continue;
      }
      if (delim === '**') {
        // Skip nested `*em*` (may hold `**`); bare `**` here is our closer.
        if (input[search] === '*' && !input.startsWith('**', search)) {
          const next = skipNestedSpan(search);
          if (next < 0) return -1;
          search = next;
          continue;
        }
      } else if (delim === '__') {
        if (
          input.startsWith('**', search)
          || input[search] === '*'
          || input.startsWith('~~', search)
          || (input[search] === '_' && !input.startsWith('__', search))
        ) {
          const next = skipNestedSpan(search);
          if (next < 0) return -1;
          search = next;
          continue;
        }
      } else {
        // ~~ — skip nested marks that may hold `~~` only via code (already skipped).
        if (
          input.startsWith('**', search)
          || input[search] === '*'
          || input.startsWith('__', search)
          || input[search] === '_'
        ) {
          const next = skipNestedSpan(search);
          if (next < 0) return -1;
          search = next;
          continue;
        }
      }
      if (input.startsWith(delim, search)) {
        if (search === openAt + dlen || isWs(input[search - 1])) return -1;
        if (delim === '__' && isWordChar(input[search - 1]) && isWordChar(input[search + 2])) {
          return -1;
        }
        return search;
      }
      search += 1;
    }
    return -1;
  };

  /** Find closer for single `*`; skip nested `**` / code / ~~ / _ spans. */
  const findStarClose = (openAt: number): number => {
    let search = openAt + 1;
    while (search < len) {
      if (input[search] === '\\') {
        search = afterEscape(search);
        continue;
      }
      if (input[search] === '$') {
        const math = endOfSimpleInlineMath(input, search);
        if (!math) return -1;
        search = math.end;
        continue;
      }
      if (input[search] === '<') {
        const httpEnd = endOfSimpleAngleAutolink(input, search);
        if (httpEnd >= 0) {
          search = httpEnd;
          continue;
        }
        const emailEnd = endOfSimpleAngleEmail(input, search);
        if (emailEnd >= 0) {
          search = emailEnd;
          continue;
        }
        const htmlEnd = endOfSimpleInlineHtml(input, search);
        if (htmlEnd >= 0) {
          search = htmlEnd;
          continue;
        }
        if (looksLikeInlineHtmlStart(input, search)) return -1;
        search += 1;
        continue;
      }
      if (input.startsWith('[[', search)) {
        const next = skipNestedSpan(search);
        if (next < 0) return -1;
        search = next;
        continue;
      }
      if (input.startsWith('**', search) || input[search] === '`' || input.startsWith('~~', search)
        || input.startsWith('__', search) || input[search] === '_') {
        // Same-delimiter single `*` nest is refused by skip returning past inner.
        if (input[search] === '*' && !input.startsWith('**', search)) {
          // Bare `*` inside `*` → same-delimiter nest → dialect.
          return -1;
        }
        if (input[search] === '_' || input.startsWith('__', search) || input.startsWith('**', search)
          || input[search] === '`' || input.startsWith('~~', search)) {
          const next = skipNestedSpan(search);
          if (next < 0) return -1;
          search = next;
          continue;
        }
      }
      if (input[search] === '*') {
        if (search === openAt + 1 || isWs(input[search - 1])) return -1;
        return search;
      }
      search += 1;
    }
    return -1;
  };

  /** Find closer for single `_`; skip nested non-`_` spans. */
  const findUnderscoreClose = (openAt: number): number => {
    let search = openAt + 1;
    while (search < len) {
      if (input[search] === '\\') {
        search = afterEscape(search);
        continue;
      }
      if (input[search] === '$') {
        const math = endOfSimpleInlineMath(input, search);
        if (!math) return -1;
        search = math.end;
        continue;
      }
      if (input[search] === '<') {
        const httpEnd = endOfSimpleAngleAutolink(input, search);
        if (httpEnd >= 0) {
          search = httpEnd;
          continue;
        }
        const emailEnd = endOfSimpleAngleEmail(input, search);
        if (emailEnd >= 0) {
          search = emailEnd;
          continue;
        }
        const htmlEnd = endOfSimpleInlineHtml(input, search);
        if (htmlEnd >= 0) {
          search = htmlEnd;
          continue;
        }
        if (looksLikeInlineHtmlStart(input, search)) return -1;
        search += 1;
        continue;
      }
      if (input.startsWith('[[', search)) {
        const next = skipNestedSpan(search);
        if (next < 0) return -1;
        search = next;
        continue;
      }
      if (input.startsWith('__', search)) {
        // Part of `__` run — not a single `_` closer; skip two chars.
        search += 2;
        continue;
      }
      if (input[search] === '`' || input.startsWith('~~', search) || input.startsWith('**', search)
        || input[search] === '*') {
        const next = skipNestedSpan(search);
        if (next < 0) return -1;
        search = next;
        continue;
      }
      if (input[search] === '_') {
        if (search === openAt + 1 || isWs(input[search - 1])) {
          search += 1;
          continue;
        }
        if (isWordChar(input[search - 1]) && isWordChar(input[search + 1])) {
          search += 1;
          continue;
        }
        return search;
      }
      search += 1;
    }
    return -1;
  };

  while (i < len) {
    if (input.startsWith('***', i) || input.startsWith('___', i)) return null;

    // CommonMark backslash escapes: `\\*` → `*`, trailing `\\\\n` → hard_break.
    // Non-escapable following char keeps the backslash as literal text.
    if (input[i] === '\\') {
      if (i + 1 >= len) {
        emitPlain(i, i + 1);
        i += 1;
        continue;
      }
      const next = input[i + 1]!;
      if (next === '\n') {
        nodes.push(schema.nodes.hard_break.create(null, null, parentMarks));
        i += 2;
        continue;
      }
      if (next === '\r') {
        nodes.push(schema.nodes.hard_break.create(null, null, parentMarks));
        i += input[i + 2] === '\n' ? 3 : 2;
        continue;
      }
      if (ESCAPABLE_ASCII_PUNCT.test(next)) {
        nodes.push(...textNodes(next, parentMarks));
        i += 2;
        continue;
      }
      emitPlain(i, i + 1);
      i += 1;
      continue;
    }

    // Simple inline math `$…$` / `$$…$$` (micromark singleDollarTextMath parity).
    // from-mdast: math_inline carries no parent marks.
    if (input[i] === '$') {
      const math = endOfSimpleInlineMath(input, i);
      if (!math) {
        // Unclosed / adjacent `$` — literal dollar (or dialect if it looks open).
        emitPlain(i, i + 1);
        i += 1;
        continue;
      }
      const kids = math.value.length > 0 ? [schema.text(math.value)] : [];
      nodes.push(schema.nodes.math_inline.create(null, kids));
      i = math.end;
      continue;
    }

    // Bare http(s) autolink (GFM literal). Destinations inside `[…](url)` are
    // consumed by the link branch and never reach here as plain text.
    if (/^https?:\/\//i.test(input.slice(i))) {
      const autoEnd = endOfSimpleBareAutolink(input, i);
      if (autoEnd < 0) {
        // Alpha-previous or `https://` alone — emit as plain through the run.
        let j = i;
        while (j < len) {
          const ch = input[j]!;
          if (ch === '\n' || ch === '\r' || ch === ' ' || ch === '\t' || ch === '<' || ch === '>') break;
          if (ch === '\\' || ch === '*' || ch === '~' || ch === '`' || ch === '_' || ch === '[' || ch === '!') break;
          j += 1;
        }
        if (j === i) j = i + 1;
        emitPlain(i, j);
        i = j;
        continue;
      }
      const href = input.slice(i, autoEnd);
      const linkMark = schema.marks.link.create({
        href,
        title: null,
        referenceType: null,
      });
      nodes.push(...textNodes(href, [...parentMarks, linkMark]));
      i = autoEnd;
      continue;
    }

    // Simple GFM www. autolink (`www.example.com` → href http://www.example.com).
    if (/^www\./i.test(input.slice(i))) {
      const wwwEnd = endOfSimpleWwwAutolink(input, i);
      if (wwwEnd < 0) {
        // Alnum-previous or `www.` alone — emit as plain through the run.
        let j = i;
        while (j < len) {
          const ch = input[j]!;
          if (ch === '\n' || ch === '\r' || ch === ' ' || ch === '\t' || ch === '<' || ch === '>') break;
          if (ch === '\\' || ch === '*' || ch === '~' || ch === '`' || ch === '_' || ch === '[' || ch === '!') break;
          j += 1;
        }
        if (j === i) j = i + 1;
        emitPlain(i, j);
        i = j;
        continue;
      }
      const text = input.slice(i, wwwEnd);
      const linkMark = schema.marks.link.create({
        href: `http://${text}`,
        title: null,
        referenceType: null,
      });
      nodes.push(...textNodes(text, [...parentMarks, linkMark]));
      i = wwwEnd;
      continue;
    }

    // Simple GFM bare email (`user@host.tld` → href mailto:user@host.tld).
    {
      const emailEnd = endOfSimpleBareEmail(input, i);
      if (emailEnd >= 0) {
        const text = input.slice(i, emailEnd);
        const linkMark = schema.marks.link.create({
          href: `mailto:${text}`,
          title: null,
          referenceType: null,
        });
        nodes.push(...textNodes(text, [...parentMarks, linkMark]));
        i = emailEnd;
        continue;
      }
    }

    // Simple angle-bracket http(s) / email / mailto autolink, then simple inline HTML.
    if (input[i] === '<') {
      const httpEnd = endOfSimpleAngleAutolink(input, i);
      if (httpEnd >= 0) {
        const href = input.slice(i + 1, httpEnd - 1);
        const linkMark = schema.marks.link.create({
          href,
          title: null,
          referenceType: null,
        });
        nodes.push(...textNodes(href, [...parentMarks, linkMark]));
        i = httpEnd;
        continue;
      }
      const emailEnd = endOfSimpleAngleEmail(input, i);
      if (emailEnd >= 0) {
        const inner = input.slice(i + 1, emailEnd - 1);
        const href = /^mailto:/i.test(inner) ? inner : `mailto:${inner}`;
        const linkMark = schema.marks.link.create({
          href,
          title: null,
          referenceType: null,
        });
        nodes.push(...textNodes(inner, [...parentMarks, linkMark]));
        i = emailEnd;
        continue;
      }
      const htmlEnd = endOfSimpleInlineHtml(input, i);
      if (htmlEnd >= 0) {
        // Match from-mdast: inline_html atoms carry no parent marks.
        nodes.push(schema.nodes.inline_html.create({ value: input.slice(i, htmlEnd) }));
        i = htmlEnd;
        continue;
      }
      // Looks like a tag / comment / PI we could not own → dialect.
      if (looksLikeInlineHtmlStart(input, i)) return null;
      // Bare `<` (e.g. `a < b`) — literal text.
      emitPlain(i, i + 1);
      i += 1;
      continue;
    }

    if (input[i] === '`') {
      const close = input.indexOf('`', i + 1);
      if (close < 0) return null;
      const content = input.slice(i + 1, close);
      if (content.includes('`') || content.includes('\n')) return null;
      nodes.push(...textNodes(content, [...parentMarks, schema.marks.inline_code.create()]));
      i = close + 1;
      continue;
    }

    if (input.startsWith('~~', i)) {
      if (isWs(input[i + 2])) {
        emitPlain(i, i + 2);
        i += 2;
        continue;
      }
      const close = findDoubleClose(i, '~~');
      if (close < 0) return null;
      const content = input.slice(i + 2, close);
      if (!emitMarked(content, schema.marks.strikethrough.create(), false)) return null;
      i = close + 2;
      continue;
    }

    if (input.startsWith('**', i)) {
      if (isWs(input[i + 2])) {
        emitPlain(i, i + 2);
        i += 2;
        continue;
      }
      const close = findDoubleClose(i, '**');
      if (close < 0) return null;
      const content = input.slice(i + 2, close);
      if (!emitMarked(content, schema.marks.strong.create(), false)) return null;
      i = close + 2;
      continue;
    }

    if (input.startsWith('__', i)) {
      // Word on both sides → literal (e.g. `mcp__claude`).
      if (isWordChar(input[i - 1]) && isWordChar(input[i + 2])) {
        emitPlain(i, i + 2);
        i += 2;
        continue;
      }
      if (isWs(input[i + 2])) {
        emitPlain(i, i + 2);
        i += 2;
        continue;
      }
      const close = findDoubleClose(i, '__');
      if (close < 0) return null;
      const content = input.slice(i + 2, close);
      if (!emitMarked(content, schema.marks.strong.create(), true)) return null;
      i = close + 2;
      continue;
    }

    if (input[i] === '*') {
      // Not left-flanking → literal asterisk (e.g. `2 * 3`).
      if (isWs(input[i + 1])) {
        emitPlain(i, i + 1);
        i += 1;
        continue;
      }
      const close = findStarClose(i);
      if (close < 0) return null;
      const content = input.slice(i + 1, close);
      if (!emitMarked(content, schema.marks.emphasis.create(), false)) return null;
      i = close + 1;
      continue;
    }

    if (input[i] === '_') {
      // Snake_case mid-identifier → literal.
      if (isWordChar(input[i - 1]) && isWordChar(input[i + 1])) {
        emitPlain(i, i + 1);
        i += 1;
        continue;
      }
      // Not left-flanking → literal.
      if (isWs(input[i + 1])) {
        emitPlain(i, i + 1);
        i += 1;
        continue;
      }
      const close = findUnderscoreClose(i);
      if (close < 0) return null;
      const content = input.slice(i + 1, close);
      if (!emitMarked(content, schema.marks.emphasis.create(), true)) return null;
      i = close + 1;
      continue;
    }

    // Simple wiki `[[target]]` / `[[target|alias]]` — literal text (decoration
    // plugin owns display). Nested `[` / newline → dialect; unclosed → emit `[[`.
    if (input.startsWith('[[', i)) {
      const wikiEnd = endOfSimpleWiki(input, i);
      if (wikiEnd === -2) return null;
      if (wikiEnd < 0) {
        emitPlain(i, i + 2);
        i += 2;
        continue;
      }
      emitPlain(i, wikiEnd);
      i = wikiEnd;
      continue;
    }

    // Simple inline / reference image or link:
    //   `![alt](url)` / `[text](url)` / `[text](url "title")`
    //   `![alt][id]` / `![alt][]` / `[text][id]` / `[text][]`
    // Footnotes `[^…]` stay dialect. Bare `[…]` / `array[0]` (no `(…)` /
    // `[id]` / `[]` after) stay literal text. Nested `[` in label → dialect.
    if (input.startsWith('![', i) || input[i] === '[') {
      const isImage = input.startsWith('![', i);
      const openLen = isImage ? 2 : 1;
      const labelStart = i + openLen;
      if (!isImage && input[labelStart] === '^') return null; // footnote ref
      // Find label closer; nested `[` inside label → dialect.
      let labelEnd = -1;
      for (let k = labelStart; k < len; k += 1) {
        if (input[k] === '\n') break;
        if (input[k] === '[') {
          labelEnd = -2;
          break;
        }
        if (input[k] === ']') {
          labelEnd = k;
          break;
        }
      }
      if (labelEnd === -2) return null;
      if (labelEnd < 0) {
        // Unclosed `[` / `![` — emit opener as literal and continue.
        emitPlain(i, i + openLen);
        i += openLen;
        continue;
      }
      const label = input.slice(labelStart, labelEnd);
      const afterLabel = labelEnd + 1;

      // Reference form: `[text][id]` / `[text][]` / `![alt][id]` / `![alt][]`.
      if (input[afterLabel] === '[') {
        let idEnd = -1;
        const idStart = afterLabel + 1;
        for (let k = idStart; k < len; k += 1) {
          if (input[k] === '\n') break;
          if (input[k] === '[') {
            idEnd = -2;
            break;
          }
          if (input[k] === ']') {
            idEnd = k;
            break;
          }
        }
        if (idEnd === -2) return null;
        if (idEnd < 0) {
          // Unclosed second bracket — dialect.
          return null;
        }
        const idRaw = input.slice(idStart, idEnd);
        const end = idEnd + 1;
        const isCollapsed = idRaw.length === 0;
        const refLabel = isCollapsed ? label : idRaw;
        const refIdentifier = normalizeReferenceIdentifier(refLabel);
        if (refIdentifier.length === 0) {
          // `[][]` / `[text][ ]` — CommonMark leaves these literal.
          emitPlain(i, end);
          i = end;
          continue;
        }
        const referenceType = isCollapsed ? 'collapsed' : 'full';

        if (isImage) {
          if (parentMarks.length > 0) return null;
          if (/[*_`~[\]<!$:\\]|https?:\/\//u.test(label)) return null;
          nodes.push(schema.nodes.image.create({
            src: '',
            alt: label,
            title: null,
            referenceType,
            identifier: refIdentifier,
            label: refLabel,
          }));
          i = end;
          continue;
        }

        const linkMark = schema.marks.link.create({
          href: '',
          title: null,
          referenceType,
          identifier: refIdentifier,
          label: refLabel,
        });
        const childMarks = [...parentMarks, linkMark];
        if (label.length === 0) {
          // `[][id]` — empty children (mdast parity).
          i = end;
          continue;
        }
        if (/[\[\]<!:\\]|https?:\/\//u.test(label)) return null;
        if (!INLINE_DIALECT_RE.test(label)) {
          nodes.push(...plainRunNodes(label, childMarks, false));
        } else {
          const labelNodes = parseSimpleAsteriskTildeCode(label, childMarks, depth);
          if (!labelNodes) return null;
          nodes.push(...labelNodes);
        }
        i = end;
        continue;
      }

      if (input[afterLabel] !== '(') {
        // Not a destination link — literal brackets (e.g. array[0]).
        emitPlain(i, afterLabel);
        i = afterLabel;
        continue;
      }
      // Parse destination: optional <url>, or chars with balanced parens, then optional title.
      let p = afterLabel + 1;
      while (p < len && (input[p] === ' ' || input[p] === '\t')) p += 1;
      let href = '';
      if (input[p] === '<') {
        const closeAngle = input.indexOf('>', p + 1);
        if (closeAngle < 0 || input.slice(p + 1, closeAngle).includes('\n')) return null;
        href = input.slice(p + 1, closeAngle);
        p = closeAngle + 1;
      } else {
        let depth = 0;
        const destStart = p;
        while (p < len) {
          const ch = input[p]!;
          if (ch === '\n') return null;
          if (ch === '(') {
            depth += 1;
            p += 1;
            continue;
          }
          if (ch === ')') {
            if (depth === 0) break;
            depth -= 1;
            p += 1;
            continue;
          }
          if ((ch === ' ' || ch === '\t') && depth === 0) break;
          p += 1;
        }
        href = input.slice(destStart, p);
      }
      while (p < len && (input[p] === ' ' || input[p] === '\t')) p += 1;
      let title: string | null = null;
      if (input[p] === '"' || input[p] === "'" || input[p] === '(') {
        const closer = input[p] === '(' ? ')' : input[p]!;
        const titleStart = p + 1;
        const titleEnd = input.indexOf(closer, titleStart);
        if (titleEnd < 0 || input.slice(titleStart, titleEnd).includes('\n')) return null;
        title = input.slice(titleStart, titleEnd);
        p = titleEnd + 1;
        while (p < len && (input[p] === ' ' || input[p] === '\t')) p += 1;
      }
      if (input[p] !== ')') return null;
      const end = p + 1;

      if (isImage) {
        // Images are atoms; marks wrapping only an image stay dialect.
        if (parentMarks.length > 0) return null;
        // Alt stays plain (no marks / brackets / escapes).
        if (/[*_`~[\]<!$:\\]|https?:\/\//u.test(label)) return null;
        nodes.push(schema.nodes.image.create({
          src: href,
          alt: label,
          title,
          referenceType: null,
        }));
        i = end;
        continue;
      }

      // Link label: plain or simple-marked; no nested links / wiki / heavy.
      const linkMark = schema.marks.link.create({
        href,
        title,
        referenceType: null,
      });
      const childMarks = [...parentMarks, linkMark];
      if (label.length === 0) {
        // Empty label `[](url)` — no inline children (mdast parity).
        i = end;
        continue;
      }
      if (/[\[\]<!:\\]|https?:\/\//u.test(label)) return null;
      if (!INLINE_DIALECT_RE.test(label)) {
        nodes.push(...plainRunNodes(label, childMarks, false));
      } else {
        // Label may hold one-level simple marks; same depth so outer mark +
        // marked label still respects MAX_MARK_NEST.
        const labelNodes = parseSimpleAsteriskTildeCode(label, childMarks, depth);
        if (!labelNodes) return null;
        nodes.push(...labelNodes);
      }
      i = end;
      continue;
    }

    if (input[i] === '!') {
      // Lone `!` (not `![`) — literal.
      emitPlain(i, i + 1);
      i += 1;
      continue;
    }

    if (input[i] === '~') {
      // Lone `~` (not `~~`) — dialect (subscript / unmatched).
      return null;
    }

    let j = i + 1;
    while (j < len) {
      const ch = input[j]!;
      if (ch === '\\' || ch === '*' || ch === '~' || ch === '`' || ch === '_' || ch === '[' || ch === '!' || ch === '<' || ch === '$') break;
      // Stop before bare http(s) / www. / email so the next iteration can own it.
      if (/^https?:\/\//i.test(input.slice(j))) break;
      if (/^www\./i.test(input.slice(j)) && endOfSimpleWwwAutolink(input, j) > 0) break;
      if (endOfSimpleBareEmail(input, j) > 0) break;
      j += 1;
    }
    emitPlain(i, j);
    i = j;
  }

  return nodes;
}

function requireInlineNodes(md: string, options?: TryInlineOptions): ProseNode[] {
  const nodes = tryInlineNodesFromSource(md, options);
  if (!nodes) {
    throw new Error('engine inline IR expected to parse (caller must canSkip first)');
  }
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

/** Marker line: indent (spaces) + bullet or ordered. Nested markers may exceed 3. */
const BULLET_MARKER_RE = /^( *)([-+*])(?:([ \t]+)|$)/u;
const ORDERED_MARKER_RE = /^( *)([0-9]{1,9})([.)])(?:([ \t]+)|$)/u;

/** Cap nest depth so pathological `>>>>…` falls through to dialect. */
const MAX_QUOTE_NEST_DEPTH = 16;

export type ParsedQuoteChild =
  | { readonly type: 'paragraph'; readonly text: string }
  | { readonly type: 'quote'; readonly children: readonly ParsedQuoteChild[] }
  | { readonly type: 'list'; readonly list: ParsedFlatList };

interface QuoteLine {
  readonly depth: number;
  readonly rest: string;
}

/**
 * Count CommonMark quote markers on a line (`>` + optional space, repeat) and
 * return the remaining content. Returns null when there is no leading marker or
 * depth exceeds the cap.
 */
function parseQuoteLine(line: string): QuoteLine | null {
  let depth = 0;
  let rest = line;
  while (true) {
    const m = QUOTE_LINE_RE.exec(rest);
    if (!m) break;
    depth += 1;
    rest = m[3]!;
    if (depth > MAX_QUOTE_NEST_DEPTH) return null;
  }
  // depth 0 = CommonMark lazy continuation (no `>` markers). Still a valid
  // quote line once the splitter has kept it inside the quote span.
  return { depth, rest };
}

/**
 * Content line at the current quote depth that is still paragraph text.
 * Lists, ATX, fences, HTML, tables, hr/setext, link-defs, and indented-code
 * fall through to dialect enrich. Nested `>` is represented via `depth`, not
 * left in `rest`.
 */
function quoteInnerIsParagraphLine(rest: string): boolean {
  if (/^[ \t]*$/u.test(rest)) return true;
  if (/^(?: {4}|\t)/u.test(rest)) return false;
  const t = rest.replace(/^ {0,3}/u, '');
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

/** True when peeled quote content starts a bullet / ordered list item. */
function quoteInnerIsListStart(rest: string): boolean {
  if (/^[ \t]*$/u.test(rest)) return false;
  // Nested list markers keep their indent after `>` peel (`>   - nest`).
  if (BULLET_MARKER_RE.test(rest) || ORDERED_MARKER_RE.test(rest)) return true;
  return false;
}

/**
 * Same-depth quote line that continues an open list (blank, nested marker, or
 * soft-wrap / nested indent). Non-indented prose ends the list.
 */
function quoteInnerContinuesList(rest: string): boolean {
  if (/^[ \t]*$/u.test(rest)) return true;
  if (quoteInnerIsListStart(rest)) return true;
  // Indented continuation or nested marker under the list item.
  if (/^[ \t]/.test(rest)) return true;
  return false;
}

/**
 * Parse quote children at `level` (1 = outermost). Lines with greater depth open
 * nested quotes. A non-blank same-level plain paragraph line immediately after a
 * nest is CommonMark lazy continuation into the innermost open paragraph
 * (synthesized at `level + 1` so hard-break trailing spaces stay in the para
 * buffer). New block starts (lists / headings / …) after a nest are siblings.
 * Marked lazy lines and lazy-into-list still fall through to dialect.
 */
function parseQuoteChildren(
  lines: readonly QuoteLine[],
  level: number,
): ParsedQuoteChild[] | null {
  if (level > MAX_QUOTE_NEST_DEPTH) return null;
  const children: ParsedQuoteChild[] = [];
  let paraBuf: string[] = [];
  let i = 0;

  const flushPara = (): boolean => {
    if (paraBuf.length === 0) return true;
    const text = paraBuf.map((l) => l.replace(/^ {0,3}/u, '')).join('\n').trimEnd();
    paraBuf = [];
    if (text.length === 0) return true;
    // Hard breaks + plain GFM alert markers are engine-owned (same as plain
    // paras; alert-plugin decorates `[!NOTE]` etc. from the paragraph text).
    if (needsDialectInlineInQuote(text)) return false;
    children.push({ type: 'paragraph', text });
    return true;
  };

  while (i < lines.length) {
    const line = lines[i]!;

    // CommonMark true no-`>` lazy (depth 0) or fewer markers than `level`:
    // continue the open paragraph / list at this level when plain.
    if (line.depth < level) {
      if (/^[ \t]*$/u.test(line.rest)) return null;
      if (!quoteInnerIsParagraphLine(line.rest) || quoteInnerIsListStart(line.rest)) {
        return null;
      }
      // Lazy into an open list: synthesize soft-wrap for the list parser.
      if (children.length > 0 && children[children.length - 1]!.type === 'list') {
        return null; // list collection should have absorbed lazy lines already
      }
      paraBuf.push(line.rest);
      i += 1;
      continue;
    }

    if (line.depth === level) {
      if (/^[ \t]*$/u.test(line.rest)) {
        if (!flushPara()) return null;
        i += 1;
        continue;
      }
      // Simple list inside the quote: peel `>`, reuse flat/nested list parser.
      if (quoteInnerIsListStart(line.rest)) {
        if (!flushPara()) return null;
        const listRests: string[] = [];
        while (i < lines.length) {
          const cur = lines[i]!;
          // Same-depth quote lines, or true lazy (depth < level) soft-wrap.
          if (cur.depth > level) break;
          if (cur.depth < level) {
            if (/^[ \t]*$/u.test(cur.rest)) break;
            if (!quoteInnerIsParagraphLine(cur.rest) || quoteInnerIsListStart(cur.rest)) break;
            if (listRests.length === 0) return null;
            // Unindented lazy → list parser's Phase-13 soft-wrap path.
            listRests.push(cur.rest);
            i += 1;
            continue;
          }
          const rest = cur.rest;
          if (/^[ \t]*$/u.test(rest)) {
            // Trailing blank after the list stays for the outer loop (separator).
            let j = i + 1;
            while (j < lines.length && lines[j]!.depth === level && /^[ \t]*$/u.test(lines[j]!.rest)) {
              j += 1;
            }
            const next = j < lines.length && lines[j]!.depth === level ? lines[j]!.rest : null;
            if (next !== null && quoteInnerContinuesList(next) && !/^[ \t]*$/u.test(next)) {
              listRests.push(rest);
              i += 1;
              continue;
            }
            break;
          }
          if (!quoteInnerContinuesList(rest)) break;
          // First collected line must be a marker; later may be soft-wrap / nest.
          if (listRests.length === 0 && !quoteInnerIsListStart(rest)) return null;
          listRests.push(rest);
          i += 1;
        }
        if (listRests.length === 0) return null;
        const list = parseSimpleFlatListSource(listRests.join('\n'));
        if (!list) return null;
        children.push({ type: 'list', list });
        continue;
      }
      if (!quoteInnerIsParagraphLine(line.rest)) return null;
      paraBuf.push(line.rest);
      i += 1;
      continue;
    }

    // Deeper markers → nested blockquote.
    if (!flushPara()) return null;
    const nested: QuoteLine[] = [];
    while (i < lines.length && lines[i]!.depth > level) {
      nested.push(lines[i]!);
      i += 1;
    }
    // CommonMark lazy continuation: fewer `>` markers (incl. true no-`>` /
    // depth 0) with plain paragraph text continue the innermost open paragraph.
    // Fold those lines into the nest as depth `level + 1` so the recursive
    // parser joins them before flushPara (preserves hard-break trailing
    // spaces). List / heading / other block starts are left for this level as
    // siblings. Marked phrasing still fails inside the nested parse (dialect).
    while (
      i < lines.length
      && lines[i]!.depth <= level
      && !/^[ \t]*$/u.test(lines[i]!.rest)
      && quoteInnerIsParagraphLine(lines[i]!.rest)
      && !quoteInnerIsListStart(lines[i]!.rest)
    ) {
      nested.push({ depth: level + 1, rest: lines[i]!.rest });
      i += 1;
    }
    const nestedChildren = parseQuoteChildren(nested, level + 1);
    if (!nestedChildren || nestedChildren.length === 0) return null;
    children.push({ type: 'quote', children: nestedChildren });
  }

  if (!flushPara()) return null;
  return children.length > 0 ? children : null;
}

/**
 * Simple blockquote: lines are `>`-prefixed and/or CommonMark true no-`>` lazy
 * continuations (requires `@roobli/md` ≥ v0.1.9 so lazy lines stay in the span).
 * Inner content is plain paragraphs (incl. hard breaks), nested plain quotes
 * (incl. fewer-`>` and no-`>` lazy), and/or simple flat / nested
 * lists (any reasonable depth; lazy into list items). Returns a child tree
 * matching CommonMark / mdast shape for the owned subset, or `null` when the
 * span still needs dialect enrich (nested marks / nested / heavy inline,
 * multi-para lists, pathological depth, heavy callout titles).
 * Plain / collapsible / plain-titled / simple-marked-title GFM alerts
 * (`> [!NOTE]`, `> [!NOTE]-`, `> [!NOTE] Title **x**` …) and simple-marked
 * bodies are accepted.
 */
export function parseSimpleQuoteSource(md: string): ParsedQuoteChild[] | null {
  const trimmed = md.replace(/\r\n/g, '\n').trimEnd();
  if (trimmed.length === 0) return null;
  const lines: QuoteLine[] = [];
  let sawMarker = false;
  for (const raw of trimmed.split('\n')) {
    const q = parseQuoteLine(raw);
    if (!q) return null;
    if (q.depth >= 1) sawMarker = true;
    lines.push(q);
  }
  // A quote span must open with at least one `>`-marked line.
  if (!sawMarker || lines[0]!.depth < 1) return null;
  return parseQuoteChildren(lines, 1);
}

export type FlatListBullet = '-' | '*' | '+';
export type FlatListDelimiter = '.' | ')';

export interface ParsedFlatListItem {
  readonly checked: boolean | null;
  readonly text: string;
  /** Nested list under this item (any depth); null when the item is flat. */
  readonly nested: ParsedFlatList | null;
}

export interface ParsedFlatList {
  readonly ordered: boolean;
  readonly bullet: FlatListBullet | null;
  readonly delimiter: FlatListDelimiter | null;
  readonly start: number;
  readonly spread: boolean;
  readonly items: readonly ParsedFlatListItem[];
}

/** Cap nest indent / depth so pathological input falls through to dialect. */
const MAX_LIST_MARKER_INDENT = 40;
const MAX_LIST_NEST_DEPTH = 16;

/**
 * After stripping a known marker indent, does the remainder look like a nested
 * block (list / fence / quote / heading / hr / table / HTML) rather than soft-wrap?
 */
function restLooksStructural(rest: string): boolean {
  if (/^[ \t]*$/u.test(rest)) return false;
  if (/^([-+*])(?:[ \t]|$)/u.test(rest)) return true;
  if (/^[0-9]{1,9}[.)](?:[ \t]|$)/u.test(rest)) return true;
  if (rest.startsWith('>')) return true;
  if (/^#{1,6}(?:[ \t]|$)/u.test(rest)) return true;
  if (/^(`{3,}|~{3,})/u.test(rest)) return true;
  if (rest.startsWith('<')) return true;
  if (rest.startsWith('|')) return true;
  if (/^([*\-_])(?:[ \t]*\1){2,}[ \t]*$/u.test(rest)) return true;
  return false;
}

/**
 * Soft-wrap continuation body after a list marker indent. Requires at least one
 * extra space/tab past the marker indent (content column). Returns null when the
 * indent shape is wrong.
 */
function listContinuationRest(line: string, markerIndent: string): string | null {
  if (!(line.startsWith(markerIndent) && line.length > markerIndent.length
    && /[ \t]/.test(line[markerIndent.length]!))) {
    return null;
  }
  return line.slice(markerIndent.length).replace(/^[ \t]+/u, '');
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
 * Simple flat or nested list (any depth): bullet or ordered delimiter at each
 * level, each item a single plain paragraph (optional soft-wrap continuation;
 * CommonMark hard breaks are engine-owned). Same-family and mixed-marker nests
 * are owned (`@roobli/md` ≥ v0.1.13 Phase 16 keeps mixed nests one span).
 * Sibling markers at one level still share orderedness / bullet / delimiter.
 * Loose lists (blank between sibling items) set `spread` on that level. Task
 * checkboxes are allowed. Returns `null` when dialect enrich is still needed
 * (marked phrasing / multi-para items).
 */
export function parseSimpleFlatListSource(md: string): ParsedFlatList | null {
  const trimmed = md.replace(/\r\n/g, '\n').trimEnd();
  if (trimmed.length === 0) return null;
  const lines = trimmed.split('\n');

  type DraftItem = {
    checked: boolean | null;
    lines: string[];
    nested: DraftLevel | null;
  };
  type DraftLevel = {
    indent: string;
    ordered: boolean;
    bullet: FlatListBullet | null;
    delimiter: FlatListDelimiter | null;
    start: number;
    spread: boolean;
    items: DraftItem[];
    pendingBlank: boolean;
  };

  const stack: DraftLevel[] = [];
  let sawItem = false;

  const finalizeLevel = (level: DraftLevel): ParsedFlatList | null => {
    if (level.items.length === 0) return null;
    const items: ParsedFlatListItem[] = [];
    for (const item of level.items) {
      const joined = item.lines.join('\n');
      const text = joined.trimEnd();
      // Hard breaks + simple marked phrasing in list items are engine-owned.
      if (tryInlineNodesFromSource(text) === null) return null;
      let nested: ParsedFlatList | null = null;
      if (item.nested) {
        nested = finalizeLevel(item.nested);
        if (!nested) return null;
      }
      items.push({ checked: item.checked, text, nested });
    }
    return {
      ordered: level.ordered,
      bullet: level.ordered ? null : level.bullet,
      delimiter: level.ordered ? level.delimiter : null,
      start: level.ordered ? level.start : 1,
      spread: level.spread,
      items,
    };
  };

  const pushItem = (
    level: DraftLevel,
    checked: boolean | null,
    text: string,
  ): void => {
    level.items.push({ checked, lines: [text], nested: null });
  };

  for (const line of lines) {
    if (/^[ \t]*$/u.test(line)) {
      if (!sawItem || stack.length === 0) return null;
      // Blank belongs to the deepest open level; transferred to ancestors on pop
      // so a blank before a shallower sibling still spreads that ancestor list.
      stack[stack.length - 1]!.pendingBlank = true;
      continue;
    }

    const bulletMatch = BULLET_MARKER_RE.exec(line);
    const orderedMatch = bulletMatch ? null : ORDERED_MARKER_RE.exec(line);

    if (bulletMatch || orderedMatch) {
      const indent = (bulletMatch ?? orderedMatch)![1]!;
      if (indent.length > MAX_LIST_MARKER_INDENT) return null;

      if (stack.length === 0) {
        // Top-level marker: CommonMark allows at most three leading spaces.
        if (indent.length > 3) return null;
        let ordered: boolean;
        let bullet: FlatListBullet | null = null;
        let delimiter: FlatListDelimiter | null = null;
        let start = 1;
        let rest: string;
        if (bulletMatch) {
          ordered = false;
          bullet = bulletMatch[2] as FlatListBullet;
          rest = line.slice(bulletMatch[0].length);
        } else {
          const m = orderedMatch!;
          ordered = true;
          start = Number(m[2]!);
          delimiter = m[3] as FlatListDelimiter;
          rest = line.slice(m[0].length);
        }
        const { checked, text: rawText } = splitTaskPrefix(rest);
        const text = rawText.replace(/^[ \t]+/u, '');
        const level: DraftLevel = {
          indent,
          ordered,
          bullet,
          delimiter,
          start,
          spread: false,
          items: [],
          pendingBlank: false,
        };
        pushItem(level, checked, text);
        stack.push(level);
        sawItem = true;
        continue;
      }

      // Pop to a level whose indent is <= this marker's indent. A pending blank
      // on a popped level means the blank sits between siblings of the parent.
      while (stack.length > 1 && indent.length < stack[stack.length - 1]!.indent.length) {
        const removed = stack.pop()!;
        if (removed.pendingBlank) {
          stack[stack.length - 1]!.pendingBlank = true;
        }
      }

      const top = stack[stack.length - 1]!;

      if (indent === top.indent) {
        // Sibling at the current level.
        let rest: string;
        if (bulletMatch) {
          const marker = bulletMatch[2] as FlatListBullet;
          if (top.ordered) return null;
          if (top.bullet !== null && top.bullet !== marker) return null;
          top.bullet = marker;
          rest = line.slice(bulletMatch[0].length);
        } else {
          const m = orderedMatch!;
          const delim = m[3] as FlatListDelimiter;
          if (!top.ordered) return null;
          if (top.delimiter !== null && top.delimiter !== delim) return null;
          rest = line.slice(m[0].length);
        }
        const { checked, text: rawText } = splitTaskPrefix(rest);
        const text = rawText.replace(/^[ \t]+/u, '');
        if (top.pendingBlank && top.items.length > 0) top.spread = true;
        top.pendingBlank = false;
        pushItem(top, checked, text);
        sawItem = true;
        continue;
      }

      if (indent.length > top.indent.length && indent.startsWith(top.indent)) {
        // New nested level under the last item of `top`.
        if (top.items.length === 0) return null;
        if (stack.length >= MAX_LIST_NEST_DEPTH) return null;
        const parentItem = top.items[top.items.length - 1]!;

        let ordered: boolean;
        let bullet: FlatListBullet | null = null;
        let delimiter: FlatListDelimiter | null = null;
        let start = 1;
        let rest: string;
        if (bulletMatch) {
          ordered = false;
          bullet = bulletMatch[2] as FlatListBullet;
          rest = line.slice(bulletMatch[0].length);
        } else {
          const m = orderedMatch!;
          ordered = true;
          start = Number(m[2]!);
          delimiter = m[3] as FlatListDelimiter;
          rest = line.slice(m[0].length);
        }
        // Phase 16: nested level may differ in orderedness from parent
        // (mixed-marker nest; micromark / @roobli/md span parity).

        if (parentItem.nested) {
          // Re-entering an existing child list — indent must match.
          if (parentItem.nested.indent !== indent) return null;
          // Should have been handled as sibling after pop; inconsistent.
          return null;
        }

        // Blank between parent text and first nested item does not spread the
        // outer level; clear pending on parent level.
        top.pendingBlank = false;

        const child: DraftLevel = {
          indent,
          ordered,
          bullet,
          delimiter,
          start,
          spread: false,
          items: [],
          pendingBlank: false,
        };
        const { checked, text: rawText } = splitTaskPrefix(rest);
        const text = rawText.replace(/^[ \t]+/u, '');
        pushItem(child, checked, text);
        parentItem.nested = child;
        stack.push(child);
        sawItem = true;
        continue;
      }

      // Indent shorter than top but not equal to any ancestor, or not a
      // prefix of the deeper indent — refuse.
      return null;
    }

    // Soft-wrap continuation of the current deepest item.
    if (!sawItem || stack.length === 0) return null;
    const top = stack[stack.length - 1]!;
    if (top.pendingBlank) return null; // blank then non-marker = multi-para item
    if (top.items.length === 0) return null;
    let rest = listContinuationRest(line, top.indent);
    if (rest === null) {
      // CommonMark lazy continuation (Phase 13 / @roobli/md v0.1.9): unindented
      // line continues the innermost open item. Partial weird indent → dialect.
      if (/^[ \t]/.test(line)) return null;
      rest = line;
    }
    if (restLooksStructural(rest) || tryInlineNodesFromSource(rest) === null) {
      return null;
    }
    top.items[top.items.length - 1]!.lines.push(rest);
    top.pendingBlank = false;
  }

  if (stack.length === 0) return null;
  return finalizeLevel(stack[0]!);
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
 * plain or simple-marked (`**` / `*` / `~~` / `` ` ``) including CommonMark
 * backslash escapes (escaped `|` stays inside the cell); header and delimiter
 * column counts must match; **body rows may be ragged** (fewer or more cells
 * than the header — kept as-is, matching micromark/mdast); no blank lines
 * inside the span. Nested / heavy inline (multi-line HTML / math), and
 * delimiter≠header fall through to dialect.
 * Returns `null` when enrich is still needed.
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
  // Delimiter must match header width (otherwise micromark does not make a table).
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
    // Ragged body rows are engine-owned (micromark keeps short/long rows as-is).
    rows.push(cells);
  }

  for (const row of rows) {
    for (const cell of row) {
      if (tryInlineNodesFromSource(cell) === null) return null;
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
 * after leading whitespace is stripped (mdast parity). CommonMark hard breaks
 * are engine-owned. Marked phrasing and structural continuation lines fall
 * through to dialect.
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
    if (restLooksStructural(line.replace(/^(?: {1,}|\t)+/u, ''))) return null;
    // Footnote body soft-wrap: strip leading indent like mdast.
    parts.push(line.replace(/^[ \t]+/u, ''));
  }
  const text = parts.join('\n').trimEnd();
  // Empty body (`[^id]:` / whitespace-only) is still engine-owned: one empty
  // paragraph child (schema `block+`). Hard breaks + simple marks are engine-owned;
  // heavy / nested still dialect.
  if (tryInlineNodesFromSource(text) === null) return null;
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


function pmQuoteFromParsed(children: readonly ParsedQuoteChild[]): ProseNode {
  const nodes = children.map((child) => {
    if (child.type === 'paragraph') {
      return schema.nodes.paragraph.create(null, requireInlineNodes(child.text, { quoteAlert: true }));
    }
    if (child.type === 'list') {
      return pmListFromParsed(child.list);
    }
    return pmQuoteFromParsed(child.children);
  });
  return schema.nodes.blockquote.create(null, nodes);
}

function pmListFromParsed(list: ParsedFlatList): ProseNode {
  const items = list.items.map((item) => {
    const children: ProseNode[] = [
      schema.nodes.paragraph.create(null, requireInlineNodes(item.text)),
    ];
    if (item.nested) children.push(pmListFromParsed(item.nested));
    return schema.nodes.list_item.create({ checked: item.checked }, children);
  });
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
        return schema.nodes.heading.create({ level: 1 }, requireInlineNodes(markdown));
      }
      return schema.nodes.heading.create({ level: h.level }, requireInlineNodes(h.text));
    }
    case 'paragraph': {
      // Soft newlines stay in text (pre-wrap). Hard breaks (` {2,}\n`) become
      // `hard_break` nodes. Trailing spaces without a following newline are
      // dropped like CommonMark / mdast (avoids `See  [[` after open+type).
      return schema.nodes.paragraph.create(null, requireInlineNodes(markdown));
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
        [schema.nodes.paragraph.create(null, requireInlineNodes(f.text))],
      );
    }
    case 'quote': {
      const children = parseSimpleQuoteSource(markdown);
      if (!children) return null;
      return pmQuoteFromParsed(children);
    }
    case 'bullet-list':
    case 'ordered-list':
    case 'task-list': {
      const list = parseSimpleFlatListSource(markdown);
      if (!list) return null;
      return pmListFromParsed(list);
    }
    case 'table': {
      const table = parseSimpleTableSource(markdown);
      if (!table) return null;
      const pmRows = table.rows.map((row, rowIndex) => {
        const cellType = rowIndex === 0 ? schema.nodes.table_header : schema.nodes.table_cell;
        const cells = row.map((cell, columnIndex) => cellType.create(
          { align: table.align[columnIndex] ?? null },
          requireInlineNodes(cell),
        ));
        return schema.nodes.table_row.create(null, cells);
      });
      return schema.nodes.table.create(null, pmRows);
    }
    default:
      return null;
  }
}

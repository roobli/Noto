/**
 * Engine-owned IR → ProseMirror for common blocks (flagged `@roobli/md` path).
 *
 * Native spans are kind + source offsets only. For leaf kinds (fence, hr, math,
 * frontmatter, html), parseable link-definitions, **simple footnote-definitions**
 * (plain / empty / simple-marked single-paragraph body; optional soft-wrap /
 * hard-break), paragraph/heading with plain or **simple marked** phrasing
 * (`**strong**` / `*em*` / `__strong__` / `_em_` / `~~del~~` / `` `code` ``;
 * up to nine-level nested marks e.g. `**bold _italic_**` / `*em **strong** em*` /
 * `**bold *em ~~strike~~ more* bold**` / `**a *b ~~c _d_ c~~ b* a**` / `**a *b ~~c _d `e` d_ c~~ b* a**` / `**v *w ~~x _y *z `a` z* y_ x~~ w* v**` / `**u *v ~~w _x *y _z `a` z_ y* x_ w~~ v* u**` / `**t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t**` / `**s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s**` / `*r **s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s** r*`; hard breaks engine-owned; snake_case underscores stay literal),
 * **simple** blockquotes (every line `>`-prefixed; plain or simple-marked
 * paragraphs incl. hard breaks, nested quotes, simple lists-in-quotes,
 * plain-body GFM alerts / callouts incl. simple-marked bodies and
 * simple-marked same-line titles, and CommonMark
 * lazy continuation via fewer `>` **or true no-`>` lazy lines**), **simple
 * flat / nested lists** (same-family or mixed-marker nests at every depth;
 * plain or simple-marked items incl. hard breaks, unindented lazy soft-wrap,
 * and multi-paragraph items after a blank + indent; **structural children**
 * inside items — simple quote / fence / ATX heading / HTML / table / hr;
 * **cross-family same-indent sibling marker mixes** within one span split into
 * sibling lists as micromark does; marker-only empty item + blank + structural
 * opens outside the list at split — `@roobli/md` ≥ v0.1.17), and **simple GFM tables** (alignment row; plain or simple-marked
 * cells incl. escaped pipes; consistent **or ragged** body columns — micromark keeps
 * short/long body rows as-is; **pipe-optional** rows — leading/trailing `|` may be
 * omitted when a row still contains `|`, matching GFM; delimiter rows that would be
 * stolen by a bullet list marker (`- | -` without a leading `|`) stay dialect), the PM node is fully
 * determined by that IR — no micromark / mdast pass. Cross-family same-indent sibling
 * marker mixes within one span (nested under a parent item, or sibling lists inside a
 * quote — micromark splits each mix into its own list) are engine-owned; deeper
 * (thirty-eight+) nests still go through `from-mdast.ts` after dialect enrich.
 * Mismatched header/delimiter column counts are paragraphs at
 * split (`@roobli/md` ≥ v0.1.14); `parseSimpleTableSource` still refuses a forced
 * mismatched table span. **Simple HTML
 * and simple inline math in GFM table cells** are engine-owned. **Simple backslash escapes**
 * (ASCII punctuation + trailing-`\\` hard breaks), including **escaped pipes
 * inside simple GFM table cells**, are engine-owned. **Simple inline HTML**
 * (open/close/self-closing tags, comments, PI, declarations, CDATA; single- or
 * multi-line) is engine-owned as `inline_html` atoms.
 * **Simple inline links** (`[text](url)` /
 * optional title) and **images** (`![alt](url)`) with plain or **simple image alts**
 * (micromark-equivalent plain string: math / marks / escapes / literal HTML) are
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
 * is engine-owned as `math_inline` in phrasing; inside image alts, math/marks strip
 * to a plain micromark-equivalent alt string (not phrasing nodes). Nested-bracket
 * alts / newlines in alts / exotic constructs stay dialect.
 * **Simple wiki links** (`[[target]]` / `[[target|alias]]`) are engine-owned
 * as literal text (decoration plugin owns display).
 * **Simple GFM alerts / callouts** (incl. collapsible / plain-titled /
 * simple-marked / **heavy** same-line titles — math / HTML / escapes / nested
 * marks / triples / links / images / stacks) keep the marker as plain text for
 * the alert decoration plugin; title marks are real PM marks after the marker.
 * Nested-bracket wiki in titles is engine-owned as literal text; footnote
 * refs in titles stay dialect (micromark only promotes `[^id]` when a
 * matching definition exists elsewhere in the document — per-span IR→PM
 * cannot know).
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
 * Simple `*` / `**` / `_` / `__` / `~~` / `` ` `` marks (incl. up to nine-level
 * nesting), simple inline links / images, simple reference links / images,
 * simple bare http(s) + angle-bracket http(s) + www. + email autolinks, and
 * simple wiki `[[…]]` (literal text) are engine-owned via `tryInlineNodesFromSource`;
 * thirty-eight+ nests and heavier constructs stay on dialect. Snake_case
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
 * plain titles (`[!NOTE] Title`), **simple-marked titles**, and **heavy titles**
 * (`[!NOTE] $E=mc^2$` / `<span>x</span>` / `\*esc\*` / nested marks / `***` /
 * mixed triples / same-delimiter stacks / links / images — via
 * `tryInlineNodesFromSource`). Nested-bracket wiki titles are literal text;
 * footnote refs in titles stay dialect (need a matching def elsewhere).
 * The alert-plugin decorates from the leading `[!NOTE]` token
 * either way.
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
 * simple-marked / collapsible / plain-titled / simple-marked-title / heavy-title GFM alerts / callouts, lazy nest + no-`>` lazy); simple flat
 * or nested lists (same-family or mixed-marker, any depth, incl. hard breaks + simple marks + multi-paragraph items + structural quote/fence/ATX-heading/HTML/table/hr children + setext-shaped tight `---`/`===` after a paragraph + cross-family same-indent sibling marker mixes);
 * simple GFM tables (plain or simple-marked cells incl. escaped pipes; ragged body rows; pipe-optional leading `|`); paragraph / heading when
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
 * `` `inline code` ``) plus **up to nine-level nesting** (e.g. `**bold _italic_**`,
 * `*em **strong** em*`, `**bold *em ~~strike~~ more* bold**`, `**a *b ~~c _d_ c~~ b* a**`, `**a *b ~~c _d `e` d_ c~~ b* a**`, `**v *w ~~x _y *z `a` z* y_ x~~ w* v**`, `**u *v ~~w _x *y _z `a` z_ y* x_ w~~ v* u**`, `**t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t**`, `**s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s**`, `*r **s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s** r*`, `` **`code`** ``), **simple inline links / images**
 * (`[text](url)`, `[text](url "title")`, `![alt](url)`), **simple reference**
 * (`[text][id]` / `[text][]` / `![alt][id]` / `![alt][]`), **simple bare
 * http(s) autolinks** (text === href), **simple angle-bracket http(s)
 * autolinks** (`<https://…>`; text === href), **simple www. autolinks**,
 * **simple email autolinks** (bare + angle / mailto), and **simple wiki**
 * (`[[target]]` / `[[target|alias]]` as literal text). Matched `***` / `___` are
 * engine-owned (emphasis+strong). Mixed triple closers (`***x* y**` / `**x *y***` / `***x** y*` + underscore) owned; same-delimiter stacks owned; nested-bracket wiki owned as literal (emit `[[`); thirty-eight+ nests
 * and unmatched delimiters
 * return `null` (dialect enrich). Simple backslash escapes (ASCII punctuation
 * + trailing-`\\` hard breaks), **simple inline HTML** (incl. multi-line), and **simple inline math**
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
 * nesting. Prefer longer delimiters. Matched `***` / `___` → emphasis+strong.
 * Same-delimiter stacks (`*a *b* c*` / `**a **b** c**` / `_`/`__`/`~~` counterparts)
 * are owned. Mixed triple closers owned. Bare unmatched / thirty-eight+ nests fall through
 * to dialect. Underscores use a
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

/** CommonMark HTML tag whitespace: space / tab / line ending. */
function isHtmlTagWs(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/**
 * Exclusive end of simple CommonMark inline HTML at `at`, or -1.
 * Owns single-line and multi-line comments / CDATA / declarations / PIs /
 * open+self-closing+closing tags (newlines allowed as tag whitespace and
 * inside quoted attribute values / comment·CDATA·PI bodies — micromark
 * parity). Unclosed / malformed forms return -1 (caller may dialect via
 * `looksLikeInlineHtmlStart`).
 */
function endOfSimpleInlineHtml(input: string, at: number): number {
  if (input[at] !== '<') return -1;
  const len = input.length;
  if (at + 1 >= len) return -1;

  // HTML comment <!-- ... --> (newlines owned)
  if (input.startsWith('<!--', at)) {
    const start = at + 4;
    if (input[start] === '>' || (input[start] === '-' && input[start + 1] === '>')) return -1;
    let i = start;
    while (i < len) {
      if (input.startsWith('--', i)) {
        if (input[i + 2] === '>') return i + 3;
        return -1;
      }
      i += 1;
    }
    return -1;
  }

  // CDATA section (newlines owned)
  if (input.startsWith('<![CDATA[', at)) {
    const close = input.indexOf(']]>', at + 9);
    if (close < 0) return -1;
    return close + 3;
  }

  // Declaration <!LETTER ... > (newlines owned)
  if (input[at + 1] === '!' && /[A-Za-z]/.test(input[at + 2] ?? '')) {
    let i = at + 2;
    while (i < len) {
      if (input[i] === '>') return i + 1;
      i += 1;
    }
    return -1;
  }

  // Processing instruction <? ... ?> (newlines owned)
  if (input.startsWith('<?', at)) {
    let i = at + 2;
    while (i < len) {
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
    while (i < len && isHtmlTagWs(input[i])) i += 1;
    if (input[i] === '>') return i + 1;
    return -1;
  }

  // Open / self-closing tag <tagname attrs? /?>
  if (!/[A-Za-z]/.test(input[at + 1] ?? '')) return -1;
  let i = at + 2;
  while (i < len && /[A-Za-z0-9-]/.test(input[i]!)) i += 1;

  while (i < len) {
    if (isHtmlTagWs(input[i])) {
      while (i < len && isHtmlTagWs(input[i])) i += 1;
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
          // Quoted attribute values may include newlines (CommonMark / micromark).
          while (i < len && input[i] !== q) i += 1;
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
 * Returns the close when a simple `[[…]]` (no nested `[`, no lone `]`, no
 * newline) matches decoration rules in wiki-link-plugin. Empty `[[]]` still
 * returns the span (plain text; decoration ignores empty targets).
 * Returns -2 on newline inside (dialect). Nested `[` / lone `]` / unclosed
 * return -1 so the scanner emits `[[` as literal and keeps scanning — nested-
 * bracket wiki is therefore engine-owned as literal text (matches dialect /
 * mdast, which never special-cases those shapes).
 */
function endOfSimpleWiki(input: string, at: number): number {
  if (!input.startsWith('[[', at)) return -1;
  const len = input.length;
  let k = at + 2;
  while (k < len) {
    const ch = input[k]!;
    if (ch === '\n') return -2;
    if (ch === '[') return -1; // nested `[` — emit `[[` as literal, keep scanning
    if (ch === ']') {
      if (input[k + 1] === ']') return k + 2;
      // Lone `]` inside (e.g. `[[a] [b]]`) — emit `[[` as literal.
      return -1;
    }
    k += 1;
  }
  return -1;
}


/**
 * Flatten engine inline nodes to a micromark-equivalent image alt string.
 * Marks / links unwrap to text; `math_inline` → value; `inline_html` → raw tag
 * text; CommonMark code-span pad spaces trimmed. Returns null on hard_break
 * (alts are single-line).
 */
function flattenNodesToImageAlt(nodes: readonly ProseNode[]): string | null {
  let out = '';
  for (const n of nodes) {
    if (n.type.name === 'hard_break') return null;
    if (n.type.name === 'math_inline') {
      out += n.textContent;
      continue;
    }
    if (n.type.name === 'inline_html') {
      out += String(n.attrs.value ?? '');
      continue;
    }
    if (n.type.name === 'image') {
      out += String(n.attrs.alt ?? '');
      continue;
    }
    if (n.isText) {
      let t = n.text ?? '';
      if (n.marks.some((m) => m.type.name === 'inline_code')) {
        // CommonMark: one leading+trailing space stripped when both present.
        if (
          t.length >= 2
          && t.startsWith(' ')
          && t.endsWith(' ')
          && /[^ ]/.test(t.slice(1, -1))
        ) {
          t = t.slice(1, -1);
        }
      }
      out += t;
      continue;
    }
    out += n.textContent;
  }
  return out;
}

/**
 * Micromark-equivalent plain alt string for a simple image label, or `null` →
 * dialect. Owns: plain text; simple `$…$` / `$$…$$` (delimiters stripped, inner
 * kept as text — not `math_inline` nodes); simple flat / up-to-nine-level marks
 * (`**` / `*` / `__` / `_` / `~~` / `` ` ``; snake_case `_` flanking); simple
 * backslash escapes of ASCII punct; literal simple HTML tags as characters;
 * angle http(s)/email autolinks (brackets stripped, text kept).
 * Refuses: nested `[` / `]` (caller), newlines, unmatched /
 * thirty-eight+-level nests, newlines in alt, constructs `tryInlineNodesFromSource` cannot own.
 */
function parseSimpleImageAlt(label: string): string | null {
  if (label.includes('\n') || label.includes('\r')) return null;
  // Fast path: no mark / math / HTML / escape / autolink markers.
  if (!/[*_`~<!$:\\@]|https?:\/\/|www\./iu.test(label)) return label;
  // Preserve leading/trailing spaces (tryInlineNodesFromSource trimEnds the core).
  const lead = /^[ \t]*/.exec(label)?.[0] ?? '';
  if (lead.length === label.length) return label;
  const trail = /[ \t]*$/.exec(label)?.[0] ?? '';
  const core = label.slice(lead.length, label.length - trail.length);
  if (core.length === 0) return label;
  const nodes = tryInlineNodesFromSource(core);
  if (!nodes) return null;
  const flat = flattenNodesToImageAlt(nodes);
  if (flat === null) return null;
  return lead + flat + trail;
}

/** Max nest depth (37 = outer + thirty-seven nested, e.g. `_p *q **r _s *t **u _v *w **x _y *z **a _b *c **d _e *f **g _h *i **j _k *l **m _n *o **p _q *r **s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s** r* q_ p** o* n_ m** l* k_ j** i* h_ g** f* e_ d** c* b_ a** z* y_ x** w* v_ u** t* s_ r** q* p_`). */
const MAX_MARK_NEST = 37;

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
   * Emit mark content: plain when delimiter-free; recursive nest when
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
          if (search === at + 2) return -1;
          if (isWs(input[search - 1])) {
            if (search + 2 < len && !isWs(input[search + 2])) {
              const next = skipNestedSpan(search);
              if (next < 0) return -1;
              search = next;
              continue;
            }
            return -1;
          }
          return search + 2;
        }
        search += 1;
      }
      return -1;
    }
    if (input.startsWith('**', at)) {
      if (isWs(input[at + 2])) return -1;
      // Skip cross-family nests (`*` / `_` / `__` / `~~` / code) that may
      // embed `**` (parity with findDoubleClose). Same-delimiter nested `**`
      // openers (ws before) are skipped below; bare non-ws-preceded `**` closes.
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
        // Nested `*em*` / `_em_` / `__strong__` may hold `**`; skip them.
        if (input[search] === '*' && !input.startsWith('**', search)) {
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
        if (input.startsWith('**', search)) {
          if (search === at + 2) return -1;
          if (isWs(input[search - 1])) {
            // Same-delimiter nest (`**a **b** c**`): skip inner opener.
            if (search + 2 < len && !isWs(input[search + 2])) {
              const next = skipNestedSpan(search);
              if (next < 0) return -1;
              search = next;
              continue;
            }
            return -1;
          }
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
          if (search === at + 2) return -1;
          if (isWs(input[search - 1])) {
            if (search + 2 < len && !isWs(input[search + 2])) {
              const next = skipNestedSpan(search);
              if (next < 0) return -1;
              search = next;
              continue;
            }
            return -1;
          }
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
          if (search === at + 1) return -1;
          if (isWs(input[search - 1])) {
            if (search + 1 < len && !isWs(input[search + 1]) && !input.startsWith('**', search)) {
              const next = skipNestedSpan(search);
              if (next < 0) return -1;
              search = next;
              continue;
            }
            return -1;
          }
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
          if (search === at + 1) {
            search += 1;
            continue;
          }
          if (isWs(input[search - 1])) {
            if (search + 1 < len && !isWs(input[search + 1]) && !input.startsWith('__', search)) {
              const next = skipNestedSpan(search);
              if (next < 0) return -1;
              search = next;
              continue;
            }
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
   * may embed the delimiter. Same-delimiter stacks (`**a **b** c**`) skip the
   * inner opener (ws before + non-ws after) via `skipNestedSpan`.
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
        // When `*…***` mixed closes into a trailing triple, skipNestedSpan fails
        // (it tries to parse `***` as nested `**`); return the `***` index so the
        // `**` handler can own `**x *y***`.
        if (input[search] === '*' && !input.startsWith('**', search)) {
          const next = skipNestedSpan(search);
          if (next < 0) {
            let k = search + 1;
            while (k < len - 2) {
              if (input[k] === '\\') {
                k = afterEscape(k);
                continue;
              }
              if (input.startsWith('***', k)) {
                if (isWs(input[k - 1]) || isWs(input[search + 1])) return -1;
                return k;
              }
              if (input[k] === '*' || input.startsWith('**', k)) return -1;
              k += 1;
            }
            return -1;
          }
          search = next;
          continue;
        }
      } else if (delim === '__') {
        if (
          input.startsWith('**', search)
          || input[search] === '*'
          || input.startsWith('~~', search)
        ) {
          const next = skipNestedSpan(search);
          if (next < 0) return -1;
          search = next;
          continue;
        }
        if (input[search] === '_' && !input.startsWith('__', search)) {
          const next = skipNestedSpan(search);
          if (next < 0) {
            let k = search + 1;
            while (k < len - 2) {
              if (input[k] === '\\') {
                k = afterEscape(k);
                continue;
              }
              if (input.startsWith('___', k)) {
                if (isWs(input[k - 1]) || isWs(input[search + 1])) return -1;
                if (isWordChar(input[k - 1]) && isWordChar(input[k + 3])) return -1;
                return k;
              }
              if (input[k] === '_' || input.startsWith('__', k)) return -1;
              k += 1;
            }
            return -1;
          }
          // skipNestedSpan for `_` treats `___` as `__` skip + `_` closer, so it
          // succeeds and lands past the triple — detect and return the `___` start
          // for mixed `__x _y___`.
          if (next >= 3 && input.startsWith('___', next - 3)) {
            return next - 3;
          }
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
        if (search === openAt + dlen) return -1;
        if (isWs(input[search - 1])) {
          // Same-delimiter nest: skip inner opener, keep scanning for outer closer.
          if (search + dlen < len && !isWs(input[search + dlen])) {
            const next = skipNestedSpan(search);
            if (next < 0) return -1;
            search = next;
            continue;
          }
          return -1;
        }
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
        const next = skipNestedSpan(search);
        if (next < 0) return -1;
        search = next;
        continue;
      }
      if (input[search] === '*') {
        if (search === openAt + 1) return -1;
        if (isWs(input[search - 1])) {
          // Same-delimiter nest (`*a *b* c*`): skip inner opener.
          if (search + 1 < len && !isWs(input[search + 1]) && !input.startsWith('**', search)) {
            const next = skipNestedSpan(search);
            if (next < 0) return -1;
            search = next;
            continue;
          }
          return -1;
        }
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
        if (search === openAt + 1) {
          search += 1;
          continue;
        }
        if (isWs(input[search - 1])) {
          if (search + 1 < len && !isWs(input[search + 1]) && !input.startsWith('__', search)) {
            const next = skipNestedSpan(search);
            if (next < 0) return -1;
            search = next;
            continue;
          }
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

  /**
   * Exclusive index of a matched `***` / `___` closer for micromark-shaped
   * emphasis>strong. Cross-family nests (`~~` / `_` inside `***`, `*` inside
   * `___`, code / math / HTML / wiki) are skipped. Same-family delimiters
   * return `-1` so the mixed-closer path (`***x* y**` / `***x** y*`) can run.
   */
  const findTripleClose = (openAt: number, delim: '***' | '___'): number => {
    const otherFamilyIsStar = delim === '___';
    let search = openAt + 3;
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
      if (input.startsWith('~~', search)) {
        const next = skipNestedSpan(search);
        if (next < 0) return -1;
        search = next;
        continue;
      }
      if (otherFamilyIsStar) {
        // Inside `___…___`: skip asterisk-family nests; refuse extra `_`.
        if (input.startsWith('**', search) || input[search] === '*') {
          const next = skipNestedSpan(search);
          if (next < 0) return -1;
          search = next;
          continue;
        }
        if (input.startsWith('___', search)) {
          if (search === openAt + 3 || isWs(input[search - 1])) return -1;
          return search;
        }
        if (input[search] === '_') return -1;
      } else {
        // Inside `***…***`: skip underscore-family nests; refuse extra `*`.
        if (input.startsWith('__', search) || input[search] === '_') {
          const next = skipNestedSpan(search);
          if (next < 0) return -1;
          search = next;
          continue;
        }
        if (input.startsWith('***', search)) {
          if (search === openAt + 3 || isWs(input[search - 1])) return -1;
          return search;
        }
        if (input[search] === '*') return -1;
      }
      search += 1;
    }
    return -1;
  };

  /**
   * Emit micromark-shaped `***` / `___` content: emphasis wrapping strong.
   * Counts as two nest levels toward MAX_MARK_NEST.
   */
  const emitTripleMarked = (content: string, underscoreOuter: boolean): boolean => {
    const em = schema.marks.emphasis.create();
    const strong = schema.marks.strong.create();
    const childMarks = [...parentMarks, em, strong];
    if (!contentNeedsNest(content, underscoreOuter)) {
      nodes.push(...plainRunNodes(content, childMarks, false));
      return true;
    }
    if (depth + 2 > MAX_MARK_NEST) return false;
    const inner = parseSimpleAsteriskTildeCode(content, childMarks, depth + 2);
    if (!inner) return false;
    nodes.push(...inner);
    return true;
  };

  /**
   * Emit content under `extraMarks` (nest depth += marks.length). Empty content
   * is a no-op success.
   */
  const emitUnderMarks = (
    content: string,
    extraMarks: readonly Mark[],
    underscoreOuter: boolean,
  ): boolean => {
    if (content.length === 0) return true;
    const childMarks = [...parentMarks, ...extraMarks];
    if (!contentNeedsNest(content, underscoreOuter)) {
      nodes.push(...plainRunNodes(content, childMarks, false));
      return true;
    }
    const add = extraMarks.length;
    if (depth + add > MAX_MARK_NEST) return false;
    const inner = parseSimpleAsteriskTildeCode(content, childMarks, depth + add);
    if (!inner) return false;
    nodes.push(...inner);
    return true;
  };

  /**
   * Skip shared non-delimiter atoms while scanning for mixed triple closers.
   * Returns new search index, or -1 on hard refuse.
   */
  const skipMixedScanAtom = (search: number): number => {
    if (input[search] === '\\') return afterEscape(search);
    if (input[search] === '$') {
      const math = endOfSimpleInlineMath(input, search);
      if (!math) return -1;
      return math.end;
    }
    if (input[search] === '<') {
      const httpEnd = endOfSimpleAngleAutolink(input, search);
      if (httpEnd >= 0) return httpEnd;
      const emailEnd = endOfSimpleAngleEmail(input, search);
      if (emailEnd >= 0) return emailEnd;
      const htmlEnd = endOfSimpleInlineHtml(input, search);
      if (htmlEnd >= 0) return htmlEnd;
      if (looksLikeInlineHtmlStart(input, search)) return -1;
      return search + 1;
    }
    if (input.startsWith('[[', search)) {
      const next = skipNestedSpan(search);
      if (next < 0) return -1;
      return next;
    }
    if (input[search] === '`') {
      const next = skipNestedSpan(search);
      if (next < 0) return -1;
      return next;
    }
    if (input.startsWith('~~', search)) {
      const next = skipNestedSpan(search);
      if (next < 0) return -1;
      return next;
    }
    return search;
  };

  type MixedFromOpen3 =
    | { kind: 'em-then-strong'; emClose: number; strongClose: number }
    | { kind: 'strong-then-em'; strongClose: number; emClose: number };

  /**
   * Mixed closers after a `***` / `___` opener (micromark parity):
   * - em-then-strong: `***x* y**` / `___x_ y__`
   * - strong-then-em: `***x** y*` / `___x__ y_`
   * Longer delimiter checked first at each index. Ambiguous / unclosed → null.
   */
  const findMixedFromOpen3 = (
    openAt: number,
    family: 'star' | 'underscore',
  ): MixedFromOpen3 | null => {
    const single = family === 'star' ? '*' : '_';
    const dbl = family === 'star' ? '**' : '__';
    const otherIsStar = family === 'underscore';
    let search = openAt + 3;
    while (search < len) {
      const advanced = skipMixedScanAtom(search);
      if (advanced < 0) return null;
      if (advanced !== search) {
        search = advanced;
        continue;
      }
      // Cross-family nests — skip.
      if (otherIsStar) {
        if (input.startsWith('**', search) || input[search] === '*') {
          const next = skipNestedSpan(search);
          if (next < 0) return null;
          search = next;
          continue;
        }
      } else if (input.startsWith('__', search) || input[search] === '_') {
        const next = skipNestedSpan(search);
        if (next < 0) return null;
        search = next;
        continue;
      }
      // Double closer first (strong-then-em): `***…** …*`
      if (input.startsWith(dbl, search) && !input.startsWith(dbl + single, search)) {
        if (search === openAt + 3 || isWs(input[search - 1])) {
          search += 2;
          continue;
        }
        if (
          family === 'underscore'
          && isWordChar(input[search - 1])
          && isWordChar(input[search + 2])
        ) {
          search += 2;
          continue;
        }
        // Find single closer after this **.
        let after = search + 2;
        while (after < len) {
          const adv2 = skipMixedScanAtom(after);
          if (adv2 < 0) return null;
          if (adv2 !== after) {
            after = adv2;
            continue;
          }
          if (otherIsStar) {
            if (input.startsWith('**', after) || input[after] === '*') {
              const next = skipNestedSpan(after);
              if (next < 0) return null;
              after = next;
              continue;
            }
          } else if (input.startsWith('__', after) || input[after] === '_') {
            const next = skipNestedSpan(after);
            if (next < 0) return null;
            after = next;
            continue;
          }
          if (input.startsWith(dbl, after)) {
            // Nested same-delimiter double — skip or refuse.
            if (isWs(input[after - 1]) && after + 2 < len && !isWs(input[after + 2])) {
              const next = skipNestedSpan(after);
              if (next < 0) return null;
              after = next;
              continue;
            }
            return null;
          }
          if (input[after] === single && !input.startsWith(dbl, after)) {
            if (isWs(input[after - 1])) {
              if (after + 1 < len && !isWs(input[after + 1])) {
                const next = skipNestedSpan(after);
                if (next < 0) return null;
                after = next;
                continue;
              }
              after += 1;
              continue;
            }
            if (
              family === 'underscore'
              && isWordChar(input[after - 1])
              && isWordChar(input[after + 1])
            ) {
              after += 1;
              continue;
            }
            return { kind: 'strong-then-em', strongClose: search, emClose: after };
          }
          after += 1;
        }
        return null;
      }
      // Single closer (em-then-strong): `***…* …**`
      if (input[search] === single && !input.startsWith(dbl, search)) {
        if (search === openAt + 3 || isWs(input[search - 1])) {
          if (search + 1 < len && !isWs(input[search + 1])) {
            const next = skipNestedSpan(search);
            if (next < 0) return null;
            search = next;
            continue;
          }
          search += 1;
          continue;
        }
        if (
          family === 'underscore'
          && isWordChar(input[search - 1])
          && isWordChar(input[search + 1])
        ) {
          search += 1;
          continue;
        }
        let after = search + 1;
        while (after < len) {
          const adv2 = skipMixedScanAtom(after);
          if (adv2 < 0) return null;
          if (adv2 !== after) {
            after = adv2;
            continue;
          }
          if (otherIsStar) {
            if (input.startsWith('**', after) || input[after] === '*') {
              const next = skipNestedSpan(after);
              if (next < 0) return null;
              after = next;
              continue;
            }
          } else if (input.startsWith('__', after) || input[after] === '_') {
            const next = skipNestedSpan(after);
            if (next < 0) return null;
            after = next;
            continue;
          }
          if (input.startsWith(dbl, after) && !input.startsWith(dbl + single, after)) {
            if (isWs(input[after - 1])) {
              if (after + 2 < len && !isWs(input[after + 2])) {
                const next = skipNestedSpan(after);
                if (next < 0) return null;
                after = next;
                continue;
              }
              return null;
            }
            if (
              family === 'underscore'
              && isWordChar(input[after - 1])
              && isWordChar(input[after + 2])
            ) {
              after += 2;
              continue;
            }
            return { kind: 'em-then-strong', emClose: search, strongClose: after };
          }
          if (input[after] === single && !input.startsWith(dbl, after)) {
            // Extra same-family single before the ** — skip nest or refuse.
            if (isWs(input[after - 1]) && after + 1 < len && !isWs(input[after + 1])) {
              const next = skipNestedSpan(after);
              if (next < 0) return null;
              after = next;
              continue;
            }
            return null;
          }
          after += 1;
        }
        return null;
      }
      search += 1;
    }
    return null;
  };

  /**
   * Inside a `**` / `__` span, find a same-family single delimiter that opens
   * an emphasis closed by `closeAt` (first char of a trailing `***` / `___`).
   * Does **not** use `skipNestedSpan` on the candidate — that would try to
   * parse the trailing `***` as a nested `**` and fail. Body may only hold
   * cross-family / code / math / HTML / wiki atoms (no same-family delim).
   * Ambiguous multiples → -1.
   */
  const findEmOpenerClosingAt = (
    from: number,
    closeAt: number,
    family: 'star' | 'underscore',
  ): number => {
    const single = family === 'star' ? '*' : '_';
    const dbl = family === 'star' ? '**' : '__';
    // Trailing single must be a right-flanking closer.
    if (closeAt <= from || isWs(input[closeAt - 1])) return -1;
    if (
      family === 'underscore'
      && isWordChar(input[closeAt - 1])
      && isWordChar(input[closeAt + 1])
    ) {
      return -1;
    }
    let found = -1;
    let search = from;
    while (search < closeAt) {
      const advanced = skipMixedScanAtom(search);
      if (advanced < 0) return -1;
      if (advanced !== search) {
        search = advanced;
        continue;
      }
      if (family === 'star') {
        if (input.startsWith('__', search) || input[search] === '_') {
          const next = skipNestedSpan(search);
          if (next < 0 || next > closeAt) return -1;
          search = next;
          continue;
        }
      } else if (input.startsWith('**', search) || input[search] === '*') {
        const next = skipNestedSpan(search);
        if (next < 0 || next > closeAt) return -1;
        search = next;
        continue;
      }
      // Same-family double inside the strong prefix — skip balanced nest, but
      // it must end before closeAt (not consume the trailing triple).
      if (input.startsWith(dbl, search)) {
        // Do not treat the trailing triple's first two as a nest closer.
        if (search === closeAt) break;
        const next = skipNestedSpan(search);
        if (next < 0 || next > closeAt) return -1;
        search = next;
        continue;
      }
      if (input[search] === single) {
        if (isWs(input[search + 1])) {
          search += 1;
          continue;
        }
        if (
          family === 'underscore'
          && isWordChar(input[search - 1])
          && isWordChar(input[search + 1])
        ) {
          search += 1;
          continue;
        }
        // Body (search+1 .. closeAt) must be free of same-family delimiters.
        let body = search + 1;
        let clean = true;
        while (body < closeAt) {
          const adv2 = skipMixedScanAtom(body);
          if (adv2 < 0) {
            clean = false;
            break;
          }
          if (adv2 !== body) {
            body = adv2;
            continue;
          }
          if (family === 'star') {
            if (input.startsWith('__', body) || input[body] === '_') {
              const next = skipNestedSpan(body);
              if (next < 0 || next > closeAt) {
                clean = false;
                break;
              }
              body = next;
              continue;
            }
          } else if (input.startsWith('**', body) || input[body] === '*') {
            const next = skipNestedSpan(body);
            if (next < 0 || next > closeAt) {
              clean = false;
              break;
            }
            body = next;
            continue;
          }
          if (input[body] === single || input.startsWith(dbl, body)) {
            clean = false;
            break;
          }
          body += 1;
        }
        if (clean) {
          if (found >= 0) return -1;
          found = search;
        }
        search += 1;
        continue;
      }
      search += 1;
    }
    return found;
  };

  while (i < len) {
    // Matched `***…***` / `___…___` → emphasis + strong (micromark parity).
    // Mixed closers (`***x* y**` / `***x** y*` / underscore twins) owned below.
    // Same-delimiter `*`/`**`/`_`/`__`/`~~` stacks owned.
    if (input.startsWith('***', i)) {
      if (isWs(input[i + 3])) {
        emitPlain(i, i + 3);
        i += 3;
        continue;
      }
      const close = findTripleClose(i, '***');
      if (close >= 0) {
        const content = input.slice(i + 3, close);
        if (!emitTripleMarked(content, false)) return null;
        i = close + 3;
        continue;
      }
      const mixed = findMixedFromOpen3(i, 'star');
      if (!mixed) return null;
      const em = schema.marks.emphasis.create();
      const strong = schema.marks.strong.create();
      if (mixed.kind === 'em-then-strong') {
        const emBody = input.slice(i + 3, mixed.emClose);
        const strongTail = input.slice(mixed.emClose + 1, mixed.strongClose);
        if (emBody.length === 0 || strongTail.length === 0) return null;
        if (!emitUnderMarks(emBody, [em, strong], false)) return null;
        if (!emitUnderMarks(strongTail, [strong], false)) return null;
        i = mixed.strongClose + 2;
        continue;
      }
      const strongBody = input.slice(i + 3, mixed.strongClose);
      const emTail = input.slice(mixed.strongClose + 2, mixed.emClose);
      if (strongBody.length === 0 || emTail.length === 0) return null;
      if (!emitUnderMarks(strongBody, [em, strong], false)) return null;
      if (!emitUnderMarks(emTail, [em], false)) return null;
      i = mixed.emClose + 1;
      continue;
    }
    if (input.startsWith('___', i)) {
      if (isWordChar(input[i - 1]) && isWordChar(input[i + 3])) {
        emitPlain(i, i + 3);
        i += 3;
        continue;
      }
      if (isWs(input[i + 3])) {
        emitPlain(i, i + 3);
        i += 3;
        continue;
      }
      const close = findTripleClose(i, '___');
      if (close >= 0) {
        const content = input.slice(i + 3, close);
        if (!emitTripleMarked(content, true)) return null;
        i = close + 3;
        continue;
      }
      const mixed = findMixedFromOpen3(i, 'underscore');
      if (!mixed) return null;
      const em = schema.marks.emphasis.create();
      const strong = schema.marks.strong.create();
      if (mixed.kind === 'em-then-strong') {
        const emBody = input.slice(i + 3, mixed.emClose);
        const strongTail = input.slice(mixed.emClose + 1, mixed.strongClose);
        if (emBody.length === 0 || strongTail.length === 0) return null;
        if (!emitUnderMarks(emBody, [em, strong], true)) return null;
        if (!emitUnderMarks(strongTail, [strong], true)) return null;
        i = mixed.strongClose + 2;
        continue;
      }
      const strongBody = input.slice(i + 3, mixed.strongClose);
      const emTail = input.slice(mixed.strongClose + 2, mixed.emClose);
      if (strongBody.length === 0 || emTail.length === 0) return null;
      if (!emitUnderMarks(strongBody, [em, strong], true)) return null;
      if (!emitUnderMarks(emTail, [em], true)) return null;
      i = mixed.emClose + 1;
      continue;
    }


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
      // Mixed `**x *y***`: closer is first two of trailing `***`; inner `*` opens em.
      if (input.startsWith('***', close)) {
        const emOpen = findEmOpenerClosingAt(i + 2, close, 'star');
        if (emOpen >= 0) {
          const prefix = input.slice(i + 2, emOpen);
          const emBody = input.slice(emOpen + 1, close);
          if (emBody.length === 0) return null;
          const strong = schema.marks.strong.create();
          const em = schema.marks.emphasis.create();
          if (!emitUnderMarks(prefix, [strong], false)) return null;
          if (!emitUnderMarks(emBody, [em, strong], false)) return null;
          i = close + 3;
          continue;
        }
      }
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
      // Mixed `__x _y___`: closer is first two of trailing `___`; inner `_` opens em.
      if (input.startsWith('___', close)) {
        const emOpen = findEmOpenerClosingAt(i + 2, close, 'underscore');
        if (emOpen >= 0) {
          const prefix = input.slice(i + 2, emOpen);
          const emBody = input.slice(emOpen + 1, close);
          if (emBody.length === 0) return null;
          const strong = schema.marks.strong.create();
          const em = schema.marks.emphasis.create();
          if (!emitUnderMarks(prefix, [strong], true)) return null;
          if (!emitUnderMarks(emBody, [em, strong], true)) return null;
          i = close + 3;
          continue;
        }
      }
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
    // plugin owns display). Newline inside → dialect; nested `[` / lone `]` /
    // unclosed → emit `[[` and keep scanning (nested-bracket wiki = literal).
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
      // Backslash escapes (e.g. `\\]`) do not close the label (CommonMark).
      let labelEnd = -1;
      for (let k = labelStart; k < len; k += 1) {
        if (input[k] === '\n') break;
        if (input[k] === '\\') {
          if (k + 1 < len) k += 1;
          continue;
        }
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
          const alt = parseSimpleImageAlt(label);
          if (alt === null) return null;
          nodes.push(schema.nodes.image.create({
            src: '',
            alt: alt,
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
        const alt = parseSimpleImageAlt(label);
        if (alt === null) return null;
        nodes.push(schema.nodes.image.create({
          src: href,
          alt: alt,
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
        const lists = parseSimpleFlatListsSource(listRests.join('\n'));
        if (!lists || lists.length === 0) return null;
        for (const list of lists) children.push({ type: 'list', list });
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
 * multi-para lists, pathological depth, footnote-ref titles).
 * Plain / collapsible / plain-titled / simple-marked-title / heavy-title GFM
 * alerts (`> [!NOTE]`, `> [!NOTE]-`, `> [!NOTE] $E=mc^2$` / `<span>x</span>` /
 * nested marks / triples / links …) and simple-marked bodies are accepted.
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

/**
 * Block children of a list item in document order (paragraphs + owned
 * structural kids). Nested lists stay on `ParsedFlatListItem.nestedLists`.
 */
export type ParsedListItemChild =
  | { readonly type: 'paragraph'; readonly text: string }
  | { readonly type: 'quote'; readonly children: readonly ParsedQuoteChild[] }
  | {
    readonly type: 'fence';
    readonly lang: string;
    readonly meta: string;
    readonly value: string;
  }
  | { readonly type: 'heading'; readonly level: number; readonly text: string }
  | { readonly type: 'html'; readonly value: string }
  | {
    readonly type: 'table';
    readonly align: readonly TableAlign[];
    readonly rows: readonly (readonly string[])[];
  }
  | { readonly type: 'hr' };

export interface ParsedFlatListItem {
  readonly checked: boolean | null;
  /**
   * Item body in document order. Soft-wrap newlines stay inside one paragraph
   * entry; a blank + indented continuation starts a new paragraph (multi-block)
   * or an owned structural child (simple quote / fence / ATX heading / HTML / table / hr).
   */
  readonly children: readonly ParsedListItemChild[];
  /**
   * Nested lists under this item (any depth). Empty when the item is flat.
   * Same-indent sibling marker / delimiter / orderedness changes open a new
   * nested list (micromark parity); Phase 16 keeps the outer span one piece.
   */
  readonly nestedLists: readonly ParsedFlatList[];
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
  if (rest.startsWith('<')) return listHtmlBlockKind(rest) !== null;
  if (rest.startsWith('|')) return true;
  if (/^([*\-_])(?:[ \t]*\1){2,}[ \t]*$/u.test(rest)) return true;
  return false;
}

/**
 * Owned structural continuations inside a list item.
 * Tables may also start with a pipe-optional header (`x | y`); those are peeked
 * via `tryCollectTableChild` rather than this classifier.
 */
function ownedStructuralKind(
  rest: string,
): 'quote' | 'fence' | 'heading' | 'hr' | 'html' | 'table' | null {
  if (rest.startsWith('>')) return 'quote';
  if (/^#{1,6}(?:[ \t]|$)/u.test(rest)) return 'heading';
  if (/^(`{3,}|~{3,})/u.test(rest)) return 'fence';
  if (/^([*\-_])(?:[ \t]*\1){2,}[ \t]*$/u.test(rest)) return 'hr';
  if (rest.startsWith('<') && listHtmlBlockKind(rest) !== null) return 'html';
  if (rest.startsWith('|')) return 'table';
  return null;
}

/**
 * Continuous setext underline after list-item indent strip (CommonMark /
 * micromark). Spaced thematic rules (`- - -`) and `***` / `___` do not match.
 */
function isSetextUnderlineRest(rest: string): boolean {
  return /^([=-])\1*[ \t]*$/u.test(rest);
}

/**
 * Promote the item's trailing paragraph to a setext heading (micromark).
 * Returns false when there is nothing to promote (caller falls through).
 * Returns null when inline IR refuses (caller should dialect).
 */
function promoteTrailingParagraphToSetext(
  item: DraftListItem,
  underline: string,
): boolean | null {
  const last = item.children[item.children.length - 1];
  if (!last || last.type !== 'paragraph') return false;
  let text = last.lines.join('\n').trimEnd();
  // GFM task checkbox is paragraph-only; setext absorbs `[ ]`/`[x]` into
  // heading text and clears checked (micromark parity).
  if (item.checked !== null) {
    const box = item.checked ? '[x]' : '[ ]';
    text = text.length > 0 ? `${box} ${text}` : box;
    item.checked = null;
  }
  if (text.length === 0) return false;
  if (tryInlineNodesFromSource(text) === null) return null;
  const marker = underline.trimStart()[0];
  item.children[item.children.length - 1] = {
    type: 'heading',
    level: marker === '=' ? 1 : 2,
    text,
  };
  return true;
}

/** CommonMark HTML block tag names (type 6). */
const LIST_HTML_BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul',
]);

type ListHtmlKind =
  | { type: 1; endTag: string }
  | { type: 2 | 3 | 4 | 5 }
  | { type: 6 | 7 };

/** Detect CommonMark HTML block start on indent-stripped list continuation text. */
function listHtmlBlockKind(content: string): ListHtmlKind | null {
  if (!content.startsWith('<')) return null;
  if (/^<!--/u.test(content)) return { type: 2 };
  if (/^<\?/u.test(content)) return { type: 3 };
  if (/^<![A-Za-z]/u.test(content)) return { type: 4 };
  if (/^<!\[CDATA\[/iu.test(content)) return { type: 5 };
  const type1 = /^<\/?((?:script|pre|style|textarea))(?:[\s\/>]|$)/iu.exec(content);
  if (type1) return { type: 1, endTag: type1[1]!.toLowerCase() };
  const type6 = /^<\/?([A-Za-z][A-Za-z0-9]*)(?=[\s\/>]|$)/u.exec(content);
  if (type6 && LIST_HTML_BLOCK_TAGS.has(type6[1]!.toLowerCase())) return { type: 6 };
  if (
    /^<[A-Za-z][A-Za-z0-9]*(?:[:][A-Za-z][A-Za-z0-9]*)?(?:\s+[^\s>][^>]*)?\s*\/?>\s*$/u.test(content)
    || /^<\/[A-Za-z][A-Za-z0-9]*(?:[:][A-Za-z][A-Za-z0-9]*)?\s*>\s*$/u.test(content)
  ) {
    return { type: 7 };
  }
  return null;
}

function listHtmlBlockLineEnds(content: string, kind: ListHtmlKind): boolean {
  switch (kind.type) {
    case 1:
      return new RegExp(`</${kind.endTag}>`, 'i').test(content);
    case 2:
      return content.includes('-->');
    case 3:
      return content.includes('?>');
    case 4:
      return content.includes('>');
    case 5:
      return content.includes(']]>');
    case 6:
    case 7:
      return false; // blank line ends — caller stops
    default:
      return false;
  }
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

type DraftListChild =
  | { type: 'paragraph'; lines: string[] }
  | { type: 'quote'; children: ParsedQuoteChild[] }
  | { type: 'fence'; lang: string; meta: string; value: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'html'; value: string }
  | { type: 'table'; align: TableAlign[]; rows: string[][] }
  | { type: 'hr' };

type DraftListItem = {
  checked: boolean | null;
  children: DraftListChild[];
  /** Currently open nested list under this item (being filled). */
  nested: DraftListLevel | null;
  /** Nested lists closed by a same-indent marker-family split (micromark). */
  closedNested: DraftListLevel[];
};

type DraftListLevel = {
  indent: string;
  ordered: boolean;
  bullet: FlatListBullet | null;
  delimiter: FlatListDelimiter | null;
  start: number;
  spread: boolean;
  items: DraftListItem[];
  pendingBlank: boolean;
};

/** True when the item has only a single empty paragraph so far. */
function itemIsEmptyPlaceholder(item: DraftListItem): boolean {
  return item.children.length === 1
    && item.children[0]!.type === 'paragraph'
    && item.children[0]!.lines.length === 1
    && item.children[0]!.lines[0] === '';
}

/** Drop a leading empty paragraph placeholder before attaching structural kids. */
function dropEmptyPlaceholder(item: DraftListItem): void {
  if (itemIsEmptyPlaceholder(item)) item.children.pop();
}

/**
 * Collect an owned structural child (quote / fence / ATX heading / HTML /
 * table / hr) starting at `startIdx`. Returns the next line index after the
 * child, or null → dialect.
 */
function collectStructuralChild(
  lines: readonly string[],
  startIdx: number,
  markerIndent: string,
  firstRest: string,
): { child: DraftListChild; nextIdx: number } | null {
  const kind = ownedStructuralKind(firstRest);
  if (!kind) return null;

  if (kind === 'heading') {
    const h = parseHeadingSource(firstRest);
    // Setext underlines inside list items stay dialect (two-line shape).
    if (!h || !/^#{1,6}(?:[ \t]|$)/u.test(firstRest)) return null;
    if (tryInlineNodesFromSource(h.text) === null) return null;
    return {
      child: { type: 'heading', level: h.level, text: h.text },
      nextIdx: startIdx + 1,
    };
  }

  if (kind === 'hr') {
    return { child: { type: 'hr' }, nextIdx: startIdx + 1 };
  }

  if (kind === 'quote') {
    const rests: string[] = [firstRest];
    let j = startIdx + 1;
    while (j < lines.length) {
      const line = lines[j]!;
      if (/^[ \t]*$/u.test(line)) break; // blank ends this quote; outer owns it
      const rest = listContinuationRest(line, markerIndent);
      if (rest === null) break;
      // Contiguous `>`-prefixed lines only (lazy-in-quote inside list stays dialect).
      if (!rest.startsWith('>')) break;
      rests.push(rest);
      j += 1;
    }
    const quote = parseSimpleQuoteSource(rests.join('\n'));
    if (!quote) return null;
    return { child: { type: 'quote', children: quote }, nextIdx: j };
  }

  if (kind === 'html') {
    const htmlKind = listHtmlBlockKind(firstRest);
    if (!htmlKind) return null;
    const collected = [firstRest];
    let j = startIdx + 1;
    if (htmlKind.type <= 5 && listHtmlBlockLineEnds(firstRest, htmlKind)) {
      return { child: { type: 'html', value: firstRest }, nextIdx: j };
    }
    while (j < lines.length) {
      const line = lines[j]!;
      if (/^[ \t]*$/u.test(line)) {
        // Type 6/7 end on blank (blank not part of the HTML). Type 1–5 keep blanks.
        if (htmlKind.type === 6 || htmlKind.type === 7) break;
        collected.push('');
        j += 1;
        continue;
      }
      const rest = listContinuationRest(line, markerIndent);
      if (rest === null) {
        // Unindented / sibling marker: type 6/7 may end at EOF-like boundary;
        // type 1–5 need their closer → dialect.
        if (htmlKind.type === 6 || htmlKind.type === 7) break;
        return null;
      }
      collected.push(rest);
      j += 1;
      if (htmlKind.type <= 5 && listHtmlBlockLineEnds(rest, htmlKind)) break;
    }
    return { child: { type: 'html', value: collected.join('\n') }, nextIdx: j };
  }

  if (kind === 'table') {
    return tryCollectTableChild(lines, startIdx, markerIndent, firstRest);
  }

  // fence — firstRest is already indent-stripped.
  const bare = /^(`{3,}|~{3,})([^\n]*)$/u.exec(firstRest);
  if (!bare) return null;
  const fenceMarker = bare[1]![0] as '`' | '~';
  const fenceLen = bare[1]!.length;
  const collected = [firstRest];
  let j = startIdx + 1;
  let closed = false;
  while (j < lines.length) {
    const line = lines[j]!;
    if (/^[ \t]*$/u.test(line)) {
      // Blank inside a fence is fence content (CommonMark).
      collected.push('');
      j += 1;
      continue;
    }
    const rest = listContinuationRest(line, markerIndent);
    if (rest === null) return null;
    collected.push(rest);
    if (new RegExp(`^${fenceMarker}{${fenceLen},}[ \\t]*$`, 'u').test(rest)) {
      closed = true;
      j += 1;
      break;
    }
    j += 1;
  }
  if (!closed) return null;
  const parsed = parseFenceSource(collected.join('\n'));
  if (!parsed) return null;
  return {
    child: {
      type: 'fence',
      lang: parsed.lang,
      meta: parsed.meta,
      value: parsed.value,
    },
    nextIdx: j,
  };
}

/**
 * Collect a simple GFM table under a list item (indent already stripped on
 * `firstRest`). Pipe-optional rows allowed. Returns null when the lines are
 * not a simple table (caller may fall through or refuse).
 */
function tryCollectTableChild(
  lines: readonly string[],
  startIdx: number,
  markerIndent: string,
  firstRest: string,
): { child: DraftListChild; nextIdx: number } | null {
  if (!firstRest.includes('|')) return null;
  const collected = [firstRest];
  let j = startIdx + 1;
  while (j < lines.length) {
    const line = lines[j]!;
    if (/^[ \t]*$/u.test(line)) break; // blank ends a GFM table
    const rest = listContinuationRest(line, markerIndent);
    if (rest === null) break;
    if (!rest.includes('|')) break;
    collected.push(rest);
    j += 1;
  }
  const parsed = parseSimpleTableSource(collected.join('\n'));
  if (!parsed) return null;
  return {
    child: {
      type: 'table',
      align: [...parsed.align],
      rows: parsed.rows.map((row) => [...row]),
    },
    nextIdx: j,
  };
}

/** True when the line after `startIdx` looks like a GFM table delimiter row. */
function peekTableDelimiter(
  lines: readonly string[],
  startIdx: number,
  markerIndent: string,
): boolean {
  const j = startIdx + 1;
  if (j >= lines.length) return false;
  if (/^[ \t]*$/u.test(lines[j]!)) return false;
  const rest = listContinuationRest(lines[j]!, markerIndent);
  if (rest === null || !rest.includes('|')) return false;
  const cells = splitTableRow(rest);
  return cells.length > 0 && cells.every((cell) => TABLE_DELIMITER_CELL.test(cell));
}

/**
 * Simple flat or nested list (any depth): bullet or ordered delimiter at each
 * level, each item plain/simple-marked paragraphs (optional soft-wrap;
 * CommonMark hard breaks are engine-owned; blank + indented continuation starts
 * another paragraph and marks the list loose) and/or owned structural children
 * (simple quote / fence / ATX heading / HTML / table / hr). Same-family and
 * mixed-marker nests are owned (`@roobli/md` ≥ v0.1.13 Phase 16 keeps mixed nests
 * one span). Same-indent sibling marker / delimiter / orderedness changes under a
 * parent item open another nested list on that item (micromark). Root-level
 * same-indent mixes return multiple lists via `parseSimpleFlatListsSource`
 * (quotes); a single-list span still uses this helper (Phase 19 already splits
 * top-level mixes into separate IR spans). Loose lists set `spread` on that
 * level. Task checkboxes are allowed. Returns `null` when dialect enrich is
 * still needed (heavy inline / lazy line after a blank / root-level marker
 * mix). Setext-shaped tight `---` / `===` after a paragraph promote that
 * paragraph to a heading (micromark). Empty-item + blank + structural is closed
 * at split (`@roobli/md` ≥ v0.1.17 Phase 20 — outside the list span); the refuse
 * below stays as a safety net.
 */
export function parseSimpleFlatListSource(md: string): ParsedFlatList | null {
  const lists = parseSimpleFlatListsSource(md);
  if (!lists || lists.length !== 1) return null;
  return lists[0]!;
}

/**
 * Like `parseSimpleFlatListSource`, but keeps root-level same-indent marker
 * mixes as consecutive sibling lists (micromark / lists-in-quotes).
 */
export function parseSimpleFlatListsSource(md: string): ParsedFlatList[] | null {
  const trimmed = md.replace(/\r\n/g, '\n').trimEnd();
  if (trimmed.length === 0) return null;
  const lines = trimmed.split('\n');

  const stack: DraftListLevel[] = [];
  let sawItem = false;

  const finalizeLevel = (level: DraftListLevel): ParsedFlatList | null => {
    if (level.items.length === 0) return null;
    const items: ParsedFlatListItem[] = [];
    for (const item of level.items) {
      const children: ParsedListItemChild[] = [];
      for (const child of item.children) {
        if (child.type === 'paragraph') {
          const joined = child.lines.join('\n').trimEnd();
          if (tryInlineNodesFromSource(joined) === null) return null;
          children.push({ type: 'paragraph', text: joined });
        } else if (child.type === 'quote') {
          children.push({ type: 'quote', children: child.children });
        } else if (child.type === 'fence') {
          children.push({
            type: 'fence',
            lang: child.lang,
            meta: child.meta,
            value: child.value,
          });
        } else if (child.type === 'heading') {
          children.push({
            type: 'heading',
            level: child.level,
            text: child.text,
          });
        } else if (child.type === 'html') {
          children.push({ type: 'html', value: child.value });
        } else if (child.type === 'table') {
          children.push({
            type: 'table',
            align: child.align,
            rows: child.rows,
          });
        } else {
          children.push({ type: 'hr' });
        }
      }
      const nestedLists: ParsedFlatList[] = [];
      for (const closed of item.closedNested) {
        const finalized = finalizeLevel(closed);
        if (!finalized) return null;
        nestedLists.push(finalized);
      }
      if (item.nested) {
        const nested = finalizeLevel(item.nested);
        if (!nested) return null;
        nestedLists.push(nested);
      }
      // Allow empty children only when a nested list carries the item (rare).
      if (children.length === 0 && nestedLists.length === 0) return null;
      items.push({ checked: item.checked, children, nestedLists });
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
    level: DraftListLevel,
    checked: boolean | null,
    text: string,
  ): void => {
    level.items.push({
      checked,
      children: [{ type: 'paragraph', lines: [text] }],
      nested: null,
      closedNested: [],
    });
  };

  /** Root lists completed by a same-indent marker-family split. */
  const rootLists: ParsedFlatList[] = [];

  /**
   * Same-indent sibling with a different bullet / delimiter / orderedness:
   * close the current list and open a new one (micromark). At nest depth this
   * attaches another nested list under the parent item; at root it starts a
   * sibling top-level list (quotes keep both).
   */
  const splitSameIndentList = (
    ordered: boolean,
    bullet: FlatListBullet | null,
    delimiter: FlatListDelimiter | null,
    start: number,
    checked: boolean | null,
    text: string,
  ): boolean => {
    const top = stack[stack.length - 1]!;
    if (stack.length === 1) {
      const finalized = finalizeLevel(top);
      if (!finalized) return false;
      rootLists.push(finalized);
      const level: DraftListLevel = {
        indent: top.indent,
        ordered,
        bullet,
        delimiter,
        start,
        spread: false,
        items: [],
        pendingBlank: false,
      };
      pushItem(level, checked, text);
      stack[0] = level;
      return true;
    }
    // Nested: close current nest onto parent item, open a new nest sibling.
    const child = stack.pop()!;
    const parent = stack[stack.length - 1]!;
    const parentItem = parent.items[parent.items.length - 1]!;
    if (parentItem.nested !== child) return false;
    parentItem.closedNested.push(child);
    parentItem.nested = null;
    if (child.pendingBlank) parent.pendingBlank = true;
    const next: DraftListLevel = {
      indent: child.indent,
      ordered,
      bullet,
      delimiter,
      start,
      spread: false,
      items: [],
      pendingBlank: false,
    };
    pushItem(next, checked, text);
    parentItem.nested = next;
    stack.push(next);
    return true;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    if (/^[ \t]*$/u.test(line)) {
      if (!sawItem || stack.length === 0) return null;
      // Blank belongs to the deepest open level; transferred to ancestors on pop
      // so a blank before a shallower sibling still spreads that ancestor list.
      stack[stack.length - 1]!.pendingBlank = true;
      i += 1;
      continue;
    }

    const bulletMatch = BULLET_MARKER_RE.exec(line);
    const orderedMatch = bulletMatch ? null : ORDERED_MARKER_RE.exec(line);

    // Tight setext / thematic-break lines can look like a nested bullet
    // (`  -`, `  - - -`). Prefer paragraph setext / hr (micromark) over opening
    // a nested item — fall through to the continuation handler below.
    let listMarker = Boolean(bulletMatch || orderedMatch);
    if (listMarker && stack.length > 0) {
      const peekTop = stack[stack.length - 1]!;
      const peekRest = listContinuationRest(line, peekTop.indent);
      if (
        peekRest !== null
        && (isSetextUnderlineRest(peekRest) || ownedStructuralKind(peekRest) === 'hr')
      ) {
        listMarker = false;
      }
    }

    if (listMarker) {
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
        const level: DraftListLevel = {
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
        i += 1;
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
        // Sibling at the current level (or marker-family split → new list).
        let rest: string;
        let ordered = top.ordered;
        let bullet = top.bullet;
        let delimiter = top.delimiter;
        let start = top.start;
        let familyChanged = false;
        if (bulletMatch) {
          const marker = bulletMatch[2] as FlatListBullet;
          if (top.ordered || (top.bullet !== null && top.bullet !== marker)) {
            familyChanged = true;
            ordered = false;
            bullet = marker;
            delimiter = null;
            start = 1;
          } else {
            top.bullet = marker;
            bullet = marker;
          }
          rest = line.slice(bulletMatch[0].length);
        } else {
          const m = orderedMatch!;
          const delim = m[3] as FlatListDelimiter;
          const nextStart = Number(m[2]!);
          if (!top.ordered || (top.delimiter !== null && top.delimiter !== delim)) {
            familyChanged = true;
            ordered = true;
            bullet = null;
            delimiter = delim;
            start = nextStart;
          }
          rest = line.slice(m[0].length);
        }
        const { checked, text: rawText } = splitTaskPrefix(rest);
        const text = rawText.replace(/^[ \t]+/u, '');
        if (familyChanged) {
          if (!splitSameIndentList(ordered, bullet, delimiter, start, checked, text)) {
            return null;
          }
          sawItem = true;
          i += 1;
          continue;
        }
        if (top.pendingBlank && top.items.length > 0) top.spread = true;
        top.pendingBlank = false;
        pushItem(top, checked, text);
        sawItem = true;
        i += 1;
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

        const child: DraftListLevel = {
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
        i += 1;
        continue;
      }

      // Indent shorter than top but not equal to any ancestor, or not a
      // prefix of the deeper indent — refuse.
      return null;
    }

    // Continuation of the current deepest item: soft-wrap, new paragraph after
    // a blank, or an owned structural child (quote / fence / ATX heading / HTML /
    // table / hr). Lazy after a blank is not in the item (CommonMark) — refuse
    // so the span stays dialect rather than mis-owning.
    if (!sawItem || stack.length === 0) return null;
    const top = stack[stack.length - 1]!;
    if (top.items.length === 0) return null;
    const cur = top.items[top.items.length - 1]!;

    if (top.pendingBlank) {
      const rest = listContinuationRest(line, top.indent);
      if (rest === null) return null; // lazy / weird indent after blank → dialect
      const structural = ownedStructuralKind(rest);
      if (structural) {
        // Empty item + blank + structural is outside the list at split
        // (`@roobli/md` ≥ v0.1.17). Refuse if a mis-split still feeds it here.
        if (itemIsEmptyPlaceholder(cur)) return null;
        const collected = collectStructuralChild(lines, i, top.indent, rest);
        if (!collected) return null;
        cur.children.push(collected.child);
        top.spread = true;
        top.pendingBlank = false;
        i = collected.nextIdx;
        continue;
      }
      // Pipe-optional table header (no leading `|`) after a blank.
      if (rest.includes('|')) {
        if (itemIsEmptyPlaceholder(cur)) return null;
        const tableCollected = tryCollectTableChild(lines, i, top.indent, rest);
        if (tableCollected) {
          cur.children.push(tableCollected.child);
          top.spread = true;
          top.pendingBlank = false;
          i = tableCollected.nextIdx;
          continue;
        }
        if (peekTableDelimiter(lines, i, top.indent)) return null;
      }
      if (restLooksStructural(rest) || tryInlineNodesFromSource(rest) === null) {
        return null;
      }
      cur.children.push({ type: 'paragraph', lines: [rest] });
      top.spread = true;
      top.pendingBlank = false;
      i += 1;
      continue;
    }

    let rest = listContinuationRest(line, top.indent);
    if (rest === null) {
      // CommonMark lazy continuation (Phase 13 / @roobli/md v0.1.9): unindented
      // line continues the innermost open item. Partial weird indent → dialect.
      if (/^[ \t]/.test(line)) return null;
      rest = line;
    }
    // Tight continuous setext underline after a paragraph → heading (micromark).
    // Spaced `- - -` / `***` / `___` fall through as thematic breaks; empty
    // placeholder paras (no task box) fall through so `---` alone stays hr.
    if (isSetextUnderlineRest(rest)) {
      const promoted = promoteTrailingParagraphToSetext(cur, rest);
      if (promoted === null) return null;
      if (promoted) {
        top.pendingBlank = false;
        i += 1;
        continue;
      }
    }
    const structural = ownedStructuralKind(rest);
    if (structural) {
      // Tight structural child (no blank). Drop empty marker placeholder.
      const collected = collectStructuralChild(lines, i, top.indent, rest);
      if (!collected) return null;
      dropEmptyPlaceholder(cur);
      cur.children.push(collected.child);
      top.pendingBlank = false;
      i = collected.nextIdx;
      continue;
    }
    // Pipe-optional table header (no leading `|`) as a tight continuation.
    if (rest.includes('|')) {
      const tableCollected = tryCollectTableChild(lines, i, top.indent, rest);
      if (tableCollected) {
        dropEmptyPlaceholder(cur);
        cur.children.push(tableCollected.child);
        top.pendingBlank = false;
        i = tableCollected.nextIdx;
        continue;
      }
      if (peekTableDelimiter(lines, i, top.indent)) return null;
    }
    if (restLooksStructural(rest) || tryInlineNodesFromSource(rest) === null) {
      return null;
    }
    const last = cur.children[cur.children.length - 1];
    if (last && last.type === 'paragraph') {
      last.lines.push(rest);
    } else {
      cur.children.push({ type: 'paragraph', lines: [rest] });
    }
    top.pendingBlank = false;
    i += 1;
  }

  if (stack.length === 0) return null;
  const last = finalizeLevel(stack[0]!);
  if (!last) return null;
  rootLists.push(last);
  return rootLists;
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
 * than the header — kept as-is, matching micromark/mdast); **pipe-optional**
 * rows (leading/trailing `|` may be omitted when the row still contains `|`,
 * matching GFM; 0–3 space indent); no blank lines inside the span. Nested /
 * heavy inline (cell newlines / exotic math / footnote refs) fall through to
 * dialect. Delimiter≠header returns null (Phase 17 split keeps those as
 * paragraphs; this refuse is a safety net). Pipe-less delimiter rows that
 * micromark treats as a bullet list (`- | -` — marker + space, no leading `|`)
 * also return null so IR→PM stays at micromark parity.
 * Returns `null` when enrich is still needed.
 */
export function parseSimpleTableSource(md: string): ParsedSimpleTable | null {
  const trimmed = md.replace(/\r\n/g, '\n').trimEnd();
  if (trimmed.length === 0) return null;
  const lines = trimmed.split('\n');
  if (lines.length < 2) return null;

  // GFM: leading `|` after 0–3 spaces is optional when the row still contains `|`.
  const normalized: string[] = [];
  for (const line of lines) {
    if (/^[ \t]*$/u.test(line)) return null; // blank ends a GFM table
    const m = /^( {0,3})(.*\S.*)$/u.exec(line);
    if (!m) return null;
    const content = m[2]!;
    if (!content.includes('|')) return null;
    normalized.push(content);
  }

  // Micromark steals pipe-less `- | -` as a bullet list (marker + space). Compact
  // `-|-` / leading-`|` rows are fine; refuse the list-steal shape only.
  const delimLine = normalized[1]!;
  if (!delimLine.startsWith('|') && /^[-*+]\s/u.test(delimLine)) return null;

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

function pmListItemChildNodes(child: ParsedListItemChild): ProseNode {
  switch (child.type) {
    case 'paragraph':
      return schema.nodes.paragraph.create(null, requireInlineNodes(child.text));
    case 'quote':
      return pmQuoteFromParsed(child.children);
    case 'fence':
      return schema.nodes.code_block.create(
        { lang: child.lang, fenced: true },
        textNodes(child.value),
      );
    case 'heading':
      return schema.nodes.heading.create(
        { level: child.level },
        requireInlineNodes(child.text),
      );
    case 'html':
      return schema.nodes.html_block.create(null, textNodes(child.value));
    case 'table': {
      const pmRows = child.rows.map((row, rowIndex) => {
        const cellType = rowIndex === 0 ? schema.nodes.table_header : schema.nodes.table_cell;
        const cells = row.map((cell, columnIndex) => cellType.create(
          { align: child.align[columnIndex] ?? null },
          requireInlineNodes(cell),
        ));
        return schema.nodes.table_row.create(null, cells);
      });
      return schema.nodes.table.create(null, pmRows);
    }
    case 'hr':
      return schema.nodes.horizontal_rule.create();
  }
}

function pmListFromParsed(list: ParsedFlatList): ProseNode {
  const items = list.items.map((item) => {
    const children: ProseNode[] = item.children.map(pmListItemChildNodes);
    for (const nested of item.nestedLists) children.push(pmListFromParsed(nested));
    if (children.length === 0) children.push(schema.nodes.paragraph.create());
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

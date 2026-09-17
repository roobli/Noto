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
 * plain-body GFM alerts / callouts incl. simple-marked bodies, and CommonMark
 * lazy continuation via fewer `>` **or true no-`>` lazy lines**), **simple
 * flat / nested lists** (same-family markers at every depth; plain or
 * simple-marked single-paragraph items incl. hard breaks and unindented lazy
 * soft-wrap), and **simple GFM tables** (alignment row; plain or simple-marked
 * cells; consistent columns), the PM node is fully determined by that IR — no
 * micromark / mdast pass. Cross-family nests, multi-block items, deep / ambiguous nested marks /
 * links / wiki / HTML /
 * escapes, and complex / ragged tables still go through `from-mdast.ts` after
 * dialect enrich. **Simple GFM alerts / callouts** keep the marker as plain
 * text for the alert decoration plugin.
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
 * nesting) are engine-owned via `tryInlineNodesFromSource`; deep / ambiguous
 * nests and heavier constructs stay on dialect. Snake_case underscores are
 * literal (CommonMark flanking).
 */
const INLINE_DIALECT_RE = /[*_~`[\]<!$:\\]|https?:\/\//u;
/**
 * Markers that always force dialect even with the simple-marked subset:
 * links, wiki, HTML, math, escapes, autolink. Underscore emphasis is owned
 * (with snake_case-safe flanking); deep / unmatched nests fall through in the
 * scanner.
 */
const HEAVY_INLINE_RE = /[\[\]<!$:\\]|https?:\/\//;
/** CommonMark / vault hard break: two+ spaces before newline. */
const HARD_BREAK_RE = / {2,}\r?\n/;

export function needsDialectInline(markdown: string): boolean {
  return INLINE_DIALECT_RE.test(markdown);
}

/**
 * GFM alert / callout marker at the start of a quote paragraph.
 *
 * Owns plain `[!NOTE]`, collapsible `[!NOTE]-` / `[!NOTE]+`, and an optional
 * same-line plain title (`[!NOTE] Title`). Title text with marks / links /
 * wiki / HTML still falls through to dialect so micromark keeps parity. The
 * alert-plugin decorates from the leading `[!NOTE]` token either way.
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
 * simple-marked / collapsible / plain-titled GFM alerts / callouts, lazy nest + no-`>` lazy); simple flat
 * or same-family nested lists (any depth, incl. hard breaks + simple marks);
 * simple GFM tables (plain or simple-marked cells); paragraph / heading when
 * plain or simple-marked (hard breaks allowed — engine-owned).
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
 * `*em **strong** em*`, `` **`code`** ``). Deep / ambiguous nests (`***`,
 * same-delimiter stacks), links/wiki/HTML/math/escapes/autolink, and unmatched
 * delimiters return `null` (dialect enrich). Snake_case underscores
 * (`mcp_register`) stay literal via CommonMark-ish flanking.
 */
export function tryInlineNodesFromSource(
  md: string,
  options: TryInlineOptions = {},
): ProseNode[] | null {
  const normalized = md.replace(/\r\n/g, '\n');
  if (options.quoteAlert) {
    const match = ALERT_MARKER_RE.exec(normalized);
    if (match) {
      const title = match[3] ?? '';
      // Same-line title must stay plain; marked/heavy titles keep dialect.
      if (title.length > 0 && INLINE_DIALECT_RE.test(title)) return null;
      const prefix = match[0];
      const rest = normalized.slice(prefix.length);
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
  if (HEAVY_INLINE_RE.test(normalized)) return null;
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

  /** Content of a leaf (no further nest) may not hold delimiter characters. */
  const ASTERISK_TILDE_FORBIDDEN = /[*`~]/u;
  const UNDERSCORE_FORBIDDEN = /[*_`~]/u;

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
    if (input[at] === '`') {
      const close = input.indexOf('`', at + 1);
      if (close < 0 || input.slice(at + 1, close).includes('\n')) return -1;
      return close + 1;
    }
    if (input.startsWith('~~', at)) {
      if (isWs(input[at + 2])) return -1;
      const close = input.indexOf('~~', at + 2);
      if (close < 0 || close === at + 2 || isWs(input[close - 1])) return -1;
      return close + 2;
    }
    if (input.startsWith('**', at)) {
      if (isWs(input[at + 2])) return -1;
      // Nested ** content must not itself hold ** (one-level / no same-delimiter).
      let search = at + 2;
      while (search < len) {
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
      const close = input.indexOf('__', at + 2);
      if (close < 0 || close === at + 2 || isWs(input[close - 1])) return -1;
      if (isWordChar(input[close - 1]) && isWordChar(input[close + 2])) return -1;
      return close + 2;
    }
    if (input[at] === '*') {
      if (isWs(input[at + 1])) return -1;
      let search = at + 1;
      while (search < len) {
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

    if (input[i] === '~') {
      // Lone `~` (not `~~`) — dialect (subscript / unmatched).
      return null;
    }

    let j = i + 1;
    while (j < len) {
      const ch = input[j]!;
      if (ch === '*' || ch === '~' || ch === '`' || ch === '_') break;
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
 * (incl. fewer-`>` and no-`>` lazy), and/or simple flat / same-family nested
 * lists (any reasonable depth; lazy into list items). Returns a child tree
 * matching CommonMark / mdast shape for the owned subset, or `null` when the
 * span still needs dialect enrich (nested marks / nested / heavy inline,
 * cross-family / multi-para lists, pathological depth, marked callout titles).
 * Plain / collapsible / plain-titled GFM alerts (`> [!NOTE]`, `> [!NOTE]-`,
 * `> [!NOTE] Title` …) and simple-marked bodies are accepted.
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
 * Simple flat or same-family nested list (any depth): consistent bullet or
 * ordered delimiter at each level, each item a single plain paragraph (optional
 * soft-wrap continuation; CommonMark hard breaks are engine-owned). Parent and
 * every nest share orderedness (same family); mixed-marker nests that split
 * under micromark are refused. Loose lists (blank between sibling items) set
 * `spread` on that level. Task checkboxes are allowed. Returns `null` when
 * dialect enrich is still needed (marked phrasing, cross-family / multi-para).
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
  let rootFamily: boolean | null = null; // false=bullet, true=ordered
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
        rootFamily = ordered;
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
        // Same family as root.
        if (rootFamily !== top.ordered) return null;
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
        // Same family as root (and therefore as parent).
        if (rootFamily === null || rootFamily !== ordered) return null;

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
 * plain or simple-marked (`**` / `*` / `~~` / `` ` ``); consistent column
 * counts; no blank lines inside the span. Ragged columns, escaped pipes,
 * nested / heavy inline, and missing delimiter fall through to
 * dialect. Returns `null` when enrich is still needed.
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

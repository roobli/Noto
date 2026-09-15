/**
 * Engine-owned IR → ProseMirror for common blocks (flagged `@roobli/md` path).
 *
 * Native spans are kind + source offsets only. For leaf kinds (fence, hr, math,
 * frontmatter, html) and for plain paragraph/heading with no inline dialect
 * markers, the PM node is fully determined by that IR — no micromark / mdast
 * pass. Lists, tables, quotes, and marked-up phrasing still go through
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
 * links, code, math, HTML, autolink, hard breaks). Any hit → paragraph/heading
 * stay on mdast so serialize keeps vault hard-break form (two trailing spaces).
 */
const INLINE_DIALECT_RE = /[*_~`[\]<!$:\\]|https?:\/\//u;
/** CommonMark / vault hard break: two+ spaces before newline. */
const HARD_BREAK_RE = / {2,}\r?\n/;

export function needsDialectInline(markdown: string): boolean {
  return INLINE_DIALECT_RE.test(markdown) || HARD_BREAK_RE.test(markdown);
}

/**
 * True when dialect enrich can be skipped: leaf kinds always; paragraph /
 * heading only when the source has no inline dialect markers.
 */
export function canSkipDialectEnrich(kind: NotoBlockKind, markdown: string): boolean {
  if (ENGINE_LEAF_KINDS.has(kind)) return true;
  if (kind === 'paragraph' || kind === 'heading') {
    return !needsDialectInline(markdown);
  }
  return false;
}

function textNodes(value: string): ProseNode[] {
  return value.length === 0 ? [] : [schema.text(value)];
}

export interface ParsedFence {
  readonly lang: string;
  readonly meta: string;
  readonly value: string;
}

/** Parse a fenced code source slice (ATX fence open/close). */
export function parseFenceSource(md: string): ParsedFence | null {
  const fence = /^(?: {0,3})(`{3,}|~{3,})([^\n]*)\r?\n([\s\S]*?)\r?\n(?: {0,3})\1[ \t]*\r?$/s.exec(md);
  if (!fence) return null;
  const info = fence[2]!.trim();
  const infoMatch = info.length > 0 ? /^(\S+)(?:[ \t]+(.*))?$/u.exec(info) : null;
  return {
    lang: infoMatch?.[1] ?? '',
    meta: infoMatch?.[2]?.trim() ?? '',
    value: fence[3]!,
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
        return schema.nodes.heading.create({ level: 1 }, textNodes(markdown));
      }
      return schema.nodes.heading.create({ level: h.level }, textNodes(h.text));
    }
    case 'paragraph': {
      const body = markdown.replace(/\r\n/g, '\n');
      return schema.nodes.paragraph.create(null, textNodes(body));
    }
    default:
      return null;
  }
}

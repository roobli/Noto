/**
 * What Quick Open's preview draws from a note's first few kilobytes, or the
 * lines around a match, worked out without a window.
 *
 * The preview is there to tell notes apart before opening one: a vault of
 * thousands holds many `00_索引.md` and many notes with the same opening
 * words, and the name and folder alone do not say which is which. So it
 * shows the note as it reads, not as it is written: headings as headings,
 * a list as a list, links by their words, and none of the frontmatter or the
 * generated markers a tool keeps in it. It never renders HTML; every block
 * is plain text, drawn as a text node.
 */

import { fenceCloses, fenceOpens, type Fence } from '../shared/markdown-fence';

export type PreviewKind = 'h1' | 'h2' | 'h3' | 'p' | 'li' | 'quote' | 'code' | 'rule';

export interface PreviewBlock {
  readonly kind: PreviewKind;
  readonly text: string;
  /** The line it came from, 1-based, so a match can be found among them. */
  readonly line: number;
}

/** Blocks drawn at most: more than a preview pane holds, so it always ends cut off rather than short. */
const MOST = 40;

/** A link's words, a picture's name, and no markdown punctuation: how the line reads on the page. */
export function readable(text: string): string {
  return text
    .replace(/<!--.*?-->/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt: string) => (alt ? `[${alt}]` : '[picture]'))
    .replace(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, (_, name: string) => `[${name}]`)
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/(\*\*|__|~~|==)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

/**
 * A line from a search inside notes, as a person reads it: a path a link
 * escaped (`%E9%A1%B9`) in its own letters, a link by its words, and a table
 * row's cells apart rather than walled in pipes.
 */
export function readableLine(text: string): string {
  let out = text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try { return decodeURIComponent(run); } catch { return run; }
  });
  out = out.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/(\*\*|__)(.+?)\1/g, '$2');
  if (/^\s*\|/.test(out)) out = out.replace(/^\s*\|\s*/, '').replace(/\s*\|\s*$/, '').replace(/\s*\|\s*/g, ' · ');
  return out;
}

/**
 * A found line made readable, with where the match is in what is shown: the
 * whole line is made readable first, since cleaning its pieces apart loses a
 * table's first separator, and the match is then found again in it. Null
 * `at` when the cleaning took the matched characters with it.
 */
export function readableHit(line: string, column: number, length: number): { text: string; at: number; length: number } {
  const text = readableLine(line);
  const wanted = line.slice(column, column + length).toLowerCase();
  if (!wanted) return { text, at: -1, length: 0 };
  // The cleaning moves characters, so the match is the occurrence nearest to
  // where the text before it lands once cleaned, not the first one.
  const near = readableLine(line.slice(0, column)).length;
  const lower = text.toLowerCase();
  let at = -1;
  for (let found = lower.indexOf(wanted); found >= 0; found = lower.indexOf(wanted, found + 1)) {
    if (at < 0 || Math.abs(found - near) < Math.abs(at - near)) at = found;
  }
  return { text, at, length: at < 0 ? 0 : wanted.length };
}

/**
 * The blocks of `text`, which begins on line `from`, inside the code block
 * `inside` opened when the window starts within one. A note's opening loses
 * its byte-order mark and its frontmatter, all of it when the read stopped
 * before the frontmatter ended; fenced code is kept as a few lines of code;
 * blank lines only separate. The last line may be cut where the read
 * stopped, and is kept: the pane fades it out.
 */
export function previewBlocks(text: string, from = 1, inside: string | null = null): PreviewBlock[] {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: PreviewBlock[] = [];
  let at = 0;
  if (from === 1 && /^---\s*$/.test(lines[0] ?? '')) {
    const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
    at = end > 0 ? end + 1 : lines.length;
  }
  let fence: Fence | null = inside ? fenceOpens(inside) : null;
  let fenced = 0;
  for (; at < lines.length && blocks.length < MOST; at += 1) {
    const raw = lines[at]!;
    const line = from + at;
    if (fence !== null) {
      if (fenceCloses(raw, fence)) { fence = null; continue; }
      // A long block of code is a few of its lines: enough to recognise it.
      if (fenced < 6) blocks.push({ kind: 'code', text: raw.replace(/\t/g, '  '), line });
      fenced += 1;
      continue;
    }
    const opens = fenceOpens(raw);
    if (opens) { fence = opens; fenced = 0; continue; }
    const trimmed = raw.trim();
    if (trimmed === '' || /^<!--.*-->$/.test(trimmed) || /^\[\^[^\]]+\]:/.test(trimmed)) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const depth = heading[1]!.length;
      blocks.push({ kind: depth === 1 ? 'h1' : depth === 2 ? 'h2' : 'h3', text: readable(heading[2]!.replace(/\s+#+\s*$/, '')), line });
      continue;
    }
    if (/^([-*_])\s*(\1\s*){2,}$/.test(trimmed)) { blocks.push({ kind: 'rule', text: '', line }); continue; }
    const item = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(trimmed);
    if (item) { blocks.push({ kind: 'li', text: readable(item[1]!), line }); continue; }
    if (trimmed.startsWith('>')) { blocks.push({ kind: 'quote', text: readable(trimmed.replace(/^>+\s?/, '').replace(/^\[!\w+\]\s*/, '')), line }); continue; }
    if (/^\|.*\|$/.test(trimmed)) {
      // A table's divider row says nothing; its other rows read as their cells.
      if (/^\|[\s:|-]+\|$/.test(trimmed)) continue;
      blocks.push({ kind: 'p', text: readableLine(trimmed), line });
      continue;
    }
    const text = readable(trimmed);
    if (text) blocks.push({ kind: 'p', text, line });
  }
  return blocks;
}

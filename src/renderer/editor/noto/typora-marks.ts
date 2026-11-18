/**
 * Typora's inline extensions, found in a run of text: `==highlight==`,
 * `^superscript^` and `~subscript~`.
 *
 * None of these is CommonMark, so the parser keeps them as plain text and
 * the file keeps its delimiters byte for byte. The editor draws them as
 * Typora does through decorations: the inner text takes the mark, the
 * delimiters hide, and both come back while the caret is in the block,
 * which is the same reveal every other inline syntax gets.
 *
 * Pure, so the scanning is tested on its own. Offsets are code units into
 * the text given, which is how ProseMirror counts positions in a text node.
 */

export type TyporaMarkKind = 'highlight' | 'superscript' | 'subscript';

export interface TyporaMarkRange {
  readonly kind: TyporaMarkKind;
  /** The whole thing, delimiters included. */
  readonly from: number;
  readonly to: number;
  /** The inner text. */
  readonly innerFrom: number;
  readonly innerTo: number;
  /** Offsets of the backslashes in `\ ` escapes inside, which are not drawn. */
  readonly escapes: readonly number[];
}

/*
 * `==text==` may span spaces, as Typora allows. `^text^` and `~text~` may
 * not: a caret or a tilde with a space after it is punctuation, not a mark,
 * and `~~struck~~` is strikethrough, which the parser already owns, so a
 * tilde next to another tilde is left alone. A space written `\ ` is the one
 * a mark may hold, as Typora's reference has it (`X~long\ text~`); the
 * backslash is source, hidden with the delimiters.
 */
const HIGHLIGHT = /==([^=\n]+?)==/g;
const SUPERSCRIPT = /\^((?:\\ |[^\s^\\]|\\(?! ))+?)\^/g;
const SUBSCRIPT = /(^|[^~])~((?:\\ |[^\s~\\]|\\(?! ))+?)~(?!~)/g;

function escapesIn(inner: string, start: number): number[] {
  const found: number[] = [];
  for (let index = inner.indexOf('\\ '); index >= 0; index = inner.indexOf('\\ ', index + 2)) found.push(start + index);
  return found;
}

/** Which of the three are read as marks; the rest stay as characters. */
export interface TyporaMarkKinds {
  readonly highlight: boolean;
  readonly superscript: boolean;
  readonly subscript: boolean;
}

export const ALL_MARK_KINDS: TyporaMarkKinds = { highlight: true, superscript: true, subscript: true };

export function typoraMarkRanges(text: string, kinds: TyporaMarkKinds = ALL_MARK_KINDS): TyporaMarkRange[] {
  const ranges: TyporaMarkRange[] = [];
  if (kinds.highlight) for (const match of text.matchAll(HIGHLIGHT)) {
    const from = match.index;
    ranges.push({ kind: 'highlight', from, to: from + match[0].length, innerFrom: from + 2, innerTo: from + 2 + match[1].length, escapes: [] });
  }
  if (kinds.superscript) for (const match of text.matchAll(SUPERSCRIPT)) {
    const from = match.index;
    ranges.push({ kind: 'superscript', from, to: from + match[0].length, innerFrom: from + 1, innerTo: from + 1 + match[1].length, escapes: escapesIn(match[1], from + 1) });
  }
  if (kinds.subscript) for (const match of text.matchAll(SUBSCRIPT)) {
    const from = match.index + match[1].length;
    const length = match[0].length - match[1].length;
    ranges.push({ kind: 'subscript', from, to: from + length, innerFrom: from + 1, innerTo: from + 1 + match[2].length, escapes: escapesIn(match[2], from + 1) });
  }
  ranges.sort((a, b) => a.from - b.from);
  // Marks do not nest here: the first to start wins and anything it covers is dropped.
  const kept: TyporaMarkRange[] = [];
  let reach = -1;
  for (const range of ranges) {
    if (range.from < reach) continue;
    kept.push(range);
    reach = range.to;
  }
  return kept;
}

/**
 * Tufte-style margin notes written as `<span class="sidenote">…</span>`.
 *
 * The author's Typora `sidenote` plugin recognises that spelling (and the
 * older `marginnote` class) and turns it into a numbered note in the gutter.
 * The file keeps every tag byte for byte; only the drawing changes. Pure, so
 * the ranges and the insertion text are tested without a document.
 */

export const SIDENOTE_TAG_OPEN = '<span class="sidenote">';
export const SIDENOTE_TAG_CLOSE = '</span>';

/** Opening tag the author's plugin accepts: `sidenote` or `marginnote`. */
const OPEN_TAG = /^<span\b[^>]*\bclass\s*=\s*["'](?:side|margin)note["'][^>]*>$/i;
const CLOSE_TAG = /^<\/span>$/i;

export function isSidenoteOpen(value: string): boolean {
  return OPEN_TAG.test(value.trim());
}

export function isSidenoteClose(value: string): boolean {
  return CLOSE_TAG.test(value.trim());
}

/**
 * The markdown a command writes for a selection.
 *
 * Empty selection becomes an empty note the caret can fill. Newlines inside
 * the selection flatten to spaces, because a sidenote is an inline note, not
 * a second paragraph hanging off the first.
 */
export function formatSidenoteInsertion(selectedText: string): string {
  const content = selectedText
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .trim();
  return `${SIDENOTE_TAG_OPEN}${content}${SIDENOTE_TAG_CLOSE}`;
}

/** One sidenote inside a text block, located by the positions of its tags. */
export interface SidenoteRange {
  /** Document position of the opening `inline_html` node. */
  readonly openFrom: number;
  readonly openTo: number;
  /** Document position of the closing `</span>` node. */
  readonly closeFrom: number;
  readonly closeTo: number;
  /** Inclusive start of the note's content, exclusive end. */
  readonly contentFrom: number;
  readonly contentTo: number;
  /** 1-based index across the whole document, in reading order. */
  readonly index: number;
}

/** A child of a textblock, reduced to what pairing needs. */
export interface SidenoteChild {
  readonly type: string;
  readonly value?: string;
  readonly size: number;
}

/**
 * Pair every sidenote open with the next `</span>` that has not already closed
 * one, walking the block's children left to right.
 *
 * Other span tags are ignored for pairing: the vault writes sidenotes as a
 * dedicated class and does not nest them, which is the same rule the Typora
 * plugin lives by.
 */
export function sidenoteRangesInBlock(
  children: ReadonlyArray<SidenoteChild>,
  blockContentStart: number,
  indexStart: number,
): SidenoteRange[] {
  const pending: number[] = [];
  const ranges: SidenoteRange[] = [];
  let index = indexStart;
  let offset = 0;

  for (const child of children) {
    const here = blockContentStart + offset;
    if (child.type === 'inline_html') {
      const value = child.value ?? '';
      if (isSidenoteOpen(value)) {
        pending.push(here);
      } else if (isSidenoteClose(value) && pending.length > 0) {
        const openFrom = pending.pop()!;
        const openTo = openFrom + 1;
        const closeFrom = here;
        const closeTo = here + child.size;
        index += 1;
        ranges.push({
          openFrom,
          openTo,
          closeFrom,
          closeTo,
          contentFrom: openTo,
          contentTo: closeFrom,
          index,
        });
      }
    }
    offset += child.size;
  }
  return ranges;
}

/** Class on the note's content while it is drawn as a note. */
export const SIDENOTE_CLASS = 'noto-sidenote';
/** Class on the superscript marker widget. */
export const SIDENOTE_MARKER_CLASS = 'noto-sidenote-num';

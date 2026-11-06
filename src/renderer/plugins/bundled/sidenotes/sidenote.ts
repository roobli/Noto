/**
 * Tufte-style margin notes written as `<span class="sidenote">…</span>`.
 *
 * The author's Typora `sidenote` plugin recognises that spelling (and the
 * older `marginnote` class) and turns it into a numbered note in the gutter.
 * The file keeps every tag byte for byte; only the drawing changes. Pure, so
 * the ranges and the insertion text are tested without a document.
 *
 * A note can also name the words it is about. They sit in a
 * `<span class="sidenote-target">` written directly before the note:
 *
 *     <span class="sidenote-target">the words</span><span class="sidenote">the note</span>
 *
 * Typora's plugin and theme draw the note as before and show the target as
 * plain text, and a reader without either sees the words followed by the
 * note, so the file means the same thing everywhere. Noto marks the words and
 * ties them to their note.
 */

export const SIDENOTE_TAG_OPEN = '<span class="sidenote">';
export const SIDENOTE_TARGET_OPEN = '<span class="sidenote-target">';
export const SIDENOTE_TAG_CLOSE = '</span>';

/** Opening tag the author's plugin accepts: `sidenote` or `marginnote`. */
const OPEN_TAG = /^<span\b[^>]*\bclass\s*=\s*["'](?:side|margin)note["'][^>]*>$/i;
const TARGET_TAG = /^<span\b[^>]*\bclass\s*=\s*["']sidenote-target["'][^>]*>$/i;
const CLOSE_TAG = /^<\/span>$/i;

export function isSidenoteOpen(value: string): boolean {
  return OPEN_TAG.test(value.trim());
}

export function isSidenoteTargetOpen(value: string): boolean {
  return TARGET_TAG.test(value.trim());
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
  return `${SIDENOTE_TAG_OPEN}${normalizeSidenoteBody(selectedText)}${SIDENOTE_TAG_CLOSE}`;
}

/**
 * A note's text as it is written into the file: one line, single spaces.
 * A sidenote is an inline note, not a second paragraph hanging off the first.
 */
export function normalizeSidenoteBody(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .trim();
}

/** The words a note is about, located by the positions of their tags. */
export interface SidenoteTargetRange {
  readonly openFrom: number;
  readonly openTo: number;
  readonly closeFrom: number;
  readonly closeTo: number;
  readonly contentFrom: number;
  readonly contentTo: number;
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
  /** The words it is about, when a target span closes right before it. */
  readonly target: SidenoteTargetRange | null;
}

/** A child of a textblock, reduced to what pairing needs. */
export interface SidenoteChild {
  readonly type: string;
  readonly value?: string;
  readonly size: number;
}

/**
 * Pair every sidenote and target open with the next `</span>` that has not
 * already closed one, walking the block's children left to right. A target
 * whose close is the child right before a note's open is that note's target.
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
  type Open =
    | { readonly kind: 'note'; readonly from: number; readonly target: SidenoteTargetRange | null }
    | { readonly kind: 'target'; readonly from: number };
  const pending: Open[] = [];
  const ranges: SidenoteRange[] = [];
  let index = indexStart;
  let offset = 0;
  // A target just closed, and the child index it closed at.
  let closedTarget: { readonly range: SidenoteTargetRange; readonly at: number } | null = null;

  children.forEach((child, at) => {
    const here = blockContentStart + offset;
    offset += child.size;
    if (child.type !== 'inline_html') return;
    const value = child.value ?? '';
    if (isSidenoteTargetOpen(value)) {
      pending.push({ kind: 'target', from: here });
    } else if (isSidenoteOpen(value)) {
      const target = closedTarget !== null && closedTarget.at === at - 1 ? closedTarget.range : null;
      pending.push({ kind: 'note', from: here, target });
    } else if (isSidenoteClose(value) && pending.length > 0) {
      const open = pending.pop()!;
      const span = {
        openFrom: open.from,
        openTo: open.from + 1,
        closeFrom: here,
        closeTo: here + child.size,
        contentFrom: open.from + 1,
        contentTo: here,
      };
      if (open.kind === 'target') {
        closedTarget = { range: span, at };
        return;
      }
      index += 1;
      ranges.push({ ...span, index, target: open.target });
    }
  });
  return ranges;
}

/** Class on the note's content while it is drawn as a note. */
export const SIDENOTE_CLASS = 'noto-sidenote';
/** Class on the superscript marker widget. */
export const SIDENOTE_MARKER_CLASS = 'noto-sidenote-num';

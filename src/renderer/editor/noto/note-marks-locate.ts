/**
 * Where a mark on the note in front falls in the document as it stands.
 *
 * A plugin names the words it marks as the saved file has them, with the
 * words around them on their line: the note may have been edited since, so
 * an offset into the file would point at the wrong place. The words are
 * looked for in running text only (not in code, math, frontmatter, raw HTML,
 * headings, links or wiki links, which hold text that is not prose naming
 * anything) and only as whole words, so "AI" is never found inside
 * "AIRPORT". Where they occur more than once, the place whose neighbours
 * agree with what the plugin saw is taken, and none is taken when none
 * agrees: the plugin's view of the note may be older than the note, and a
 * guess would put an edit in the wrong place. Words that are no longer in the
 * note are not marked at all.
 */

import type { Node as ProseNode } from 'prosemirror-model';

export interface NoteMarkSpot {
  readonly key: string;
  /** The words marked, as written. */
  readonly text: string;
  /** What comes before them on their line, perhaps shortened at its start with `…`. */
  readonly before: string;
  /** What comes after them on their line, perhaps shortened at its end with `…`. */
  readonly after: string;
}

export interface LocatedMark {
  readonly key: string;
  readonly from: number;
  readonly to: number;
}

/** Stands for what is not running text, so no match crosses or includes it. */
const WALL = '\u0000';

/** How much of the neighbours, on each side, must agree when the words occur more than once. */
const AGREE = 4;

interface Run {
  /** The block's running text, with walls where something else is. */
  readonly text: string;
  /** The document position of each character of `text`. */
  readonly at: readonly number[];
}

function runs(doc: ProseNode): Run[] {
  const out: Run[] = [];
  doc.descendants((node, pos) => {
    // Code, math, frontmatter and raw HTML hold their text as written; a heading names its own note.
    if (node.type.spec.code || node.type.name === 'heading' || node.type.name === 'link_definition') return false;
    if (!node.isTextblock) return true;
    let text = '';
    const at: number[] = [];
    node.forEach((child, offset) => {
      const start = pos + 1 + offset;
      if (child.isText && !child.marks.some((mark) => mark.type.name === 'inline_code' || mark.type.name === 'link')) {
        const value = child.text ?? '';
        for (let index = 0; index < value.length; index += 1) at.push(start + index);
        text += value;
      } else {
        at.push(start);
        text += WALL;
      }
    });
    // A wiki link is plain text the editor dresses up, and a bare URL is an address: neither is prose.
    text = text.replace(/!?\[\[[^\]\n]*\]\]|https?:\/\/\S+/g, (part) => WALL.repeat(part.length));
    out.push({ text, at });
    return false;
  });
  return out;
}

/** How many characters two strings share, from their ends (`fromEnd`) or their starts. */
function shared(left: string, right: string, fromEnd: boolean): number {
  let count = 0;
  const max = Math.min(left.length, right.length);
  while (count < max) {
    const a = fromEnd ? left[left.length - 1 - count] : left[count];
    const b = fromEnd ? right[right.length - 1 - count] : right[count];
    if (a !== b) break;
    count += 1;
  }
  return count;
}

const wordChar = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch) && !/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(ch);

/** Whether the words at `index` stand alone: not the middle of a longer word, where words are spaced. */
function whole(text: string, index: number, length: number): boolean {
  const first = text[index];
  const last = text[index + length - 1];
  return !(wordChar(first) && wordChar(text[index - 1])) && !(wordChar(last) && wordChar(text[index + length]));
}

interface Candidate { readonly from: number; readonly to: number; readonly score: number }

/**
 * The place of each mark, at most one each, in document order. Two marks
 * never overlap: a later one takes its next best place, or none.
 */
export function locateMarks(doc: ProseNode, marks: readonly NoteMarkSpot[]): LocatedMark[] {
  const blocks = runs(doc);
  const found: LocatedMark[] = [];
  for (const mark of marks) {
    if (mark.text === '' || mark.text.includes(WALL)) continue;
    const before = mark.before.replace(/^…/, '');
    const after = mark.after.replace(/…$/, '');
    const candidates: Candidate[] = [];
    for (const block of blocks) {
      for (let index = block.text.indexOf(mark.text); index >= 0; index = block.text.indexOf(mark.text, index + 1)) {
        if (!whole(block.text, index, mark.text.length)) continue;
        const score = shared(block.text.slice(0, index), before, true) + shared(block.text.slice(index + mark.text.length), after, false);
        candidates.push({ from: block.at[index]!, to: block.at[index + mark.text.length - 1]! + 1, score });
      }
    }
    // Alone in the note, the words are the place; among several, only neighbours that agree say which.
    const needed = candidates.length === 1 ? 0 : Math.min(before.length, AGREE) + Math.min(after.length, AGREE);
    const place = candidates.filter((candidate) => candidate.score >= needed)
      .sort((left, right) => right.score - left.score || left.from - right.from)
      .find((candidate) => !found.some((other) => candidate.from < other.to && other.from < candidate.to));
    if (place) found.push({ key: mark.key, from: place.from, to: place.to });
  }
  return found.sort((left, right) => left.from - right.from);
}

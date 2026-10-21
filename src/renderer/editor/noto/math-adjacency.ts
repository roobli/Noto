/**
 * Two inline formulas never touch.
 *
 * `$x$` followed directly by `$y$` has no Markdown spelling: written out it is
 * `$x$$y$`, which every reader parses as one formula holding `x$$y`. A file
 * can never contain two touching formulas, so the state only arises from
 * editing: typing a second formula after the first, a paste, deleting the text
 * between them, or joining two blocks.
 *
 * The editor therefore resolves it the moment it happens, by merging the two
 * into one formula, `left + ' ' + right`. TeX ignores spaces in maths, so the
 * merged formula typesets exactly as the two did side by side, and the space
 * keeps a command from running into the next token (`\alpha` and `b` must not
 * become `\alphab`). The serializer stays pure: it is never asked to write the
 * impossible state.
 *
 * One exception. A left formula ending in an odd number of backslashes would
 * turn the joining space into a TeX control space (`\ `), which changes what
 * is drawn. Those two stay apart, with one plain space between them in the
 * text, which also has a Markdown spelling.
 *
 * Runs as an appended transaction, so the fix lands in the same history event
 * as the edit that caused it: one undo takes both away.
 */

import type { Node as ProseNode } from 'prosemirror-model';
import { Mark } from 'prosemirror-model';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';

export const mathAdjacencyKey = new PluginKey('noto-math-adjacency');

/** A changed region of the final document, as `[from, to]`. */
type Range = readonly [number, number];

/** True when `latex` ends in an odd run of backslashes. */
export function endsInOddBackslashes(latex: string): boolean {
  let count = 0;
  for (let index = latex.length - 1; index >= 0 && latex.charCodeAt(index) === 0x5c; index -= 1) count += 1;
  return count % 2 === 1;
}

/**
 * The regions of the final document the transactions touched.
 *
 * Each step's changed range is mapped through every later step, so the result
 * is in the coordinates of the last document. Positions are widened by one so
 * a pure deletion, which leaves an empty range at the seam, still reaches the
 * textblock holding it.
 */
function changedRanges(transactions: readonly Transaction[]): Range[] {
  const ranges: Range[] = [];
  const maps = transactions.flatMap((tr) => tr.mapping.maps);
  maps.forEach((map, index) => {
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      let from = newStart;
      let to = newEnd;
      for (let later = index + 1; later < maps.length; later += 1) {
        from = maps[later]!.map(from, -1);
        to = maps[later]!.map(to, 1);
      }
      ranges.push([from, to]);
    });
  });
  return ranges;
}

interface Seam {
  /** Position between the two formulas, in the document being fixed. */
  readonly at: number;
  readonly left: ProseNode;
  readonly right: ProseNode;
}

/** Touching inline formulas inside one textblock, with matching marks. */
function seamsIn(block: ProseNode, contentStart: number, out: Seam[]): void {
  let previous: ProseNode | null = null;
  block.forEach((child, offset) => {
    if (
      previous
      && previous.type.name === 'math_inline'
      && child.type.name === 'math_inline'
      // Different marks put a delimiter between them when written out
      // (`**$x$**$y$`), so only formulas under the same marks collide.
      && Mark.sameSet(previous.marks, child.marks)
    ) {
      out.push({ at: contentStart + offset, left: previous, right: child });
    }
    previous = child;
  });
}

/**
 * The transaction that resolves every pair of touching inline formulas in
 * `ranges` (the whole document when omitted), or null when there are none.
 */
export function fixAdjacentInlineMath(state: EditorState, ranges?: readonly Range[]): Transaction | null {
  const { doc } = state;
  const seams: Seam[] = [];
  const seen = new Set<number>();
  const visit = (from: number, to: number) => {
    doc.nodesBetween(from, to, (node, position) => {
      if (!node.isTextblock) return true;
      if (!seen.has(position)) {
        seen.add(position);
        seamsIn(node, position + 1, seams);
      }
      return false;
    });
  };
  if (ranges) {
    for (const [from, to] of ranges) visit(Math.max(0, from - 1), Math.min(doc.content.size, to + 1));
  } else {
    visit(0, doc.content.size);
  }
  if (seams.length === 0) return null;

  // Right to left, so a fix never moves a seam still waiting to be fixed, and
  // a chain `$a$$b$$c$` folds into one formula.
  seams.sort((a, b) => b.at - a.at);
  const tr = state.tr;
  const { selection } = state;
  const caretAtSeam = selection.empty ? seams.find((seam) => seam.at === selection.head) : undefined;
  let caretTarget: number | null = null;

  for (const seam of seams) {
    const { at, left, right } = seam;
    if (endsInOddBackslashes(left.textContent)) {
      tr.insert(at, state.schema.text(' ', left.marks));
      continue;
    }
    // From the end of the left formula's text to the start of the right's:
    // replacing that span joins the two nodes, and the replacement is the
    // joining space. Positions inside either formula map to the same
    // character afterwards, so a caret inside one stays where it was.
    const join = left.content.size === 0 || right.content.size === 0 ? null : state.schema.text(' ');
    if (join) tr.replaceWith(at - 1, at + 1, join);
    else tr.delete(at - 1, at + 1);
    if (seam === caretAtSeam) caretTarget = at + right.nodeSize;
  }

  // A caret sitting between the two formulas has nowhere to stay once they are
  // one, so it goes after the merged formula, where typing would have gone.
  if (caretTarget !== null) {
    const end = tr.mapping.map(caretTarget, -1);
    tr.setSelection(TextSelection.create(tr.doc, end));
  }
  return tr.docChanged ? tr : null;
}

export function mathAdjacencyPlugin(): Plugin {
  return new Plugin({
    key: mathAdjacencyKey,
    appendTransaction(transactions, _oldState, newState) {
      if (!transactions.some((tr) => tr.docChanged)) return null;
      const tr = fixAdjacentInlineMath(newState, changedRanges(transactions));
      return tr ? tr.setMeta(mathAdjacencyKey, true) : null;
    },
  });
}

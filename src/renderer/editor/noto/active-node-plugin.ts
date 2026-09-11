/**
 * What reveals its markup, and when.
 *
 * Three scopes, because markdown has three kinds of syntax and they do not
 * behave the same way.
 *
 * Top-level block syntax belongs to the top-level block: a heading's level
 * badge, a fence's language, the frontmatter's fold. There is nothing smaller
 * to reveal, so the block that holds the selection carries `.noto-active-block`
 * and the stylesheet does the rest — and only while the editor itself has
 * focus, so opening a file does not flash syntax for a block nobody is editing.
 *
 * Textblock-scoped source belongs to the caret's own textblock (a paragraph
 * inside a list item, a heading, a quote line). Wiki-link brackets and the
 * muted `target|` path are ordinary characters in the file; they stay hidden
 * until that textblock is the one being edited, which is the Typora rule for
 * "source symbols of the focused block" without lighting up every sibling item
 * in a long list of `[[links]]`.
 *
 * Inline mark syntax belongs to the span. The top-level block class used to
 * drive descendant rules, so putting the caret anywhere in a paragraph revealed
 * the delimiters of every emphasis, every code span and every link in it at
 * once: a list item mentioning eleven directory names turned into eleven pairs
 * of visible backticks because the caret was somewhere in the sentence. Typora
 * reveals the one span you are actually in and leaves the rest of the sentence
 * set as prose. So those delimiters are widgets on the innermost mark range
 * containing the caret, and nothing else in the paragraph changes. Widgets
 * rather than generated content because a widget can be placed at an exact
 * position rather than at the edge of an element, and because it is a
 * decoration either way and so can never reach the saved file.
 */

import { Plugin, PluginKey, type EditorState } from 'prosemirror-state';
import type { Mark, Node as ProseNode } from 'prosemirror-model';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { INLINE_DELIMITERS } from '../../../shared/markdown/v3/syntax';

export const activeNodeKey = new PluginKey<DecorationSet>('noto-active-node');

/**
 * The delimiters each mark is written with.
 *
 * Taken from the serializer rather than written out again, so what is revealed
 * is what a save would write. Copying them was how the reveal came to show an
 * underscore for emphasis months after the serializer had moved to a star.
 */
export const DELIMITERS: Record<string, { open: string; close: (mark: Mark) => string }> = {
  emphasis: { open: INLINE_DELIMITERS.emphasis, close: () => INLINE_DELIMITERS.emphasis },
  strong: { open: INLINE_DELIMITERS.strong, close: () => INLINE_DELIMITERS.strong },
  strikethrough: { open: INLINE_DELIMITERS.strikethrough, close: () => INLINE_DELIMITERS.strikethrough },
  inline_code: { open: INLINE_DELIMITERS.inline_code, close: () => INLINE_DELIMITERS.inline_code },
  // A link's closing delimiter carries its destination, which is the part a
  // reader cannot otherwise see and the part they came to edit.
  link: { open: '[', close: (mark) => `](${String(mark.attrs.href ?? '')})` },
};

export interface MarkRange {
  readonly from: number;
  readonly to: number;
  readonly mark: Mark;
}

const markKey = (mark: Mark): string => `${mark.type.name}:${JSON.stringify(mark.attrs)}`;

/**
 * Every mark range in the caret's own text block that contains the caret.
 *
 * Scoped to one block on purpose: this runs on every selection change, and
 * walking the document to find mark boundaries would put the length of the file
 * into the cost of moving the caret.
 */
export function containingMarkRanges(state: EditorState, position: number): MarkRange[] {
  const $position = state.doc.resolve(position);
  const parent = $position.parent;
  if (!parent.isTextblock) return [];

  const ranges: MarkRange[] = [];
  const open = new Map<string, { from: number; mark: Mark }>();
  let offset = $position.start();

  parent.forEach((child) => {
    const childFrom = offset;
    for (const [key, entry] of [...open]) {
      if (!child.marks.some((mark) => markKey(mark) === key)) {
        ranges.push({ from: entry.from, to: childFrom, mark: entry.mark });
        open.delete(key);
      }
    }
    for (const mark of child.marks) {
      const key = markKey(mark);
      if (!open.has(key)) open.set(key, { from: childFrom, mark });
    }
    offset = childFrom + child.nodeSize;
  });

  for (const entry of open.values()) ranges.push({ from: entry.from, to: offset, mark: entry.mark });
  return ranges.filter((range) => position >= range.from && position <= range.to);
}

/**
 * The delimiter itself, which is never part of the document.
 *
 * `contentEditable = 'false'` matters more than it looks. The widget lives
 * inside the editable area, so without it the caret can be placed between the
 * two backticks of a revealed code span and typed characters land in the
 * decoration, where they are neither in the document nor recoverable: the text
 * simply disappears on the next redraw. It is also hidden from assistive
 * technology, because the delimiter is a drawing of syntax rather than content
 * anyone needs read to them.
 */
function delimiter(text: string): HTMLElement {
  const element = document.createElement('span');
  element.className = 'noto-syntax';
  element.textContent = text;
  element.spellcheck = false;
  element.contentEditable = 'false';
  element.setAttribute('aria-hidden', 'true');
  return element;
}

/**
 * A link whose text is its own address, written without any delimiters.
 *
 * The file holds the URL and nothing else, so revealing `[url](url)` around it
 * would show the reader syntax their file does not contain and offer them an
 * edit that would change it into a different construct.
 */
function isBareLink(state: EditorState, range: MarkRange): boolean {
  if (range.mark.type.name !== 'link') return false;
  const href = String(range.mark.attrs.href ?? '');
  return href !== '' && state.doc.textBetween(range.from, range.to) === href;
}

/** The smallest range, so emphasis inside strong reveals the emphasis alone. */
export function innermostRange(ranges: readonly MarkRange[]): MarkRange | null {
  return ranges.reduce<MarkRange | null>(
    (best, range) => (best === null || range.to - range.from < best.to - best.from ? range : best),
    null,
  );
}

function holdsInlineHtml(textblock: ProseNode): boolean {
  let found = false;
  textblock.forEach((child) => { if (child.type.name === 'inline_html') found = true; });
  return found;
}

function activeDecorations(state: EditorState): DecorationSet {
  const { from, to, empty } = state.selection;
  const decorations: Decoration[] = [];

  // Only the blocks the selection actually touches are visited. Scanning every
  // top level child instead would make each keystroke cost a walk of the whole
  // document, which is precisely the cost a long document cannot afford.
  state.doc.nodesBetween(from, to, (node, position, parent) => {
    if (parent !== state.doc) return false;
    decorations.push(Decoration.node(position, position + node.nodeSize, {
      class: 'noto-active-block',
    }));
    return false;
  });

  /*
   * Deeper than the top-level active block.
   *
   * Raw HTML that is shown as a picture shows its source while the caret is
   * in it, at whatever depth it sits. The top-level class above cannot say
   * that: an image tag inside a list item would show its source whenever the
   * caret was anywhere in the list.
   *
   * Every textblock holding the caret also gets `.noto-source-editing`, so
   * wiki-link brackets (and similar in-file source) can reveal for that
   * paragraph alone rather than for every sibling in a list. Inline HTML
   * keeps `.noto-inline-editing` on top of that when the textblock holds any.
   */
  const marked = new Set<number>();
  for (const $pos of [state.selection.$from, state.selection.$to]) {
    for (let depth = $pos.depth; depth >= 1; depth -= 1) {
      const node = $pos.node(depth);
      const start = $pos.before(depth);
      if (marked.has(start)) continue;
      if (node.type.name === 'html_block') {
        marked.add(start);
        decorations.push(Decoration.node(start, $pos.after(depth), { class: 'noto-html-editing' }));
      } else if (node.isTextblock) {
        marked.add(start);
        const classes = holdsInlineHtml(node)
          ? 'noto-source-editing noto-inline-editing'
          : 'noto-source-editing';
        decorations.push(Decoration.node(start, $pos.after(depth), { class: classes }));
      }
    }
  }

  /*
   * Only for a collapsed selection.
   *
   * With a range selected the reader is operating on the text rather than
   * editing inside one span, and inserting delimiters into a highlighted run
   * shifts the very thing they are looking at.
   */
  if (empty) {
    const ranges = containingMarkRanges(state, from)
      .filter((range) => DELIMITERS[range.mark.type.name] !== undefined);
    // The innermost: the smallest range wins, so emphasis inside strong reveals
    // the emphasis and leaves the strong alone.
    const innermost = innermostRange(ranges);
    if (innermost && !isBareLink(state, innermost)) {
      const spec = DELIMITERS[innermost.mark.type.name];
      decorations.push(
        // `ignoreSelection` keeps the caret out of the widget entirely, so
        // arrow keys step over a delimiter rather than into it.
        Decoration.widget(innermost.from, () => delimiter(spec.open),
          { side: -1, marks: [], ignoreSelection: true }),
        Decoration.widget(innermost.to, () => delimiter(spec.close(innermost.mark)),
          { side: 1, marks: [], ignoreSelection: true }),
      );
    }
  }

  return DecorationSet.create(state.doc, decorations);
}

export function activeNodePlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: activeNodeKey,
    state: {
      init: (_config, state) => activeDecorations(state),
      apply: (transaction, previous, _oldState, newState) =>
        (transaction.docChanged || transaction.selectionSet ? activeDecorations(newState) : previous),
    },
    props: {
      decorations: (state) => activeNodeKey.getState(state),
    },
  });
}

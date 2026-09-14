/**
 * `[[wiki links]]`, rendered without touching the document.
 *
 * A decoration, not a schema node. A node would mean teaching the parser to
 * recognise `[[x]]`, the serializer to write it back, and the byte-fidelity
 * layer to agree that the round trip is exact. That is three chances to rewrite
 * somebody's file over a piece of syntax that is, to markdown, ordinary text.
 * A decoration cannot reach the saved bytes at all, which is the right risk for
 * a display convenience.
 *
 * It also means wiki links work everywhere immediately, including inside blocks
 * the schema models as opaque source, because the decoration only needs the
 * text to be text.
 */

import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import type { Node as ProseNode, ResolvedPos } from 'prosemirror-model';
import { Decoration, DecorationSet } from 'prosemirror-view';

export const wikiLinkKey = new PluginKey<DecorationSet>('noto-wiki-links');

/**
 * `[[target]]` or `[[target|label]]`.
 *
 * No newline inside, because a link that spans a paragraph break is a pair of
 * brackets that happen to line up rather than a link anybody wrote. No nested
 * `[` either, so `[[a] [b]]` does not become one long false positive.
 */
const WIKI_LINK = /\[\[([^[\]\n|]+)(?:\|([^[\]\n]*))?\]\]/g;


/**
 * RTFS-style array text such as `[[100, 101, ...]]` — digits and commas only,
 * not a note path. A bare `[[100]]` still counts; a real title can be a number.
 */
export function isCommaSeparatedIntegerList(target: string): boolean {
  return /^\d+(?:\s*,\s*\d+)+$/.test(target);
}

export interface WikiLinkMatch {
  readonly from: number;
  readonly to: number;
  readonly target: string;
  readonly label: string;
  /** Visible link text: the label, or the whole target when there is no pipe. */
  readonly linkFrom: number;
  readonly linkTo: number;
  /** `target|` muted like the brackets when a label is present; null otherwise. */
  readonly muteFrom: number | null;
  readonly muteTo: number | null;
}

/** Every wiki link in a run of text, offset by where that text starts. */
export function findWikiLinks(text: string, offset: number): WikiLinkMatch[] {
  const matches: WikiLinkMatch[] = [];
  WIKI_LINK.lastIndex = 0;
  for (;;) {
    const match = WIKI_LINK.exec(text);
    if (match === null) break;
    const rawTarget = match[1];
    const target = rawTarget.trim();
    if (target.length === 0) continue;
    if (isCommaSeparatedIntegerList(target)) continue;
    const from = offset + match.index;
    const to = from + match[0].length;
    const innerFrom = from + 2;
    const innerTo = to - 2;
    const rawLabel = match[2];
    if (rawLabel === undefined) {
      matches.push({
        from, to, target,
        label: target,
        linkFrom: innerFrom,
        linkTo: innerTo,
        muteFrom: null,
        muteTo: null,
      });
      continue;
    }
    const label = rawLabel.trim() || target;
    // Mute the path and the pipe; the label is what a reader should see.
    const muteTo = innerFrom + rawTarget.length + 1;
    matches.push({
      from, to, target, label,
      linkFrom: muteTo,
      linkTo: innerTo,
      muteFrom: innerFrom,
      muteTo,
    });
  }
  return matches;
}

/**
 * The link's decorations.
 *
 * Brackets (and, when present, `target|`) carry `.noto-wiki-bracket`. The
 * stylesheet hides those unless the caret's textblock has `.noto-source-editing`
 * *and* this match is the one under the caret (`.noto-wiki-source-active`).
 * Sibling wiki links in the same paragraph keep their labels only. The visible
 * name is the label — or the bare target when nobody wrote a pipe.
 */
function decorateLink(match: WikiLinkMatch, active: boolean): Decoration[] {
  const bracketClass = active
    ? 'noto-wiki-bracket noto-wiki-source-active'
    : 'noto-wiki-bracket';
  const openTo = match.from + 2;
  const closeFrom = match.to - 2;
  const decorations: Decoration[] = [
    Decoration.inline(match.from, openTo, { class: bracketClass }),
    Decoration.inline(closeFrom, match.to, { class: bracketClass }),
    Decoration.inline(match.linkFrom, match.linkTo, {
      class: 'noto-wiki-link',
      'data-wiki-target': match.target,
    }),
  ];
  if (match.muteFrom !== null && match.muteTo !== null && match.muteTo > match.muteFrom) {
    decorations.push(Decoration.inline(match.muteFrom, match.muteTo, {
      class: bracketClass,
    }));
  }
  return decorations;
}

function wikiDecorations(state: EditorState): DecorationSet {
  const decorations: Decoration[] = [];
  state.doc.descendants((node, position) => {
    if (!node.isText || node.text === undefined) return true;
    for (const match of findWikiLinks(node.text, position)) {
      decorations.push(...decorateLink(match, false));
    }
    return true;
  });
  return DecorationSet.create(state.doc, decorations);
}

/** Textblocks overlapping a range — whole blocks, so a partial edit rescans cleanly. */
function textblocksIn(doc: ProseNode, from: number, to: number): Map<number, ProseNode> {
  const blocks = new Map<number, ProseNode>();
  const size = doc.content.size;
  const $from = doc.resolve(Math.max(0, Math.min(from, size)));
  const $to = doc.resolve(Math.max(0, Math.min(to, size)));
  const start = $from.parent.isTextblock ? $from.before() : $from.pos;
  const end = $to.parent.isTextblock ? $to.after() : $to.pos;
  doc.nodesBetween(start, end, (node, position) => {
    if (node.isTextblock) {
      if (!node.type.spec.code) blocks.set(position, node);
      return false;
    }
    return true;
  });
  return blocks;
}

/** Wiki matches inside one textblock (no document-wide walk). */
export function wikiMatchesInBlock(block: ProseNode, position: number): WikiLinkMatch[] {
  const matches: WikiLinkMatch[] = [];
  const contentStart = position + 1;
  block.forEach((child, offset) => {
    if (!child.isText || child.text === undefined) return;
    matches.push(...findWikiLinks(child.text, contentStart + offset));
  });
  return matches;
}

/** Caret inside `[from, to)` of the match — after `]]` is outside. */
export function wikiMatchAt(caret: number, matches: readonly WikiLinkMatch[]): WikiLinkMatch | null {
  for (const match of matches) {
    if (caret >= match.from && caret < match.to) return match;
  }
  return null;
}

function textblockAt($pos: ResolvedPos): { pos: number; node: ProseNode } | null {
  for (let depth = $pos.depth; depth >= 1; depth -= 1) {
    const node = $pos.node(depth);
    if (node.isTextblock && !node.type.spec.code) {
      return { pos: $pos.before(depth), node };
    }
  }
  return null;
}

function blockWikiDecorations(
  block: ProseNode,
  position: number,
  active: WikiLinkMatch | null,
): Decoration[] {
  const decorations: Decoration[] = [];
  for (const match of wikiMatchesInBlock(block, position)) {
    const isActive = active !== null && match.from === active.from && match.to === active.to;
    decorations.push(...decorateLink(match, isActive));
  }
  return decorations;
}

function replaceBlockWikiDecorations(
  set: DecorationSet,
  doc: ProseNode,
  blockPos: number,
  block: ProseNode,
  active: WikiLinkMatch | null,
): DecorationSet {
  let next = set;
  const from = blockPos + 1;
  const to = blockPos + block.nodeSize - 1;
  const stale = next.find(from, to);
  if (stale.length > 0) next = next.remove(stale);
  const fresh = blockWikiDecorations(block, blockPos, active);
  if (fresh.length > 0) next = next.add(doc, fresh);
  return next;
}

/**
 * Span-level source reveal: only the wiki match under a collapsed caret gets
 * `.noto-wiki-source-active`. Refreshes the previous and current caret
 * textblocks only — never a full `descendants` walk.
 */
function applyWikiSourceActive(
  set: DecorationSet,
  oldState: EditorState,
  newState: EditorState,
  mapping: Transaction['mapping'] | null,
): DecorationSet {
  let next = set;
  const touched = new Map<number, ProseNode>();

  const oldBlock = textblockAt(oldState.selection.$head);
  if (oldBlock) {
    const mapped = mapping ? mapping.map(oldBlock.pos) : oldBlock.pos;
    const node = newState.doc.nodeAt(mapped);
    if (node?.isTextblock && !node.type.spec.code) touched.set(mapped, node);
  }

  const newBlock = textblockAt(newState.selection.$head);
  if (newBlock) touched.set(newBlock.pos, newBlock.node);

  const caret = newState.selection.empty ? newState.selection.head : null;
  const activePos = newBlock?.pos ?? -1;

  for (const [pos, node] of touched) {
    let active: WikiLinkMatch | null = null;
    if (caret !== null && pos === activePos) {
      active = wikiMatchAt(caret, wikiMatchesInBlock(node, pos));
    }
    next = replaceBlockWikiDecorations(next, newState.doc, pos, node, active);
  }
  return next;
}

function applyWiki(
  transaction: Transaction,
  previous: DecorationSet,
  state: EditorState,
): DecorationSet {
  if (!transaction.docChanged) return previous;
  let next = previous.map(transaction.mapping, transaction.doc);
  const blocks = new Map<number, ProseNode>();
  transaction.mapping.maps.forEach((map, index) => {
    const rest = transaction.mapping.slice(index + 1);
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      for (const [position, block] of textblocksIn(
        state.doc,
        rest.map(newStart, -1),
        rest.map(newEnd, 1),
      )) {
        blocks.set(position, block);
      }
    });
  });
  for (const [position, block] of blocks) {
    const stale = next.find(position + 1, position + block.nodeSize - 1);
    if (stale.length > 0) next = next.remove(stale);
    const fresh = blockWikiDecorations(block, position, null);
    if (fresh.length > 0) next = next.add(state.doc, fresh);
  }
  return next;
}

export interface WikiLinkOptions {
  /** Asked to open a link's target. The shell decides how to resolve it. */
  readonly onFollow: (target: string) => void;
}

export function wikiLinkPlugin(options: WikiLinkOptions): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: wikiLinkKey,
    state: {
      init: (_config, state) => {
        // Full scan once at load (inactive). Then mark the caret match if any.
        const base = wikiDecorations(state);
        return applyWikiSourceActive(base, state, state, null);
      },
      // Doc edits: map + rescan only the textblocks the edit touched.
      // Selection moves: refresh only previous/current caret textblocks for
      // `.noto-wiki-source-active` — never a full descendants walk.
      apply: (transaction, previous, oldState, newState) => {
        let next = previous;
        if (transaction.docChanged) {
          next = applyWiki(transaction, previous, newState);
        }
        if (transaction.docChanged || transaction.selectionSet) {
          next = applyWikiSourceActive(
            next,
            oldState,
            newState,
            transaction.docChanged ? transaction.mapping : null,
          );
        }
        return next;
      },
    },
    props: {
      decorations: (state) => wikiLinkKey.getState(state),
      handleClick: (_view, _position, event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return false;
        const link = target.closest<HTMLElement>('[data-wiki-target]');
        // A plain click still places the caret, because the text is editable
        // text. Following takes the same modifier a link takes everywhere else.
        if (!link || !(event.metaKey || event.ctrlKey)) return false;
        const value = link.dataset.wikiTarget;
        if (!value) return false;
        options.onFollow(value);
        return true;
      },
    },
  });
}

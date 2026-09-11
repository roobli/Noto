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

import { Plugin, PluginKey, type EditorState } from 'prosemirror-state';
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
 * Brackets (and, when present, `target|`) carry `.noto-wiki-bracket` so the
 * stylesheet can hide them outside the caret's textblock and show them dimmed
 * while that block is being edited. The visible name is the label — or the
 * bare target when nobody wrote a pipe — styled as a link either way.
 */
function decorateLink(match: WikiLinkMatch): Decoration[] {
  const openTo = match.from + 2;
  const closeFrom = match.to - 2;
  const decorations: Decoration[] = [
    Decoration.inline(match.from, openTo, { class: 'noto-wiki-bracket' }),
    Decoration.inline(closeFrom, match.to, { class: 'noto-wiki-bracket' }),
    Decoration.inline(match.linkFrom, match.linkTo, {
      class: 'noto-wiki-link',
      'data-wiki-target': match.target,
    }),
  ];
  if (match.muteFrom !== null && match.muteTo !== null && match.muteTo > match.muteFrom) {
    decorations.push(Decoration.inline(match.muteFrom, match.muteTo, {
      class: 'noto-wiki-bracket',
    }));
  }
  return decorations;
}

function wikiDecorations(state: EditorState): DecorationSet {
  const decorations: Decoration[] = [];
  state.doc.descendants((node, position) => {
    if (!node.isText || node.text === undefined) return true;
    for (const match of findWikiLinks(node.text, position)) {
      decorations.push(...decorateLink(match));
    }
    return true;
  });
  return DecorationSet.create(state.doc, decorations);
}

export interface WikiLinkOptions {
  /** Asked to open a link's target. The shell decides how to resolve it. */
  readonly onFollow: (target: string) => void;
}

export function wikiLinkPlugin(options: WikiLinkOptions): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: wikiLinkKey,
    state: {
      init: (_config, state) => wikiDecorations(state),
      // Only on a document change: a link's position moves when text does, and
      // moving the caret cannot change where a link is.
      apply: (transaction, previous, _oldState, newState) =>
        (transaction.docChanged ? wikiDecorations(newState) : previous),
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

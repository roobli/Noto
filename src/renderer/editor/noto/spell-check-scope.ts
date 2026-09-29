/**
 * Where the browser checks spelling in a long note.
 *
 * Chromium checks spelling in two ways. As you type it checks the words around
 * the caret, which costs next to nothing. When typing pauses it checks the
 * whole editable element in one idle task
 * (`ColdModeSpellCheckRequester::RequestFullChecking`), and that cost grows far
 * faster than the note: about 0.65 s for the 2 MB benchmark document and 37 s
 * for the 8 MB one, run twice after each pause, with the window frozen
 * throughout. Traced in the development build on Linux, and seen as a window
 * that ignored clicks in the packaged benchmark on macOS; see
 * `docs/performance/measurements.md`.
 *
 * The whole-element check only runs when the editable root itself has spelling
 * enabled. So in a long note, the same length that turns viewport stubbing on,
 * the root says `spellcheck="false"` and the top-level blocks around the
 * selection say `"true"`: what you are writing is still checked as you write
 * it, and nothing checks eight megabytes in one go. Short notes keep the plain
 * behaviour, the whole note checked.
 */

import { Plugin, PluginKey, type EditorState } from 'prosemirror-state';
import type { Node as ProseNode } from 'prosemirror-model';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { stubbingEnabled } from './viewport-stub';

export const spellCheckScopeKey = new PluginKey<DecorationSet>('noto-spell-check-scope');

/** Meta that asks the plugin to recompute, for a settings change. */
export const SPELL_CHECK_RESCAN = 'rescan';

/** Top-level blocks either side of the selection that keep spell checking. */
export const SPELL_CHECK_RADIUS = 2;

/** Whether a note is long enough that only the selection's blocks are checked. */
export function spellCheckIsScoped(doc: ProseNode): boolean {
  return stubbingEnabled(doc.childCount);
}

/** The editable root's `spellcheck` attribute for this state. */
export function rootSpellCheck(enabled: boolean, state: EditorState): string {
  return String(enabled && !spellCheckIsScoped(state.doc));
}

/**
 * Node decorations that re-enable spelling on the top-level blocks within
 * `SPELL_CHECK_RADIUS` of the selection. Walks only those blocks, so the cost
 * does not grow with the note.
 */
export function scopedSpellCheckDecorations(state: EditorState): DecorationSet {
  const { doc } = state;
  if (doc.childCount === 0) return DecorationSet.empty;
  const $from = state.selection.$from;
  // The top-level block holding the selection and where it starts. Inside a
  // block the resolved position already knows both. At depth 0 the selection
  // sits on the boundary before a block, or after the last one.
  let index = $from.index(0);
  let start: number;
  if ($from.depth >= 1) {
    start = $from.before(1);
  } else if (index < doc.childCount) {
    start = $from.pos;
  } else {
    index = doc.childCount - 1;
    start = doc.content.size - doc.child(index).nodeSize;
  }
  const decorations: Decoration[] = [];
  let at = start;
  for (let i = index; i >= 0 && i >= index - SPELL_CHECK_RADIUS; i -= 1) {
    if (i < index) at -= doc.child(i).nodeSize;
    decorations.push(Decoration.node(at, at + doc.child(i).nodeSize, { spellcheck: 'true' }));
  }
  at = start;
  for (let i = index + 1; i < doc.childCount && i <= index + SPELL_CHECK_RADIUS; i += 1) {
    at += doc.child(i - 1).nodeSize;
    decorations.push(Decoration.node(at, at + doc.child(i).nodeSize, { spellcheck: 'true' }));
  }
  return DecorationSet.create(doc, decorations);
}

function decorationsFor(state: EditorState, enabled: boolean): DecorationSet {
  if (!enabled || !spellCheckIsScoped(state.doc)) return DecorationSet.empty;
  return scopedSpellCheckDecorations(state);
}

/**
 * `enabled` is a getter so the setting can change while the editor is open;
 * dispatch `SPELL_CHECK_RESCAN` under `spellCheckScopeKey` after it does.
 */
export function spellCheckScopePlugin(enabled: () => boolean): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: spellCheckScopeKey,
    state: {
      init: (_config, state) => decorationsFor(state, enabled()),
      apply: (tr, previous, _oldState, state) => {
        if (!tr.docChanged && !tr.selectionSet && tr.getMeta(spellCheckScopeKey) !== SPELL_CHECK_RESCAN) {
          return previous;
        }
        return decorationsFor(state, enabled());
      },
    },
    props: {
      decorations: (state) => spellCheckScopeKey.getState(state),
    },
  });
}

/**
 * Draws the inline syntax the parser leaves as text: Typora's `==highlight==`,
 * `^superscript^` and `~subscript~`, and the handful of raw HTML tags a note
 * uses for what markdown has no spelling for, `<kbd>`, `<sub>`, `<sup>`,
 * `<u>` and `<br>`.
 *
 * Everything here is a decoration. The file keeps every delimiter and every
 * tag byte for byte; the editor hides them while the caret is elsewhere and
 * shows them again, muted, while the selection touches the block, which is
 * the same rule the other inline syntax follows.
 *
 * The scan is incremental. A transaction that changes text is answered by
 * rescanning only the text blocks its changed ranges touch, and a selection
 * change by rescanning the blocks the old and the new selection touch, so a
 * keystroke in a long document costs one paragraph, not the document.
 */

import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { AddMarkStep, RemoveMarkStep } from 'prosemirror-transform';
import type { Node as ProseNode } from 'prosemirror-model';
import { ALL_MARK_KINDS, typoraMarkRanges, type TyporaMarkKinds } from './typora-marks';

export const typoraMarksKey = new PluginKey<DecorationSet>('noto-typora-marks');

/** Asks the plugin to read the whole document again, whatever the transaction did. */
export const RESCAN = 'rescan';

/** Tags drawn as what they are; anything with attributes is left as source. */
const PAIRED_TAGS = new Set(['kbd', 'sub', 'sup', 'u', 'mark', 'b', 'strong', 'i', 'em', 's', 'del', 'ins', 'small']);
const OPEN_TAG = /^<([a-z]+)>$/;
const CLOSE_TAG = /^<\/([a-z]+)>$/;
const BREAK_TAG = /^<br\s*\/?>$/i;

/** A character that no mark can match, standing in for anything that is not plain text. */
const OPAQUE = '￼';

const MARK_CLASS = {
  highlight: 'noto-mark-highlight',
  superscript: 'noto-mark-sup',
  subscript: 'noto-mark-sub',
} as const;

interface TagNode {
  readonly tag: string;
  /** Position of the inline_html node. */
  readonly position: number;
}

/** The characters a mark of each kind cannot do without. */
export function markCharacters(kinds: TyporaMarkKinds): string {
  return (kinds.highlight ? '=' : '') + (kinds.superscript ? '^' : '') + (kinds.subscript ? '~' : '');
}

/**
 * Whether a block could draw anything at all.
 *
 * Nothing is drawn without an inline HTML node or, in plain text, one of the
 * characters a mark is spelled with. Most blocks of a long note have neither,
 * and answering that from the text nodes is far cheaper than assembling the
 * block's text and running the three expressions over it, which is what the
 * scan does for a block that might.
 */
export function mightDecorate(block: ProseNode, characters: string): boolean {
  let found = false;
  block.forEach((child) => {
    if (found) return;
    if (child.type.name === 'inline_html') {
      found = true;
    } else if (child.isText && characters.length > 0) {
      const text = child.text!;
      for (let index = 0; index < characters.length; index += 1) {
        if (text.includes(characters[index]!)) {
          found = true;
          return;
        }
      }
    }
  });
  return found;
}

function blockDecorations(
  block: ProseNode,
  position: number,
  editing: boolean,
  kinds: TyporaMarkKinds,
): Decoration[] {
  if (!mightDecorate(block, markCharacters(kinds))) return [];
  const contentStart = position + 1;
  const decorations: Decoration[] = [];
  let text = '';
  const opens = new Map<string, TagNode[]>();
  let plain = false;

  block.forEach((child, offset) => {
    if (child.isText && !child.marks.some((mark) => mark.type.spec.code === true)) {
      text += child.text;
      plain = true;
      return;
    }
    if (child.type.name === 'inline_html') {
      const value = (child.attrs.value as string).trim();
      const here = contentStart + offset;
      if (BREAK_TAG.test(value)) {
        decorations.push(Decoration.node(here, here + child.nodeSize, { class: 'noto-inline-tag noto-inline-break' }));
      } else {
        const open = OPEN_TAG.exec(value);
        const close = CLOSE_TAG.exec(value);
        if (open && PAIRED_TAGS.has(open[1])) {
          const stack = opens.get(open[1]) ?? [];
          stack.push({ tag: open[1], position: here });
          opens.set(open[1], stack);
        } else if (close && PAIRED_TAGS.has(close[1])) {
          const opener = opens.get(close[1])?.pop();
          if (opener) {
            decorations.push(Decoration.node(opener.position, opener.position + 1, { class: 'noto-inline-tag' }));
            decorations.push(Decoration.node(here, here + child.nodeSize, { class: 'noto-inline-tag' }));
            if (here > opener.position + 1) {
              decorations.push(Decoration.inline(opener.position + 1, here, { class: `noto-html-inline noto-html-${close[1]}` }));
            }
          }
        }
      }
    }
    text += OPAQUE.repeat(child.nodeSize);
  });

  if (plain) {
    for (const range of typoraMarkRanges(text, kinds)) {
      decorations.push(Decoration.inline(contentStart + range.from, contentStart + range.innerFrom, { class: 'noto-typora-delim' }));
      decorations.push(Decoration.inline(contentStart + range.innerFrom, contentStart + range.innerTo, { class: MARK_CLASS[range.kind] }));
      decorations.push(Decoration.inline(contentStart + range.innerTo, contentStart + range.to, { class: 'noto-typora-delim' }));
    }
  }

  if (decorations.length > 0 && editing) {
    decorations.push(Decoration.node(position, position + block.nodeSize, { class: 'noto-marks-editing' }));
  }
  return decorations;
}

function touches(state: EditorState, position: number, block: ProseNode): boolean {
  const { from, to } = state.selection;
  return from <= position + block.nodeSize && to >= position;
}

/** The text blocks any part of a range falls in, whole. */
function blocksIn(doc: ProseNode, from: number, to: number): Map<number, ProseNode> {
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

function scan(
  state: EditorState,
  set: DecorationSet,
  blocks: Map<number, ProseNode>,
  kinds: TyporaMarkKinds,
): DecorationSet {
  let next = set;
  for (const [position, block] of blocks) {
    // Strictly inside the block. `find` includes what ends at the block's
    // start, which is the previous block's own node decoration.
    const stale = next.find(position + 1, position + block.nodeSize - 1);
    if (stale.length > 0) next = next.remove(stale);
    const fresh = blockDecorations(block, position, touches(state, position, block), kinds);
    if (fresh.length > 0) next = next.add(state.doc, fresh);
  }
  return next;
}

function fullScan(state: EditorState, kinds: TyporaMarkKinds): DecorationSet {
  return scan(state, DecorationSet.empty, blocksIn(state.doc, 0, state.doc.content.size), kinds);
}

function apply(
  tr: Transaction,
  set: DecorationSet,
  oldState: EditorState,
  state: EditorState,
  kinds: TyporaMarkKinds,
): DecorationSet {
  if (!tr.docChanged && !tr.selectionSet) return set;
  const blocks = new Map<number, ProseNode>();
  const collect = (from: number, to: number) => {
    for (const [position, block] of blocksIn(state.doc, from, to)) blocks.set(position, block);
  };

  let next = set;
  if (tr.docChanged) {
    next = set.map(tr.mapping, tr.doc);
    tr.steps.forEach((step, index) => {
      const rest = tr.mapping.slice(index + 1);
      // A mark step replaces nothing, so its map is empty and says nothing;
      // its own range is where the text changed, and whether a run is code is
      // exactly what this plugin reads.
      if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
        collect(rest.map(step.from, -1), rest.map(step.to, 1));
        return;
      }
      tr.mapping.maps[index].forEach((_oldStart, _oldEnd, newStart, newEnd) => {
        collect(rest.map(newStart, -1), rest.map(newEnd, 1));
      });
    });
  }
  if (tr.selectionSet) {
    const before = oldState.selection;
    collect(tr.mapping.map(before.from, -1), tr.mapping.map(before.to, 1));
    collect(state.selection.from, state.selection.to);
  }
  return blocks.size > 0 ? scan(state, next, blocks, kinds) : next;
}

/**
 * `kinds` is read at each scan rather than captured, so turning one of the
 * three off in preferences shows at the next keystroke without the plugin
 * list being rebuilt, which would cost the reader their undo stack.
 */
export function typoraMarksPlugin(kinds: () => TyporaMarkKinds = () => ALL_MARK_KINDS): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: typoraMarksKey,
    state: {
      init: (_config, state) => fullScan(state, kinds()),
      apply: (tr, set, oldState, state) => (tr.getMeta(typoraMarksKey) === RESCAN
        // A switch in preferences changes what counts as a mark without
        // changing a character, so nothing in the transaction says where to
        // look and the whole document is read again. It happens once, when
        // the switch is pressed.
        ? fullScan(state, kinds())
        : apply(tr, set, oldState, state, kinds())),
    },
    props: {
      decorations(state) {
        return this.getState(state) ?? DecorationSet.empty;
      },
    },
  });
}

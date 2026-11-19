/**
 * Ticking a task by pressing its box.
 *
 * The box is a pseudo-element drawn from the item's `data-checked` attribute,
 * so there is nothing to attach a handler to and nothing for a click to land
 * on: a press went through to the text and put the caret there instead. Ticking
 * an item was only possible by retyping `[x] ` at the head of it, which is not
 * something anybody would guess.
 *
 * A pseudo-element's clicks are reported against the element that owns it, so
 * the item itself is the target and the only question is whether the press was
 * in the box or in the words. That is a matter of where it landed, and the box
 * is drawn to the left of the item's content, so the answer is the geometry.
 */

import type { Node as ProseNode } from 'prosemirror-model';
import { Plugin } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { notoSchema } from '../../../shared/markdown/v3/pm/schema';
import { applyCheckStamp, CHECK_STAMP_RE, positionAtTextOffset, type TaskStampOptions } from './todo-manager';

/**
 * Whether a press at `clientX` landed on the box rather than on the words.
 *
 * The box sits in the margin the list reserves, so anything left of the item's
 * own content box is it. A small allowance on the right so a press on the edge
 * of the box counts, which is how a checkbox behaves everywhere else.
 */
export function pressedTheBox(itemLeft: number, clientX: number): boolean {
  return clientX < itemLeft + 2;
}

export function taskClickPlugin(stamp: TaskStampOptions = {}): Plugin {
  return new Plugin({
    props: {
      handleClickOn: (view: EditorView, _position, node, nodePosition, event) => {
        if (node.type !== notoSchema.nodes.list_item) return false;
        // Only a task has a state to flip; an ordinary bullet has none.
        if (node.attrs.checked === null) return false;
        const target = event.target;
        if (!(target instanceof HTMLElement)) return false;
        const item = target.closest<HTMLElement>('li.noto-task-item');
        if (!item) return false;
        if (!pressedTheBox(item.getBoundingClientRect().left, (event as MouseEvent).clientX)) {
          return false;
        }
        const checked = !node.attrs.checked;
        let tr = view.state.tr.setNodeMarkup(nodePosition, undefined, {
          ...node.attrs,
          checked,
        });
        if (stamp.enabled?.() ?? true) {
          tr = applyCheckStamp(
            tr,
            nodePosition,
            node,
            checked,
            (stamp.now ?? (() => new Date()))(),
          );
        }
        view.dispatch(tr);
        return true;
      },
    },
  });
}

/**
 * The ` ✅ 2026-11-10` a finished task carries, marked so it is not struck
 * through with the words.
 *
 * The words are done and the line through them says so; the stamp says when,
 * and a line through the emoji and the date read as damage. A decoration
 * over the stamp's characters, found again in each finished item's last
 * paragraph, so the file keeps them exactly as written.
 */
function stampDecorations(doc: ProseNode): DecorationSet {
  const found: Decoration[] = [];
  doc.descendants((node, position) => {
    if (node.type !== notoSchema.nodes.list_item) return true;
    if (node.attrs.checked === true) {
      const paragraph = node.firstChild;
      if (paragraph?.isTextblock) {
        const text = paragraph.textContent;
        const match = CHECK_STAMP_RE.exec(text);
        if (match) {
          // Text offsets, not positions: a link or a formula earlier in the
          // line is one character of text and several positions.
          const content = position + 2;
          const from = positionAtTextOffset(paragraph, content, match.index);
          const to = positionAtTextOffset(paragraph, content, match.index + match[0].length);
          found.push(Decoration.inline(from, to, { class: 'noto-task-stamp' }));
        }
      }
    }
    return true;
  });
  return DecorationSet.create(doc, found);
}

export function taskStampPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    state: {
      init: (_config, state) => stampDecorations(state.doc),
      apply: (tr, previous) => (tr.docChanged ? stampDecorations(tr.doc) : previous),
    },
    props: {
      decorations(state) {
        return this.getState(state) ?? DecorationSet.empty;
      },
    },
  });
}

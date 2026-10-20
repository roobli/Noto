/**
 * The git gutter: a thin line beside each block of the open note that
 * differs from the note as last committed, and a small mark where committed
 * blocks were deleted.
 *
 * Read-only. Main works out which blocks changed (`git-blocks.ts`) and sends
 * their block ids; this lands each on the top-level node whose origin is that
 * block, so the line stays beside the block it is about however much has been
 * typed elsewhere. Pressing the line shows the block as committed.
 *
 * Costs nothing while typing. An edit inside one block keeps every origin
 * where it was, and the decorations are only mapped through it; they are
 * rebuilt from the origins when blocks are split, joined, added or removed,
 * which is when the origin plugin already walks the top level itself.
 */

import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { NotoBlockOrigin } from '../../../shared/markdown/v3/contracts';
import type { WorkspaceGitBlocksV1 } from '../../../shared/workspace/v1/contracts';
import { originKey } from './origin-plugin';
import { GIT_BLOCK_WORDS, openGitPopover } from './git-popover';

export interface GitGutterEntry {
  readonly change: 'modified' | 'added';
  readonly head: string | null;
}

interface GitGutterState {
  readonly blocks: ReadonlyMap<string, GitGutterEntry>;
  /** Keyed by the block the deleted ones stood before; `''` for the end. */
  readonly deleted: ReadonlyMap<string, string>;
  readonly origins: readonly (NotoBlockOrigin | null)[] | null;
  readonly decorations: DecorationSet;
}

export const gitGutterKey = new PluginKey<GitGutterState>('noto-git-gutter');

const END = '';

const EMPTY: GitGutterState = {
  blocks: new Map(), deleted: new Map(), origins: null, decorations: DecorationSet.empty,
};


function originsOf(state: EditorState): readonly (NotoBlockOrigin | null)[] | null {
  return originKey.getState(state)?.origins ?? null;
}

function deletedWidget(head: string, key: string) {
  return (view: EditorView) => {
    const holder = document.createElement('div');
    holder.className = 'noto-git-deleted';
    holder.contentEditable = 'false';
    const mark = document.createElement('button');
    mark.type = 'button';
    mark.className = 'noto-git-deleted-mark';
    mark.dataset.testid = 'git-deleted-mark';
    mark.title = GIT_BLOCK_WORDS.deleted;
    mark.setAttribute('aria-label', `${GIT_BLOCK_WORDS.deleted}: show what was here`);
    mark.addEventListener('mousedown', (event) => event.preventDefault());
    mark.addEventListener('click', (event) => {
      event.preventDefault();
      openGitPopover(view, mark, { kind: 'deleted', text: head });
    });
    holder.dataset.gitDeleted = key;
    holder.append(mark);
    return holder;
  };
}

function build(state: EditorState, blocks: GitGutterState['blocks'], deleted: GitGutterState['deleted'], origins: GitGutterState['origins']): DecorationSet {
  if ((blocks.size === 0 && deleted.size === 0) || origins === null) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  let pos = 0;
  const doc = state.doc;
  for (let index = 0; index < doc.childCount; index += 1) {
    const node = doc.child(index);
    const origin = origins[index] ?? null;
    if (origin) {
      const removed = deleted.get(origin.blockId);
      if (removed !== undefined) {
        decorations.push(Decoration.widget(pos, deletedWidget(removed, origin.blockId), {
          side: -1, key: `git-deleted-${origin.blockId}`, ignoreSelection: true, stopEvent: () => true,
        }));
      }
      const entry = blocks.get(origin.blockId);
      if (entry) {
        decorations.push(Decoration.node(pos, pos + node.nodeSize, {
          class: `noto-git-block noto-git-${entry.change}`,
          'data-git-block': entry.change,
        }));
      }
    }
    pos += node.nodeSize;
  }
  const atEnd = deleted.get(END);
  if (atEnd !== undefined) {
    decorations.push(Decoration.widget(doc.content.size, deletedWidget(atEnd, 'end'), {
      side: 1, key: 'git-deleted-end', ignoreSelection: true, stopEvent: () => true,
    }));
  }
  return DecorationSet.create(doc, decorations);
}

/** The meta that replaces what the gutter shows. */
export function setGitBlocks(tr: Transaction, event: WorkspaceGitBlocksV1 | null): Transaction {
  return tr.setMeta(gitGutterKey, event).setMeta('addToHistory', false);
}

/** What the gutter says about the top-level block at `index`, if anything. */
export function gitEntryAt(state: EditorState, index: number): GitGutterEntry | null {
  const gutter = gitGutterKey.getState(state);
  const origin = originsOf(state)?.[index] ?? null;
  if (!gutter || !origin) return null;
  return gutter.blocks.get(origin.blockId) ?? null;
}

/** The deleted run just before the top-level block at `index`, if any. */
export function gitDeletedBefore(state: EditorState, index: number): string | null {
  const gutter = gitGutterKey.getState(state);
  if (!gutter) return null;
  const origin = originsOf(state)?.[index] ?? null;
  if (index >= state.doc.childCount) return gutter.deleted.get(END) ?? null;
  return origin ? gutter.deleted.get(origin.blockId) ?? null : null;
}

/**
 * Open the popover for the block holding the caret, for the keyboard.
 * False when the gutter has nothing to say there.
 */
export function showCommittedAtSelection(view: EditorView): boolean {
  const { state } = view;
  const index = state.selection.$from.index(0);
  const entry = gitEntryAt(state, index);
  const anchor = view.nodeDOM(posOfChild(state, index)) as HTMLElement | null;
  if (!anchor) return false;
  if (entry) {
    openGitPopover(view, anchor, entry.change === 'modified'
      ? { kind: 'modified', text: entry.head ?? '' }
      : { kind: 'added', text: null });
    return true;
  }
  const removed = gitDeletedBefore(state, index) ?? gitDeletedBefore(state, index + 1);
  if (removed !== null) {
    openGitPopover(view, anchor, { kind: 'deleted', text: removed });
    return true;
  }
  return false;
}

function posOfChild(state: EditorState, index: number): number {
  let pos = 0;
  for (let child = 0; child < index; child += 1) pos += state.doc.child(child).nodeSize;
  return pos;
}

export function gitGutterPlugin(): Plugin<GitGutterState> {
  return new Plugin<GitGutterState>({
    key: gitGutterKey,
    state: {
      init: () => EMPTY,
      apply(tr, previous, _old, next) {
        const meta = tr.getMeta(gitGutterKey) as WorkspaceGitBlocksV1 | null | undefined;
        if (meta !== undefined) {
          const blocks = new Map((meta?.blocks ?? []).map((block) => [block.blockId, { change: block.change, head: block.head }]));
          const deleted = new Map((meta?.deleted ?? []).map((run) => [run.beforeBlockId ?? END, run.head]));
          const origins = originsOf(next);
          return { blocks, deleted, origins, decorations: build(next, blocks, deleted, origins) };
        }
        if (!tr.docChanged || (previous.blocks.size === 0 && previous.deleted.size === 0)) return previous;
        const origins = originsOf(next);
        // The same origins array is the origin plugin saying no block came or went.
        if (origins === previous.origins) {
          return { ...previous, decorations: previous.decorations.map(tr.mapping, tr.doc) };
        }
        return { ...previous, origins, decorations: build(next, previous.blocks, previous.deleted, origins) };
      },
    },
    props: {
      decorations: (state) => gitGutterKey.getState(state)?.decorations,
      handleDOMEvents: {
        /*
         * The line is the block's own `::after`, drawn in the document's
         * gutter, so a press on it arrives as a press on the block. Only a
         * press left of the block's box counts; one on the text is typing.
         */
        mousedown(view, event) {
          const gutter = gitGutterKey.getState(view.state);
          if (!gutter || gutter.blocks.size === 0) return false;
          const target = event.target as HTMLElement | null;
          const block = target?.closest?.('.noto-git-block') as HTMLElement | null;
          if (!block || block.parentElement !== view.dom) return false;
          if (event.clientX >= block.getBoundingClientRect().left) return false;
          const index = view.state.doc.resolve(view.posAtDOM(block, 0)).index(0);
          const entry = gitEntryAt(view.state, index);
          if (!entry) return false;
          event.preventDefault();
          openGitPopover(view, block, entry.change === 'modified'
            ? { kind: 'modified', text: entry.head ?? '' }
            : { kind: 'added', text: null });
          return true;
        },
      },
    },
  });
}

/**
 * Revert one block to the last commit: the third and last part of git in
 * Noto, from the gutter's popover or the palette.
 *
 * An ordinary editor transaction and nothing else. The block's node is
 * replaced by one built from the committed source, which the gutter already
 * holds (main read it with `git cat-file`); a deleted run is put back where it
 * was; a block the commit does not have is removed. It is undoable like any
 * edit, marks the note dirty, and reaches the file through the normal save.
 * Noto still never runs a git command that writes, and never touches `.git`.
 *
 * Bytes, not just structure: the new node is pinned to the committed source
 * (capture.ts `pinSource`), so the save writes HEAD's bytes for the block
 * rather than the serializer's rendering of them, and keeps the replaced
 * block's place (its origin, so the gaps around it are kept too). The node it
 * replaced is pinned to the bytes it had, so an undo, which puts that same
 * node back, saves exactly what was there.
 */

import { Selection, type EditorState, type Transaction } from 'prosemirror-state';
import type { Node as ProseNode } from 'prosemirror-model';
import type { NotoBlockOrigin } from '../../../shared/markdown/v3/contracts';
import { parseSingleBlock } from '../../../shared/markdown/v3/blocks';
import { blockFromSpan } from '../../../shared/markdown/v3/pm/from-mdast';
import { blockMarkdownNow, pinSource, type PristineBlock } from './capture';
import { gitDeletedHeadsBefore, gitEntryAt, type GitRevertTarget } from './git-gutter';

export type { GitRevertTarget };

export interface GitRevertContext {
  /** Origins as a save would use them (the editor's, with pinned ones filled in). */
  readonly origins: readonly (NotoBlockOrigin | null)[];
  readonly pristine: ReadonlyMap<string, PristineBlock>;
}

function positionOf(state: EditorState, index: number): number {
  let pos = 0;
  for (let child = 0; child < index; child += 1) pos += state.doc.child(child).nodeSize;
  return pos;
}

/** A node for one committed block, pinned to its bytes. Null if it is not one block. */
function committedNode(markdown: string, origin: NotoBlockOrigin | null): ProseNode | null {
  const span = parseSingleBlock(markdown);
  if (!span) return null;
  const node = blockFromSpan(span);
  pinSource(node, { markdown, origin, committed: true });
  return node;
}

/** Keep the bytes a node has now, for when an undo puts it back. */
function keep(node: ProseNode, origin: NotoBlockOrigin | null, context: GitRevertContext): void {
  pinSource(node, { markdown: blockMarkdownNow(node, origin, context.pristine), origin });
}

/** What a revert there would do, for the words on the button; null when there is nothing to revert. */
export function gitRevertKind(state: EditorState, target: GitRevertTarget): 'restore' | 'remove' | null {
  if (target.kind === 'deleted') return gitDeletedHeadsBefore(state, target.before) ? 'restore' : null;
  const entry = gitEntryAt(state, target.index);
  if (!entry) return null;
  return entry.change === 'modified' ? 'restore' : 'remove';
}

/**
 * The transaction that reverts `target`, or null when the gutter has nothing
 * to revert there or the committed source does not make one block.
 */
export function gitRevertTransaction(
  state: EditorState,
  target: GitRevertTarget,
  context: GitRevertContext,
): Transaction | null {
  const count = state.doc.childCount;
  if (target.kind === 'deleted') {
    const heads = gitDeletedHeadsBefore(state, target.before);
    if (!heads) return null;
    const nodes: ProseNode[] = [];
    for (const head of heads) {
      const node = committedNode(head, null);
      if (!node) return null;
      nodes.push(node);
    }
    const at = target.before >= count ? state.doc.content.size : positionOf(state, target.before);
    const tr = state.tr.insert(at, nodes);
    tr.setSelection(Selection.near(tr.doc.resolve(at + 1)));
    return tr.scrollIntoView();
  }

  const entry = gitEntryAt(state, target.index);
  if (!entry) return null;
  const old = state.doc.child(target.index);
  const origin = context.origins[target.index] ?? null;
  const from = positionOf(state, target.index);
  const to = from + old.nodeSize;
  keep(old, origin, context);

  if (entry.change === 'added') {
    // The commit does not have this block: reverting is removing it. The only
    // block of a note leaves an empty paragraph, which saves as nothing.
    const tr = count === 1
      ? state.tr.replaceWith(from, to, state.schema.nodes.paragraph.create())
      : state.tr.delete(from, to);
    tr.setSelection(Selection.near(tr.doc.resolve(Math.min(from, tr.doc.content.size)), -1));
    return tr.scrollIntoView();
  }

  const node = committedNode(entry.head ?? '', origin);
  if (!node) return null;
  const tr = state.tr.replaceWith(from, to, node);
  tr.setSelection(Selection.near(tr.doc.resolve(from + 1)));
  return tr.scrollIntoView();
}

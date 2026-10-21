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
import { closeHistory } from 'prosemirror-history';
import type { NotoBlockOrigin, NotoDocumentWire } from '../../../shared/markdown/v3/contracts';
import { sameOrigin } from '../../../shared/markdown/v3/revision-patch';
import { parseSingleBlock, splitBlocks } from '../../../shared/markdown/v3/blocks';
import { toLf } from '../../../shared/markdown/v3/line-endings';
import { blockFromSpan } from '../../../shared/markdown/v3/pm/from-mdast';
import { blockMarkdownNow, pinSource, type PristineBlock } from './capture';
import { gitDeletedHeadsBefore, gitEntryAt, type GitRevertTarget } from './git-gutter';

export type { GitRevertTarget };

export interface GitRevertContext {
  /** Origins as a save would use them (the editor's, with pinned ones filled in). */
  readonly origins: readonly (NotoBlockOrigin | null)[];
  readonly pristine: ReadonlyMap<string, PristineBlock>;
  /** The document as last opened or saved, for where its blocks sit. */
  readonly document: NotoDocumentWire;
}

/** Its own undo step: two reverts in a row, or a revert after typing, undo one at a time. */
function finish(tr: Transaction): Transaction {
  return closeHistory(tr).scrollIntoView();
}

function positionOf(state: EditorState, index: number): number {
  let pos = 0;
  for (let child = 0; child < index; child += 1) pos += state.doc.child(child).nodeSize;
  return pos;
}

/** A node for one committed block. Null if its source is not one block. */
function committedNode(markdown: string): ProseNode | null {
  const span = parseSingleBlock(markdown);
  return span ? blockFromSpan(span) : null;
}

/**
 * Whether these blocks, written one after another, read back as themselves:
 * the check the save makes (incremental.ts `checkWindow`), made before the
 * revert rather than after it. A committed block among blocks it never sat
 * beside can join them (a list swallowing an indented block after it); such
 * a revert is not offered, rather than leaving a note that will not save.
 */
function readsBack(blocks: readonly string[]): boolean {
  const split = splitBlocks(blocks.join('\n\n'));
  if (split.spans.length !== blocks.length) return false;
  if (split.leading.trim() || split.trailing.trim()) return false;
  return split.spans.every((span, index) => toLf(span.markdown) === toLf(blocks[index]!));
}

/**
 * Keep the bytes a node has now, for when an undo puts it back. Only bytes
 * that stand on their own: a block whose first line is indented keeps that
 * indent in the gap before it, so its bytes alone read as something else
 * once the gap is not kept (a fence loses its indent and its code gains
 * one). Such a node is left to the serializer, as any undone edit is.
 */
function keep(node: ProseNode, origin: NotoBlockOrigin | null, context: GitRevertContext): void {
  if (origin && indented(context.document, origin)) return;
  pinSource(node, { markdown: blockMarkdownNow(node, origin, context.pristine), origin });
}

/** Whether the file has text before this block on its first line (its indent, held by the gap). */
function indented(document: NotoDocumentWire, origin: NotoBlockOrigin): boolean {
  const span = document.spans[origin.ordinal];
  const issued = document.origins[origin.ordinal];
  if (!span || !issued || !sameOrigin(issued, origin)) return false;
  const lineStart = document.text.lastIndexOf('\n', span.start - 1) + 1;
  return lineStart < span.start;
}

/** What a revert at `target` would do, before anything is pinned or dispatched. */
interface RevertPlan {
  readonly from: number;
  readonly to: number;
  /** The committed nodes and their bytes, or nothing for a removal. */
  readonly nodes: readonly { readonly node: ProseNode; readonly markdown: string }[];
  /** The block replaced or removed, with its origin; null when a run is put back. */
  readonly old: { readonly node: ProseNode; readonly origin: NotoBlockOrigin | null } | null;
}

function planRevert(state: EditorState, target: GitRevertTarget, context: GitRevertContext): RevertPlan | null {
  const doc = state.doc;
  const count = doc.childCount;
  const around = (index: number): string | null => index >= 0 && index < count
    ? blockMarkdownNow(doc.child(index), context.origins[index] ?? null, context.pristine)
    : null;
  const committed = (heads: readonly string[]): RevertPlan['nodes'] | null => {
    const nodes = [];
    for (const markdown of heads) {
      const node = committedNode(markdown);
      if (!node) return null;
      nodes.push({ node, markdown });
    }
    return nodes;
  };
  const fits = (before: number, heads: readonly string[], after: number): boolean => {
    const window = [around(before), ...heads, around(after)].filter((text): text is string => text !== null);
    return readsBack(window);
  };

  if (target.kind === 'deleted') {
    const heads = gitDeletedHeadsBefore(state, target.before);
    if (!heads || !fits(target.before - 1, heads, target.before)) return null;
    const nodes = committed(heads);
    if (!nodes) return null;
    const at = target.before >= count ? doc.content.size : positionOf(state, target.before);
    return { from: at, to: at, nodes, old: null };
  }

  const entry = gitEntryAt(state, target.index);
  if (!entry) return null;
  const old = { node: doc.child(target.index), origin: context.origins[target.index] ?? null };
  const from = positionOf(state, target.index);
  const to = from + old.node.nodeSize;
  // The commit does not have this block: reverting is removing it, the same
  // edit as deleting it by hand, which the save already knows how to write.
  if (entry.change === 'added') return { from, to, nodes: [], old };
  const head = entry.head ?? '';
  if (!fits(target.index - 1, [head], target.index + 1)) return null;
  const nodes = committed([head]);
  return nodes ? { from, to, nodes, old } : null;
}

/** What a revert there would do, for the words on the button; null when it cannot be done. */
export function gitRevertKind(state: EditorState, target: GitRevertTarget, context: GitRevertContext): 'restore' | 'remove' | null {
  const plan = planRevert(state, target, context);
  if (!plan) return null;
  return plan.nodes.length === 0 ? 'remove' : 'restore';
}

/**
 * The transaction that reverts `target`, or null when the gutter has nothing
 * to revert there, the committed source does not make one block, or it would
 * not read back where it goes.
 */
export function gitRevertTransaction(
  state: EditorState,
  target: GitRevertTarget,
  context: GitRevertContext,
): Transaction | null {
  const plan = planRevert(state, target, context);
  if (!plan) return null;
  const origin = plan.old?.origin ?? null;
  if (plan.old) keep(plan.old.node, origin, context);
  // A changed block keeps its place in the file (its origin); a run put back
  // has none and takes ordinary blank lines around it.
  for (const { node, markdown } of plan.nodes) {
    pinSource(node, { markdown, origin: plan.old ? origin : null, committed: true });
  }
  let tr = state.tr;
  if (plan.nodes.length > 0) {
    tr = tr.replaceWith(plan.from, plan.to, plan.nodes.map((entry) => entry.node));
    tr.setSelection(Selection.near(tr.doc.resolve(plan.from + 1)));
  } else if (state.doc.childCount === 1) {
    // The only block of a note leaves an empty paragraph, which saves as nothing.
    tr = tr.replaceWith(plan.from, plan.to, state.schema.nodes.paragraph.create());
    tr.setSelection(Selection.near(tr.doc.resolve(plan.from + 1)));
  } else {
    tr = tr.delete(plan.from, plan.to);
    tr.setSelection(Selection.near(tr.doc.resolve(Math.min(plan.from, tr.doc.content.size)), -1));
  }
  return finish(tr);
}

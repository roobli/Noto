/**
 * Turning editor state into a save transaction.
 *
 * Kept free of `EditorView` so it can be tested without a DOM, and so the
 * expensive decision (serialize this block, or reuse its original source?)
 * lives somewhere it can be reasoned about on its own.
 */

import type { Node as ProseNode } from 'prosemirror-model';
import { blockToMarkdown } from '../../../shared/markdown/v3/pm/to-mdast';
import {
  NOTO_MARKDOWN_VERSION,
  type NotoBlockOrigin,
  type NotoDocumentWire,
  type NotoKeptRun,
  type NotoTransaction,
  type NotoTransactionWire,
  type NotoTargetEnvelope,
  type NotoUnit,
} from '../../../shared/markdown/v3/contracts';
import { compactTransaction, sameOrigin } from '../../../shared/markdown/v3/revision-patch';

/** What a block looked like when the document was accepted. */
export interface PristineBlock {
  readonly node: ProseNode;
  readonly markdown: string;
}

export interface CaptureInput {
  readonly doc: ProseNode;
  readonly origins: readonly (NotoBlockOrigin | null)[];
  readonly document: NotoDocumentWire;
  readonly pristine: ReadonlyMap<string, PristineBlock>;
  /**
   * What the file should end up as, when the reader has asked for something
   * other than what it already is. Absent means leave it alone, which is what
   * every save does unless a line-ending command has been used.
   */
  readonly envelope?: NotoTargetEnvelope;
}

export interface CaptureStats {
  /** Blocks reused verbatim, costing no serialization. */
  readonly reused: number;
  /** Blocks rendered back to markdown. */
  readonly serialized: number;
}

/**
 * Source text for one block.
 *
 * `ProseNode.eq` is a structural comparison that stops at the first difference,
 * so an untouched block is far cheaper than rendering it back to markdown. On a
 * large document where the user changed one paragraph this is the difference
 * between serializing one block and serializing all of them.
 */
function markdownFor(
  node: ProseNode,
  origin: NotoBlockOrigin | null,
  pristine: CaptureInput['pristine'],
): { markdown: string; reused: boolean } {
  if (origin) {
    const previous = pristine.get(origin.blockId);
    if (previous && node.eq(previous.node)) {
      return { markdown: previous.markdown, reused: true };
    }
  }
  return { markdown: blockToMarkdown(node), reused: false };
}

/**
 * The markdown a unit stands for, resolving an unchanged unit to its origin.
 *
 * Callers that want the document as text (a plugin transform, the outline) need
 * every block's markdown, while callers that want a save transaction need
 * unchanged blocks to stay empty. This keeps the two apart rather than making
 * one pay for the other.
 */
export function unitMarkdown(unit: NotoUnit, pristine: CaptureInput['pristine']): string {
  if (unit.markdown !== null) return unit.markdown;
  if (unit.origin === null) return '';
  return pristine.get(unit.origin.blockId)?.markdown ?? '';
}

/** Every block's markdown, in document order. */
export function captureMarkdown(input: CaptureInput): string[] {
  return captureUnits(input).units.map((unit) => unitMarkdown(unit, input.pristine));
}

export function captureUnits(input: CaptureInput): { units: NotoUnit[]; stats: CaptureStats } {
  const units: NotoUnit[] = [];
  let reused = 0;
  let serialized = 0;

  input.doc.forEach((node, _offset, index) => {
    const origin = input.origins[index] ?? null;
    const result = markdownFor(node, origin, input.pristine);
    if (result.reused) reused += 1;
    else serialized += 1;
    // A reused block sends no text. Main already holds its bytes, so repeating
    // them would make every save carry the whole document across the process
    // boundary regardless of how little changed.
    units.push({ origin, markdown: result.reused ? null : result.markdown });
  });

  return { units, stats: { reused, serialized } };
}

export function captureTransaction(input: CaptureInput): { transaction: NotoTransaction; stats: CaptureStats } {
  const { units, stats } = captureUnits(input);
  return {
    transaction: {
      version: NOTO_MARKDOWN_VERSION,
      mode: 'blocks',
      documentId: input.document.documentId,
      revisionId: input.document.revisionId,
      units,
      // `mixed` and the document's own final newline mean "as it is", so a save
      // nobody asked to convert is byte for byte what it always was.
      envelope: input.envelope ?? {
        lineEnding: 'mixed',
        hasFinalNewline: input.document.envelope.hasFinalNewline,
      },
    },
    stats,
  };
}

/**
 * Save wire for a document whose top-level nodes have not been split, merged,
 * inserted, or deleted since they were accepted.
 *
 * `acceptedNodes[i]` is the node that block had when it was last accepted.
 * ProseMirror reuses every node an interior edit did not touch, so a save can
 * name those blocks as kept runs instead of allocating one unit per block and
 * then folding the units back into the same runs (`compactTransaction`).
 *
 * A node that is not the accepted object is still reused when it compares
 * equal, which is what the full walk does. Anything else is serialized. When
 * the caller cannot promise index alignment, this falls back to that walk.
 */
export function captureStableWire(
  input: CaptureInput,
  acceptedNodes: readonly ProseNode[],
): { transaction: NotoTransactionWire; stats: CaptureStats } {
  const doc = input.doc;
  if (acceptedNodes.length !== doc.childCount || input.origins.length !== doc.childCount) {
    const full = captureTransaction(input);
    return { transaction: compactTransaction(full.transaction, input.document), stats: full.stats };
  }

  const units: (NotoUnit | NotoKeptRun)[] = [];
  let run: { keep: number; count: number } | null = null;
  let reused = 0;
  let serialized = 0;
  const baseOrigins = input.document.origins;

  for (let index = 0; index < doc.childCount; index += 1) {
    const node = doc.child(index);
    const origin = input.origins[index] ?? null;
    let unchanged = node === acceptedNodes[index];
    if (!unchanged && origin) {
      const previous = input.pristine.get(origin.blockId);
      unchanged = !!previous && (node === previous.node || node.eq(previous.node));
    }
    const base = origin ? baseOrigins[origin.ordinal] : undefined;
    if (unchanged && origin && base && sameOrigin(origin, base)) {
      reused += 1;
      if (run && run.keep + run.count === origin.ordinal) {
        run.count += 1;
      } else {
        run = { keep: origin.ordinal, count: 1 };
        units.push(run);
      }
      continue;
    }
    serialized += 1;
    run = null;
    // Unchanged but not a base block at its ordinal still sends no text. A
    // block with no origin has nothing to reuse and must be rendered.
    units.push({
      origin,
      markdown: unchanged && origin ? null : blockToMarkdown(node),
    });
  }

  return {
    transaction: {
      version: NOTO_MARKDOWN_VERSION,
      mode: 'blocks',
      documentId: input.document.documentId,
      revisionId: input.document.revisionId,
      units,
      envelope: input.envelope ?? {
        lineEnding: 'mixed',
        hasFinalNewline: input.document.envelope.hasFinalNewline,
      },
    },
    stats: { reused, serialized },
  };
}

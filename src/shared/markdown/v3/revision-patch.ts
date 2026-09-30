/**
 * Saving a long note without sending it whole, either way.
 *
 * A save used to send main an origin for every block, changed or not, and main
 * answered with the whole next revision: its text and an origin and a span for
 * every block. For one edited paragraph in an 8 MB note that was 6 MB of
 * request and 15 MB of reply, copied between processes, and the renderer then
 * hashed the whole text again to check it. Most of a save went there.
 *
 * Both sides already hold the revision the save starts from, and a revision id
 * is the hash of the revision's content: equal ids mean equal bytes. So:
 *
 * - The request names untouched blocks by ordinal, in runs (`compactUnits`),
 *   and main expands the runs against its own copy (`expandUnits`).
 * - The reply names the blocks that only moved, in runs, and carries the text
 *   and blocks that are new (`revisionPatch`). The renderer rebuilds the next
 *   revision from its base (`applyRevisionPatch`).
 *
 * Neither side has to trust the other to have done this right. A run names the
 * id of its first block, a moved block's id is derived from its old one, and
 * `applyRevisionPatch` refuses anything that does not line up. The renderer
 * then falls back to asking for the whole revision.
 */

import type {
  NotoBlock,
  NotoBlockId,
  NotoBlockOrigin,
  NotoDocument,
  NotoDocumentWire,
  NotoKeptBlocks,
  NotoKeptRun,
  NotoPatchedBlock,
  NotoRevisionPatch,
  NotoTextSplice,
  NotoTransaction,
  NotoTransactionWire,
  NotoUnit,
} from './contracts';
import { NOTO_MARKDOWN_VERSION } from './contracts';

/** Expanded transactions are held to the same ceiling as sent ones. */
export const MAX_TRANSACTION_UNITS = 100_000;

const BLOCK_ID = /^noto-block-v3:(\d+):([0-9a-f]{16})$/;

/**
 * A block's id at another ordinal.
 *
 * Ids are `noto-block-v3:<ordinal>:<first 16 hex digits of the block's hash>`,
 * so a block that only moved keeps its digest and changes its ordinal. Null for
 * an id that is not of that form.
 */
export function blockIdAt(id: string, ordinal: number): NotoBlockId | null {
  const match = BLOCK_ID.exec(id);
  return match ? `noto-block-v3:${ordinal}:${match[2]}` as NotoBlockId : null;
}

export function isKeptRun(unit: NotoUnit | NotoKeptRun): unit is NotoKeptRun {
  return 'keep' in unit;
}

function sameOrigin(left: NotoBlockOrigin, right: NotoBlockOrigin): boolean {
  return left.blockId === right.blockId && left.ordinal === right.ordinal
    && left.kind === right.kind && left.semanticKey === right.semanticKey;
}

/**
 * The transaction as it is sent: each untouched unit that is the base's block
 * at its own ordinal becomes part of a run.
 */
export function compactTransaction(transaction: NotoTransaction, base: NotoDocumentWire): NotoTransactionWire {
  if (transaction.mode !== 'blocks') return transaction;
  const units: (NotoUnit | NotoKeptRun)[] = [];
  let run: { keep: number; count: number } | null = null;
  for (const unit of transaction.units) {
    const origin = unit.origin;
    const baseOrigin = origin ? base.origins[origin.ordinal] : undefined;
    if (unit.markdown === null && origin && baseOrigin && sameOrigin(origin, baseOrigin)) {
      if (run && run.keep + run.count === origin.ordinal) {
        run.count += 1;
      } else {
        run = { keep: origin.ordinal, count: 1 };
        units.push(run);
      }
      continue;
    }
    run = null;
    units.push(unit);
  }
  return { ...transaction, units };
}

/**
 * The transaction main serializes: runs replaced by the units they stand for,
 * each with the origin main itself holds for that block. Null when a run names
 * a block the document does not have, or the result would be too large.
 */
export function expandTransaction(transaction: NotoTransactionWire, document: NotoDocument): NotoTransaction | null {
  if (transaction.mode !== 'blocks') return transaction;
  const units: NotoUnit[] = [];
  for (const unit of transaction.units) {
    if (!isKeptRun(unit)) {
      units.push(unit);
    } else {
      if (unit.keep + unit.count > document.blocks.length) return null;
      for (let ordinal = unit.keep; ordinal < unit.keep + unit.count; ordinal += 1) {
        units.push({ origin: document.blocks[ordinal]!.origin, markdown: null });
      }
    }
    if (units.length > MAX_TRANSACTION_UNITS) return null;
  }
  return { ...transaction, units };
}

/**
 * Whether `next[j]` is `base[i]` unchanged: the same text, byte for byte, the
 * same kind and key, and the id a block moved to `j` would have.
 */
function unchanged(base: NotoDocument, next: NotoDocument, i: number, j: number): boolean {
  const before: NotoBlock | undefined = base.blocks[i];
  const after: NotoBlock | undefined = next.blocks[j];
  if (!before || !after) return false;
  return before.sha256 === after.sha256
    && before.kind === after.kind
    && before.semanticKey === after.semanticKey
    && before.end - before.start === after.end - after.start
    && after.id === blockIdAt(before.id, j)
    && base.text.slice(before.start, before.end) === next.text.slice(after.start, after.end);
}

/**
 * Pair the blocks of `next` with the base blocks they are, in order.
 *
 * Greedy and linear: the common edits (a block changed, added or removed) are
 * settled by looking one step ahead, and anything else by finding the next base
 * block with the same hash. A pairing only has to be true, not the longest
 * possible: every block left unpaired travels in full, and the patch is still
 * exact.
 */
function pairBlocks(base: NotoDocument, next: NotoDocument): Int32Array {
  const paired = new Int32Array(next.blocks.length).fill(-1);
  let byHash: Map<string, number[]> | null = null;
  let i = 0;
  for (let j = 0; j < next.blocks.length; j += 1) {
    if (i >= base.blocks.length) break;
    if (unchanged(base, next, i, j)) {
      paired[j] = i;
      i += 1;
      continue;
    }
    // Changed in place, or inserted: the base block may still come later.
    if (unchanged(base, next, i + 1, j + 1) || unchanged(base, next, i, j + 1)) {
      if (unchanged(base, next, i + 1, j + 1)) i += 1;
      continue;
    }
    // Removed: the next block is the base block after it.
    if (unchanged(base, next, i + 1, j)) {
      paired[j] = i + 1;
      i += 2;
      continue;
    }
    if (byHash === null) {
      byHash = new Map();
      base.blocks.forEach((block, index) => {
        const list = byHash!.get(block.sha256);
        if (list) list.push(index);
        else byHash!.set(block.sha256, [index]);
      });
    }
    const candidates = byHash.get(next.blocks[j]!.sha256) ?? [];
    const found = candidates.find((index) => index >= i && unchanged(base, next, index, j));
    if (found !== undefined) {
      paired[j] = found;
      i = found + 1;
    }
  }
  return paired;
}

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * How many code units two strings share at the start and, after that, at the
 * end, never splitting a surrogate pair.
 */
function commonEnds(left: string, right: string): [number, number] {
  const shortest = Math.min(left.length, right.length);
  let head = 0;
  while (head < shortest && left.charCodeAt(head) === right.charCodeAt(head)) head += 1;
  if (head > 0 && head < shortest && isHigh(left.charCodeAt(head - 1))) head -= 1;
  let tail = 0;
  while (tail < shortest - head
    && left.charCodeAt(left.length - 1 - tail) === right.charCodeAt(right.length - 1 - tail)) tail += 1;
  if (tail > 0 && isLow(left.charCodeAt(left.length - tail))) tail -= 1;
  return [head, tail];
}

/**
 * The patch that turns `base` into `next`, two revisions of one document.
 *
 * Main builds it after a save from the document it saved from and the one it
 * wrote. Linear in the number of blocks, with no hashing: blocks are compared
 * by the hashes they already carry and by their text.
 */
export function revisionPatch(base: NotoDocument, next: NotoDocument): NotoRevisionPatch {
  const paired = pairBlocks(base, next);
  const splices: NotoTextSplice[] = [];
  const blocks: (NotoKeptBlocks | NotoPatchedBlock)[] = [];

  // The text between two paired blocks is either what it was, or a splice of
  // just the part that differs.
  let baseCursor = 0;
  let nextCursor = 0;
  const between = (baseEnd: number, nextEnd: number) => {
    const before = base.text.slice(baseCursor, baseEnd);
    const after = next.text.slice(nextCursor, nextEnd);
    if (before === after) return;
    const [head, tail] = commonEnds(before, after);
    splices.push({ start: baseCursor + head, end: baseEnd - tail, text: after.slice(head, after.length - tail) });
  };

  let run: { keep: number; count: number; firstBlockId: NotoBlockId } | null = null;
  for (let j = 0; j < next.blocks.length; j += 1) {
    const block = next.blocks[j]!;
    const i = paired[j]!;
    if (i < 0) {
      run = null;
      blocks.push({ origin: block.origin, start: block.start, end: block.end });
      continue;
    }
    const kept = base.blocks[i]!;
    between(kept.start, block.start);
    baseCursor = kept.end;
    nextCursor = block.end;
    if (run && run.keep + run.count === i) {
      run.count += 1;
    } else {
      run = { keep: i, count: 1, firstBlockId: kept.id };
      blocks.push(run);
    }
  }
  between(base.text.length, next.text.length);

  return {
    version: NOTO_MARKDOWN_VERSION,
    baseRevisionId: base.revisionId,
    revisionId: next.revisionId,
    envelope: next.envelope,
    splices,
    blocks,
  };
}

/**
 * The next revision, rebuilt from the base and a patch, or null when the patch
 * does not fit that base: a different revision, a run past its end or not
 * starting where it says, a splice through a kept block, or offsets out of
 * order. The caller then asks for the whole revision instead.
 */
export function applyRevisionPatch(base: NotoDocumentWire, patch: NotoRevisionPatch): NotoDocumentWire | null {
  if (patch.baseRevisionId !== base.revisionId) return null;

  // The text: base slices between the splices, and each splice's text.
  const pieces: string[] = [];
  let cursor = 0;
  for (const splice of patch.splices) {
    if (splice.start < cursor || splice.end < splice.start || splice.end > base.text.length) return null;
    pieces.push(base.text.slice(cursor, splice.start), splice.text);
    cursor = splice.end;
  }
  pieces.push(base.text.slice(cursor));
  const text = pieces.join('');

  // A kept block moves by the total change of the splices before it, and must
  // not overlap any of them.
  const origins: NotoBlockOrigin[] = [];
  const spans: { start: number; end: number }[] = [];
  let splice = 0;
  let shift = 0;
  let lastEnd = 0;
  for (const entry of patch.blocks) {
    if ('keep' in entry) {
      if (entry.count < 1 || entry.keep + entry.count > base.origins.length
        || base.origins[entry.keep]!.blockId !== entry.firstBlockId) return null;
      for (let ordinal = entry.keep; ordinal < entry.keep + entry.count; ordinal += 1) {
        const origin = base.origins[ordinal]!;
        const span = base.spans[ordinal]!;
        while (splice < patch.splices.length && patch.splices[splice]!.end <= span.start) {
          const done = patch.splices[splice]!;
          shift += done.text.length - (done.end - done.start);
          splice += 1;
        }
        if (splice < patch.splices.length && patch.splices[splice]!.start < span.end) return null;
        const blockId = blockIdAt(origin.blockId, origins.length);
        if (blockId === null) return null;
        origins.push({ blockId, ordinal: origins.length, kind: origin.kind, semanticKey: origin.semanticKey });
        spans.push({ start: span.start + shift, end: span.end + shift });
      }
    } else {
      if (entry.origin.ordinal !== origins.length) return null;
      origins.push(entry.origin);
      spans.push({ start: entry.start, end: entry.end });
    }
    const last = spans[spans.length - 1]!;
    if (last.start < lastEnd || last.end < last.start || last.end > text.length) return null;
    lastEnd = last.end;
  }

  return {
    version: NOTO_MARKDOWN_VERSION,
    documentId: base.documentId,
    revisionId: patch.revisionId,
    envelope: patch.envelope,
    text,
    origins,
    spans,
    nodes: null,
  };
}

/** UTF-8 length of `text`, without encoding it. */
function utf8Length(text: string): number {
  let length = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) length += 1;
    else if (code < 0x800) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const low = text.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        length += 4;
        index += 1;
      } else {
        length += 3;
      }
    } else length += 3;
  }
  return length;
}

/**
 * Whether the patch's envelope counts the bytes the patched text has: the
 * base's byte length, less what the splices removed, plus what they put in.
 * Costs the length of the splices, not of the note.
 */
export function patchKeepsByteLength(base: NotoDocumentWire, patch: NotoRevisionPatch): boolean {
  if (patch.envelope.bom !== base.envelope.bom) return false;
  let length = base.envelope.byteLength;
  for (const splice of patch.splices) {
    length += utf8Length(splice.text) - utf8Length(base.text.slice(splice.start, splice.end));
  }
  return length === patch.envelope.byteLength;
}

/**
 * The page's end of a save: what it sends, and how it takes the answer.
 *
 * Untouched blocks go to main as runs of ordinals, and a saved revision comes
 * back as a patch against the revision the save was captured from
 * (`revision-patch.ts`). Everything past this module sees a save outcome with
 * the whole document in it, exactly as before.
 */

import type {
  FileTruthResultV1,
  FileTruthSaveOutcomeV1,
  FileTruthSaveReplyV1,
  FileTruthSavedPatchV1,
  FileTruthSavedV1,
} from '../shared/file-truth/v1/contracts';
import type { NotoDocumentWire, NotoRevisionId } from '../shared/markdown/v3/contracts';
import { applyRevisionPatch, patchKeepsByteLength } from '../shared/markdown/v3/revision-patch';

export { compactTransaction } from '../shared/markdown/v3/revision-patch';

/** Ask main for a revision whole; null when it cannot be had. */
export type FetchRevision = (revisionId: NotoRevisionId) => Promise<NotoDocumentWire | null>;

/**
 * The save reply with any patched revision rebuilt against `base`, the
 * revision the save was captured from.
 *
 * A patch that does not fit `base` is not guessed at: the revision is asked
 * for whole instead. Only when that fails too is the reply reported as a
 * transport failure, and then the file is saved but the editor keeps its
 * unsaved state, so the next save is refused as stale rather than written from
 * a baseline the page does not have.
 */
export async function materializeSaveReply(
  result: FileTruthResultV1<FileTruthSaveReplyV1>,
  base: NotoDocumentWire,
  fetchRevision: FetchRevision,
): Promise<FileTruthResultV1<FileTruthSaveOutcomeV1>> {
  if (!result.ok) return result;
  const value = result.value;

  const rebuild = async (saved: FileTruthSavedPatchV1): Promise<FileTruthSavedV1 | null> => {
    const { documentPatch, ...rest } = saved;
    const applied = patchKeepsByteLength(base, documentPatch) ? applyRevisionPatch(base, documentPatch) : null;
    const document = applied ?? await fetchRevision(documentPatch.revisionId);
    if (!document || document.revisionId !== documentPatch.revisionId) return null;
    return { ...rest, document };
  };
  const failed = (): FileTruthResultV1<FileTruthSaveOutcomeV1> => ({
    ok: false,
    requestId: result.requestId,
    error: {
      code: 'FILE_TRUTH_TRANSPORT_FAILED',
      message: 'The note was saved, but the editor could not take the saved version. Reopen the note before editing further.',
    },
  });

  if (value.status === 'saved' && 'documentPatch' in value) {
    const saved = await rebuild(value);
    return saved ? { ok: true, requestId: result.requestId, value: saved } : failed();
  }
  if (value.status === 'cleanup-failed' && 'documentPatch' in value.primary) {
    const primary = await rebuild(value.primary);
    return primary ? { ok: true, requestId: result.requestId, value: { ...value, primary } } : failed();
  }
  return { ok: true, requestId: result.requestId, value: value as FileTruthSaveOutcomeV1 };
}

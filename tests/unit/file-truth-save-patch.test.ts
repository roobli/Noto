import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileTruthStoreV1 } from '../../src/main/file-truth/v1/file-truth-store';
import {
  isFileTruthSaveReplyResultV1,
  isFileTruthSaveRequestV1,
  isFileTruthSaveResultV1,
} from '../../src/shared/file-truth/v1/validate';
import { compactTransaction } from '../../src/shared/markdown/v3/revision-patch';
import { NOTO_MARKDOWN_VERSION, type NotoDocumentWire, type NotoTransaction } from '../../src/shared/markdown/v3/contracts';
import type {
  FileTruthEditCandidateV1,
  FileTruthResultV1,
  FileTruthSaveReplyV1,
  FileTruthSaveTokenV1,
} from '../../src/shared/file-truth/v1/contracts';
import { materializeSaveReply } from '../../src/renderer/file-truth-save';

const roots: string[] = [];
const logger = { filePath: '/dev/null', log() {} };
const paragraphs = Array.from({ length: 200 }, (_, index) => `Paragraph ${index}, with ünïcödé.`);
const source = `# Patched saves\n\n${paragraphs.join('\n\n')}\n`;

/** What the editor sends: every block untouched except the edits, by index. */
function transactionFor(document: NotoDocumentWire, edits: ReadonlyMap<number, string>): Extract<NotoTransaction, { mode: 'blocks' }> {
  return {
    version: NOTO_MARKDOWN_VERSION,
    mode: 'blocks',
    documentId: document.documentId,
    revisionId: document.revisionId,
    envelope: { lineEnding: 'mixed', hasFinalNewline: true },
    units: document.origins.map((origin, index) => ({ origin, markdown: edits.get(index) ?? null })),
  };
}

function candidate(document: NotoDocumentWire, saveToken: FileTruthSaveTokenV1, edits: ReadonlyMap<number, string>): FileTruthEditCandidateV1 {
  return { version: 3, saveToken, transaction: compactTransaction(transactionFor(document, edits), document) };
}

async function opened() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noto-save-patch-'));
  roots.push(root);
  const file = path.join(root, 'note.md');
  await writeFile(file, source, { mode: 0o640 });
  const store = new FileTruthStoreV1(path.join(root, 'user-data'), logger);
  return { file, store, open: await store.open(file) };
}

const reply = (value: FileTruthSaveReplyV1): FileTruthResultV1<FileTruthSaveReplyV1> => ({ ok: true, requestId: 'r-1', value });

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('a save sent compact and answered with a patch', () => {
  it('writes the edit, and the patch rebuilds exactly the accepted revision', async () => {
    const { file, store, open } = await opened();
    const request = { version: 1, requestId: 'r-1', candidate: candidate(open.document, open.saveToken, new Map([[50, 'Paragraph forty nine, rewritten.']])) };
    expect(isFileTruthSaveRequestV1(request)).toBe(true);
    // Two hundred untouched blocks travel as two runs.
    expect(request.candidate.transaction.mode === 'blocks' && request.candidate.transaction.units.length).toBe(3);

    const outcome = await store.saveForRenderer(request.candidate);
    expect(outcome.status).toBe('saved');
    if (outcome.status !== 'saved' || !('documentPatch' in outcome)) throw new Error('expected a patched save');
    expect(await readFile(file, 'utf8')).toBe(source.replace('Paragraph 49, with ünïcödé.', 'Paragraph forty nine, rewritten.'));
    expect(isFileTruthSaveReplyResultV1(reply(outcome), 'r-1')).toBe(true);
    // A patched reply is not a whole outcome, and no validator takes it for one.
    expect(isFileTruthSaveResultV1(reply(outcome), 'r-1')).toBe(false);

    const result = await materializeSaveReply(reply(outcome), open.document, async () => { throw new Error('not needed'); });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.status !== 'saved') throw new Error('expected a saved outcome');
    expect(result.value.document).toEqual(store.currentDocument(outcome.documentPatch.revisionId));
    expect(isFileTruthSaveResultV1({ ok: true, requestId: 'r-1', value: result.value }, 'r-1')).toBe(true);
  });

  it('saves again from the revision the patch rebuilt', async () => {
    const { store, open } = await opened();
    let document = open.document;
    let token = open.saveToken;
    for (let round = 0; round < 5; round += 1) {
      const outcome = await store.saveForRenderer(candidate(document, token, new Map([[round * 30 + 1, `Round ${round}.`]])));
      const result = await materializeSaveReply(reply(outcome), document, async () => null);
      if (!result.ok || result.value.status !== 'saved') throw new Error(`round ${round} did not save`);
      document = result.value.document;
      token = result.value.saveToken;
      expect(document).toEqual(store.currentDocument(document.revisionId));
    }
  });

  it('asks for the revision whole when the patch does not fit, and only then', async () => {
    const { store, open } = await opened();
    const outcome = await store.saveForRenderer(candidate(open.document, open.saveToken, new Map([[3, 'Changed.']])));
    if (outcome.status !== 'saved' || !('documentPatch' in outcome)) throw new Error('expected a patched save');
    const wrongBase = { ...open.document, revisionId: outcome.documentPatch.revisionId };
    const asked: string[] = [];
    const result = await materializeSaveReply(reply(outcome), wrongBase, async (revisionId) => {
      asked.push(revisionId);
      return store.currentDocument(revisionId);
    });
    expect(asked).toEqual([outcome.documentPatch.revisionId]);
    expect(result.ok && result.value.status === 'saved' && result.value.document.revisionId).toBe(outcome.documentPatch.revisionId);

    const refused = await materializeSaveReply(reply(outcome), wrongBase, async () => null);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toContain('The note was saved');
  });

  it('answers a stale save whole, as before, and refuses a revision it has moved past', async () => {
    const { store, open } = await opened();
    await store.saveForRenderer(candidate(open.document, open.saveToken, new Map([[3, 'First.']])));
    const stale = await store.saveForRenderer(candidate(open.document, open.saveToken, new Map([[4, 'Second.']])));
    expect(stale.status).toBe('stale-editor-revision');
    expect(() => store.currentDocument(open.document.revisionId)).toThrow(/STALE_REVISION/);
  });

  it('refuses a run that names blocks the document does not have', async () => {
    const { store, open } = await opened();
    const outcome = await store.saveForRenderer({
      version: 3,
      saveToken: open.saveToken,
      transaction: { ...transactionFor(open.document, new Map()), units: [{ keep: 0, count: open.document.origins.length + 5 }] },
    });
    expect(outcome.status).toBe('serialization-failed');
  });
});

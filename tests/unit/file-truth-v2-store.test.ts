import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileTruthStoreV1 } from '../../src/main/file-truth/v1/file-truth-store';
import { isFileTruthOpenResultV1, isFileTruthSaveResultV1 } from '../../src/shared/file-truth/v1/validate';
import { splitBlocks } from '../../src/shared/markdown/v3/blocks';
import { toLf } from '../../src/shared/markdown/v3/line-endings';
import {
  NOTO_MARKDOWN_VERSION,
  type NotoDocumentWire,
  type NotoUnit,
} from '../../src/shared/markdown/v3/contracts';
import type { FileTruthEditCandidateV1, FileTruthSaveTokenV1 } from '../../src/shared/file-truth/v1/contracts';

const roots: string[] = [];
const logger = { filePath: '/dev/null', log() {} };
const source = '# File truth\n\nFirst.\n\nMiddle stays put.\n\nLast.\n';

/** The document's blocks as editable units, all pristine to begin with. */
function unitsOf(document: NotoDocumentWire): NotoUnit[] {
  const spans = splitBlocks(document.text).spans;
  return document.origins.map((origin, index) => ({ origin, markdown: toLf(spans[index].markdown) }));
}

function candidateFrom(document: NotoDocumentWire, saveToken: FileTruthSaveTokenV1,
  edits: ReadonlyMap<number, string>): FileTruthEditCandidateV1 {
  const units = unitsOf(document).map((unit, index) => {
    const replacement = edits.get(index);
    return replacement === undefined ? unit : { origin: unit.origin, markdown: replacement };
  });
  return {
    version: 3,
    saveToken,
    transaction: {
      version: NOTO_MARKDOWN_VERSION,
      mode: 'blocks',
      envelope: { lineEnding: 'mixed' as const, hasFinalNewline: true },
      documentId: document.documentId,
      revisionId: document.revisionId,
      units,
    },
  };
}

async function harness() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noto-ft2-store-'));
  roots.push(root);
  const file = path.join(root, 'note.md');
  await writeFile(file, source, { mode: 0o640 });
  const store = new FileTruthStoreV1(path.join(root, 'user-data'), logger);
  const opened = await store.open(file);
  const candidate = candidateFrom(opened.document, opened.saveToken,
    new Map([[1, 'First changed.'], [3, 'Last changed.']]));
  return { root, file, store, opened, candidate };
}

function editingCandidate(
  document: NotoDocumentWire,
  saveToken: FileTruthSaveTokenV1,
  blockIndex: number,
  markdown: string,
): FileTruthEditCandidateV1 {
  return candidateFrom(document, saveToken, new Map([[blockIndex, markdown]]));
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('file-truth store with v3 editing transactions', () => {
  it('gives two open files with the same bytes different identities, so neither is shown or saved as the other', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'noto-ft2-twins-'));
    roots.push(root);
    // Two empty notes, the shape every new note and every untouched template
    // copy has. The identity used to be the hash of the bytes, so these two
    // were one document to everything keyed by it.
    const first = path.join(root, 'first.md');
    const second = path.join(root, 'second.md');
    await writeFile(first, '');
    await writeFile(second, '');
    const firstStore = new FileTruthStoreV1(path.join(root, 'user-data'), logger);
    const one = await firstStore.open(first);
    const other = await new FileTruthStoreV1(path.join(root, 'user-data'), logger).open(second);
    expect(one.document.envelope.sourceSha256).toBe(other.document.envelope.sourceSha256);
    expect(one.document.documentId).not.toBe(other.document.documentId);
    // The window asks the store in front to open again on startup; that is
    // the same document, under the same identity.
    expect((await firstStore.open(first)).document.documentId).toBe(one.document.documentId);
    expect(isFileTruthOpenResultV1({ ok: true, requestId: 'twin', value: other }, 'twin')).toBe(true);
  });

  it('saves ordered multi-block edits and returns the newly accepted document', async () => {
    const { file, store, candidate } = await harness();
    const outcome = await store.save(candidate);
    expect(outcome.status).toBe('saved');
    if (outcome.status !== 'saved') return;
    expect(await readFile(file, 'utf8')).toBe(source.replace('First.', 'First changed.').replace('Last.', 'Last changed.'));
    expect(outcome.document.text).toContain('First changed.');
    expect(outcome.document.text).toContain('Last changed.');
    // The untouched middle block must have survived without re-serialization.
    expect(outcome.document.text).toContain('Middle stays put.');
    expect(outcome.document.revisionId).toBe(outcome.saveToken.documentRevisionId);
    expect(outcome.document.envelope.sourceSha256).toBe(outcome.outputSha256);
    expect(await store.save(candidate)).toMatchObject({ status: 'stale-editor-revision', dirtyPreserved: true });
  });

  it('preserves external conflict and save-copy behavior', async () => {
    const conflictHarness = await harness();
    await conflictHarness.store.platform.replaceExternally(conflictHarness.file, Buffer.from('External.\n'));
    expect(await conflictHarness.store.save(conflictHarness.candidate)).toMatchObject({ status: 'external-conflict', dirtyPreserved: true });
    expect(await readFile(conflictHarness.file, 'utf8')).toBe('External.\n');

    const copyHarness = await harness();
    const copy = path.join(copyHarness.root, 'copy.md');
    expect(await copyHarness.store.saveCopy(copyHarness.candidate, copy)).toMatchObject({ status: 'copy-saved', dirtyPreserved: true });
    expect(await readFile(copy, 'utf8')).toContain('First changed.');
    expect(await readFile(copyHarness.file, 'utf8')).toBe(source);
  });

  it.each([
    ['before replacement', 'before-replacement', 'replacement-failed'],
    ['after replacement', 'after-replacement-before-journal-completion', 'recovery-needed'],
  ] as const)('reconstructs document identity across a crash %s and continues saving', async (_label, point, status) => {
    const { file, root, store, candidate } = await harness();
    store.platform.injector.arm(point);
    const interrupted = await store.save(candidate);
    expect(interrupted).toMatchObject({ status, dirtyPreserved: true });
    if (!('recovery' in interrupted) || !interrupted.recovery) throw new Error('Expected durable recovery evidence');

    // v3 derives identity from content, so the journal only has to record the
    // candidate's hash. There is no durable identity map to drift or rebind.
    const journal = JSON.parse(await readFile(interrupted.recovery.journalPath, 'utf8')) as Record<string, unknown>;
    expect(journal.schema).toBe('noto-file-truth-journal-v2');
    expect(journal).not.toHaveProperty('candidateEditingIdentity');
    expect(journal).not.toHaveProperty('candidateIdentity');
    const candidateSha256 = String(journal.candidateSha256);
    store.close();

    const reopened = new FileTruthStoreV1(path.join(root, 'user-data'), logger);
    const recoveryOpen = await reopened.open(file);
    expect(isFileTruthOpenResultV1({ ok: true, requestId: 'recovery-open', value: recoveryOpen }, 'recovery-open')).toBe(true);
    expect(recoveryOpen.recovery).not.toBeNull();
    // The reopened document is the durable candidate, under the identity this
    // open was given rather than one read off the bytes.
    expect(recoveryOpen.document.text).toContain('First changed.');
    expect(recoveryOpen.document.envelope.sourceSha256).toBe(candidateSha256);
    expect(recoveryOpen.document.documentId).not.toBe(`noto-doc-v3:${candidateSha256}`);

    const recovered = await reopened.recover();
    expect(recovered).toMatchObject({ status: 'saved', dirtyPreserved: false });
    expect(isFileTruthSaveResultV1({ ok: true, requestId: 'recovery-save', value: recovered }, 'recovery-save')).toBe(true);
    if (recovered.status !== 'saved') throw new Error('Expected a recovered save');
    expect(recovered.document.envelope.sourceSha256).toBe(candidateSha256);

    const continued = await reopened.save(editingCandidate(
      recovered.document,
      recovered.saveToken,
      1,
      'First changed again.',
    ));
    expect(continued).toMatchObject({ status: 'saved', dirtyPreserved: false });
    expect(await readFile(file, 'utf8')).toContain('Last changed.');
    expect(await readFile(file, 'utf8')).toContain('First changed again.');
    reopened.close();
  });

  it('rejects a journal from an older schema without deleting its evidence', async () => {
    const { file, root, store, candidate } = await harness();
    store.platform.injector.arm('before-replacement');
    const interrupted = await store.save(candidate);
    if (!('recovery' in interrupted) || !interrupted.recovery) throw new Error('Expected durable recovery evidence');
    const journal = JSON.parse(await readFile(interrupted.recovery.journalPath, 'utf8')) as Record<string, unknown>;
    journal.schema = 'noto-file-truth-journal-v1';
    await writeFile(interrupted.recovery.journalPath, `${JSON.stringify(journal)}\n`);
    store.close();

    const reopened = new FileTruthStoreV1(path.join(root, 'user-data'), logger);
    const recoveryOpen = await reopened.open(file);
    expect(recoveryOpen.initialOutcome).toMatchObject({ status: 'recovery-failed', dirtyPreserved: true });
    expect(await reopened.platform.exists(interrupted.recovery.journalPath)).toBe(true);
    expect(await reopened.platform.exists(interrupted.recovery.payloadPath)).toBe(true);
    reopened.close();
  });

  it('rejects a malformed journal without deleting its evidence', async () => {
    for (const corrupt of [
      (journal: Record<string, unknown>) => { journal.unexpected = true; },
      (journal: Record<string, unknown>) => { journal.candidateSha256 = 'not-a-hash'; },
      (journal: Record<string, unknown>) => { journal.stage = 'invented-stage'; },
      (journal: Record<string, unknown>) => { journal.posixMode = 99999; },
    ]) {
      const { file, root, store, candidate } = await harness();
      store.platform.injector.arm('before-replacement');
      const interrupted = await store.save(candidate);
      if (!('recovery' in interrupted) || !interrupted.recovery) throw new Error('Expected durable recovery evidence');
      const journal = JSON.parse(await readFile(interrupted.recovery.journalPath, 'utf8')) as Record<string, unknown>;
      corrupt(journal);
      await writeFile(interrupted.recovery.journalPath, `${JSON.stringify(journal)}\n`);
      store.close();

      const reopened = new FileTruthStoreV1(path.join(root, 'user-data'), logger);
      const recoveryOpen = await reopened.open(file);
      expect(recoveryOpen.initialOutcome).toMatchObject({ status: 'recovery-failed', dirtyPreserved: true });
      expect(await reopened.platform.exists(interrupted.recovery.journalPath)).toBe(true);
      expect(await reopened.platform.exists(interrupted.recovery.payloadPath)).toBe(true);
      reopened.close();
    }
  });

  it('detects a payload that does not match its journalled hash', async () => {
    const { file, root, store, candidate } = await harness();
    store.platform.injector.arm('before-replacement');
    const interrupted = await store.save(candidate);
    if (!('recovery' in interrupted) || !interrupted.recovery) throw new Error('Expected durable recovery evidence');
    await writeFile(interrupted.recovery.payloadPath, 'tampered payload\n');
    store.close();

    const reopened = new FileTruthStoreV1(path.join(root, 'user-data'), logger);
    const recoveryOpen = await reopened.open(file);
    expect(recoveryOpen.initialOutcome).toMatchObject({ status: 'recovery-failed', dirtyPreserved: true });
    expect(await reopened.platform.exists(interrupted.recovery.payloadPath)).toBe(true);
    reopened.close();
  });
});

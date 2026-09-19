import { chmod, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileTruthStoreV1 } from '../../src/main/file-truth/v1/file-truth-store';
import type { FileTruthFailurePointV1 } from '../../src/main/file-truth/v1/node-platform';
import { splitBlocks } from '../../src/shared/markdown/v3/blocks';

/**
 * Long enough for the watcher to notice and for its burst to settle.
 *
 * The watcher reports on a trailing delay so that a writer streaming a file
 * produces one report rather than a dozen, and reading the file between two of
 * somebody's writes would give half a document.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 700));
import { toLf } from '../../src/shared/markdown/v3/line-endings';
import { NOTO_MARKDOWN_VERSION, type NotoDocumentWire, type NotoUnit } from '../../src/shared/markdown/v3/contracts';
import type { FileTruthEditCandidateV1, FileTruthSaveTokenV1 } from '../../src/shared/file-truth/v1/contracts';

const roots: string[] = [];
const logger = { filePath: '/dev/null', log() {} };
const source = '# File truth\n\nOriginal paragraph.\n\n> A quoted aside.\n';

/**
 * Build a save candidate that edits the first paragraph and leaves every other
 * block pristine, which is what exercises the byte-preservation path.
 */
function editParagraph(document: NotoDocumentWire, saveToken: FileTruthSaveTokenV1,
  replacement = 'Edited paragraph.'): FileTruthEditCandidateV1 {
  const spans = splitBlocks(document.text).spans;
  let replaced = false;
  const units: NotoUnit[] = document.origins.map((origin, index) => {
    if (origin.kind === 'paragraph' && !replaced) {
      replaced = true;
      return { origin, markdown: replacement };
    }
    return { origin, markdown: toLf(spans[index].markdown) };
  });
  if (!replaced) throw new Error('fixture has no paragraph to edit');
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'noto-ft1-store-'));
  roots.push(root);
  const file = path.join(root, 'note.md');
  const userData = path.join(root, 'user-data');
  await writeFile(file, source, { mode: 0o640 });
  const store = new FileTruthStoreV1(userData, logger);
  const opened = await store.open(file);
  const candidate = editParagraph(opened.document, opened.saveToken);
  return { root, file, userData, store, opened, candidate };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('Noto file-truth v1 save transaction', () => {
  it('uses the accepted G002 document, preserves untouched bytes/mode, and advances only on saved', async () => {
    const { file, store, candidate } = await harness();
    const mode = (await stat(file)).mode & 0o7777;
    const outcome = await store.save(candidate);
    expect(outcome.status).toBe('saved');
    expect(await readFile(file, 'utf8')).toBe(source.replace('Original paragraph.', 'Edited paragraph.'));
    expect((await stat(file)).mode & 0o7777).toBe(mode);
    expect(store.diagnostics()).toMatchObject({ state: 'saved', lastOutcome: { status: 'saved' } });
    const stale = await store.save(candidate);
    expect(stale).toMatchObject({ status: 'stale-editor-revision', dirtyPreserved: true });
  });

  it('rejects observable external replacement without overwriting it', async () => {
    const { file, store, candidate } = await harness();
    const external = '# File truth\n\nExternal writer!\n';
    await store.platform.replaceExternally(file, Buffer.from(external));
    const outcome = await store.save(candidate);
    expect(outcome).toMatchObject({ status: 'external-conflict', dirtyPreserved: true, safeStage: 'before-temp-write' });
    expect(await readFile(file, 'utf8')).toBe(external);
  });

  it('admits only one main-process file-truth transaction at a time', async () => {
    const { store, candidate } = await harness();
    const first = store.save(candidate);
    const second = await store.save(candidate);
    const completed = await first;
    expect(completed.status).toBe('saved');
    expect(second).toMatchObject({ status: 'write-failed', dirtyPreserved: true });
    expect(second.message).toContain('Another file-truth transaction is active');
  });

  it('does not let recovery and a new save advance concurrently', async () => {
    const { store, candidate } = await harness();
    store.platform.injector.arm('before-replacement');
    expect((await store.save(candidate)).status).toBe('replacement-failed');
    const recovery = store.recover();
    const blocked = await store.save(candidate);
    expect(blocked).toMatchObject({ status: 'write-failed', dirtyPreserved: true });
    expect(blocked.message).toContain('Another file-truth transaction is active');
    expect((await recovery).status).toBe('saved');
  });

  it('rejects an external replacement during temp write and immediately before final validation', async () => {
    for (const point of ['during-temp-write', 'immediately-before-final-validation'] as const) {
      const { file, store, candidate } = await harness();
      const external = Buffer.from(`# File truth\n\nExternal ${point}.\n`);
      if (point === 'during-temp-write') {
        const writeTemp = store.platform.writeTemp.bind(store.platform);
        store.platform.writeTemp = async (handle, bytes) => {
          await writeTemp(handle, bytes);
          await store.platform.replaceExternally(file, external);
        };
      } else {
        const validate = store.platform.validateExpectedAndReplace.bind(store.platform);
        store.platform.validateExpectedAndReplace = async (tempPath, filePath, expected) => {
          await store.platform.replaceExternally(file, external);
          return validate(tempPath, filePath, expected);
        };
      }
      const outcome = await store.save(candidate);
      expect(outcome.status).toBe('external-conflict');
      expect(Buffer.from(await readFile(file)).equals(external)).toBe(true);
      store.close();
    }
  });

  const cases: Array<[FileTruthFailurePointV1, string]> = [
    ['before-temp-write', 'write-failed'], ['after-write', 'write-failed'], ['after-flush', 'flush-failed'],
    ['metadata', 'metadata-failed'], ['before-replace-validation', 'replacement-failed'], ['before-replacement', 'replacement-failed'], ['replacement', 'replacement-failed'],
    ['directory-flush', 'recovery-needed'], ['readback', 'recovery-needed'],
    ['after-replacement-before-journal-completion', 'recovery-needed'], ['cleanup', 'cleanup-failed'],
    ['payload-write', 'write-failed'], ['journal-write', 'write-failed'],
  ];
  for (const [point, status] of cases) {
    it(`maps ${point} to exact ${status} without false clean success`, async () => {
      const { file, store, candidate } = await harness();
      const before = await readFile(file);
      store.platform.injector.arm(point);
      const outcome = await store.save(candidate);
      expect(outcome.status).toBe(status);
      expect(outcome.dirtyPreserved).toBe(true);
      if (!['directory-flush', 'readback', 'after-replacement-before-journal-completion', 'cleanup'].includes(point)) {
        expect(Buffer.from(await readFile(file)).equals(before)).toBe(true);
      }
      expect(outcome.status).not.toBe('saved');
    });
  }

  it('replays a candidate after a pre-replacement crash and cleans journal, payload, and temp', async () => {
    const { file, store, candidate } = await harness();
    store.platform.injector.arm('before-replacement');
    const failed = await store.save(candidate);
    expect(failed.status).toBe('replacement-failed');
    if (!('recovery' in failed) || !failed.recovery) throw new Error('Expected durable recovery record');
    expect(Buffer.from(await readFile(failed.recovery.payloadPath)).equals(Buffer.from(source.replace('Original paragraph.', 'Edited paragraph.')))).toBe(true);
    expect((await stat(failed.recovery.payloadPath)).mode & 0o7777).toBe(0o600);
    expect((await stat(failed.recovery.journalPath)).mode & 0o7777).toBe(0o600);
    const recoveryStages: string[] = [];
    const writeDurable = store.platform.writeDurableFile.bind(store.platform);
    store.platform.writeDurableFile = async (filePath, bytes, mode) => {
      if (filePath.endsWith('.journal.json')) recoveryStages.push(JSON.parse(new TextDecoder().decode(bytes)).stage);
      await writeDurable(filePath, bytes, mode);
    };
    const recovered = await store.recover();
    expect(recovered.status).toBe('saved');
    expect(recoveryStages).toEqual(['replacement-complete', 'replacement-verified', 'journal-complete']);
    expect(store.diagnostics()).toMatchObject({ state: 'saved', lastOutcome: { status: 'saved' } });
    expect(await readFile(file, 'utf8')).toContain('Edited paragraph.');
    expect(await store.platform.listOwnedTemps(file)).toEqual([]);
  });

  it('persists recovery replacement-complete before directory sync and resumes cleanly in a fresh process', async () => {
    const { file, userData, store, candidate } = await harness();
    store.platform.injector.arm('before-replacement');
    const interrupted = await store.save(candidate);
    if (!('recovery' in interrupted) || !interrupted.recovery) throw new Error('Expected durable recovery record');

    store.platform.injector.arm('directory-flush');
    const replayed = await store.recover();
    expect(replayed).toMatchObject({ status: 'recovery-failed', safeStage: 'replacement-complete', dirtyPreserved: true });
    expect(await readFile(file, 'utf8')).toBe(source.replace('Original paragraph.', 'Edited paragraph.'));
    expect(JSON.parse(await readFile(interrupted.recovery.journalPath, 'utf8'))).toMatchObject({
      attemptId: interrupted.recovery.attemptId,
      stage: 'replacement-complete',
    });
    store.close();

    const reopened = new FileTruthStoreV1(userData, logger);
    const opened = await reopened.open(file);
    expect(opened.initialOutcome).toBeNull();
    expect(opened.recovery).toMatchObject({ attemptId: interrupted.recovery.attemptId, stage: 'replacement-complete' });
    expect(await reopened.recover()).toMatchObject({ status: 'saved', dirtyPreserved: false });
    expect(await readFile(file, 'utf8')).toBe(source.replace('Original paragraph.', 'Edited paragraph.'));
    expect(await reopened.platform.exists(interrupted.recovery.journalPath)).toBe(false);
    expect(await reopened.platform.exists(interrupted.recovery.payloadPath)).toBe(false);
    expect(await reopened.platform.listOwnedTemps(file)).toEqual([]);
    reopened.close();
  });

  it('reconciles exact candidate bytes and mode when recovery replacement-complete journal persistence failed', async () => {
    const { file, userData, store, candidate } = await harness();
    store.platform.injector.arm('before-replacement');
    const interrupted = await store.save(candidate);
    if (!('recovery' in interrupted) || !interrupted.recovery) throw new Error('Expected durable recovery record');

    const writeDurable = store.platform.writeDurableFile.bind(store.platform);
    let deniedReplacementComplete = false;
    store.platform.writeDurableFile = async (filePath, bytes, mode) => {
      if (!deniedReplacementComplete && filePath.endsWith('.journal.json')
        && new TextDecoder().decode(bytes).includes('"stage":"replacement-complete"')) {
        deniedReplacementComplete = true;
        throw Object.assign(new Error('replacement-complete journal denied'), { code: 'EIO' });
      }
      await writeDurable(filePath, bytes, mode);
    };
    const replayed = await store.recover();
    expect(deniedReplacementComplete).toBe(true);
    expect(replayed).toMatchObject({ status: 'recovery-failed', safeStage: 'precondition-confirmed', dirtyPreserved: true,
      recovery: { attemptId: interrupted.recovery.attemptId, stage: 'precondition-confirmed' } });
    expect(await readFile(file, 'utf8')).toBe(source.replace('Original paragraph.', 'Edited paragraph.'));
    expect(JSON.parse(await readFile(interrupted.recovery.journalPath, 'utf8'))).toMatchObject({
      attemptId: interrupted.recovery.attemptId,
      stage: 'precondition-confirmed',
    });
    store.close();

    const reopened = new FileTruthStoreV1(userData, logger);
    const opened = await reopened.open(file);
    expect(opened.initialOutcome).toBeNull();
    expect(opened.recovery).toMatchObject({ attemptId: interrupted.recovery.attemptId, stage: 'precondition-confirmed' });
    expect(await reopened.recover()).toMatchObject({ status: 'saved', dirtyPreserved: false });
    expect(await readFile(file, 'utf8')).toBe(source.replace('Original paragraph.', 'Edited paragraph.'));
    expect(await reopened.platform.exists(interrupted.recovery.journalPath)).toBe(false);
    expect(await reopened.platform.exists(interrupted.recovery.payloadPath)).toBe(false);
    reopened.close();
  });

  it('keeps precondition-confirmed recovery as an external conflict when disk bytes differ from the candidate', async () => {
    const { file, userData, store, candidate } = await harness();
    store.platform.injector.arm('before-replacement');
    const interrupted = await store.save(candidate);
    if (!('recovery' in interrupted) || !interrupted.recovery) throw new Error('Expected durable recovery record');
    const external = '# File truth\n\nDifferent external bytes.\n';
    await store.platform.replaceExternally(file, Buffer.from(external));
    store.close();

    const reopened = new FileTruthStoreV1(userData, logger);
    const opened = await reopened.open(file);
    expect(opened.initialOutcome).toBeNull();
    expect(opened.recovery?.stage).toBe('precondition-confirmed');
    expect(await reopened.recover()).toMatchObject({ status: 'external-conflict', dirtyPreserved: true });
    expect(await readFile(file, 'utf8')).toBe(external);
    expect(JSON.parse(await readFile(interrupted.recovery.journalPath, 'utf8'))).toMatchObject({
      attemptId: interrupted.recovery.attemptId,
      stage: 'precondition-confirmed',
    });
    expect(await reopened.platform.exists(interrupted.recovery.payloadPath)).toBe(true);
    reopened.close();
  });

  it('opens a fresh process on the durable candidate projection before recovery', async () => {
    const { file, userData, store, candidate } = await harness();
    store.platform.injector.arm('before-replacement');
    const failed = await store.save(candidate);
    expect(failed.status).toBe('replacement-failed');
    store.close();

    const reopened = new FileTruthStoreV1(userData, logger);
    const opened = await reopened.open(file);
    expect(opened.recovery?.attemptId).toBe(failed.attemptId);
    // The reopened process presents the durable candidate, not what is on disk.
    expect(opened.document.text).toContain('Edited paragraph.');
    expect(opened.document.revisionId).not.toBe(candidate.transaction.revisionId);
    expect((await reopened.recover()).status).toBe('saved');
    reopened.close();
  });

  it('blocks a new save while recovery evidence is active without replacing its journal or payload', async () => {
    const { store, candidate } = await harness();
    store.platform.injector.arm('before-replacement');
    const failed = await store.save(candidate);
    if (!('recovery' in failed) || !failed.recovery) throw new Error('Expected active recovery evidence');
    const journalBefore = await readFile(failed.recovery.journalPath);
    const payloadBefore = await readFile(failed.recovery.payloadPath);
    const filesBefore = (await readdir(store.recoveryRoot)).sort();

    const blocked = await store.save(candidate);
    expect(blocked).toMatchObject({ status: 'recovery-needed', dirtyPreserved: true,
      recoveryRecordId: failed.recovery.attemptId });
    expect(await readFile(failed.recovery.journalPath)).toEqual(journalBefore);
    expect(await readFile(failed.recovery.payloadPath)).toEqual(payloadBefore);
    expect((await readdir(store.recoveryRoot)).sort()).toEqual(filesBefore);
  });

  it('blocks after the first journal write fails and rediscovers the orphan payload on reopen', async () => {
    const { file, userData, store, candidate } = await harness();
    store.platform.injector.arm('journal-write');
    const failed = await store.save(candidate);
    expect(failed).toMatchObject({ status: 'write-failed', dirtyPreserved: true, recovery: null });
    const artifacts = (await readdir(store.recoveryRoot)).sort();
    expect(artifacts.some((name) => name.endsWith('.payload'))).toBe(true);
    const blocked = await store.save(candidate);
    expect(blocked).toMatchObject({ status: 'recovery-failed', dirtyPreserved: true });
    expect((await readdir(store.recoveryRoot)).sort()).toEqual(artifacts);
    store.close();

    const reopened = new FileTruthStoreV1(userData, logger);
    const opened = await reopened.open(file);
    expect(opened.initialOutcome).toMatchObject({ status: 'recovery-failed', dirtyPreserved: true });
    expect(opened.initialOutcome?.residuePaths.map((item) => path.basename(item)).sort()).toEqual(artifacts);
    reopened.close();
  });

  it('does not advance accepted revision before journal-complete is durable', async () => {
    const { root, store, opened, candidate } = await harness();
    const writeDurable = store.platform.writeDurableFile.bind(store.platform);
    store.platform.writeDurableFile = async (filePath, bytes, mode) => {
      if (filePath.endsWith('.journal.json') && new TextDecoder().decode(bytes).includes('"stage":"journal-complete"')) {
        throw Object.assign(new Error('final journal denied'), { code: 'EIO' });
      }
      await writeDurable(filePath, bytes, mode);
    };
    const failed = await store.save(candidate);
    expect(failed).toMatchObject({ status: 'recovery-needed', dirtyPreserved: true });
    expect(store.diagnostics().state).toBe('recovery-needed');
    const copy = path.join(root, 'journal-complete-copy.md');
    const copied = await store.saveCopy(candidate, copy);
    expect(copied.status).toBe('copy-saved');
    expect(await readFile(copy, 'utf8')).toContain('Edited paragraph.');
    expect(opened.saveToken.documentRevisionId).toBe(candidate.transaction.revisionId);
    if (!('recovery' in failed) || !failed.recovery) throw new Error('Expected durable recovery record');
    expect(JSON.parse(await readFile(failed.recovery.journalPath, 'utf8')).stage).toBe('replacement-verified');
    let recoveryJournalCompleteWrites = 0;
    store.platform.writeDurableFile = async (filePath, bytes, mode) => {
      if (filePath.endsWith('.journal.json') && new TextDecoder().decode(bytes).includes('"stage":"journal-complete"')) {
        recoveryJournalCompleteWrites += 1;
      }
      await writeDurable(filePath, bytes, mode);
    };
    expect((await store.recover()).status).toBe('saved');
    expect(recoveryJournalCompleteWrites).toBe(1);
  });

  it('rejects post-replacement recovery when the journaled POSIX mode no longer matches', async () => {
    const { file, store, candidate } = await harness();
    store.platform.injector.arm('after-replacement-before-journal-completion');
    const failed = await store.save(candidate);
    expect(failed.status).toBe('recovery-needed');
    await chmod(file, 0o600);
    const recovered = await store.recover();
    expect(recovered).toMatchObject({ status: 'recovery-failed', dirtyPreserved: true });
    expect(recovered.message).toContain('POSIX mode');
  });

  it('removes stale owned temps on open but preserves the temp referenced by recovery', async () => {
    const { file, userData, store, candidate } = await harness();
    const stale = store.platform.tempPathFor(file, 'stale-owned');
    await writeFile(stale, 'stale', { mode: 0o600 });
    store.platform.injector.arm('before-replacement');
    const failed = await store.save(candidate);
    if (!('recovery' in failed) || !failed.recovery?.tempPath) throw new Error('Expected recovery temp');
    const referenced = failed.recovery.tempPath;
    const reopened = new FileTruthStoreV1(userData, logger);
    const open = await reopened.open(file);
    expect(open.recovery?.tempPath).toBe(referenced);
    expect(await reopened.platform.exists(stale)).toBe(false);
    expect(await reopened.platform.exists(referenced)).toBe(true);
    reopened.close();
  });

  it('removes stale private durable-writer temps on open', async () => {
    const { file, userData, store } = await harness();
    store.close();
    await import('node:fs/promises').then(({ mkdir }) => mkdir(path.join(userData, 'file-truth-v1'), { recursive: true }));
    const stale = path.join(userData, 'file-truth-v1', 'record.payload.tmp-acde');
    await writeFile(stale, 'stale');
    const reopened = new FileTruthStoreV1(userData, logger);
    const opened = await reopened.open(file);
    expect(opened.initialOutcome).toBeNull();
    expect(await reopened.platform.exists(stale)).toBe(false);
    reopened.close();
  });

  it('reports stale-temp removal failure with exact residue instead of opening clean', async () => {
    const { file, userData, store } = await harness();
    store.close();
    const stale = store.platform.tempPathFor(file, 'stale-remove-failure');
    await writeFile(stale, 'stale');
    const reopened = new FileTruthStoreV1(userData, logger);
    reopened.platform.removeWithoutInjection = async () => { throw Object.assign(new Error('remove denied'), { code: 'EACCES' }); };
    const opened = await reopened.open(file);
    expect(opened.initialOutcome).toMatchObject({ status: 'recovery-failed', safeStage: 'cleanup' });
    expect(opened.initialOutcome?.residuePaths.map((value) => path.basename(value))).toEqual([path.basename(stale)]);
    expect(opened.initialOutcome?.message).toContain('EACCES');
    reopened.close();
  });

  it('nests temp-close and journal-read failures instead of masking the primary save failure', async () => {
    const closeHarness = await harness();
    closeHarness.store.platform.injector.arm('temp-close');
    const closeOutcome = await closeHarness.store.save(closeHarness.candidate);
    expect(closeOutcome).toMatchObject({ status: 'cleanup-failed', dirtyPreserved: true, primary: { dirtyPreserved: true } });
    expect(closeOutcome.message).toContain('temp-close');

    const readHarness = await harness();
    readHarness.store.platform.injector.arm('after-write');
    readHarness.store.platform.injector.arm('journal-read');
    const readOutcome = await readHarness.store.save(readHarness.candidate);
    expect(readOutcome).toMatchObject({ status: 'cleanup-failed', dirtyPreserved: true, primary: {
      status: 'write-failed', recoveryRecordId: expect.any(String),
    } });
    if (readOutcome.status !== 'cleanup-failed') throw new Error('Expected nested cleanup failure');
    expect(readOutcome.message).toContain('journal-read');
    expect(readOutcome.residuePaths.some((value) => value.endsWith('.journal.json'))).toBe(true);
  });

  it('reports private durable-writer residue when write and cleanup both fail', async () => {
    const { store, candidate } = await harness();
    store.platform.injector.arm('durable-write');
    store.platform.injector.arm('durable-remove');
    const outcome = await store.save(candidate);
    expect(outcome).toMatchObject({ status: 'write-failed', dirtyPreserved: true });
    expect(outcome.status === 'write-failed' && outcome.residuePaths.some((value) => /\.payload\.tmp-/.test(value))).toBe(true);
  });

  it.each(['payload', 'journal'] as const)('preserves saved primary and exact residue when %s cleanup fails', async (kind) => {
    const { store, candidate } = await harness();
    const remove = store.platform.remove.bind(store.platform);
    store.platform.remove = async (filePath) => {
      const matches = kind === 'payload' ? filePath.endsWith('.payload') : filePath.endsWith('.journal.json');
      if (matches) throw Object.assign(new Error(`${kind} cleanup denied`), { code: 'EACCES' });
      await remove(filePath);
    };
    const outcome = await store.save(candidate);
    expect(outcome).toMatchObject({ status: 'cleanup-failed', dirtyPreserved: true, primary: { status: 'saved' } });
    if (outcome.status !== 'cleanup-failed') throw new Error('Expected cleanup failure');
    expect(outcome.message).toContain(`EACCES:${kind} cleanup denied`);
    expect(outcome.residuePaths.some((value) => kind === 'payload' ? value.endsWith('.payload') : value.endsWith('.journal.json'))).toBe(true);
    expect(outcome.recoveryRecordId).toBe(outcome.primary.attemptId);
    if (!outcome.recovery) throw new Error('Expected journal-complete recovery evidence');
    expect(JSON.parse(await readFile(outcome.recovery.journalPath, 'utf8')).stage).toBe('journal-complete');
  });

  it('cleans replay temp on final conflict or reports cleanup-failed with exact residue', { timeout: 15_000 }, async () => {
    for (const cleanupFails of [false, true]) {
      const { file, store, candidate } = await harness();
      store.platform.injector.arm('before-replacement');
      const failed = await store.save(candidate);
      expect(failed.status).toBe('replacement-failed');
      const validate = store.platform.validateExpectedAndReplace.bind(store.platform);
      store.platform.validateExpectedAndReplace = async (tempPath, filePath, expected) => {
        await store.platform.replaceExternally(file, Buffer.from('# File truth\n\nReplay conflict.\n'));
        return validate(tempPath, filePath, expected);
      };
      if (cleanupFails) store.platform.injector.arm('cleanup');
      const recovered = await store.recover();
      if (cleanupFails) {
        expect(recovered).toMatchObject({ status: 'cleanup-failed', primary: { status: 'external-conflict' } });
        expect(recovered.status === 'cleanup-failed' && recovered.residuePaths.some((value) => /-recovery\.tmp$/.test(value))).toBe(true);
      } else {
        expect(recovered.status).toBe('external-conflict');
        expect((await store.platform.listOwnedTemps(file)).filter((value) => /-recovery\.tmp$/.test(value))).toEqual([]);
      }
      store.close();
    }
  });

  it('retains loaded journal identity, stage, and residue through broad recovery failures', async () => {
    const { store, candidate } = await harness();
    store.platform.injector.arm('before-replacement');
    const failed = await store.save(candidate);
    if (!('recovery' in failed) || !failed.recovery) throw new Error('Expected recovery record');
    store.platform.injector.arm('journal-read');
    const recovered = await store.recover();
    expect(recovered).toMatchObject({ status: 'recovery-failed', recoveryRecordId: failed.recovery.attemptId,
      safeStage: failed.recovery.stage, recovery: { attemptId: failed.recovery.attemptId } });
    expect(recovered.status === 'recovery-failed' && recovered.residuePaths).toEqual(expect.arrayContaining([
      failed.recovery.journalPath, failed.recovery.payloadPath, failed.recovery.tempPath,
    ]));
  });

  it('retains replay temp and journal evidence when recovery temp close fails', async () => {
    const { store, candidate } = await harness();
    store.platform.injector.arm('before-replacement');
    const failed = await store.save(candidate);
    if (!('recovery' in failed) || !failed.recovery) throw new Error('Expected recovery record');
    store.platform.injector.arm('temp-close');
    const recovered = await store.recover();
    expect(recovered).toMatchObject({ status: 'recovery-failed', recoveryRecordId: failed.recovery.attemptId });
    expect(recovered.message).toContain('temp-close');
    expect(recovered.status === 'recovery-failed' && recovered.residuePaths.some((value) => /-recovery\.tmp$/.test(value))).toBe(true);
  });

  it('uses adapter final expected-fingerprint validation in save and recovery', async () => {
    const saveHarness = await harness();
    let saveValidations = 0;
    const saveValidate = saveHarness.store.platform.validateExpectedAndReplace.bind(saveHarness.store.platform);
    saveHarness.store.platform.validateExpectedAndReplace = async (...args) => { saveValidations += 1; return saveValidate(...args); };
    expect((await saveHarness.store.save(saveHarness.candidate)).status).toBe('saved');
    expect(saveValidations).toBe(1);

    const recoveryHarness = await harness();
    recoveryHarness.store.platform.injector.arm('before-replacement');
    expect((await recoveryHarness.store.save(recoveryHarness.candidate)).status).toBe('replacement-failed');
    let recoveryValidations = 0;
    const recoveryValidate = recoveryHarness.store.platform.validateExpectedAndReplace.bind(recoveryHarness.store.platform);
    recoveryHarness.store.platform.validateExpectedAndReplace = async (...args) => { recoveryValidations += 1; return recoveryValidate(...args); };
    expect((await recoveryHarness.store.recover()).status).toBe('saved');
    expect(recoveryValidations).toBe(1);
  });

  it('reports somebody else writing the file, and stays quiet about its own save', async () => {
    const { file, store, candidate } = await harness();
    const seen: string[] = [];
    store.onExternalChange = (event) => { seen.push(event.kind); };

    // This app's own save replaces the file by rename, which is exactly the
    // operation that used to leave the watcher holding a file nothing points at.
    expect((await store.save(candidate)).status).toBe('saved');
    await settle();
    expect(seen).toEqual([]);

    // And the watcher is still listening afterwards, which is the part that
    // was broken: a rename left it permanently deaf.
    await writeFile(file, 'Edited paragraph.\n\nSomebody else wrote this.\n');
    await settle();
    expect(seen).toEqual(['changed']);
    store.close();
  });

  it('calls the same content under a new identity a rebase, not a change', async () => {
    const { root, file, store } = await harness();
    const seen: string[] = [];
    store.onExternalChange = (event) => { seen.push(event.kind); };

    // What a git checkout or a stash pop does: the same bytes arrive as a new
    // file. Nothing needs reloading, but the identity a save checks against has
    // moved and has to move with it.
    const replacement = path.join(root, 'same.md');
    await writeFile(replacement, source);
    await rename(replacement, file);
    await settle();
    expect(seen).toEqual(['rebased']);
    expect((await store.reload()).status).toBe('unchanged');
    store.close();
  });

  it('reports the file being taken away without touching the accepted document', async () => {
    const { file, store } = await harness();
    const seen: string[] = [];
    store.onExternalChange = (event) => { seen.push(event.kind); };
    await rm(file);
    await settle();
    expect(seen).toEqual(['missing']);
    // The buffer now holds the only copy, so a reload must not replace it.
    expect((await store.reload()).status).toBe('missing');
    store.close();
  });

  it('reloads what another program wrote, keeping the document identity', async () => {
    const { file, store } = await harness();
    const before = store.diagnostics();
    expect(before.state).toBe('opened');
    await writeFile(file, '# Replaced\n\nBy something else entirely.\n');
    const outcome = await store.reload();
    expect(outcome.status).toBe('reloaded');
    if (outcome.status !== 'reloaded') return;
    expect(outcome.opened.document.text).toContain('By something else entirely.');
    // The renderer keys its editors on this, so a reload that changed it would
    // tear the editor down and take the caret and the undo history with it.
    const reopened = await store.reload();
    expect(reopened.status).toBe('unchanged');
    store.close();
  });

  it('refuses a reload while a recovery record stands, rather than making the replay unverifiable', async () => {
    const { file, userData, store, candidate } = await harness();
    store.platform.injector.arm('after-replacement-before-journal-completion');
    expect((await store.save(candidate)).status).toBe('recovery-needed');
    const blocked = new FileTruthStoreV1(userData, logger);
    await blocked.open(file);
    expect(await blocked.reload()).toEqual({ version: 1, status: 'refused', reason: 'recovery-pending' });
    blocked.close();
    store.close();
  });

  it('reconciles a crash after replacement and keeps malformed journals safe', async () => {
    const { file, userData, store, candidate } = await harness();
    store.platform.injector.arm('after-replacement-before-journal-completion');
    expect((await store.save(candidate)).status).toBe('recovery-needed');
    expect((await store.recover()).status).toBe('saved');
    expect(await readFile(file, 'utf8')).toContain('Edited paragraph.');

    const reopened = new FileTruthStoreV1(userData, logger);
    const open = await reopened.open(file);
    const journal = path.join(reopened.recoveryRoot, `${(await import('node:crypto')).createHash('sha256').update(open.path).digest('hex')}.journal.json`);
    await writeFile(journal, JSON.stringify({ version: 1, schema: 'noto-file-truth-journal-v1', originalPath: '/unsafe' }));
    const unsafe = new FileTruthStoreV1(userData, logger);
    const unsafeOpen = await unsafe.open(file);
    expect(unsafeOpen.initialOutcome).toMatchObject({ status: 'recovery-failed', dirtyPreserved: true });
    const failed = await unsafe.recover();
    expect(failed).toMatchObject({ status: 'recovery-failed', dirtyPreserved: true });
    expect(await readFile(journal, 'utf8')).toContain('/unsafe');
  });

  it('save-copy never overwrites the original or clears dirty truth', async () => {
    const { root, file, store, candidate } = await harness();
    const copy = path.join(root, 'copy.md');
    const outcome = await store.saveCopy(candidate, copy);
    expect(outcome).toMatchObject({ status: 'copy-saved', dirtyPreserved: true, replacedOriginal: false });
    expect(await readFile(file, 'utf8')).toBe(source);
    expect(await readFile(copy, 'utf8')).toContain('Edited paragraph.');
  });

  it('leaves no copy target when private-temp writing fails and remains retryable', async () => {
    const { root, file, store, candidate } = await harness();
    const copy = path.join(root, 'copy-after-write.md');
    store.platform.injector.arm('after-write');
    expect(await store.saveCopy(candidate, copy)).toMatchObject({ status: 'write-failed', dirtyPreserved: true });
    await expect(stat(copy)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await store.platform.listOwnedTemps(copy)).toEqual([]);
    expect((await store.saveCopy(candidate, copy)).status).toBe('copy-saved');
    expect(await readFile(file, 'utf8')).toBe(source);
  });

  it.each(['directory-flush', 'readback'] as const)(
    'retains a complete published copy as explicit residue after %s uncertainty', async (point) => {
      const { root, file, store, candidate } = await harness();
      const copy = path.join(root, `copy-${point}.md`);
      store.platform.injector.arm(point);
      const failed = await store.saveCopy(candidate, copy);
      expect(failed).toMatchObject({ status: 'write-failed', dirtyPreserved: true });
      expect(failed.status === 'write-failed' && failed.residuePaths).toContain(copy);
      expect(await readFile(copy, 'utf8')).toContain('Edited paragraph.');
      expect((await stat(copy)).mode & 0o7777).toBe(0o640);
      expect(await store.platform.listOwnedTemps(copy)).toEqual([]);
      expect((await store.saveCopy(candidate, copy)).status).toBe('write-failed');
      expect(await readFile(file, 'utf8')).toBe(source);
    });

  it('re-arms after the file is replaced, which is what a rename used to break', async () => {
    const { root, file, store } = await harness();
    const seen: string[] = [];
    store.onExternalChange = (event) => { seen.push(event.kind); };

    // Three replacements in a row. Every one of them is a rename over the path,
    // and before the watcher re-armed on a rename only the first was ever seen.
    for (const line of ['one', 'two', 'three']) {
      const temp = path.join(root, `${line}.tmp`);
      await writeFile(temp, `# Note\n\n${line}\n`);
      await rename(temp, file);
      await settle();
    }
    expect(seen).toEqual(['changed', 'changed', 'changed']);
    store.close();
  });
});

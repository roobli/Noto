import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { FileTruthSaveOutcomeV1 } from '../../src/shared/file-truth/v1/contracts';
import { acceptedSaveOutcome, actionableFileTruthMessage, fileTruthActions, outcomeHasRecoveryEvidence,
  presentFileTruthOutcome, reloadNeedsConfirm, savedSnapshotLeavesDirty,
} from '../../src/renderer/file-truth-state';
import { exceptionalAlertPresentation } from '../../src/renderer/App';

const base = { version: 1, attemptId: 'attempt', safeStage: 'before-temp-write', dirtyPreserved: true, message: 'message' } as const;
const savedOutcome = { ...base, status: 'saved', dirtyPreserved: false } as unknown as FileTruthSaveOutcomeV1;
const failedOutcome = { ...base, status: 'write-failed', message: 'Current file-truth failure' } as unknown as FileTruthSaveOutcomeV1;

describe('file-truth renderer state', () => {
  it('keeps a saved outcome alone quiet', () => {
    expect(exceptionalAlertPresentation(false, savedOutcome, null)).toBeNull();
  });

  it('shows a local editor rejection instead of stale saved outcome copy', () => {
    expect(exceptionalAlertPresentation(false, savedOutcome, 'Current local rejection'))
      .toEqual({ message: 'Current local rejection' });
  });

  it('gives a current file-truth failure precedence over a local editor rejection', () => {
    expect(exceptionalAlertPresentation(false, failedOutcome, 'Current local rejection'))
      .toEqual({ message: 'Current file-truth failure' });
  });

  it('shows durable recovery attention when only the current barrier remains', () => {
    expect(exceptionalAlertPresentation(true, savedOutcome, null))
      .toEqual({ message: 'A durable recovery record needs attention before this document can be clean.' });
  });

  it('hides initial recovery attention after recovery clears the current barrier', () => {
    expect(exceptionalAlertPresentation(true, savedOutcome, null)).not.toBeNull();
    expect(exceptionalAlertPresentation(false, savedOutcome, null)).toBeNull();
  });

  it('keeps an empty exceptional state quiet', () => {
    expect(exceptionalAlertPresentation(false, null, null)).toBeNull();
  });

  it('raises the bar for a file that moved under the document, which has no outcome of its own', () => {
    expect(exceptionalAlertPresentation(false, null, null, 'Changed on disk')?.message)
      .toContain('unsaved changes are still here');
    expect(exceptionalAlertPresentation(false, null, null, 'File removed')?.message)
      .toContain('only copy');
    expect(exceptionalAlertPresentation(false, null, null, 'Saved')).toBeNull();
  });

  it.each([
    ['external-conflict', 'External conflict'], ['stale-editor-revision', 'Stale editor revision'],
    ['serialization-failed', 'Save failed'], ['write-failed', 'Save failed'], ['flush-failed', 'Save failed'],
    ['replacement-failed', 'Save failed'], ['metadata-failed', 'Save failed'], ['recovery-needed', 'Recovery needed'],
    ['recovery-failed', 'Recovery failed'], ['cleanup-failed', 'Cleanup failed'],
  ])('never presents %s as clean Saved', (status, expected) => {
    let outcome: unknown;
    if (status === 'cleanup-failed') {
      outcome = { ...base, status, primary: { ...base, status: 'write-failed', recovery: null, recoveryRecordId: null, residuePaths: [] }, residuePaths: [] };
    } else if (status === 'external-conflict') {
      outcome = { ...base, status, acceptedFingerprint: null, currentFingerprint: null };
    } else if (status === 'stale-editor-revision') {
      outcome = { ...base, status, acceptedRevisionId: 'a', candidateRevisionId: 'b' };
    } else {
      outcome = { ...base, status, recovery: null, recoveryRecordId: null, residuePaths: [] };
    }
    expect(presentFileTruthOutcome(outcome as unknown as FileTruthSaveOutcomeV1)).toEqual({ state: expected, dirty: true });
  });

  it('keeps newer edits dirty after an in-flight saved snapshot returns', () => {
    expect(savedSnapshotLeavesDirty(4, 4)).toBe(false);
    expect(savedSnapshotLeavesDirty(4, 5)).toBe(true);
  });

  it('preserves actionable transport text while removing controls and bounding display', () => {
    expect(actionableFileTruthMessage('\u0000SAVE_TRANSPORT: disk denied\nRetry after restoring access.', 'fallback'))
      .toBe('SAVE_TRANSPORT: disk denied\nRetry after restoring access.');
    expect(actionableFileTruthMessage('', 'Exact fallback')).toBe('Exact fallback');
    expect(actionableFileTruthMessage('x'.repeat(3_000), 'fallback')).toHaveLength(2_048);
  });


  it('asks before a dirty reload and never before a clean one', () => {
    expect(reloadNeedsConfirm(false)).toBe(false);
    expect(reloadNeedsConfirm(true)).toBe(true);
  });

  it('offers only actions valid for editor and recovery truth', () => {
    expect(fileTruthActions('Recovery failed', false)).toEqual(['retry-recovery']);
    expect(fileTruthActions('Recovery failed', true)).toEqual(['retry-recovery', 'save-copy']);
    expect(fileTruthActions('Recovery needed', true)).toEqual(['retry-recovery', 'save-copy']);
    expect(fileTruthActions('Cleanup failed', false)).toEqual(['retry-recovery']);
    expect(fileTruthActions('Cleanup failed', true)).toEqual(['retry-recovery', 'save-copy']);
    // Reload comes first for a conflict: the file on disk is ahead, and taking
    // it is usually what was wanted. Saving a copy is there for when it is not.
    expect(fileTruthActions('External conflict', true)).toEqual(['reload', 'save-copy']);
    expect(fileTruthActions('Stale editor revision', true)).toEqual(['save-copy']);
    expect(fileTruthActions('Save failed', false)).toEqual([]);
    // Offered with nothing unsaved too: a reader who turned silent reloading
    // off still needs a way to take the new version.
    expect(fileTruthActions('Changed on disk', false)).toEqual(['reload']);
    expect(fileTruthActions('Changed on disk', true)).toEqual(['reload', 'save-copy']);
    expect(fileTruthActions('File removed', true)).toEqual([]);
  });

  it('extracts an accepted save token from cleanup failure while retaining the recovery barrier', () => {
    const saved = { ...base, status: 'saved', dirtyPreserved: false, accepted: { version: 1, canonicalPath: '/note.md',
      posixMode: 0o644, fingerprint: { version: 1, objectId: 'object', byteLength: 1, mtimeNanoseconds: '1', contentSha256: 'a'.repeat(64) } },
    saveToken: { version: 1, documentRevisionId: 'next', editorRevision: 1,
      fingerprint: { version: 1, objectId: 'object', byteLength: 1, mtimeNanoseconds: '1', contentSha256: 'a'.repeat(64) } },
    outputSha256: 'a'.repeat(64), replacedOriginal: true } as const;
    const cleanup = { ...base, status: 'cleanup-failed', primary: saved, recovery: null,
      recoveryRecordId: null, residuePaths: ['/journal'] } as unknown as FileTruthSaveOutcomeV1;
    expect(acceptedSaveOutcome(cleanup)?.saveToken.documentRevisionId).toBe('next');
    expect(outcomeHasRecoveryEvidence(cleanup)).toBe(true);
  });

});

/*
 * The checks below read the shell's source directly. That is blunt, but these
 * are ordering and containment properties (capture before pending, IPC inside
 * try, no fabricated dirty state) that a unit test cannot observe without a DOM,
 * and getting them wrong loses a user's edits rather than showing a wrong pixel.
 */
describe('shell failure containment', () => {
  const shell = () => readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8');
  const between = (text: string, from: string, to: string) => text.slice(text.indexOf(from), text.indexOf(to));

  it('surfaces a rejected bootstrap instead of falling back to a second shell', async () => {
    const app = await shell();
    expect(app).toContain('<BootstrapFailure message={boot.error} />');
    expect(app).toContain('error: result.error.message');
    // There is exactly one workspace component; no capability flag chooses between two.
    expect(app.match(/function NotoWorkspace/g)).toHaveLength(1);
    expect(app).not.toContain('result.value.enabled');
  });

  it('contains a rejected open transport and never reports a clean document', async () => {
    const app = await shell();
    const openFlow = between(app, 'const open = async () => {', '    void open();');
    expect(openFlow.indexOf('try {')).toBeLessThan(openFlow.indexOf('await window.notoFileTruth.open'));
    expect(openFlow.indexOf('await window.notoFileTruth.open')).toBeLessThan(openFlow.indexOf('catch (error) {'));
    expect(openFlow).toContain('if (!active) return;');
    expect(openFlow).toContain("actionableFileTruthMessage(error, 'The document could not be opened.')");
    expect(openFlow).toContain("setState('Save failed');");
    // A failed open must not leave a document adopted, so nothing on the
    // failure path may reach `adopt`.
    expect(openFlow.slice(openFlow.indexOf('catch (error) {'))).not.toContain('adopt(');
    expect(openFlow).not.toContain('.then(');
  });

  it('rejects a refused capture before pending or IPC, without fabricating a recovery barrier', async () => {
    const app = await shell();
    const saveFlow = between(app, 'const save = async () => {', '  const recover = async () => {');
    const captureIndex = saveFlow.indexOf('editor.capture()');
    const captureCatch = saveFlow.indexOf('catch (error) {', captureIndex);
    const rejection = saveFlow.slice(captureCatch, saveFlow.indexOf('try {', captureCatch));
    expect(captureIndex).toBeGreaterThan(-1);
    expect(captureCatch).toBeLessThan(saveFlow.indexOf('setPending(true)'));
    expect(saveFlow.indexOf('setPending(true)')).toBeLessThan(saveFlow.indexOf('await window.notoFileTruth.save'));
    expect(rejection).toContain('The editor refused this save.');
    expect(rejection).toContain("setState('Unsaved changes');");
    expect(rejection).toContain('return;');
    expect(rejection).not.toContain('setPending(');
    expect(rejection).not.toContain('window.notoFileTruth.save');
    expect(rejection).not.toContain('updateRecoveryBarrier(');
  });

  it('contains a rejected save transport and leaves the editor dirty', async () => {
    const app = await shell();
    const saveFlow = between(app, 'const save = async () => {', '  const recover = async () => {');
    const invoke = saveFlow.indexOf('await window.notoFileTruth.save');
    const transportCatch = saveFlow.indexOf('catch (error) {', invoke);
    expect(saveFlow.indexOf('present(result.value);')).toBeGreaterThan(invoke);
    expect(saveFlow.indexOf('present(result.value);')).toBeLessThan(transportCatch);
    const failure = saveFlow.slice(transportCatch);
    expect(failure).toContain("actionableFileTruthMessage(error, 'The save transport failed. Your edits are still here.')");
    expect(failure).toContain('setOutcome(null);');
    expect(failure).toContain("setState('Save failed');");
    expect(failure).toContain('updateRecoveryBarrier(true);');
    // Dirtiness belongs to the editor. A failed save must not clear it, and the
    // shell must not invent it either.
    expect(failure).not.toContain('updateEditorDirty(false)');
  });

  it('contains a rejected recovery transport without reloading the window', async () => {
    const app = await shell();
    const recoverFlow = between(app, 'const recover = async () => {', '  const saveCopy = async () => {');
    expect(recoverFlow.indexOf('try {')).toBeLessThan(recoverFlow.indexOf('await window.notoFileTruth.recover'));
    expect(recoverFlow.indexOf('await window.notoFileTruth.recover')).toBeLessThan(recoverFlow.indexOf('catch (error) {'));
    const rejection = recoverFlow.slice(recoverFlow.indexOf('catch (error) {'));
    expect(rejection).toContain('setPending(false);');
    expect(rejection).toContain('setOutcome(null);');
    expect(rejection).toContain("actionableFileTruthMessage(error, 'Recovery transport failed. Evidence remains on disk.')");
    expect(rejection).toContain("setState('Recovery failed');");
    expect(recoverFlow).not.toContain('location.reload()');
  });

  it('tears the editor down through the canvas rather than leaking a live view', async () => {
    const canvas = await readFile(new URL('../../src/renderer/editor/noto/NotoCanvas.tsx', import.meta.url), 'utf8');
    // Open parses off-thread, so cleanup closes over the editor that actually
    // finished mounting and tears that instance down before destroying it.
    expect(canvas).toContain('onTeardown(current);');
    expect(canvas).toContain('current.destroy();');
    expect(canvas.indexOf('onTeardown(current);')).toBeLessThan(canvas.indexOf('current.destroy();'));
    // Construction failure must reach the shell instead of leaving a blank canvas.
    expect(canvas).toContain('onError(error instanceof Error ? error.message');
  });


  it('routes a dirty reload through the confirm rather than discarding at once', async () => {
    const app = await shell();
    expect(app).toContain('reloadNeedsConfirm');
    expect(app).toContain('requestReloadFromDisk');
    expect(app).toContain('<ReloadConfirmDialog');
    // Banner and menu both go through the ask; the silent clean path does not.
    expect(app).toContain('requestReloadFromDisk(id)');
    expect(app).toContain("case 'reload-from-disk':");
    const menuCase = between(app, "case 'reload-from-disk': {", "case 'insert-image':");
    expect(menuCase).toContain('requestReloadFromDiskRef.current(id)');
    expect(menuCase).not.toContain('reloadFromDiskRef.current(id)');
  });

  it('contains save-copy failure without reporting a clean copy', async () => {
    const app = await shell();
    const saveCopy = between(app, 'const saveCopy = async (): Promise<boolean> => {', '  const confirmDiscard =');
    expect(saveCopy.indexOf('editor.capture()')).toBeGreaterThan(saveCopy.indexOf('try {'));
    expect(saveCopy.indexOf('await window.notoFileTruth.saveCopy')).toBeGreaterThan(saveCopy.indexOf('try {'));
    expect(saveCopy).toContain('Save a copy failed. The original is unchanged.');
    expect(saveCopy).toContain("setState('Save failed');");
    expect(saveCopy.indexOf('present(result.value);')).toBeLessThan(saveCopy.indexOf('catch (error) {'));
  });

  it('adopts the saved document as the clean baseline and gates save behind recovery evidence', async () => {
    const app = await shell();
    expect(app).toContain('editorRef.current?.commit(accepted.document);');
    // The accepted revision replaces the document's own state, keyed by the
    // document the save belonged to rather than whichever tab is in front.
    expect(app).toContain("patchDoc(id, { token: accepted.saveToken, document: accepted.document");
    expect(app).toContain('fileTruthActions(state, editorDirty, recoveryBarrier)');
    // Save is drawn only when there is something to save, and is still refused
    // while a recovery barrier or a conflict stands.
    expect(app).toContain("{(editorDirty || state === 'Save failed') && (");
    expect(app).toContain('disabled={pending || saveBlocked}');
  });

  it('restores the last honest clean state when the editor becomes clean again', async () => {
    const app = await shell();
    expect(app).toContain("const cleanStateRef = useRef<'Opened' | 'Saved'>('Opened');");
    expect(app).toContain("cleanStateRef.current = 'Opened';");
    expect(app).toContain("cleanStateRef.current = 'Saved';");
    expect(app).toContain("dirty ? 'Unsaved changes' : existing.cleanState,");
  });

  it('clears a stale rejection alert when undo restores a clean editor, but not behind a barrier', async () => {
    const app = await shell();
    const boundary = between(app, 'const onDocumentDirtyChange = useCallback', 'const closeSettings =');
    // A clean editor clears the stale outcome and message, but only when no
    // recovery evidence is standing in the way.
    expect(boundary).toContain('!dirty && !recoveryBarrierRef.current ? null : existing.outcome');
    expect(boundary).toContain('if (!dirty && !recoveryBarrierRef.current) setLocalMessage(null);');
    expect(boundary).toContain('recoveryBarrierRef.current\n          ? existing.state');
  });

  it('lets a real file-truth failure outrank a local editor rejection', async () => {
    const app = await shell();
    expect(app).toContain('exceptionalAlertPresentation(recoveryBarrier, outcome, localMessage, state)');
  });
});

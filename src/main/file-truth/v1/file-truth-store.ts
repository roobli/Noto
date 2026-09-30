import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { DocumentWatcher } from './document-watcher';
import type { StructuredLogger } from '../../logger';
import { parseDocument, toWire } from '../../../shared/markdown/v3/document';
import { serializeDocument } from '../../../shared/markdown/v3/serialize';
import type { NotoDocument, NotoDocumentWire } from '../../../shared/markdown/v3/contracts';
import type {
  FileFingerprintV1,
  FileTruthDiagnosticsV1,
  FileTruthEditCandidateV1,
  FileTruthExternalConflictV1,
  FileTruthFailureV1,
  FileTruthOpenReplyV1,
  FileTruthRecoveryRecordV1,
  FileTruthSaveOutcomeV1,
  FileTruthStageV1,
  FileTruthExternalChangeKindV1,
  FileTruthReloadOutcomeV1,
  FileTruthSaveTokenV1,
} from '../../../shared/file-truth/v1/contracts';
import {
  InjectedFileTruthFailure,
  FileTruthPlatformOperationError,
  NodeFileTruthPlatform,
} from './node-platform';

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/**
 * The document a save replies with, without the parser's node cache.
 *
 * The editor is already mounted when a save lands and only needs the text, the
 * offsets and the origins to take the saved file as its new baseline. The node
 * cache is what open ships so the editor can mount without parsing; on a save
 * of the 8 MB benchmark document it was one entry per block, 43,970 of them,
 * and copying it to the renderer took most of a second.
 */
function saveReplyWire(document: NotoDocument): NotoDocumentWire {
  const { nodesEnrichment: _unused, ...rest } = document;
  return toWire({ ...rest, nodes: null });
}
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
function messageOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as NodeJS.ErrnoException).code;
  return code ? `${code}:${error.message}` : error.message;
}

/**
 * The journal is exactly the public recovery record now.
 *
 * Markdown v3 derives block identity from content, so a recovered payload
 * reparses to the same document identity it had when it was written. That
 * removed the durable identity map the v2 journal had to carry, along with the
 * whole class of rebind failures it could produce.
 */
type JournalV1 = FileTruthRecoveryRecordV1;

/** What the store tells its owner when the file moved under the document. */
export interface ExternalChange {
  readonly kind: FileTruthExternalChangeKindV1;
  readonly saveToken: FileTruthSaveTokenV1 | null;
}

const journalStages = new Set<FileTruthStageV1>([
  'before-temp-write', 'candidate-durable', 'temp-written', 'temp-flushed', 'metadata-applied',
  'precondition-confirmed', 'replacement-complete', 'replacement-verified', 'journal-complete', 'cleanup',
]);
const hashPattern = /^[a-f0-9]{64}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));

function isFingerprint(value: unknown): value is FileFingerprintV1 {
  return record(value) && exact(value, ['version', 'object', 'byteLength', 'mtimeNanoseconds', 'contentSha256'])
    && value.version === 1 && record(value.object) && exact(value.object, ['scheme', 'opaqueId', 'basis'])
    && value.object.scheme === 'noto-file-object-v1'
    && (value.object.basis === 'inode' || value.object.basis === 'path')
    && typeof value.object.opaqueId === 'string'
    && value.object.opaqueId.length > 0 && Number.isSafeInteger(value.byteLength) && Number(value.byteLength) >= 0
    && typeof value.mtimeNanoseconds === 'string' && /^\d+$/.test(value.mtimeNanoseconds)
    && typeof value.contentSha256 === 'string' && hashPattern.test(value.contentSha256);
}

function publicRecovery(journal: JournalV1 | null): FileTruthRecoveryRecordV1 | null {
  return journal;
}

function classifySaveFailure(error: unknown, stage: FileTruthStageV1): FileTruthFailureV1['status'] {
  const injected = error instanceof InjectedFileTruthFailure ? error.point : null;
  if (injected === 'metadata') return 'metadata-failed';
  if (injected === 'replacement' || injected === 'before-replacement' || injected === 'before-replace-validation') return 'replacement-failed';
  if (injected === 'directory-flush' && stage === 'replacement-complete') return 'recovery-needed';
  if (injected === 'after-flush' || injected === 'directory-flush') return 'flush-failed';
  if (injected === 'after-replacement-before-journal-completion') return 'recovery-needed';
  if (stage === 'replacement-complete' || stage === 'replacement-verified' || stage === 'journal-complete') return 'recovery-needed';
  if (stage === 'before-temp-write' || stage === 'candidate-durable' || stage === 'temp-written') return 'write-failed';
  return 'flush-failed';
}

export class FileTruthStoreV1 {
  private document: NotoDocument | null = null;
  private acceptedPath: string | null = null;
  private acceptedFingerprint: FileFingerprintV1 | null = null;
  private acceptedMode = 0;
  private editorRevision = 0;
  private recovery: JournalV1 | null = null;
  private recoveryBlocked = false;
  private transactionActive = false;
  private readonly watcher: DocumentWatcher;
  private watcherGeneration = 0;
  private watcherEvents = { self: 0, foreign: 0 };
  /**
   * Told when the file behind this document changed under it.
   *
   * A callback rather than a window, so the store keeps no Electron import and
   * stays testable with a plain function.
   */
  onExternalChange: ((event: ExternalChange) => void) | null = null;
  private state: FileTruthDiagnosticsV1['state'] = 'closed';
  private lastOutcome: FileTruthSaveOutcomeV1 | null = null;
  readonly recoveryRoot: string;

  constructor(
    userDataPath: string,
    private readonly logger: StructuredLogger,
    readonly platform = new NodeFileTruthPlatform(),
  ) {
    this.recoveryRoot = path.join(userDataPath, 'file-truth-v1');
    this.watcher = new DocumentWatcher({
      onChanged: () => { void this.checkExternalChange(); },
      onDiagnostic: (event, detail) => this.logger.log(event, detail),
    });
  }

  /** The document currently open, or null before the first successful open. */
  get openPath(): string | null {
    return this.acceptedPath;
  }

  /**
   * Whether this document must not be moved or removed right now.
   *
   * A save in flight has a temporary file beside the original and is about to
   * rename it over the top. A recovery record is durable evidence keyed to the
   * accepted path, so moving the file would leave a payload nothing can ever
   * replay and the reader's unsaved work inside it.
   */
  get busy(): boolean {
    return this.transactionActive || this.recovery !== null || this.recoveryBlocked;
  }

  /**
   * Follow the file to a new path, keeping the document and its identity.
   *
   * A rename within one filesystem leaves the inode, the size, the mtime and
   * every byte untouched, so the accepted fingerprint still describes the file
   * exactly and the renderer's save token stays valid. Only the name changed,
   * and the name is not part of what a save checks. That is why a renamed note
   * keeps its unsaved edits and its undo history rather than being reopened.
   *
   * Refused while busy, for the reason `busy` gives.
   */
  adoptPath(next: string): boolean {
    if (!this.acceptedPath || this.busy) return false;
    this.acceptedPath = next;
    this.startWatcher();
    this.logger.log('file_truth_path_adopted', {});
    return true;
  }

  /**
   * Open a file, replacing whatever was open before.
   *
   * Every piece of per-document state is reset first. Carrying an accepted
   * fingerprint or a recovery record across a document switch would let a save
   * validate against the wrong file.
   */
  async open(filePath: string): Promise<FileTruthOpenReplyV1> {
    this.watcher.close();
    this.document = null;
    this.acceptedPath = null;
    this.acceptedFingerprint = null;
    this.acceptedMode = 0;
    this.editorRevision = 0;
    this.recovery = null;
    this.recoveryBlocked = false;
    this.lastOutcome = null;
    this.state = 'closed';

    const captured = await this.platform.capture(filePath);
    const parsed = parseDocument(captured.bytes);
    if (parsed.status !== 'parsed') throw new Error(`FILE_TRUTH_PARSE_FAILED:${parsed.code}`);
    this.document = parsed.document;
    this.acceptedPath = captured.identity.canonicalPath;
    this.acceptedFingerprint = captured.identity.fingerprint;
    this.acceptedMode = captured.identity.posixMode;
    let initialOutcome: FileTruthFailureV1 | null = null;
    try {
      this.recovery = await this.loadJournalSafe();
      this.recoveryBlocked = Boolean(this.recovery);
    }
    catch (error) {
      this.recovery = null;
      this.recoveryBlocked = true;
      initialOutcome = this.failure('recovery-failed', randomUUID(), 'before-temp-write',
        `Recovery journal is unsafe or malformed. No referenced file was deleted. ${error instanceof Error ? error.message : ''}`, null, []);
    }
    if (!initialOutcome && !this.recovery) {
      const orphaned = await this.platform.listRecoveryArtifacts(this.recoveryRoot, sha256(this.acceptedPath));
      if (orphaned.length > 0) {
        this.recoveryBlocked = true;
        initialOutcome = this.failure('recovery-failed', randomUUID(), 'candidate-durable',
          'Durable recovery payload exists without a safe journal. Existing evidence was preserved and saving is blocked.',
          null, orphaned);
      }
    }
    if (!initialOutcome && this.recovery) {
      try {
        const candidateBytes = await this.platform.readBytes(this.recovery.payloadPath);
        if (candidateBytes.byteLength !== this.recovery.candidateByteLength
          || sha256(candidateBytes) !== this.recovery.candidateSha256) {
          throw new Error('RECOVERY_PAYLOAD_MISMATCH');
        }
        const candidate = parseDocument(candidateBytes);
        if (candidate.status !== 'parsed') throw new Error(`RECOVERY_PARSE_FAILED:${candidate.code}`);
        this.document = candidate.document;
      } catch (error) {
        this.recoveryBlocked = true;
        const evidence = await this.residueEvidence([
          this.recovery.journalPath, this.recovery.payloadPath, this.recovery.tempPath,
        ]);
        initialOutcome = this.failure('recovery-failed', randomUUID(), this.recovery.stage,
          `Recovery candidate cannot be projected safely. Existing evidence was preserved. ${messageOf(error)}`,
          this.recovery, evidence.paths);
      }
    }
    if (!initialOutcome) {
      const cleanupCandidates: string[] = [];
      try {
        const protectedTemp = this.recovery?.tempPath;
        for (const temp of await this.platform.listOwnedTemps(captured.identity.canonicalPath)) {
          if (temp !== protectedTemp) cleanupCandidates.push(temp);
        }
        if (await this.platform.exists(this.recoveryRoot)) {
          cleanupCandidates.push(...await this.platform.listDurableInternalTemps(this.recoveryRoot));
        }
        for (const temp of cleanupCandidates) await this.platform.removeWithoutInjection(temp);
      } catch (error) {
        this.recoveryBlocked = true;
        const evidence = await this.residueEvidence(cleanupCandidates);
        initialOutcome = this.failure('recovery-failed', randomUUID(), 'cleanup',
          `Stale temporary-file cleanup failed. ${messageOf(error)}${evidence.errors.length ? `; evidence:${evidence.errors.join('|')}` : ''}`,
          this.recovery, evidence.paths);
      }
    }
    this.state = initialOutcome ? 'failed' : this.recovery ? 'recovery-needed' : 'opened';
    this.startWatcher();
    this.logger.log('file_truth_opened', {
      recoveryNeeded: Boolean(this.recovery),
      sha256: captured.identity.fingerprint.contentSha256,
    });
    return {
      version: 1,
      path: captured.identity.canonicalPath,
      document: toWire(this.document),
      saveToken: this.saveToken(),
      recovery: publicRecovery(this.recovery),
      initialOutcome,
    };
  }

  diagnostics(): FileTruthDiagnosticsV1 {
    return { version: 1, state: this.state, watcherGeneration: this.watcherGeneration, watcherEvents: { ...this.watcherEvents }, lastOutcome: this.lastOutcome };
  }

  async save(candidate: FileTruthEditCandidateV1): Promise<FileTruthSaveOutcomeV1> {
    const attemptId = randomUUID();
    if (this.transactionActive) {
      return this.failure('write-failed', attemptId, 'before-temp-write',
        'Another file-truth transaction is active. No second save was started.', this.recovery, []);
    }
    this.transactionActive = true;
    try { return await this.saveLocked(candidate, attemptId); }
    finally { this.transactionActive = false; }
  }

  private async saveLocked(candidate: FileTruthEditCandidateV1, attemptId: string): Promise<FileTruthSaveOutcomeV1> {
    if (!this.document || !this.acceptedPath || !this.acceptedFingerprint) {
      return this.failure('write-failed', attemptId, 'before-temp-write', 'The file is not open.', null, []);
    }
    if (this.recovery || this.recoveryBlocked) {
      const recovery = this.recovery;
      const evidence = await this.residueEvidence([
        this.expectedJournalPath(), recovery?.payloadPath, recovery?.tempPath,
      ]);
      return this.failure(recovery ? 'recovery-needed' : 'recovery-failed', attemptId,
        recovery?.stage ?? 'before-temp-write',
        recovery
          ? 'Resolve or preserve the active recovery record before starting another save. Existing recovery evidence was not replaced.'
          : 'Unsafe or incomplete recovery evidence blocks saving. Preserve a copy and repair recovery before replacing the original.',
        recovery, evidence.paths);
    }
    if (candidate.saveToken.editorRevision !== this.editorRevision
      || candidate.saveToken.documentRevisionId !== this.document.revisionId
      || !this.platform.sameFingerprint(candidate.saveToken.fingerprint, this.acceptedFingerprint)
      || candidate.transaction.revisionId !== this.document.revisionId) {
      return this.finish({ version: 1, status: 'stale-editor-revision', attemptId, safeStage: 'before-temp-write', dirtyPreserved: true,
        message: 'The editor snapshot is stale. Capture the current document before retrying.', acceptedRevisionId: this.document.revisionId,
        candidateRevisionId: candidate.transaction.revisionId });
    }
    const serialized = this.serializeCandidate(candidate);
    if ('failure' in serialized) return this.failure('serialization-failed', attemptId, 'before-temp-write', serialized.failure, null, []);
    const output = serialized.outputBytes;
    const recovery = this.recoveryPaths(attemptId, output);
    let tempHandle: Awaited<ReturnType<NodeFileTruthPlatform['createExclusiveTemp']>> | null = null;
    let stage: FileTruthStageV1 = 'before-temp-write';
    let primary: FileTruthSaveOutcomeV1 | null = null;
    try {
      const current = await this.platform.fingerprint(this.acceptedPath);
      if (!this.platform.sameFingerprint(this.acceptedFingerprint, current)) {
        primary = this.conflict(attemptId, stage, current);
        return this.finish(primary);
      }
      this.recoveryBlocked = true;
      this.platform.injector.hit('payload-write');
      await this.platform.writeDurableFile(recovery.payloadPath, output, 0o600);
      stage = 'candidate-durable';
      await this.persistJournal({ ...recovery, stage });
      tempHandle = await this.platform.createExclusiveTemp(recovery.tempPath!);
      await this.platform.writeTemp(tempHandle, output);
      stage = 'temp-written';
      await this.persistJournal({ ...recovery, stage });
      await this.platform.flush(tempHandle);
      stage = 'temp-flushed';
      await this.persistJournal({ ...recovery, stage });
      await this.platform.applyAndVerifyMode(tempHandle, this.acceptedMode);
      stage = 'metadata-applied';
      await this.persistJournal({ ...recovery, stage });
      await this.platform.closeHandle(tempHandle);
      tempHandle = null;
      stage = 'precondition-confirmed';
      await this.persistJournal({ ...recovery, stage });
      const replacement = await this.platform.validateExpectedAndReplace(recovery.tempPath!, this.acceptedPath, this.acceptedFingerprint,
        () => { this.watcher.suspend(); });
      if (replacement.status === 'conflict') {
        primary = this.conflict(attemptId, stage, replacement.current);
        return await this.cleanupThen(primary, recovery);
      }
      stage = 'replacement-complete';
      await this.persistJournal({ ...recovery, stage });
      this.platform.injector.hit('after-replacement-before-journal-completion');
      await this.platform.syncDirectory(path.dirname(this.acceptedPath));
      const accepted = await this.platform.verifyReadback(this.acceptedPath, output, this.acceptedMode);
      stage = 'replacement-verified';
      await this.persistJournal({ ...recovery, stage });
      stage = 'journal-complete';
      await this.persistJournal({ ...recovery, stage });
      this.document = serialized.document;
      this.acceptedFingerprint = accepted.fingerprint;
      // The file this document lives in is a new one now, because a save
      // replaces it by rename. The watcher was suspended over the replacement
      // and has to be pointed at the file that exists after it.
      this.startWatcher();
      this.editorRevision += 1;
      primary = {
        version: 1, status: 'saved', attemptId, safeStage: stage, dirtyPreserved: false,
        message: 'Saved after fingerprint validation, atomic replacement, directory sync, and readback verification.',
        accepted, saveToken: this.saveToken(), outputSha256: serialized.outputSha256, replacedOriginal: true,
        document: saveReplyWire(serialized.document),
      };
      this.state = 'saved';
      return await this.cleanupThen(primary, { ...recovery, stage });
    } catch (error) {
      let closeError: unknown = null;
      if (tempHandle) {
        try { await this.platform.closeHandle(tempHandle); }
        catch (failure) { closeError = failure; }
      }
      const status = classifySaveFailure(error, stage);
      if (error instanceof InjectedFileTruthFailure && error.point === 'temp-close') closeError ??= error;
      let journal: JournalV1 | null = this.recovery;
      let journalError: unknown = null;
      try { journal = await this.loadJournalSafe() ?? journal; }
      catch (failure) { journalError = failure; }
      const evidence = await this.residueEvidence([
        recovery.journalPath, recovery.payloadPath, recovery.tempPath,
        ...(error instanceof FileTruthPlatformOperationError ? error.residuePaths : []),
      ]);
      if (!journal && evidence.paths.length === 0) this.recoveryBlocked = false;
      primary = this.failure(status, attemptId, stage,
        `${status}: ${messageOf(error)}${closeError ? `; temp-close:${messageOf(closeError)}` : ''}${journalError ? `; journal-read:${messageOf(journalError)}` : ''}${evidence.errors.length ? `; residue-check:${evidence.errors.join('|')}` : ''}`,
        journal, evidence.paths);
      if (status === 'recovery-needed') this.state = 'recovery-needed';
      this.logger.log('file_truth_save_non_success', { attemptId, stage, status });
      if (closeError || journalError) return this.cleanupFailure(primary, evidence.paths,
        `The save failed and failure evidence could not be finalized cleanly.${closeError ? ` temp-close:${messageOf(closeError)}` : ''}${journalError ? ` journal-read:${messageOf(journalError)}` : ''}`);
      return this.finish(primary);
    }
  }

  async saveCopy(candidate: FileTruthEditCandidateV1, destinationPath: string): Promise<FileTruthSaveOutcomeV1> {
    const attemptId = randomUUID();
    if (this.transactionActive) {
      return this.failure('write-failed', attemptId, 'before-temp-write',
        'Another file-truth transaction is active. No copy was started.', this.recovery, []);
    }
    this.transactionActive = true;
    try { return await this.saveCopyLocked(candidate, destinationPath, attemptId); }
    finally { this.transactionActive = false; }
  }

  private async saveCopyLocked(candidate: FileTruthEditCandidateV1, destinationPath: string,
    attemptId: string): Promise<FileTruthSaveOutcomeV1> {
    if (!this.document || !this.acceptedPath) return this.failure('write-failed', attemptId, 'before-temp-write', 'The file is not open.', null, []);
    if (path.resolve(destinationPath) === path.resolve(this.acceptedPath)) {
      return this.failure('replacement-failed', attemptId, 'before-temp-write', 'Save a copy cannot overwrite the original.', null, []);
    }
    const serialized = this.serializeCandidate(candidate);
    if ('failure' in serialized) return this.failure('serialization-failed', attemptId, 'before-temp-write', serialized.failure, null, []);
    const target = path.resolve(destinationPath);
    const temporary = this.platform.tempPathFor(target, `${attemptId}-copy`);
    let handle: Awaited<ReturnType<NodeFileTruthPlatform['createExclusiveTemp']>> | null = null;
    try {
      handle = await this.platform.createExclusiveTemp(temporary);
      await this.platform.writeTemp(handle, serialized.outputBytes);
      await this.platform.flush(handle);
      await this.platform.applyAndVerifyMode(handle, this.acceptedMode);
      await this.platform.closeHandle(handle);
      handle = null;
      await this.platform.publishExclusive(temporary, target, serialized.outputBytes, this.acceptedMode);
      return this.finish({ version: 1, status: 'copy-saved', attemptId, safeStage: 'replacement-verified', dirtyPreserved: true,
        message: 'A copy was saved. The original remains unchanged and current edits remain dirty.', destinationPath: target,
        outputSha256: serialized.outputSha256, replacedOriginal: false });
    } catch (error) {
      let closeError: unknown = null;
      if (handle) {
        try { await this.platform.closeHandle(handle); } catch (failure) { closeError = failure; }
      }
      try { await this.platform.removeWithoutInjection(temporary); } catch (failure) { closeError ??= failure; }
      const evidence = await this.residueEvidence([
        temporary, target, ...(error instanceof FileTruthPlatformOperationError ? error.residuePaths : []),
      ]);
      return this.failure('write-failed', attemptId, 'before-temp-write',
        `Copy failed: ${messageOf(error)}${closeError ? `; cleanup:${messageOf(closeError)}` : ''}${evidence.errors.length ? `; residue-check:${evidence.errors.join('|')}` : ''}`,
        null, evidence.paths);
    }
  }

  async recover(): Promise<FileTruthSaveOutcomeV1> {
    const attemptId = randomUUID();
    if (this.transactionActive) {
      return this.failure('recovery-failed', attemptId, 'before-temp-write',
        'Another file-truth transaction is active. Recovery was not started.', this.recovery, []);
    }
    this.transactionActive = true;
    try { return await this.recoverLocked(attemptId); }
    finally { this.transactionActive = false; }
  }

  private async recoverLocked(attemptId: string): Promise<FileTruthSaveOutcomeV1> {
    let journal: JournalV1 | null = this.recovery;
    let stage: FileTruthStageV1 = journal?.stage ?? 'before-temp-write';
    let replayTemp: string | null = null;
    try {
      const loaded = await this.loadJournalSafe();
      if (!loaded) return this.failure('recovery-failed', attemptId, 'before-temp-write', 'No valid recovery journal is available.', null, []);
      journal = loaded;
      this.recovery = loaded;
      this.recoveryBlocked = true;
      stage = journal.stage;
      const bytes = await this.platform.readBytes(journal.payloadPath);
      if (bytes.byteLength !== journal.candidateByteLength || sha256(bytes) !== journal.candidateSha256) {
        const evidence = await this.residueEvidence([journal.journalPath, journal.payloadPath, journal.tempPath]);
        return this.failure('recovery-failed', attemptId, journal.stage,
          `Recovery payload is missing or corrupt. No referenced file was deleted.${evidence.errors.length ? ` Evidence:${evidence.errors.join('|')}` : ''}`,
          journal, evidence.paths);
      }
      const parsedCandidate = parseDocument(bytes);
      if (parsedCandidate.status !== 'parsed') {
        const evidence = await this.residueEvidence([journal.journalPath, journal.payloadPath, journal.tempPath]);
        return this.failure('recovery-failed', attemptId, journal.stage,
          'Durable candidate bytes cannot be parsed as a Noto document. The original was not replaced.',
          journal, evidence.paths);
      }
      const recoveredDocument = parsedCandidate.document;
      if (journal.stage === 'replacement-complete' || journal.stage === 'replacement-verified' || journal.stage === 'journal-complete') {
        return await this.completeRecoveredReplacement(attemptId, journal, bytes, recoveredDocument,
          'Recovery verified the completed replacement and reconciled the accepted document.');
      }
      let currentCapture: Awaited<ReturnType<NodeFileTruthPlatform['capture']>> | null = null;
      try { currentCapture = await this.platform.capture(journal.originalPath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const current = currentCapture?.identity.fingerprint ?? null;
      if (!this.platform.sameFingerprint(journal.acceptedFingerprint, current)) {
        const candidateAlreadyPublished = journal.stage === 'precondition-confirmed'
          && currentCapture !== null
          && currentCapture.identity.posixMode === journal.posixMode
          && Buffer.from(currentCapture.bytes).equals(Buffer.from(bytes));
        if (!candidateAlreadyPublished) return this.conflict(attemptId, journal.stage, current);
        stage = 'replacement-complete';
        const completedJournal: JournalV1 = { ...journal, stage };
        await this.persistJournal(completedJournal);
        journal = completedJournal;
        return await this.completeRecoveredReplacement(attemptId, journal, bytes, recoveredDocument,
          'Recovery reconciled the exact durable candidate after replacement journal persistence was interrupted.');
      }
      if (journal.tempPath && await this.platform.exists(journal.tempPath)) await this.platform.removeWithoutInjection(journal.tempPath);
      replayTemp = this.platform.tempPathFor(journal.originalPath, `${attemptId}-recovery`);
      const handle = await this.platform.createExclusiveTemp(replayTemp);
      try { await this.platform.writeTemp(handle, bytes); await this.platform.flush(handle); await this.platform.applyAndVerifyMode(handle, journal.posixMode); }
      finally { await this.platform.closeHandle(handle); }
      stage = 'metadata-applied';
      const replacement = await this.platform.validateExpectedAndReplace(replayTemp, journal.originalPath, journal.acceptedFingerprint,
        () => { this.watcher.suspend(); });
      if (replacement.status === 'conflict') {
        const primary = this.conflict(attemptId, stage, replacement.current);
        try { await this.platform.remove(replayTemp); replayTemp = null; return this.finish(primary); }
        catch (error) {
          const evidence = await this.residueEvidence([replayTemp, journal.journalPath, journal.payloadPath, journal.tempPath]);
          return this.cleanupFailure(primary, evidence.paths,
            `Recovery detected an external conflict, then replay-temp cleanup failed: ${messageOf(error)}${evidence.errors.length ? `; evidence:${evidence.errors.join('|')}` : ''}`);
        }
      }
      stage = 'replacement-complete';
      const completedJournal: JournalV1 = { ...journal, stage, tempPath: replayTemp };
      await this.persistJournal(completedJournal);
      journal = completedJournal;
      return await this.completeRecoveredReplacement(attemptId, journal, bytes, recoveredDocument,
        'Recovery replayed the durable candidate and verified the replacement.');
    } catch (error) {
      const retainedJournal = this.recovery ?? journal;
      const retainedStage = retainedJournal?.stage ?? stage;
      const expectedJournal = this.expectedJournalPath();
      const evidence = await this.residueEvidence([
        expectedJournal,
        retainedJournal?.payloadPath,
        retainedJournal?.tempPath,
        replayTemp,
        ...(error instanceof FileTruthPlatformOperationError ? error.residuePaths : []),
      ]);
      return this.failure('recovery-failed', attemptId, retainedStage,
        `Recovery failed safely at ${retainedStage}: ${messageOf(error)}. Recovery record ${retainedJournal?.attemptId ?? 'unavailable'} was retained.${evidence.errors.length ? ` Evidence:${evidence.errors.join('|')}` : ''}`,
        retainedJournal, evidence.paths);
    }
  }

  private async completeRecoveredReplacement(attemptId: string, journal: JournalV1, bytes: Uint8Array,
    document: NotoDocument, message: string): Promise<FileTruthSaveOutcomeV1> {
    let durableJournal = journal;
    if (durableJournal.stage === 'replacement-complete') {
      await this.platform.syncDirectory(path.dirname(durableJournal.originalPath));
    }
    let accepted: Awaited<ReturnType<NodeFileTruthPlatform['verifyReadback']>>;
    try { accepted = await this.platform.verifyReadback(durableJournal.originalPath, bytes, durableJournal.posixMode); }
    catch (error) {
      if (!(error instanceof Error)
        || (error.message !== 'READBACK_BYTES_MISMATCH' && error.message !== 'READBACK_MODE_MISMATCH')) throw error;
      const evidence = await this.residueEvidence([durableJournal.journalPath, durableJournal.payloadPath, durableJournal.tempPath]);
      return this.failure('recovery-failed', attemptId, durableJournal.stage,
        'Replacement state is uncertain and does not match the durable candidate bytes and POSIX mode.', durableJournal, evidence.paths);
    }
    if (durableJournal.stage !== 'replacement-verified' && durableJournal.stage !== 'journal-complete') {
      const verifiedJournal: JournalV1 = { ...durableJournal, stage: 'replacement-verified' };
      await this.persistJournal(verifiedJournal);
      durableJournal = verifiedJournal;
    }
    if (durableJournal.stage !== 'journal-complete') {
      const completeJournal: JournalV1 = { ...durableJournal, stage: 'journal-complete' };
      await this.persistJournal(completeJournal);
      durableJournal = completeJournal;
    }
    this.document = document;
    this.acceptedFingerprint = accepted.fingerprint;
    this.acceptedMode = accepted.posixMode;
    this.editorRevision += 1;
    const primary = { version: 1, status: 'saved', attemptId, safeStage: 'replacement-verified', dirtyPreserved: false,
      message, accepted, saveToken: this.saveToken(), outputSha256: durableJournal.candidateSha256, replacedOriginal: true,
      document: toWire(document) } as const;
    this.state = 'saved';
    return await this.cleanupThen(primary, durableJournal);
  }

  close(): void { this.watcher.close(); this.onExternalChange = null; }

  private saveToken() {
    if (!this.document || !this.acceptedFingerprint) throw new Error('FILE_NOT_OPEN');
    return { version: 1 as const, documentRevisionId: this.document.revisionId, editorRevision: this.editorRevision, fingerprint: this.acceptedFingerprint };
  }

  private serializeCandidate(candidate: FileTruthEditCandidateV1):
    | { failure: string }
    | { outputBytes: Uint8Array; outputSha256: string; document: NotoDocument } {
    if (!this.document) return { failure: 'The accepted document is unavailable.' };
    const result = serializeDocument(this.document, candidate.transaction);
    if (result.status !== 'serialized') return { failure: result.message };
    return { outputBytes: result.outputBytes, outputSha256: result.outputSha256, document: result.document };
  }

  private recoveryPaths(attemptId: string, bytes: Uint8Array): JournalV1 {
    if (!this.acceptedPath || !this.acceptedFingerprint) throw new Error('FILE_NOT_OPEN');
    const key = sha256(this.acceptedPath);
    const journalPath = path.join(this.recoveryRoot, `${key}.journal.json`);
    const payloadPath = path.join(this.recoveryRoot, `${key}.${attemptId}.payload`);
    return { version: 1, schema: 'noto-file-truth-journal-v2', attemptId, stage: 'before-temp-write', originalPath: this.acceptedPath,
      payloadPath, journalPath, tempPath: this.platform.tempPathFor(this.acceptedPath, attemptId), candidateSha256: sha256(bytes),
      candidateByteLength: bytes.byteLength, acceptedFingerprint: this.acceptedFingerprint, posixMode: this.acceptedMode };
  }

  private async persistJournal(journal: JournalV1): Promise<void> {
    this.platform.injector.hit('journal-write');
    await this.platform.writeDurableFile(journal.journalPath, encoder.encode(`${JSON.stringify(journal)}\n`), 0o600);
    this.recovery = journal;
    this.recoveryBlocked = true;
  }

  private async loadJournalSafe(): Promise<JournalV1 | null> {
    if (!this.acceptedPath) return null;
    const expected = this.expectedJournalPath();
    if (!await this.platform.exists(expected)) return null;
    const raw = decoder.decode(await this.platform.readBytes(expected, true));
    const value = JSON.parse(raw) as unknown;
    const keys = ['version', 'schema', 'attemptId', 'stage', 'originalPath', 'payloadPath', 'journalPath', 'tempPath',
      'candidateSha256', 'candidateByteLength', 'acceptedFingerprint', 'posixMode'];
    const safe = record(value) && exact(value, keys)
      && value.version === 1 && value.schema === 'noto-file-truth-journal-v2'
      && value.originalPath === this.acceptedPath && value.journalPath === expected
      && typeof value.payloadPath === 'string' && path.dirname(value.payloadPath) === this.recoveryRoot
      && path.basename(value.payloadPath).endsWith('.payload')
      && (value.tempPath === null || (typeof value.tempPath === 'string' && path.dirname(value.tempPath) === path.dirname(this.acceptedPath)
        && /^\.noto-ft1-[A-Za-z0-9_-]+\.tmp$/.test(path.basename(value.tempPath))))
      && typeof value.candidateSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.candidateSha256)
      && Number.isSafeInteger(value.candidateByteLength) && Number(value.candidateByteLength) >= 0
      && typeof value.attemptId === 'string' && value.attemptId.length > 0 && value.attemptId.length <= 128
      && path.basename(value.payloadPath) === `${sha256(this.acceptedPath)}.${value.attemptId}.payload`
      && typeof value.stage === 'string' && journalStages.has(value.stage as FileTruthStageV1)
      && isFingerprint(value.acceptedFingerprint)
      && Number.isSafeInteger(value.posixMode) && Number(value.posixMode) >= 0 && Number(value.posixMode) <= 0o7777;
    if (!safe) throw new Error('UNSAFE_OR_MALFORMED_RECOVERY_JOURNAL');
    return value as unknown as JournalV1;
  }

  private conflict(attemptId: string, stage: FileTruthStageV1, current: FileFingerprintV1 | null): FileTruthExternalConflictV1 {
    this.state = 'conflict';
    return { version: 1, status: 'external-conflict', attemptId, safeStage: stage, dirtyPreserved: true,
      // Says what the window can actually do: reload takes the disk version
      // (after a confirm when the buffer is dirty), and save a copy keeps the
      // unsaved edits under a new path.
      message: 'The file changed on disk, so it was not overwritten. Your work is still here. Reload from disk to take their version, or save a copy to keep yours.',
      acceptedFingerprint: this.acceptedFingerprint!, currentFingerprint: current };
  }

  private failure(status: FileTruthFailureV1['status'], attemptId: string, stage: FileTruthStageV1, message: string,
    recovery: FileTruthRecoveryRecordV1 | null, residuePaths: readonly string[]): FileTruthFailureV1 {
    this.state = status === 'recovery-needed' ? 'recovery-needed' : 'failed';
    return this.finish({ version: 1, status, attemptId, safeStage: stage, dirtyPreserved: true, message,
      recovery: publicRecovery(recovery), recoveryRecordId: recovery?.attemptId ?? null, residuePaths });
  }

  private finish<T extends FileTruthSaveOutcomeV1>(outcome: T): T { this.lastOutcome = outcome; return outcome; }

  private async cleanupThen(primary: Exclude<FileTruthSaveOutcomeV1, { status: 'cleanup-failed' }>, journal: JournalV1): Promise<FileTruthSaveOutcomeV1> {
    try {
      if (journal.tempPath) await this.platform.remove(journal.tempPath);
      await this.platform.remove(journal.payloadPath);
      await this.platform.remove(journal.journalPath);
      this.recovery = null;
      this.recoveryBlocked = false;
      return this.finish(primary);
    } catch (error) {
      const evidence = await this.residueEvidence([journal.journalPath, journal.payloadPath, journal.tempPath]);
      return this.cleanupFailure(primary, evidence.paths,
        `The primary operation completed but cleanup failed. Verify residue before treating the editor as clean. ${messageOf(error)}${evidence.errors.length ? `; evidence:${evidence.errors.join('|')}` : ''}`);
    }
  }

  private cleanupFailure(primary: Exclude<FileTruthSaveOutcomeV1, { status: 'cleanup-failed' }>, residuePaths: readonly string[], message: string): FileTruthSaveOutcomeV1 {
    this.state = 'failed';
    this.recoveryBlocked = true;
    return this.finish({ version: 1, status: 'cleanup-failed', attemptId: primary.attemptId, safeStage: 'cleanup', dirtyPreserved: true,
      message, primary, recovery: publicRecovery(this.recovery), recoveryRecordId: this.recovery?.attemptId ?? null, residuePaths });
  }

  private expectedJournalPath(): string {
    if (!this.acceptedPath) return path.join(this.recoveryRoot, 'unknown.journal.json');
    return path.join(this.recoveryRoot, `${sha256(this.acceptedPath)}.journal.json`);
  }

  private async residueEvidence(candidates: readonly (string | null | undefined)[]): Promise<{ paths: string[]; errors: string[] }> {
    const paths: string[] = [];
    const errors: string[] = [];
    for (const candidate of new Set(candidates.filter((value): value is string => Boolean(value)))) {
      try { if (await this.platform.exists(candidate)) paths.push(candidate); }
      catch (error) { paths.push(candidate); errors.push(`${candidate}:${messageOf(error)}`); }
    }
    return { paths, errors };
  }

  /**
   * Watch the file this document was read from.
   *
   * A generation count is still kept, because the diagnostics contract reports
   * it and a reader chasing a watcher that stopped wants to know how many times
   * it was re-armed.
   */
  private startWatcher(): void {
    if (!this.acceptedPath) return;
    this.watcherGeneration += 1;
    this.watcher.arm(this.acceptedPath);
  }

  /**
   * Work out what happened to the file, and tell the renderer if it matters.
   *
   * This is where a write of our own is told apart from somebody else's, and
   * the only test that is actually trustworthy is the last one: compare the
   * file's identity and content against what this store accepted. A timing
   * window would answer wrongly for a save that takes longer than the window,
   * and every other signal is a guess.
   *
   * Identical content under a new identity is a rebase, not a change: a git
   * checkout that restores the same bytes, or a plain touch. Nothing needs
   * reloading, but the accepted identity has to move to the new file or the
   * next save would fail its precondition against a file that no longer exists.
   */
  private async checkExternalChange(): Promise<void> {
    const accepted = this.acceptedFingerprint;
    const filePath = this.acceptedPath;
    if (!accepted || !filePath || !this.document) return;

    let current: FileFingerprintV1 | null;
    try {
      current = await this.platform.fingerprint(filePath);
    } catch {
      // Still being written, or briefly not a regular file. The watcher will
      // fire again when it settles; reporting a half-written file would be
      // worse than reporting nothing.
      return;
    }

    if (current === null) {
      this.watcherEvents.foreign += 1;
      this.logger.log('file_truth_external_missing', { generation: this.watcherGeneration });
      // The accepted identity is left alone on purpose: the buffer now holds
      // the only copy of this note, and a save has to be able to write it back.
      this.onExternalChange?.({ kind: 'missing', saveToken: null });
      return;
    }

    if (current.object.opaqueId === accepted.object.opaqueId
      && current.mtimeNanoseconds === accepted.mtimeNanoseconds
      && current.contentSha256 === accepted.contentSha256) {
      this.watcherEvents.self += 1;
      return;
    }

    if (current.contentSha256 === accepted.contentSha256) {
      this.acceptedFingerprint = current;
      this.watcherEvents.self += 1;
      this.logger.log('file_truth_external_rebased', { generation: this.watcherGeneration });
      this.onExternalChange?.({ kind: 'rebased', saveToken: this.saveToken() });
      return;
    }

    this.watcherEvents.foreign += 1;
    this.logger.log('file_truth_external_changed', { generation: this.watcherGeneration });
    this.onExternalChange?.({ kind: 'changed', saveToken: null });
  }

  /**
   * Read the file again and make it the accepted document.
   *
   * The document id is carried over from the document being replaced. It is
   * otherwise derived from the bytes, and the renderer keys its editors and its
   * React tree on it, so taking the freshly parsed id would tear the editor
   * down and rebuild it: the caret, the scroll position and the undo history
   * would all go, which is the opposite of what reloading a note in place is
   * for. A save already breaks the id-equals-current-bytes property for the
   * same reason.
   *
   * Refused rather than queued while a save is in flight or a recovery record
   * stands. The journal is replayed against the accepted identity, and moving
   * that identity would leave the replay unverifiable.
   */
  async reload(): Promise<FileTruthReloadOutcomeV1> {
    if (!this.document || !this.acceptedPath || !this.acceptedFingerprint) {
      return { version: 1, status: 'refused', reason: 'no-document' };
    }
    if (this.transactionActive) return { version: 1, status: 'refused', reason: 'save-in-flight' };
    if (this.recovery || this.recoveryBlocked) return { version: 1, status: 'refused', reason: 'recovery-pending' };

    this.transactionActive = true;
    try {
      const previousId = this.document.documentId;
      const accepted = this.acceptedFingerprint;
      let captured;
      try {
        captured = await this.platform.capture(this.acceptedPath);
      } catch {
        return { version: 1, status: 'missing' };
      }
      if (captured.identity.fingerprint.contentSha256 === accepted.contentSha256) {
        // Same bytes. Move the identity so the next save has a precondition
        // that still names a file, and leave the buffer untouched.
        this.acceptedFingerprint = captured.identity.fingerprint;
        return { version: 1, status: 'unchanged' };
      }
      const parsed = parseDocument(captured.bytes);
      if (parsed.status !== 'parsed') return { version: 1, status: 'refused', reason: 'parse-failed' };

      this.document = { ...parsed.document, documentId: previousId };
      this.acceptedFingerprint = captured.identity.fingerprint;
      this.acceptedMode = captured.identity.posixMode;
      this.editorRevision = 0;
      this.state = 'opened';
      this.lastOutcome = null;
      this.startWatcher();
      this.logger.log('file_truth_reloaded', { sha256: captured.identity.fingerprint.contentSha256 });
      return {
        version: 1,
        status: 'reloaded',
        opened: {
          version: 1,
          path: captured.identity.canonicalPath,
          document: toWire(this.document),
          saveToken: this.saveToken(),
          recovery: null,
          initialOutcome: null,
        },
      };
    } finally {
      this.transactionActive = false;
    }
  }
}

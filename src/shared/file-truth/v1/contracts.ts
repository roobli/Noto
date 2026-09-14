import type {
  NotoDocumentWire,
  NotoRevisionId,
  NotoTransaction,
} from '../../markdown/v3/contracts';

export const NOTO_FILE_TRUTH_VERSION = 1 as const;

/** The three platforms Noto treats as first class. */
export type NotoPlatform = 'darwin' | 'win32' | 'linux';

export interface FileTruthBootstrapReplyV1 {
  readonly version: typeof NOTO_FILE_TRUTH_VERSION;
  readonly enabled: boolean;
  /**
   * Sent from the main process rather than sniffed in the renderer, because
   * user agent parsing is unreliable and keyboard accelerators depend on it.
   */
  readonly platform: NotoPlatform;
}

export const FILE_TRUTH_CHANNELS = {
  bootstrap: 'noto:file-truth:v1:bootstrap',
  open: 'noto:file-truth:v1:open',
  save: 'noto:file-truth:v1:save',
  saveCopy: 'noto:file-truth:v1:save-copy',
  recover: 'noto:file-truth:v1:recover',
  diagnostics: 'noto:file-truth:v1:diagnostics',
  /** Push: the file behind an open document changed under it. */
  externalChange: 'noto:file-truth:v1:external-change',
  reload: 'noto:file-truth:v1:reload',
} as const;

export interface FileTruthRequestV1 {
  readonly version: typeof NOTO_FILE_TRUTH_VERSION;
  readonly requestId: string;
}

/**
 * Identifies the filesystem object a document was read from, so an external
 * replacement can be detected even when the path is unchanged.
 *
 * `basis` records how strong the identity actually is, because that varies by
 * platform and Noto should not pretend otherwise. `inode` means the OS gave a
 * stable object id (device plus inode on Unix, volume serial plus file index on
 * Windows). `path` means it did not, and conflict detection is relying on size,
 * modification time and content hash alone.
 */
export interface FileObjectIdentityV1 {
  readonly scheme: 'noto-file-object-v1';
  readonly opaqueId: string;
  readonly basis: 'inode' | 'path';
}

export interface FileFingerprintV1 {
  readonly version: typeof NOTO_FILE_TRUTH_VERSION;
  readonly object: FileObjectIdentityV1;
  readonly byteLength: number;
  readonly mtimeNanoseconds: string;
  readonly contentSha256: string;
}

export interface AcceptedFileIdentityV1 {
  readonly version: typeof NOTO_FILE_TRUTH_VERSION;
  readonly canonicalPath: string;
  readonly fingerprint: FileFingerprintV1;
  /**
   * Permission bits as reported by the OS. Meaningful on Unix, where Noto
   * restores them exactly after a save. On Windows only the read-only bit is
   * real, so the value is recorded but not verified.
   */
  readonly posixMode: number;
}

export interface FileTruthSaveTokenV1 {
  readonly version: typeof NOTO_FILE_TRUTH_VERSION;
  readonly documentRevisionId: NotoRevisionId;
  readonly editorRevision: number;
  readonly fingerprint: FileFingerprintV1;
}

export interface FileTruthOpenReplyV1 {
  readonly version: typeof NOTO_FILE_TRUTH_VERSION;
  readonly path: string;
  readonly document: NotoDocumentWire;
  readonly saveToken: FileTruthSaveTokenV1;
  readonly recovery: FileTruthRecoveryRecordV1 | null;
  readonly initialOutcome: FileTruthFailureV1 | null;
}

/**
 * A save candidate.
 *
 * v3 collapsed the two earlier shapes into one. The v1 single-block edit and
 * the v2 transaction both existed because the editor could only express certain
 * changes; the markdown v3 transaction covers both block edits and whole-file
 * source edits.
 */
export interface FileTruthEditCandidateV1 {
  readonly version: 3;
  readonly saveToken: FileTruthSaveTokenV1;
  readonly transaction: NotoTransaction;
}

export interface FileTruthSaveRequestV1 extends FileTruthRequestV1 {
  readonly candidate: FileTruthEditCandidateV1;
}

export interface FileTruthSaveCopyRequestV1 extends FileTruthRequestV1 {
  readonly candidate: FileTruthEditCandidateV1;
  readonly destinationPath: string;
}

export type FileTruthStageV1 =
  | 'before-temp-write'
  | 'candidate-durable'
  | 'temp-written'
  | 'temp-flushed'
  | 'metadata-applied'
  | 'precondition-confirmed'
  | 'replacement-complete'
  | 'replacement-verified'
  | 'journal-complete'
  | 'cleanup';

/**
 * A durable record of a save that was interrupted.
 *
 * The schema is v2 because markdown v3 removed the `candidateIdentity` field.
 * Block identities are now derived deterministically from content, so
 * `candidateSha256` already identifies the candidate document completely and
 * reparsing the payload reproduces the same ids. A v1 journal left by an older
 * build fails validation and is preserved as evidence rather than misread.
 */
export interface FileTruthRecoveryRecordV1 {
  readonly version: typeof NOTO_FILE_TRUTH_VERSION;
  readonly schema: 'noto-file-truth-journal-v2';
  readonly attemptId: string;
  readonly stage: FileTruthStageV1;
  readonly originalPath: string;
  readonly payloadPath: string;
  readonly journalPath: string;
  readonly tempPath: string | null;
  readonly candidateSha256: string;
  readonly candidateByteLength: number;
  readonly acceptedFingerprint: FileFingerprintV1;
  readonly posixMode: number;
}

interface OutcomeBaseV1 {
  readonly version: typeof NOTO_FILE_TRUTH_VERSION;
  readonly attemptId: string;
  readonly dirtyPreserved: boolean;
  readonly message: string;
  readonly safeStage: FileTruthStageV1;
}

export interface FileTruthSavedV1 extends OutcomeBaseV1 {
  readonly status: 'saved';
  readonly dirtyPreserved: false;
  readonly accepted: AcceptedFileIdentityV1;
  readonly saveToken: FileTruthSaveTokenV1;
  readonly outputSha256: string;
  readonly replacedOriginal: true;
  /** The newly accepted document, which the editor adopts as its clean baseline. */
  readonly document: NotoDocumentWire;
}

export interface FileTruthCopySavedV1 extends OutcomeBaseV1 {
  readonly status: 'copy-saved';
  readonly dirtyPreserved: true;
  readonly destinationPath: string;
  readonly outputSha256: string;
  readonly replacedOriginal: false;
}

export interface FileTruthExternalConflictV1 extends OutcomeBaseV1 {
  readonly status: 'external-conflict';
  readonly dirtyPreserved: true;
  readonly acceptedFingerprint: FileFingerprintV1;
  readonly currentFingerprint: FileFingerprintV1 | null;
}

export interface FileTruthStaleRevisionV1 extends OutcomeBaseV1 {
  readonly status: 'stale-editor-revision';
  readonly dirtyPreserved: true;
  readonly acceptedRevisionId: NotoRevisionId;
  readonly candidateRevisionId: NotoRevisionId;
}

export interface FileTruthFailureV1 extends OutcomeBaseV1 {
  readonly status:
    | 'serialization-failed'
    | 'write-failed'
    | 'flush-failed'
    | 'replacement-failed'
    | 'metadata-failed'
    | 'recovery-needed'
    | 'recovery-failed';
  readonly dirtyPreserved: true;
  readonly recovery: FileTruthRecoveryRecordV1 | null;
  readonly recoveryRecordId: string | null;
  readonly residuePaths: readonly string[];
}

export interface FileTruthCleanupFailureV1 extends OutcomeBaseV1 {
  readonly status: 'cleanup-failed';
  readonly dirtyPreserved: true;
  readonly primary: FileTruthSavedV1 | FileTruthCopySavedV1 | FileTruthExternalConflictV1 | FileTruthStaleRevisionV1 | FileTruthFailureV1;
  readonly recovery: FileTruthRecoveryRecordV1 | null;
  readonly recoveryRecordId: string | null;
  readonly residuePaths: readonly string[];
}

export type FileTruthSaveOutcomeV1 =
  | FileTruthSavedV1
  | FileTruthCopySavedV1
  | FileTruthExternalConflictV1
  | FileTruthStaleRevisionV1
  | FileTruthFailureV1
  | FileTruthCleanupFailureV1;

export interface FileTruthRecoveryRequestV1 extends FileTruthRequestV1 {}

export interface FileTruthDiagnosticsV1 {
  readonly version: typeof NOTO_FILE_TRUTH_VERSION;
  readonly state: 'closed' | 'opened' | 'dirty' | 'saved' | 'conflict' | 'recovery-needed' | 'failed';
  readonly watcherGeneration: number;
  readonly watcherEvents: { readonly self: number; readonly foreign: number };
  readonly lastOutcome: FileTruthSaveOutcomeV1 | null;
}

export type FileTruthResultV1<T> =
  | { readonly ok: true; readonly requestId: string; readonly value: T }
  | { readonly ok: false; readonly requestId: string; readonly error: { readonly code: 'BAD_REQUEST' | 'NO_DOCUMENT_OPEN' | 'FILE_TRUTH_TRANSPORT_FAILED'; readonly message: string } };

/**
 * What happened to the file behind an open document.
 *
 * `changed` is somebody else's edit. `rebased` is the same content written
 * again, which a git checkout or a `touch` produces: the bytes match, only the
 * file's identity moved, so nothing needs reloading and the accepted identity
 * is simply moved to the new one. `missing` is the file being deleted or
 * renamed away, and is the case where the open buffer is now the only copy.
 */
export type FileTruthExternalChangeKindV1 = 'changed' | 'rebased' | 'missing';

export interface FileTruthExternalChangeEventV1 {
  readonly version: typeof NOTO_FILE_TRUTH_VERSION;
  readonly documentId: string;
  readonly kind: FileTruthExternalChangeKindV1;
  /** The identity to save against now, for a rebase the renderer can accept. */
  readonly saveToken: FileTruthSaveTokenV1 | null;
}

export interface FileTruthReloadRequestV1 extends FileTruthRequestV1 {
  readonly documentId: string;
}

/**
 * Why a reload did nothing, when it did nothing.
 *
 * A reload while a recovery record stands is refused rather than queued: the
 * journal is replayed against the accepted identity, and moving that identity
 * would leave the replay unverifiable.
 */
export type FileTruthReloadRefusalV1 = 'recovery-pending' | 'save-in-flight' | 'parse-failed' | 'no-document';

export type FileTruthReloadOutcomeV1 =
  | { readonly version: typeof NOTO_FILE_TRUTH_VERSION; readonly status: 'reloaded'; readonly opened: FileTruthOpenReplyV1 }
  | { readonly version: typeof NOTO_FILE_TRUTH_VERSION; readonly status: 'unchanged' }
  | { readonly version: typeof NOTO_FILE_TRUTH_VERSION; readonly status: 'missing' }
  | { readonly version: typeof NOTO_FILE_TRUTH_VERSION; readonly status: 'refused'; readonly reason: FileTruthReloadRefusalV1 };

export interface NotoFileTruthApiV1 {
  bootstrap(request: FileTruthRequestV1): Promise<FileTruthResultV1<FileTruthBootstrapReplyV1>>;
  open(request: FileTruthRequestV1): Promise<FileTruthResultV1<FileTruthOpenReplyV1>>;
  save(request: FileTruthSaveRequestV1): Promise<FileTruthResultV1<FileTruthSaveOutcomeV1>>;
  saveCopy(request: FileTruthSaveCopyRequestV1): Promise<FileTruthResultV1<FileTruthSaveOutcomeV1>>;
  recover(request: FileTruthRecoveryRequestV1): Promise<FileTruthResultV1<FileTruthSaveOutcomeV1>>;
  diagnostics(request: FileTruthRequestV1): Promise<FileTruthResultV1<FileTruthDiagnosticsV1>>;
  reload(request: FileTruthReloadRequestV1): Promise<FileTruthResultV1<FileTruthReloadOutcomeV1>>;
  onExternalChange(listener: (event: FileTruthExternalChangeEventV1) => void): () => void;
}


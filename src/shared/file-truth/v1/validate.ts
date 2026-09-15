import type {
  AcceptedFileIdentityV1,
  FileFingerprintV1,
  FileTruthBootstrapReplyV1,
  FileTruthDiagnosticsV1,
  FileTruthOpenReplyV1,
  FileTruthRequestV1,
  FileTruthRecoveryRecordV1,
  FileTruthResultV1,
  FileTruthSaveOutcomeV1,
  FileTruthSaveCopyRequestV1,
  FileTruthSaveRequestV1,
  FileTruthSaveTokenV1,
  FileTruthExternalChangeEventV1,
  FileTruthReloadRequestV1,
  FileTruthReloadOutcomeV1,
} from './contracts';
import type { NotoDocumentWire } from '../../markdown/v3/contracts';

const requestId = /^[A-Za-z0-9._:-]{1,96}$/;
const hash = /^[a-f0-9]{64}$/;
const stages = new Set([
  'before-temp-write', 'candidate-durable', 'temp-written', 'temp-flushed', 'metadata-applied',
  'precondition-confirmed', 'replacement-complete', 'replacement-verified', 'journal-complete', 'cleanup',
]);
const sha256Initial = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);
const sha256RoundConstants = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotateRight = (value: number, bits: number): number =>
  (value >>> bits) | (value << (32 - bits));

function compressSha256Block(
  state: Uint32Array,
  block: Uint8Array,
  offset: number,
  words: Uint32Array,
): void {
  for (let index = 0; index < 16; index += 1) {
    const cursor = offset + index * 4;
    words[index] = ((block[cursor] << 24) | (block[cursor + 1] << 16)
      | (block[cursor + 2] << 8) | block[cursor + 3]) >>> 0;
  }
  for (let index = 16; index < 64; index += 1) {
    const left = words[index - 15];
    const right = words[index - 2];
    const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
    const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
    words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
  }

  let [a, b, c, d, e, f, g, h] = state;
  for (let index = 0; index < 64; index += 1) {
    const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
    const choice = (e & f) ^ (~e & g);
    const temporary1 = (h + sum1 + choice + sha256RoundConstants[index] + words[index]) >>> 0;
    const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
    const majority = (a & b) ^ (a & c) ^ (b & c);
    const temporary2 = (sum0 + majority) >>> 0;
    h = g; g = f; f = e; e = (d + temporary1) >>> 0;
    d = c; c = b; b = a; a = (temporary1 + temporary2) >>> 0;
  }
  state[0] = (state[0] + a) >>> 0;
  state[1] = (state[1] + b) >>> 0;
  state[2] = (state[2] + c) >>> 0;
  state[3] = (state[3] + d) >>> 0;
  state[4] = (state[4] + e) >>> 0;
  state[5] = (state[5] + f) >>> 0;
  state[6] = (state[6] + g) >>> 0;
  state[7] = (state[7] + h) >>> 0;
}

export function sha256Hex(bytes: Uint8Array): string {
  const state = sha256Initial.slice();
  const words = new Uint32Array(64);
  const fullBlockLength = bytes.byteLength - (bytes.byteLength % 64);
  for (let offset = 0; offset < fullBlockLength; offset += 64) {
    compressSha256Block(state, bytes, offset, words);
  }

  const remainder = bytes.byteLength - fullBlockLength;
  const tail = new Uint8Array(remainder < 56 ? 64 : 128);
  tail.set(bytes.subarray(fullBlockLength));
  tail[remainder] = 0x80;
  const bitLength = bytes.byteLength * 8;
  const tailView = new DataView(tail.buffer);
  tailView.setUint32(tail.byteLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  tailView.setUint32(tail.byteLength - 4, bitLength >>> 0, false);
  for (let offset = 0; offset < tail.byteLength; offset += 64) {
    compressSha256Block(state, tail, offset, words);
  }

  let digest = '';
  for (const value of state) digest += value.toString(16).padStart(8, '0');
  return digest;
}

/** `noto-doc-v3:` and the hash of the bytes the document was parsed from. */
const isDocumentId = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('noto-doc-v3:') && hash.test(value.slice('noto-doc-v3:'.length));

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));

export function isFileTruthRequestV1(value: unknown): value is FileTruthRequestV1 {
  return record(value) && exact(value, ['version', 'requestId'])
    && value.version === 1 && typeof value.requestId === 'string' && requestId.test(value.requestId);
}

function isFingerprint(value: unknown): value is FileFingerprintV1 {
  return record(value) && exact(value, ['version', 'object', 'byteLength', 'mtimeNanoseconds', 'contentSha256'])
    && value.version === 1 && record(value.object)
    && exact(value.object, ['scheme', 'opaqueId', 'basis'])
    && value.object.scheme === 'noto-file-object-v1'
    && ['inode', 'path'].includes(String(value.object.basis))
    && typeof value.object.opaqueId === 'string' && value.object.opaqueId.length > 0 && value.object.opaqueId.length <= 256
    && Number.isSafeInteger(value.byteLength) && Number(value.byteLength) >= 0
    && typeof value.mtimeNanoseconds === 'string' && /^\d+$/.test(value.mtimeNanoseconds)
    && typeof value.contentSha256 === 'string' && hash.test(value.contentSha256);
}

function sameFingerprint(left: unknown, right: unknown): boolean {
  return isFingerprint(left) && isFingerprint(right)
    && JSON.stringify(left) === JSON.stringify(right);
}

function isAcceptedIdentity(value: unknown): value is AcceptedFileIdentityV1 {
  return record(value) && exact(value, ['version', 'canonicalPath', 'fingerprint', 'posixMode'])
    && value.version === 1 && typeof value.canonicalPath === 'string' && value.canonicalPath.length > 0
    && value.canonicalPath.length <= 4096 && isFingerprint(value.fingerprint)
    && Number.isSafeInteger(value.posixMode) && Number(value.posixMode) >= 0 && Number(value.posixMode) <= 0o7777;
}

function isSaveToken(value: unknown): value is FileTruthSaveTokenV1 {
  return record(value) && exact(value, ['version', 'documentRevisionId', 'editorRevision', 'fingerprint'])
    && value.version === 1
    && typeof value.documentRevisionId === 'string' && value.documentRevisionId.startsWith('noto-rev-v3:')
    && Number.isSafeInteger(value.editorRevision) && Number(value.editorRevision) >= 0
    && isFingerprint(value.fingerprint);
}

function isCandidate(value: unknown): boolean {
  return record(value) && value.version === 3 && exact(value, ['version', 'saveToken', 'transaction'])
    && isSaveToken(value.saveToken) && isTransaction(value.transaction);
}

function isOrigin(value: unknown): boolean {
  return record(value) && exact(value, ['blockId', 'ordinal', 'kind', 'semanticKey'])
    && typeof value.blockId === 'string' && value.blockId.startsWith('noto-block-v3:')
    && Number.isSafeInteger(value.ordinal) && Number(value.ordinal) >= 0
    && typeof value.kind === 'string' && value.kind.length <= 64
    && typeof value.semanticKey === 'string' && value.semanticKey.length <= 2_000_000;
}

/** What the save is asked to make the file's endings and last byte. */
function isTargetEnvelope(value: unknown): boolean {
  return record(value) && exact(value, ['lineEnding', 'hasFinalNewline'])
    && ['lf', 'crlf', 'mixed'].includes(String(value.lineEnding))
    && typeof value.hasFinalNewline === 'boolean';
}

function isTransaction(value: unknown): boolean {
  if (!record(value) || value.version !== 3 || typeof value.documentId !== 'string'
    || !value.documentId.startsWith('noto-doc-v3:') || typeof value.revisionId !== 'string'
    || !value.revisionId.startsWith('noto-rev-v3:')) return false;
  if (value.mode === 'blocks') return exact(value, ['version', 'mode', 'documentId', 'revisionId', 'units', 'envelope'])
    && isTargetEnvelope(value.envelope)
    && Array.isArray(value.units) && value.units.length <= 100_000
    && value.units.every((unit) => record(unit) && exact(unit, ['origin', 'markdown'])
      && (unit.origin === null || isOrigin(unit.origin))
      // Null means the block is unchanged, so it carries no text. A unit with
      // no origin has nothing to be unchanged from and must carry its markdown.
      && (unit.markdown === null
        ? unit.origin !== null
        : typeof unit.markdown === 'string' && unit.markdown.length <= 2_000_000))
    && value.units.reduce((total, unit) => total + (record(unit) && typeof unit.markdown === 'string' ? unit.markdown.length : 0), 0)
      <= 64 * 1024 * 1024;
  return value.mode === 'source' && exact(value, ['version', 'mode', 'documentId', 'revisionId', 'expectedSourceSha256', 'sourceBytes'])
    && typeof value.expectedSourceSha256 === 'string' && hash.test(value.expectedSourceSha256)
    && value.sourceBytes instanceof Uint8Array && value.sourceBytes.byteLength <= 64 * 1024 * 1024;
}

export function isFileTruthSaveRequestV1(value: unknown): value is FileTruthSaveRequestV1 {
  return record(value) && exact(value, ['version', 'requestId', 'candidate'])
    && value.version === 1 && typeof value.requestId === 'string' && requestId.test(value.requestId)
    && isCandidate(value.candidate);
}

export function isFileTruthSaveCopyRequestV1(value: unknown): value is FileTruthSaveCopyRequestV1 {
  return record(value) && exact(value, ['version', 'requestId', 'candidate', 'destinationPath'])
    && value.version === 1 && typeof value.requestId === 'string' && requestId.test(value.requestId)
    && isCandidate(value.candidate) && typeof value.destinationPath === 'string'
    && value.destinationPath.length > 0 && value.destinationPath.length <= 4096;
}

function isResult<T>(value: unknown, expectedRequestId: string, validateValue: (candidate: unknown) => candidate is T): value is FileTruthResultV1<T> {
  if (!record(value) || value.requestId !== expectedRequestId || typeof value.ok !== 'boolean') return false;
  if (value.ok) return exact(value, ['ok', 'requestId', 'value']) && validateValue(value.value);
  return exact(value, ['ok', 'requestId', 'error']) && record(value.error)
    && exact(value.error, ['code', 'message'])
    && ['BAD_REQUEST', 'NO_DOCUMENT_OPEN', 'FILE_TRUTH_TRANSPORT_FAILED'].includes(String(value.error.code))
    && typeof value.error.message === 'string' && value.error.message.length > 0 && value.error.message.length <= 2048;
}

const UTF8_BOM = Uint8Array.from([0xef, 0xbb, 0xbf]);
const encoder = new TextEncoder();

/**
 * Re-derive the original file bytes from a wire document.
 *
 * The wire carries BOM-stripped text, so verifying the envelope hash means
 * putting the BOM back first. This is what proves the renderer was handed a
 * document whose envelope actually describes its text.
 */
function originalBytesOf(text: string, bom: string): Uint8Array {
  const body = encoder.encode(text);
  if (bom !== 'utf8') return body;
  const output = new Uint8Array(UTF8_BOM.length + body.length);
  output.set(UTF8_BOM, 0);
  output.set(body, UTF8_BOM.length);
  return output;
}

function isWireMdastNode(value: unknown): boolean {
  // Deep mdast validation belongs to the parser. For the wire we only need to
  // know each entry is a plain object with a type string, so a forged payload
  // cannot smuggle functions or exotic hosts across IPC.
  return record(value) && typeof value.type === 'string' && value.type.length > 0 && value.type.length <= 64;
}

export function isNotoDocumentWire(value: unknown): value is NotoDocumentWire {
  const wireKeys = ['version', 'documentId', 'revisionId', 'envelope', 'text', 'origins', 'spans', 'nodes'] as const;
  const withEnrichment = record(value) && Object.prototype.hasOwnProperty.call(value, 'nodesEnrichment');
  if (!record(value) || !exact(value, withEnrichment ? [...wireKeys, 'nodesEnrichment'] : [...wireKeys])
    || value.version !== 3
    || typeof value.documentId !== 'string' || !value.documentId.startsWith('noto-doc-v3:')
    || typeof value.revisionId !== 'string' || !value.revisionId.startsWith('noto-rev-v3:')
    || typeof value.text !== 'string' || value.text.length > 64 * 1024 * 1024
    || !record(value.envelope)
    || !exact(value.envelope, ['version', 'byteLength', 'bom', 'lineEnding', 'hasFinalNewline', 'sourceSha256'])
    || value.envelope.version !== 3
    || !Number.isSafeInteger(value.envelope.byteLength)
    || !['utf8', 'none'].includes(String(value.envelope.bom))
    || !['lf', 'crlf', 'mixed'].includes(String(value.envelope.lineEnding))
    || typeof value.envelope.hasFinalNewline !== 'boolean'
    || typeof value.envelope.sourceSha256 !== 'string' || !hash.test(value.envelope.sourceSha256)
    || !Array.isArray(value.origins) || !value.origins.every(isOrigin)
    // One span per block, each a pair of offsets inside the document text.
    || !Array.isArray(value.spans) || value.spans.length !== value.origins.length
    || !value.spans.every((span) => record(span) && exact(span, ['start', 'end'])
      && Number.isSafeInteger(span.start) && Number(span.start) >= 0
      && Number.isSafeInteger(span.end) && Number(span.end) >= Number(span.start)
      && Number(span.end) <= (value.text as string).length)
    || !(value.nodes === null
      || (Array.isArray(value.nodes) && value.nodes.length === value.origins.length
        && value.nodes.every(isWireMdastNode)))
    // Optional open-path flag; only meaningful when nodes are present.
    || (withEnrichment && (value.nodes === null
      || (value.nodesEnrichment !== 'full' && value.nodesEnrichment !== 'deferred')))) return false;

  const bytes = originalBytesOf(value.text, String(value.envelope.bom));
  return value.envelope.byteLength === bytes.byteLength
    && sha256Hex(bytes) === value.envelope.sourceSha256
    && value.origins.every((origin, index) => (origin as { ordinal: number }).ordinal === index);
}

/**
 * The saved outcome must describe the document it claims to have written.
 *
 * v3 made this check cheap: identity is derived from content, so the envelope
 * hash, the output hash and the accepted fingerprint all have to be one value.
 */
function isMatchingSavedState(document: unknown, saveToken: unknown, outputSha256: unknown): boolean {
  if (!isNotoDocumentWire(document) || !isSaveToken(saveToken) || typeof outputSha256 !== 'string') return false;
  return document.revisionId === saveToken.documentRevisionId
    && document.envelope.sourceSha256 === outputSha256
    && document.envelope.sourceSha256 === saveToken.fingerprint.contentSha256
    && document.envelope.byteLength === saveToken.fingerprint.byteLength;
}

function isMatchingOpenState(
  document: NotoDocumentWire,
  saveToken: FileTruthSaveTokenV1,
  recovery: FileTruthRecoveryRecordV1 | null,
  initialOutcome: unknown,
): boolean {
  if (document.revisionId !== saveToken.documentRevisionId) return false;
  // When a recovery record is pending, the opened document is the recovered
  // candidate rather than what is currently on disk.
  if (recovery !== null && initialOutcome === null) {
    return document.envelope.sourceSha256 === recovery.candidateSha256
      && document.envelope.byteLength === recovery.candidateByteLength;
  }
  return document.envelope.sourceSha256 === saveToken.fingerprint.contentSha256
    && document.envelope.byteLength === saveToken.fingerprint.byteLength;
}

function isRecovery(value: unknown): value is FileTruthRecoveryRecordV1 | null {
  return value === null || (record(value)
    && exact(value, ['version', 'schema', 'attemptId', 'stage', 'originalPath', 'payloadPath', 'journalPath', 'tempPath',
      'candidateSha256', 'candidateByteLength', 'acceptedFingerprint', 'posixMode'])
    && value.version === 1 && value.schema === 'noto-file-truth-journal-v2'
    && typeof value.attemptId === 'string' && value.attemptId.length > 0 && value.attemptId.length <= 128
    && typeof value.originalPath === 'string' && typeof value.payloadPath === 'string' && typeof value.journalPath === 'string'
    && (value.tempPath === null || typeof value.tempPath === 'string') && stages.has(String(value.stage))
    && typeof value.candidateSha256 === 'string' && hash.test(value.candidateSha256)
    && Number.isSafeInteger(value.candidateByteLength) && Number(value.candidateByteLength) >= 0
    && isFingerprint(value.acceptedFingerprint)
    && Number.isSafeInteger(value.posixMode) && Number(value.posixMode) >= 0 && Number(value.posixMode) <= 0o7777);
}

export function isFileTruthSaveOutcomeV1(value: unknown): value is FileTruthSaveOutcomeV1 {
  if (!record(value) || value.version !== 1 || typeof value.status !== 'string' || typeof value.attemptId !== 'string'
    || value.attemptId.length === 0 || value.attemptId.length > 128 || !stages.has(String(value.safeStage))
    || typeof value.dirtyPreserved !== 'boolean'
    || typeof value.message !== 'string' || value.message.length === 0 || value.message.length > 4096) return false;
  const base = ['version', 'status', 'attemptId', 'safeStage', 'dirtyPreserved', 'message'];
  const residues = (candidate: unknown) => Array.isArray(candidate) && candidate.every((item) => typeof item === 'string');
  if (value.status === 'saved') {
    return exact(value, [...base, 'accepted', 'saveToken', 'outputSha256', 'replacedOriginal', 'document'])
      && value.dirtyPreserved === false && isAcceptedIdentity(value.accepted) && isSaveToken(value.saveToken)
      && sameFingerprint(value.accepted.fingerprint, value.saveToken.fingerprint)
      && typeof value.outputSha256 === 'string' && hash.test(value.outputSha256)
      && value.outputSha256 === value.accepted.fingerprint.contentSha256 && value.replacedOriginal === true
      && isMatchingSavedState(value.document, value.saveToken, value.outputSha256);
  }
  if (value.status === 'copy-saved') return exact(value, [...base, 'destinationPath', 'outputSha256', 'replacedOriginal'])
    && value.dirtyPreserved === true && typeof value.destinationPath === 'string' && value.destinationPath.length > 0
    && typeof value.outputSha256 === 'string' && hash.test(value.outputSha256) && value.replacedOriginal === false;
  if (value.status === 'external-conflict') return exact(value, [...base, 'acceptedFingerprint', 'currentFingerprint'])
    && value.dirtyPreserved === true && isFingerprint(value.acceptedFingerprint)
    && (value.currentFingerprint === null || isFingerprint(value.currentFingerprint));
  if (value.status === 'stale-editor-revision') return exact(value, [...base, 'acceptedRevisionId', 'candidateRevisionId'])
    && value.dirtyPreserved === true
    && typeof value.acceptedRevisionId === 'string' && typeof value.candidateRevisionId === 'string';
  if (value.status === 'cleanup-failed') return exact(value, [...base, 'primary', 'recovery', 'recoveryRecordId', 'residuePaths'])
    && value.dirtyPreserved === true && residues(value.residuePaths)
    && isRecovery(value.recovery) && (value.recoveryRecordId === null || typeof value.recoveryRecordId === 'string')
    && isFileTruthSaveOutcomeV1(value.primary) && value.primary.status !== 'cleanup-failed';
  return exact(value, [...base, 'recovery', 'recoveryRecordId', 'residuePaths'])
    && ['serialization-failed', 'write-failed', 'flush-failed', 'replacement-failed', 'metadata-failed', 'recovery-needed', 'recovery-failed'].includes(value.status)
    && value.dirtyPreserved === true && isRecovery(value.recovery) && residues(value.residuePaths)
    && (value.recoveryRecordId === null || typeof value.recoveryRecordId === 'string')
    && (value.recovery === null ? value.recoveryRecordId === null : value.recoveryRecordId === value.recovery.attemptId);
}

export const isFileTruthBootstrapResultV1 = (value: unknown, id: string): value is FileTruthResultV1<FileTruthBootstrapReplyV1> =>
  isResult(value, id, (candidate): candidate is FileTruthBootstrapReplyV1 => record(candidate)
    && exact(candidate, ['version', 'enabled', 'platform']) && candidate.version === 1
    && typeof candidate.enabled === 'boolean'
    && ['darwin', 'win32', 'linux'].includes(String(candidate.platform)));

/**
 * Exported on its own because the workspace contract carries an open reply too,
 * and both entry points must apply exactly the same check.
 */
export function isFileTruthOpenReplyV1(candidate: unknown): candidate is FileTruthOpenReplyV1 {
  return record(candidate)
    && exact(candidate, ['version', 'path', 'document', 'saveToken', 'recovery', 'initialOutcome'])
    && candidate.version === 1 && typeof candidate.path === 'string' && candidate.path.length > 0
    && isNotoDocumentWire(candidate.document)
    && isSaveToken(candidate.saveToken)
    && isRecovery(candidate.recovery)
    && isMatchingOpenState(candidate.document, candidate.saveToken, candidate.recovery, candidate.initialOutcome)
    && (candidate.initialOutcome === null
      || (isFileTruthSaveOutcomeV1(candidate.initialOutcome) && candidate.initialOutcome.status === 'recovery-failed'));
}

export const isFileTruthOpenResultV1 = (value: unknown, id: string): value is FileTruthResultV1<FileTruthOpenReplyV1> =>
  isResult(value, id, isFileTruthOpenReplyV1);

export const isFileTruthSaveResultV1 = (value: unknown, id: string): value is FileTruthResultV1<FileTruthSaveOutcomeV1> =>
  isResult(value, id, isFileTruthSaveOutcomeV1);

export const isFileTruthDiagnosticsResultV1 = (value: unknown, id: string): value is FileTruthResultV1<FileTruthDiagnosticsV1> =>
  isResult(value, id, (candidate): candidate is FileTruthDiagnosticsV1 => record(candidate)
    && exact(candidate, ['version', 'state', 'watcherGeneration', 'watcherEvents', 'lastOutcome']) && candidate.version === 1
    && ['closed', 'opened', 'dirty', 'saved', 'conflict', 'recovery-needed', 'failed'].includes(String(candidate.state))
    && Number.isSafeInteger(candidate.watcherGeneration) && Number(candidate.watcherGeneration) >= 0
    && record(candidate.watcherEvents) && exact(candidate.watcherEvents, ['self', 'foreign'])
    && Number.isSafeInteger(candidate.watcherEvents.self) && Number(candidate.watcherEvents.self) >= 0
    && Number.isSafeInteger(candidate.watcherEvents.foreign) && Number(candidate.watcherEvents.foreign) >= 0
    && (candidate.lastOutcome === null || isFileTruthSaveOutcomeV1(candidate.lastOutcome)));

export function isFileTruthExternalChangeEventV1(value: unknown): value is FileTruthExternalChangeEventV1 {
  return record(value) && exact(value, ['version', 'documentId', 'kind', 'saveToken'])
    && value.version === 1
    && isDocumentId(value.documentId)
    && ['changed', 'rebased', 'missing'].includes(String(value.kind))
    // Only a rebase carries a token, because only a rebase gives the renderer a
    // new identity to save against without reloading anything.
    && (value.kind === 'rebased' ? isSaveToken(value.saveToken) : value.saveToken === null);
}

export function isFileTruthReloadRequestV1(value: unknown): value is FileTruthReloadRequestV1 {
  return record(value) && exact(value, ['version', 'requestId', 'documentId'])
    && value.version === 1 && typeof value.requestId === 'string' && requestId.test(value.requestId)
    && isDocumentId(value.documentId);
}

export function isFileTruthReloadOutcomeV1(value: unknown): value is FileTruthReloadOutcomeV1 {
  if (!record(value) || value.version !== 1) return false;
  if (value.status === 'reloaded') {
    return exact(value, ['version', 'status', 'opened']) && isFileTruthOpenReplyV1(value.opened);
  }
  if (value.status === 'unchanged' || value.status === 'missing') {
    return exact(value, ['version', 'status']);
  }
  return value.status === 'refused' && exact(value, ['version', 'status', 'reason'])
    && ['recovery-pending', 'save-in-flight', 'parse-failed', 'no-document'].includes(String(value.reason));
}

export const isFileTruthReloadResultV1 = (value: unknown, id: string): value is FileTruthResultV1<FileTruthReloadOutcomeV1> =>
  isResult(value, id, isFileTruthReloadOutcomeV1);

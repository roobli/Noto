/**
 * Turns raw file bytes into an accepted Noto document.
 *
 * Runs in the main process only, because it hashes with `node:crypto`. The
 * renderer receives the resulting document over IPC and never parses file bytes
 * itself.
 */

import { createHash } from 'node:crypto';
import { splitBlocksMicromark } from './blocks';
import { isRoobliMdEngine } from './engine-flag';
import { toLf } from './line-endings';
import { splitBlocksViaRoobli } from './roobli-md-adapter';
import {
  NOTO_MARKDOWN_VERSION,
  type NotoBlock,
  type NotoBlockId,
  type NotoDocument,
  type NotoDocumentId,
  type NotoEnvelope,
  type NotoGap,
  type NotoDocumentWire,
  type NotoLineEnding,
  type NotoParseResult,
  type NotoRevisionId,
} from './contracts';

const UTF8_BOM = Uint8Array.from([0xef, 0xbb, 0xbf]);

export function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export { fromLf, toLf } from './line-endings';

function hasBom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === UTF8_BOM[0] && bytes[1] === UTF8_BOM[1] && bytes[2] === UTF8_BOM[2];
}

function detectLineEnding(text: string): NotoLineEnding {
  let crlf = 0;
  let bareLf = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\n') continue;
    if (index > 0 && text[index - 1] === '\r') crlf += 1;
    else bareLf += 1;
  }
  if (crlf > 0 && bareLf > 0) return 'mixed';
  return crlf > 0 ? 'crlf' : 'lf';
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    // `ignoreBOM: true` means "do not strip it". We remove the BOM ourselves so
    // that block offsets and the envelope agree on where the text starts.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Strip a document down to what the renderer actually needs. */
export function toWire(document: NotoDocument): NotoDocumentWire {
  return {
    version: NOTO_MARKDOWN_VERSION,
    documentId: document.documentId,
    revisionId: document.revisionId,
    envelope: document.envelope,
    text: document.text,
    origins: document.blocks.map((block) => block.origin),
    spans: document.blocks.map((block) => ({ start: block.start, end: block.end })),
    // Open and reload carry the nodes main already built; incremental saves
    // leave null so the IPC payload stays small when the editor does not need
    // to remount.
    nodes: document.nodes,
    ...(document.nodesEnrichment !== undefined
      ? { nodesEnrichment: document.nodesEnrichment }
      : {}),
  };
}


/**
 * Parse file bytes into a document.
 *
 * Unlike v1 this never falls back to a source-only document. A file that
 * decodes as UTF-8 always produces editable blocks, because micromark has a
 * defined result for every input.
 */
export function parseDocument(bytes: Uint8Array): NotoParseResult {
  const decoded = decodeUtf8(bytes);
  if (decoded === null) {
    return {
      status: 'failed',
      version: NOTO_MARKDOWN_VERSION,
      code: 'INVALID_UTF8',
      message: 'This file is not valid UTF-8, so Noto will not risk rewriting it.',
      originalBytes: bytes.slice(),
    };
  }

  const bom = hasBom(bytes) ? 'utf8' : 'none';
  const text = bom === 'utf8' ? decoded.slice(1) : decoded;
  const sourceSha256 = sha256(bytes);
  const lineEnding = detectLineEnding(text);

  const envelope: NotoEnvelope = {
    version: NOTO_MARKDOWN_VERSION,
    byteLength: bytes.byteLength,
    bom,
    lineEnding,
    hasFinalNewline: text.endsWith('\n'),
    sourceSha256,
  };

  // Flagged open: structural / enrich none on the critical path; renderer
  // fills dialect nodes for the first-paint window then the remainder.
  // Micromark and non-open splitBlocks callers stay on full dialect attach.
  const deferred = isRoobliMdEngine();
  const split = deferred
    ? splitBlocksViaRoobli(text, { enrich: 'none' })
    : splitBlocksMicromark(text);
  const documentId = `noto-doc-v3:${sourceSha256}` as NotoDocumentId;
  const revisionId = `noto-rev-v3:${sourceSha256}` as NotoRevisionId;

  const blocks: NotoBlock[] = split.spans.map((span, ordinal) => {
    const markdown = toLf(span.markdown);
    const id = `noto-block-v3:${ordinal}:${sha256(markdown).slice(0, 16)}` as NotoBlockId;
    return {
      version: NOTO_MARKDOWN_VERSION,
      id,
      kind: span.kind,
      start: span.start,
      end: span.end,
      markdown,
      sha256: sha256(markdown),
      semanticKey: span.semanticKey,
      origin: { blockId: id, ordinal, kind: span.kind, semanticKey: span.semanticKey },
    };
  });

  const gaps: NotoGap[] = split.gaps.map((gapText, index) => ({ beforeOrdinal: index, text: gapText }));

  return {
    status: 'parsed',
    document: {
      version: NOTO_MARKDOWN_VERSION,
      documentId,
      revisionId,
      envelope,
      originalBytes: bytes.slice(),
      text,
      blocks,
      gaps,
      leading: split.leading,
      trailing: split.trailing,
      nodes: split.spans.map((span) => span.node),
      nodesEnrichment: deferred ? 'deferred' : 'full',
    },
  };
}

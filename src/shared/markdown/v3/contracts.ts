/**
 * Noto markdown contract v3.
 *
 * v1 and v2 classified blocks with hand written regular expressions, so any
 * construct the classifier did not recognise degraded to an opaque source-only
 * island. v3 parses with micromark, which means every construct in the document
 * is a first class block and there is no `unsupported` kind.
 *
 * Byte fidelity is preserved by slicing the original text for blocks the editor
 * did not touch, rather than by round tripping through a serializer.
 */

export const NOTO_MARKDOWN_VERSION = 3 as const;

export type NotoDocumentId = string & { readonly __notoDocumentIdV3: unique symbol };
export type NotoRevisionId = string & { readonly __notoRevisionIdV3: unique symbol };
export type NotoBlockId = string & { readonly __notoBlockIdV3: unique symbol };

export type NotoLineEnding = 'lf' | 'crlf' | 'mixed';

/**
 * Every block kind is editable. The kind drives presentation and the plugin
 * ABI, never whether the user is allowed to type into it.
 */
export type NotoBlockKind =
  | 'heading'
  | 'paragraph'
  | 'bullet-list'
  | 'ordered-list'
  | 'task-list'
  | 'quote'
  | 'fenced-code'
  | 'indented-code'
  | 'table'
  | 'display-math'
  | 'frontmatter'
  | 'html'
  | 'thematic-break'
  | 'footnote-definition'
  | 'link-definition';

export interface NotoEnvelope {
  readonly version: typeof NOTO_MARKDOWN_VERSION;
  readonly byteLength: number;
  readonly bom: 'utf8' | 'none';
  readonly lineEnding: NotoLineEnding;
  readonly hasFinalNewline: boolean;
  readonly sourceSha256: string;
}

/**
 * Identifies a block across a reparse. `ordinal` and `semanticKey` together let
 * the serializer reject a transaction that was built against a different
 * document revision without trusting renderer supplied identity.
 */
export interface NotoBlockOrigin {
  readonly blockId: NotoBlockId;
  readonly ordinal: number;
  readonly kind: NotoBlockKind;
  readonly semanticKey: string;
}

export interface NotoBlock {
  readonly version: typeof NOTO_MARKDOWN_VERSION;
  readonly id: NotoBlockId;
  readonly kind: NotoBlockKind;
  /** Character offsets into `NotoDocument.text`, which excludes any BOM. */
  readonly start: number;
  readonly end: number;
  /**
   * Line ending normalised to LF, which is what the editor and plugins see.
   * The original bytes are recovered from `start`/`end` when the block is
   * saved untouched, so a CRLF document stays CRLF without every consumer
   * having to think about it.
   */
  readonly markdown: string;
  readonly sha256: string;
  readonly semanticKey: string;
  readonly origin: NotoBlockOrigin;
}

/** Literal text between two blocks. Preserved verbatim when both neighbours are pristine. */
export interface NotoGap {
  readonly beforeOrdinal: number;
  readonly text: string;
}

export interface NotoDocument {
  readonly version: typeof NOTO_MARKDOWN_VERSION;
  readonly documentId: NotoDocumentId;
  readonly revisionId: NotoRevisionId;
  readonly envelope: NotoEnvelope;
  readonly originalBytes: Uint8Array;
  /** Decoded source with any BOM removed. All block offsets index into this. */
  readonly text: string;
  readonly blocks: readonly NotoBlock[];
  readonly gaps: readonly NotoGap[];
  /** Text before the first block, normally empty. */
  readonly leading: string;
  /** Text after the last block, normally the trailing newline. */
  readonly trailing: string;
  /**
   * Top-level mdast nodes from the parse that produced this document, or null
   * when the document was assembled without a full micromark pass (incremental
   * save). Open ships these on the wire so the renderer can skip its second
   * parse; they are not needed after the editor is mounted.
   */
  readonly nodes: readonly import('mdast').RootContent[] | null;
  /**
   * How `nodes` were produced on open/reload.
   *
   * - `full`: every node is dialect-enriched (micromark open, or flagged bulk).
   * - `deferred`: structural / `enrich: 'none'` stand-ins — renderer enriches a
   *   first-paint window then viewport / idle deferred ranges (flagged lazy
   *   open). Absent when `nodes` is null (incremental save).
   */
  readonly nodesEnrichment?: 'full' | 'deferred';
}

/**
 * The document as sent to the renderer.
 *
 * Deliberately not `NotoDocument`. That type carries the original bytes and a
 * copy of every block's markdown, so shipping it whole would put roughly three
 * copies of the file on the IPC channel. Identities, offsets and (on open) the
 * mdast nodes main already built cross the boundary; the renderer no longer
 * needs a second micromark pass to mount the editor.
 */
export interface NotoDocumentWire {
  readonly version: typeof NOTO_MARKDOWN_VERSION;
  readonly documentId: NotoDocumentId;
  readonly revisionId: NotoRevisionId;
  readonly envelope: NotoEnvelope;
  readonly text: string;
  readonly origins: readonly NotoBlockOrigin[];
  /**
   * Where each block sits in `text`.
   *
   * Offsets rather than the block text itself, which would put a second copy of
   * the whole file on the wire. Without them the renderer had to reparse the
   * document to recover the same strings, so every save paid for a full parse
   * to learn something main already knew.
   */
  readonly spans: readonly { readonly start: number; readonly end: number }[];
  /**
   * Top-level mdast nodes aligned with `spans` / `origins`, or null.
   *
   * Present after a full `parseDocument` (open and reload). Null after an
   * incremental save, where main did not reparse the whole file; the renderer
   * keeps its editor and only needs Worker/sync parse again on a full reload.
   */
  readonly nodes: readonly import('mdast').RootContent[] | null;
  /**
   * Mirrors `NotoDocument.nodesEnrichment`. Present with open/reload nodes;
   * omitted when `nodes` is null.
   */
  readonly nodesEnrichment?: 'full' | 'deferred';
}

/**
 * One ordered editing unit. `origin` is null for a block the user newly created,
 * which the serializer accepts but reparses to confirm it is exactly one block.
 */
export interface NotoUnit {
  readonly origin: NotoBlockOrigin | null;
  /**
   * The block's markdown, or null when it is unchanged from its origin.
   *
   * Null is not an optimization detail leaking into the contract: it is the
   * difference between "this block now reads like this" and "nobody touched
   * this block". Sending the text of every untouched block made the cost of a
   * save scale with the document rather than with the edit, which on a large
   * file is the difference between instant and unusable.
   *
   * A unit with no origin must carry markdown, since there is nothing to be
   * unchanged from.
   */
  readonly markdown: string | null;
}

/**
 * What a save is asked to make the file's line endings and last byte.
 *
 * Carried on the transaction rather than read from the document, because this
 * is the one thing a save may deliberately change about bytes it was not asked
 * to edit. Every other rewrite is confined to the blocks the reader touched;
 * converting line endings is by definition a rewrite of every line in the file,
 * so it has to be asked for explicitly and it has to be visible in the payload
 * that asks for it.
 *
 * `mixed` means leave the endings as they are, which is what every save does
 * today, said out loud rather than implied by the absence of a field.
 */
export interface NotoTargetEnvelope {
  readonly lineEnding: NotoLineEnding;
  readonly hasFinalNewline: boolean;
}

export type NotoTransaction =
  | {
      readonly version: typeof NOTO_MARKDOWN_VERSION;
      readonly mode: 'blocks';
      readonly documentId: NotoDocumentId;
      readonly revisionId: NotoRevisionId;
      readonly units: readonly NotoUnit[];
      /** How the file should end up. See `NotoTargetEnvelope`. */
      readonly envelope: NotoTargetEnvelope;
    }
  | {
      readonly version: typeof NOTO_MARKDOWN_VERSION;
      readonly mode: 'source';
      readonly documentId: NotoDocumentId;
      readonly revisionId: NotoRevisionId;
      readonly expectedSourceSha256: string;
      readonly sourceBytes: Uint8Array;
    };

/** Evidence that a byte range survived a save untouched. */
export interface NotoPreservedRange {
  readonly role: 'bom' | 'block' | 'gap' | 'leading' | 'trailing';
  readonly start: number;
  readonly end: number;
  readonly sha256: string;
}

export type NotoParseFailureCode =
  | 'INVALID_UTF8'
  | 'EMPTY_DOCUMENT';

export type NotoSerializeFailureCode =
  | 'UNSUPPORTED_VERSION'
  | 'WRONG_DOCUMENT'
  | 'STALE_REVISION'
  | 'FORGED_ORIGIN'
  | 'DUPLICATE_ORIGIN'
  | 'REORDERED_ORIGIN'
  | 'EMPTY_UNIT'
  | 'MULTI_BLOCK_UNIT'
  | 'REPARSE_MISMATCH'
  | 'INVALID_FULL_SOURCE'
  | 'DOCUMENT_INTEGRITY_FAILED';

export interface NotoParseFailure {
  readonly status: 'failed';
  readonly version: typeof NOTO_MARKDOWN_VERSION;
  readonly code: NotoParseFailureCode;
  readonly message: string;
  readonly originalBytes: Uint8Array;
}

export interface NotoSerializeFailure {
  readonly status: 'failed';
  readonly version: typeof NOTO_MARKDOWN_VERSION;
  readonly code: NotoSerializeFailureCode;
  readonly message: string;
  readonly originalBytes: Uint8Array;
}

export interface NotoSerializeSuccess {
  readonly status: 'serialized';
  readonly version: typeof NOTO_MARKDOWN_VERSION;
  readonly outputBytes: Uint8Array;
  readonly outputSha256: string;
  /** The reparsed document, ready to become the next accepted revision. */
  readonly document: NotoDocument;
  readonly preserved: readonly NotoPreservedRange[];
}

export type NotoParseResult =
  | { readonly status: 'parsed'; readonly document: NotoDocument }
  | NotoParseFailure;

export type NotoSerializeResult = NotoSerializeSuccess | NotoSerializeFailure;

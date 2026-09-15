/**
 * The writing surface.
 *
 * A thin React wrapper: ProseMirror owns the DOM inside the host element, so
 * React must never re-render into it. The editor is rebuilt only when the
 * document revision changes, which is why `revisionId` is the sole dependency.
 */

import { useEffect, useLayoutEffect, useRef } from 'react';
import { documentDirOf } from './image-source';
import type { NotoDocumentWire, NotoTransaction } from '../../../shared/markdown/v3/contracts';
import { NotoEditor, type InsertedImage } from './NotoEditor';
import { parseDocumentSpans } from './parse-document';
import { blockSpansFromWire, type BlockSpan } from '../../../shared/markdown/v3/blocks';
import {
  enrichSpansInRange,
  resolveDeferredOpenSpans,
} from '../../../shared/markdown/v3/roobli-md-adapter';
import type { DocumentCount } from './word-count';

export interface NotoCanvasProps {
  readonly document: NotoDocumentWire;
  readonly mac: boolean;
  readonly smartQuotes?: boolean;
  readonly smartDashes?: boolean;
  readonly smartEllipsis?: boolean;
  readonly spellCheck?: boolean;
  /** Where the document lives, so its relative images know where to start. */
  readonly documentPath: string | null;
  readonly remoteImages?: boolean;
  /** Keep the line being written at the middle of the window. */
  readonly typewriterMode?: boolean;
  /** Close a bracket or a quote as it is opened. */
  readonly autoPair?: boolean;
  /** Append a check date when a task is ticked. */
  readonly todoCheckTime?: boolean;
  readonly markHighlight?: boolean;
  readonly markSuperscript?: boolean;
  readonly markSubscript?: boolean;
  /** Draw `<span class="sidenote">` as numbered margin notes. */
  readonly sidenotes?: boolean;
  /** The top level block the caret is in, when it changes. */
  readonly onActiveBlockChanged?: (index: number) => void;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onDocumentChanged?: () => void;
  readonly onFollowWikiLink?: (target: string) => void;
  readonly onWikiTrigger?: () => void;
  readonly onFollowLink?: (href: string) => void;
  readonly onDropNote?: (file: File) => void;
  readonly onCountChanged?: (count: DocumentCount) => void;
  readonly onReady: (editor: NotoEditor) => void;
  readonly onTeardown: (editor: NotoEditor) => void;
  readonly onError: (message: string) => void;
  /** Writes pasted picture bytes and answers with the reference to insert. */
  readonly onWriteImage?: (bytes: Uint8Array) => Promise<InsertedImage | null>;
  /** Command and a bracket, when the caret is not in a list to indent. */
  readonly onWidthStep?: (direction: 1 | -1) => void;
}

export function NotoCanvas({
  document,
  mac,
  smartQuotes,
  smartDashes,
  smartEllipsis,
  spellCheck,
  documentPath,
  remoteImages,
  typewriterMode,
  autoPair,
  todoCheckTime,
  markHighlight,
  markSuperscript,
  markSubscript,
  sidenotes,
  onActiveBlockChanged,
  onDirtyChange,
  onDocumentChanged,
  onFollowWikiLink,
  onWikiTrigger,
  onFollowLink,
  onDropNote,
  onCountChanged,
  onReady,
  onTeardown,
  onError,
  onWriteImage,
  onWidthStep,
}: NotoCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<NotoEditor | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;
    let editor: NotoEditor | null = null;

    void (async () => {
      // Prefer mdast nodes main already sent on the wire (skips the second
      // micromark pass). Fall back to the Worker when nodes are null, which is
      // the incremental-save reply shape; open and reload carry nodes.
      let spans: readonly BlockSpan[];
      let deferredRemainderFrom: number | null = null;
      try {
        spans = blockSpansFromWire(document) ?? await parseDocumentSpans(document.text);
        // Flagged lazy open: main shipped structural stand-ins. Enrich a
        // first-paint window with one range dialect parse (not N×), mount,
        // then fill the remainder after the first frame.
        const prepared = resolveDeferredOpenSpans(spans, document.text, {
          deferred: document.nodesEnrichment === 'deferred',
        });
        spans = prepared.spans;
        deferredRemainderFrom = prepared.remainderFrom;
      } catch (error) {
        if (!cancelled) {
          onError(error instanceof Error ? error.message : 'The editor failed to start.');
        }
        return;
      }
      if (cancelled) return;

      try {
        editor = new NotoEditor(host, document, {
          mac,
          smartQuotes,
          smartDashes,
          smartEllipsis,
          spellCheck,
          images: { documentDir: documentDirOf(documentPath), remote: remoteImages ?? true },
          onActiveBlockChanged,
          onDirtyChange,
          onDocumentChanged,
          onFollowWikiLink,
          onWikiTrigger,
          onFollowLink,
          onDropNote,
          onCountChanged,
          onError,
          onWriteImage,
          onWidthStep,
        }, spans);
      } catch (error) {
        if (!cancelled) {
          onError(error instanceof Error ? error.message : 'The editor failed to start.');
        }
        return;
      }

      if (cancelled) {
        editor.destroy();
        return;
      }

      editorRef.current = editor;
      onReady(editor);

      if (deferredRemainderFrom !== null) {
        const partial = spans;
        const from = deferredRemainderFrom;
        const mounted = editor;
        requestAnimationFrame(() => {
          if (cancelled || editorRef.current !== mounted) return;
          try {
            const full = enrichSpansInRange(partial, document.text, {
              from,
              to: partial.length,
            });
            mounted.applyDialectEnrichedSpans(full);
          } catch (error) {
            if (!cancelled) {
              onError(error instanceof Error ? error.message : 'Dialect enrich after open failed.');
            }
          }
        });
      }
    })();

    return () => {
      cancelled = true;
      const current = editor;
      editorRef.current = null;
      if (current) {
        onTeardown(current);
        current.destroy();
      }
    };
    // Only a different document rebuilds the editor.
    //
    // Not the revision. Every save produces a new revision, so keying on it
    // tore down the editor each time the user pressed save, taking their undo
    // history, selection and scroll position with it. A new revision of the
    // same document is applied in place by `commit`, which is what that method
    // is for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document.documentId]);

  // Settings reach the running editor rather than rebuilding it, so changing a
  // preference never costs the user their undo history or cursor.
  useEffect(() => {
    editorRef.current?.applySettings({
      smartQuotes, smartDashes, smartEllipsis, spellCheck, remoteImages, typewriterMode, autoPair,
      todoCheckTime,
      markHighlight, markSuperscript, markSubscript, sidenotes,
    });
  }, [smartQuotes, smartDashes, smartEllipsis, spellCheck, remoteImages, typewriterMode, autoPair, todoCheckTime, markHighlight, markSuperscript, markSubscript, sidenotes]);

  return <div ref={hostRef} className="noto-editor-host" data-testid="noto-editor" />;
}

export type { NotoTransaction };

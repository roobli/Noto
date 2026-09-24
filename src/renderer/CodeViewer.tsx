/**
 * Read-only view of a non-Markdown text or code file.
 *
 * The author's typora-plugin-lite `code-viewer` paints source with line numbers
 * and syntax colour, and never writes the file. Noto does the same: the pane
 * is contentEditable=false, tokens are built with textContent, and the gutter
 * is a CSS ::before so a copy never carries line numbers.
 *
 * Markup preview (HTML / SVG / drawio.svg): default isolated Preview with a
 * Preview ↔ Source toggle. SVG (including `.drawio.svg`) uses `<img>` + a
 * blob `image/svg+xml` URL so scripts do not run. HTML uses a sandboxed
 * iframe + blob `text/html` with an empty `sandbox` attribute (no scripts,
 * no same-origin, no forms) — stricter than plugin-lite's unsandboxed
 * `file://` iframe. Fail → Source. Plain `.drawio` XML stays source-only.
 * Not markdown/ProseMirror; no WYSIWYG; no trust-scripts in v1.
 */

import { useEffect, useMemo, useState } from 'react';
import type { WorkspaceCodeViewV1 } from '../shared/workspace/v1/contracts';
import {
  isDrawioFileName,
  isDrawioSvgFileName,
  isHtmlMarkupFileName,
  isSvgMarkupFileName,
} from '../shared/code-viewer/languages';
import { highlightCodeLines } from './code-viewer-highlight';

export interface CodeViewerProps {
  readonly view: WorkspaceCodeViewV1;
}

export type MarkupPreviewKind = 'svg' | 'html';

/** True when the body looks like SVG enough to risk a preview. */
export function looksLikeSvgContent(content: string): boolean {
  if (content.length === 0) return false;
  const head = content.slice(0, 2048);
  return /<svg[\s/>]/i.test(head);
}

/**
 * Which isolated preview (if any) this code view can offer.
 *
 * Returns null when there is a notice (binary / oversized), when an SVG body
 * does not look like SVG, or when the file is not renderable markup.
 */
export function markupPreviewKindFor(
  fileName: string,
  content: string,
  notice: string | null | undefined,
): MarkupPreviewKind | null {
  if (notice) return null;
  if (isSvgMarkupFileName(fileName)) {
    return looksLikeSvgContent(content) ? 'svg' : null;
  }
  if (isHtmlMarkupFileName(fileName)) {
    return content.length > 0 ? 'html' : null;
  }
  return null;
}

export function CodeViewer({ view }: CodeViewerProps) {
  const drawioSvg = isDrawioSvgFileName(view.name);
  const drawioXml = isDrawioFileName(view.name);
  const previewKind = markupPreviewKindFor(view.name, view.content, view.notice);
  const canPreview = previewKind !== null;

  const [mode, setMode] = useState<'preview' | 'source'>(canPreview ? 'preview' : 'source');
  const [previewFailed, setPreviewFailed] = useState(false);

  // Reset mode / failure when opening a different file or when previewability changes.
  useEffect(() => {
    setMode(canPreview ? 'preview' : 'source');
    setPreviewFailed(false);
  }, [view.path, canPreview]);

  const effectiveCanPreview = canPreview && !previewFailed;
  const showPreview = effectiveCanPreview && mode === 'preview';
  const showSource = !showPreview;

  const previewUrl = useMemo(() => {
    if (!canPreview || !previewKind) return null;
    const type = previewKind === 'svg' ? 'image/svg+xml' : 'text/html';
    return URL.createObjectURL(new Blob([view.content], { type }));
  }, [canPreview, previewKind, view.content]);

  useEffect(() => {
    if (!previewUrl) return undefined;
    return () => {
      URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const lines = useMemo(
    () => (view.content === '' && view.notice ? [] : highlightCodeLines(view.content, view.language)),
    [view.content, view.language, view.notice],
  );
  const gutterCh = Math.max(3, String(Math.max(lines.length, 1)).length + 1);
  const langLabel = drawioXml ? 'drawio' : drawioSvg ? 'drawio.svg' : view.language;

  const onPreviewError = () => {
    setPreviewFailed(true);
    setMode('source');
  };

  return (
    <div
      className="code-viewer"
      data-testid="code-viewer"
      data-path={view.path}
      data-drawio={drawioXml || drawioSvg ? '1' : undefined}
      data-markup-preview={effectiveCanPreview ? previewKind ?? undefined : undefined}
      data-preview-mode={showPreview ? 'preview' : 'source'}
    >
      <header className="code-viewer-head">
        <span className="code-viewer-dot" aria-hidden />
        <span className="code-viewer-name">{view.name}</span>
        {langLabel ? <span className="code-viewer-lang">{langLabel}</span> : null}
        {effectiveCanPreview ? (
          <button
            type="button"
            className="code-viewer-toggle"
            data-testid="code-viewer-mode-toggle"
            aria-pressed={mode === 'source'}
            onClick={() => setMode((current) => (current === 'preview' ? 'source' : 'preview'))}
          >
            {mode === 'preview' ? 'Source' : 'Preview'}
          </button>
        ) : null}
        <span className="code-viewer-ro">Read-only</span>
      </header>
      {drawioXml && lines.length > 0 ? (
        <div className="code-viewer-notice" role="status">
          Draw.io diagram (XML). Edit it in Draw.io / diagrams.net; Noto shows the source read-only.
        </div>
      ) : null}
      {showPreview && previewUrl && previewKind === 'svg' ? (
        <div
          className="code-viewer-preview"
          data-testid="code-viewer-preview"
          data-preview-kind="svg"
        >
          <img
            className="code-viewer-preview-img"
            src={previewUrl}
            alt={view.name}
            onError={onPreviewError}
          />
        </div>
      ) : null}
      {showPreview && previewUrl && previewKind === 'html' ? (
        <div
          className="code-viewer-preview code-viewer-preview-html"
          data-testid="code-viewer-preview"
          data-preview-kind="html"
        >
          {/*
            Empty sandbox: no allow-scripts, no allow-same-origin, no forms.
            Blob URL keeps the document off file:// and off the editor origin.
            Relative assets will not resolve — intentional isolation for v1.
          */}
          <iframe
            className="code-viewer-preview-frame"
            title={view.name}
            src={previewUrl}
            sandbox=""
            referrerPolicy="no-referrer"
            onError={onPreviewError}
          />
        </div>
      ) : null}
      {view.notice && lines.length === 0 ? (
        <div className="code-viewer-notice" role="status">{view.notice}</div>
      ) : showSource ? (
        <>
          <div
            className="code-viewer-code"
            style={{ ['--code-viewer-gutter-ch' as string]: `${gutterCh}ch` }}
            spellCheck={false}
          >
            {lines.map((tokens, index) => (
              <div className="code-viewer-row" data-ln={String(index + 1)} key={index}>
                <span className="code-viewer-src">
                  {tokens.length === 0
                    ? null
                    : tokens.map((token, tokenIndex) => (
                      token.cls
                        ? <span className={`token ${token.cls}`} key={tokenIndex}>{token.text}</span>
                        : <span key={tokenIndex}>{token.text}</span>
                    ))}
                </span>
              </div>
            ))}
          </div>
          {view.notice ? (
            <div className="code-viewer-notice" role="status">{view.notice}</div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

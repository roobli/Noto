/**
 * A note rendered for Quick Open's preview, the way the page renders it.
 *
 * The same parser the editor opens a note with (`splitBlocks`, then the
 * dialect pass and `docFromSpans`) builds the same ProseMirror document, and
 * the schema's own `toDOM` turns it into the elements the editor's stylesheet
 * already knows how to set. So a heading is the page's heading, a table the
 * page's table, a fence the page's fence, at the page's sizes: what the
 * preview shows is what the note looks like once opened, not a likeness of it.
 *
 * What the editor adds on top with node views (a fence's line numbers and
 * colours, a typeset formula, a picture loaded from disk) is added here only
 * where it is cheap and safe: formulas are typeset with KaTeX in its untrusted
 * mode, and pictures are shown as their alternative text, never fetched,
 * because a preview walked down with the arrow keys must not reach the
 * network or the disk once per row. Raw HTML is drawn as text, as the editor
 * draws a block it would not trust.
 */

import katex from 'katex';
import { DOMSerializer } from 'prosemirror-model';
import { splitBlocks } from '../shared/markdown/v3/blocks';
import { docFromSpans } from '../shared/markdown/v3/pm/from-mdast';
import { notoSchema } from '../shared/markdown/v3/pm/schema';
import { enrichSpansInRange } from '../shared/markdown/v3/roobli-md-adapter';

/** Formulas typeset at most, so a note of hundreds does not stall the arrow keys. */
const FORMULAS = 60;

/**
 * The note's markdown as the page's DOM, in a fragment of the given document.
 *
 * `text` is what main read of the note: its opening, which may stop mid-block.
 * A block cut off by the read is drawn as far as it goes.
 */
export function renderNotePreview(text: string, into: Document = document): DocumentFragment {
  const spans = splitBlocks(text).spans;
  const enriched = enrichSpansInRange(spans, text, { from: 0, to: spans.length });
  const doc = docFromSpans(enriched);
  const fragment = DOMSerializer.fromSchema(notoSchema).serializeFragment(doc.content, { document: into }) as DocumentFragment;
  finish(fragment);
  return fragment;
}

/** The few things the editor's node views would have drawn, done safely. */
function finish(root: DocumentFragment): void {
  let typeset = 0;
  for (const element of root.querySelectorAll<HTMLElement>('.noto-math-block, .noto-math-inline')) {
    if (typeset >= FORMULAS) break;
    const display = element.classList.contains('noto-math-block');
    const source = element.textContent ?? '';
    if (source.trim().length === 0) continue;
    try {
      katex.render(source, element, { displayMode: display, throwOnError: true, trust: false, strict: false });
      element.dataset.state = 'rendered';
      typeset += 1;
    } catch {
      // The source stays, as the editor shows a formula it cannot typeset.
      element.dataset.state = 'error';
    }
  }
  for (const image of root.querySelectorAll('img')) {
    const placeholder = image.ownerDocument.createElement('span');
    placeholder.className = 'quick-preview-picture';
    placeholder.textContent = image.getAttribute('alt') || (image.getAttribute('src') ?? '').split(/[\\/]/).pop() || 'picture';
    image.replaceWith(placeholder);
  }
  // Links are read, not followed: the preview is for finding the note.
  for (const link of root.querySelectorAll('a')) {
    link.removeAttribute('href');
    link.setAttribute('tabindex', '-1');
  }
}

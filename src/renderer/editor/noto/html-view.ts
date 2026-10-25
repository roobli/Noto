/**
 * Raw HTML on screen, and the one case where it shows a picture.
 *
 * HTML in a note is kept as source and never rendered live. The block and
 * the inline node are drawn as their text in a quiet monospace face, which is
 * honest and is also what a reader expects of a thing they have to edit by
 * hand. The exception is a lone `<img>` tag, which the vault holds nine
 * hundred of: when the caret is elsewhere the tag is shown as the picture it
 * names, drawn through the same frame markdown images use, and when the
 * caret enters the block the source comes back, which is what Typora does.
 *
 * The source is never removed from the block, only hidden, so the editor's
 * view of the text, and the caret's path into it, are unchanged by the
 * picture in front of it.
 */

import { resolveImageSource } from './image-source';
import { sanitizeHtml, worthDrawing } from './html-sanitize';
import { zoomedTag } from './image-tag';
import type { Node as ProseNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import type { EditorView, NodeView } from 'prosemirror-view';
import { parseImageTag, type HtmlImage } from './html-image';
import type { ImageContext } from './image-source';
import { ImageFrame, type Picture, type Refreshable } from './image-view';

/**
 * Whether a block is nothing but an HTML comment.
 *
 * A comment is the one kind of raw HTML that says nothing to the reader: it is
 * a note to a person editing the source, or a marker some tool writes. The
 * author's vault is full of the second kind, `<!-- note-assistant:index:start
 * -->` around generated sections, and drawing each one as a bordered block of
 * source puts a grey slab in the middle of the prose for a line nobody reads.
 * Typora draws them quietly and so does this.
 *
 * Only a block that is entirely one comment counts. A comment with markup
 * after it is still markup, and hiding its frame would hide that too.
 */
export function isHtmlComment(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('<!--') || !trimmed.endsWith('-->')) return false;
  // No second comment inside it, or the block holds more than one thing and the
  // text between them is not a comment at all.
  return !trimmed.slice(4, -3).includes('-->');
}

const pictureOf = (tag: HtmlImage): Picture => ({
  src: tag.src,
  alt: tag.alt,
  title: tag.title,
  width: tag.width,
  height: tag.height,
  zoom: tag.zoom,
  styleWidth: tag.styleWidth,
});

export class HtmlBlockView implements NodeView, Refreshable {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private readonly preview: HTMLElement;
  private readonly markup: HTMLElement;
  private readonly frame: ImageFrame;

  constructor(
    private node: ProseNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly context: () => ImageContext,
    private readonly registry: Set<Refreshable>,
  ) {
    this.dom = document.createElement('div');
    this.dom.className = 'noto-html-block';
    this.contentDOM = document.createElement('div');
    this.contentDOM.className = 'noto-html-source';
    this.frame = new ImageFrame(context, registry);
    this.preview = document.createElement('div');
    this.preview.className = 'noto-html-preview';
    this.preview.contentEditable = 'false';
    this.preview.append(this.frame.dom);
    // The drawn markup, for everything that is not a lone picture. It takes
    // the same press as the picture does: a click puts the caret in the
    // source behind it, which is how the markup is edited.
    this.markup = document.createElement('div');
    this.markup.className = 'noto-html-drawn';
    this.markup.contentEditable = 'false';
    this.markup.addEventListener('mousedown', (event) => {
      // Not a link: following one is what a reader means by pressing it.
      if (event.target instanceof Element && event.target.closest('a[href]')) return;
      // Nor the twisty of a `<details>`, which is there to be opened.
      if (event.target instanceof Element && event.target.closest('summary')) return;
      event.preventDefault();
      const base = this.getPos();
      if (base === undefined) return;
      const { state } = this.view;
      this.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, base + 1)));
      this.view.focus();
    });
    // A press on the picture puts the caret in the source behind it, which
    // is how the tag is edited: the block becomes the active one and shows
    // its text.
    this.preview.addEventListener('mousedown', (event) => {
      event.preventDefault();
      const base = this.getPos();
      if (base === undefined) return;
      const { state } = this.view;
      this.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, base + 1)));
      this.view.focus();
    });
    this.dom.append(this.contentDOM);
    this.render();
    registry.add(this);
  }

  update(node: ProseNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  /**
   * Draw again under a changed image context.
   *
   * A lone picture is the frame's, and the frame refreshes itself. Drawn
   * markup resolved its pictures' addresses against the context it was drawn
   * under, so with web images switched or a folder opened since, it is drawn
   * again. Markup without a picture has nothing that depends on the context
   * and is left as it is, a `<details>` the reader opened included.
   */
  refresh(): void {
    if (this.dom.dataset.preview === 'markup' && this.markup.querySelector('img')) this.render();
  }

  /** Only the source is the editor's. */
  ignoreMutation(mutation: MutationRecord | { type: 'selection'; target: Node }): boolean {
    return !this.contentDOM.contains(mutation.target);
  }

  stopEvent(event: Event): boolean {
    return event.target instanceof Node
      && (this.preview.contains(event.target) || this.markup.contains(event.target));
  }

  destroy(): void {
    this.registry.delete(this);
    this.frame.destroy();
  }

  private render(): void {
    // Said quietly rather than drawn as a slab of source. The text is still
    // there and still editable; only its frame is dropped.
    this.dom.dataset.comment = String(isHtmlComment(this.node.textContent));
    const source = this.node.textContent;
    const tag = parseImageTag(source);
    if (tag) {
      this.markup.remove();
      this.frame.render(pictureOf(tag));
      if (!this.preview.isConnected) this.dom.append(this.preview);
      this.dom.dataset.preview = 'image';
      return;
    }
    this.preview.remove();
    // Everything else a note draws with: a table with a merged cell, a
    // `<details>` to fold open, a picture centred in a `<div align>`. What
    // survives the cleaning is what is drawn, and the source stays behind it.
    if (!isHtmlComment(source) && worthDrawing(source)) {
      const drawn = sanitizeHtml(source);
      // A picture inside the markup names a file the way the note does, and
      // the renderer is not allowed to read one: each address goes through
      // the same resolver a markdown image uses, and one that resolves to
      // nothing loses its address rather than asking the network for it.
      for (const picture of drawn.querySelectorAll('img')) {
        const resolved = resolveImageSource(picture.getAttribute('src') ?? '', this.context());
        if (resolved.kind === 'url') picture.setAttribute('src', resolved.url);
        else picture.removeAttribute('src');
      }
      // Only now, with every address final, does the copy join the page.
      this.markup.replaceChildren(document.adoptNode(drawn));
      if (!this.markup.isConnected) this.dom.append(this.markup);
      this.dom.dataset.preview = 'markup';
      return;
    }
    this.markup.remove();
    this.dom.dataset.preview = 'none';
  }
}

export class InlineHtmlView implements NodeView {
  readonly dom: HTMLElement;
  private readonly source: HTMLElement;
  private readonly preview: HTMLElement;
  private readonly frame: ImageFrame;

  constructor(
    private node: ProseNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    context: () => ImageContext,
    registry: Set<Refreshable>,
  ) {
    this.dom = document.createElement('span');
    this.dom.className = 'noto-inline-html';
    this.source = document.createElement('span');
    this.source.className = 'noto-inline-html-source';
    this.frame = new ImageFrame(context, registry);
    this.frame.resizer = {
      editable: () => this.view.editable,
      commit: (zoom) => {
        const pos = this.getPos();
        if (pos === undefined) return;
        const value = zoomedTag(this.node.attrs.value as string, zoom);
        if (value === null) return;
        this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, value }));
      },
    };
    this.preview = document.createElement('span');
    this.preview.className = 'noto-html-preview';
    this.preview.append(this.frame.dom);
    this.dom.append(this.source);
    this.render();
  }

  update(node: ProseNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.frame.destroy();
  }

  private render(): void {
    const value = this.node.attrs.value as string;
    this.source.textContent = value;
    const tag = parseImageTag(value);
    if (tag) {
      this.frame.render(pictureOf(tag));
      if (!this.preview.isConnected) this.dom.append(this.preview);
      this.dom.dataset.preview = 'image';
    } else {
      this.preview.remove();
      this.dom.dataset.preview = 'none';
    }
  }
}

export function htmlNodeViews(registry: Set<Refreshable>, context: () => ImageContext) {
  return {
    html_block: (node: ProseNode, view: EditorView, getPos: () => number | undefined) =>
      new HtmlBlockView(node, view, getPos, context, registry),
    inline_html: (node: ProseNode, view: EditorView, getPos: () => number | undefined) =>
      new InlineHtmlView(node, view, getPos, context, registry),
  };
}

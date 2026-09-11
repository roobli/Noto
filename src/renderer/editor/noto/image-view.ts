/**
 * Pictures on screen: the image node, and the frame it is drawn in.
 *
 * A node view rather than the schema's `toDOM`, because what goes in the
 * `src` depends on two things the schema cannot know: the folder the note is
 * in, and whether the reader has web images turned on. The schema still owns
 * the serialisation, so copying an image copies its markdown, not the asset
 * URL it was shown from.
 *
 * The frame is its own class because a picture arrives two ways, as a
 * markdown image and as an `<img>` tag kept as raw HTML, and both should be
 * drawn by the one piece of code that knows the rules. Every state the
 * picture can be in has a face. One that loads is a picture. One that main
 * refuses, or that is not there, or that is on the web while web images are
 * off, or whose `[reference]` has no definition, becomes a small labelled
 * frame with the note's own words for it, because an empty gap where a
 * picture should be is the one outcome that tells the reader nothing.
 *
 * Live frames register themselves so the editor can redraw the pictures, and
 * only the pictures, when the context changes under an open note: a folder
 * opened after the note, or web images switched.
 */

import { tagForImage } from './image-tag';
import type { Node as ProseNode } from 'prosemirror-model';
import type { EditorView, NodeView } from 'prosemirror-view';
import { imageName, resolveImageSource, type ImageContext } from './image-source';

/** Anything the editor can ask to draw itself again. */
export interface Refreshable {
  refresh(): void;
}

/** What a picture needs, wherever it was written. */
export interface Picture {
  readonly src: string;
  readonly alt: string;
  readonly title: string | null;
  readonly width?: number | null;
  readonly height?: number | null;
  /** A factor, as Typora writes when a picture is resized in place. */
  readonly zoom?: number;
  /** A width in pixels or a percentage, from an HTML style attribute. */
  readonly styleWidth?: string | null;
}

type Reason = 'remote-off' | 'missing' | 'no-document' | 'no-definition' | 'unsupported';

const LABELS: Record<Reason, string> = {
  'remote-off': 'web images off',
  missing: 'not found',
  'no-document': 'no folder',
  'no-definition': 'no definition',
  unsupported: 'unsupported',
};

const EXPLANATIONS: Record<Reason, string> = {
  'remote-off': 'Web images are off. Turn on "Load images from the web" in Settings to show it.',
  missing: 'Could not be loaded. Images load from the open folder and from the folder the note is in.',
  'no-document': 'A relative path needs a folder to start from, and this note has none.',
  'no-definition': 'The note has no "[id]: url" line for this image.',
  unsupported: 'Not a source Noto can show.',
};

interface Shown {
  readonly key: string;
  readonly alt: string;
  readonly title: string | null;
}

/** How a frame's picture is resized: whether it may be, and what to do with the new zoom. */
export interface Resizer {
  readonly editable: () => boolean;
  readonly commit: (zoom: number) => void;
}

/** The smallest a picture may be dragged to; past this the drag is a slip. */
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;

export class ImageFrame implements Refreshable {
  readonly dom: HTMLElement;
  private picture: Picture | null = null;
  private shown: Shown | null = null;
  /** The last request for this picture was refused or failed. */
  private failed = false;
  /** Set by a node view that can write the zoom back; a frame without one does not resize. */
  resizer: Resizer | null = null;

  constructor(
    private readonly context: () => ImageContext,
    private readonly registry: Set<Refreshable>,
  ) {
    this.dom = document.createElement('span');
    this.dom.className = 'noto-image-frame';
    registry.add(this);
  }

  /** Draw `picture`, or the "no definition" face for null. Unchanged parts are left alone. */
  render(picture: Picture | null, retry = false): void {
    this.picture = picture;
    const alt = picture?.alt ?? '';
    const title = picture?.title ?? null;
    const source = picture === null
      ? { kind: 'unresolved' as const, reason: 'no-definition' as const }
      : resolveImageSource(picture.src, this.context());
    const sizing = picture ? `${picture.width ?? ''}x${picture.height ?? ''}|${picture.zoom ?? 1}|${picture.styleWidth ?? ''}` : '';
    const key = source.kind === 'unresolved' ? `unresolved:${source.reason}` : `${source.kind}:${source.url}|${sizing}`;

    // The same picture with new words: patch the words rather than reload it.
    if (this.shown?.key === key && !retry) {
      if (this.shown.alt !== alt || this.shown.title !== title) {
        this.dom.title = title ?? '';
        const img = this.dom.querySelector('img');
        if (img) img.alt = alt;
        const name = this.dom.querySelector('.noto-image-name');
        if (name) name.textContent = displayName(picture?.src ?? '', alt);
        this.shown = { key, alt, title };
      }
      return;
    }

    this.shown = { key, alt, title };
    this.failed = false;
    this.dom.replaceChildren();
    this.dom.title = title ?? '';

    if (source.kind !== 'url') {
      const reason: Reason = source.kind === 'remote-off' ? 'remote-off'
        : source.reason === 'no-document' ? 'no-document'
          : source.reason === 'no-definition' ? 'no-definition'
            : 'unsupported';
      this.dom.append(placeholder(picture?.src ?? '', alt, reason));
      return;
    }

    const img = document.createElement('img');
    img.className = 'noto-image';
    img.alt = alt;
    img.draggable = false;
    img.decoding = 'async';
    if (picture?.width) img.width = picture.width;
    if (picture?.height) img.height = picture.height;
    if (picture?.styleWidth) img.style.width = picture.styleWidth;
    if (picture?.zoom && picture.zoom !== 1) img.style.zoom = String(picture.zoom);
    img.addEventListener('error', () => {
      this.failed = true;
      img.replaceWith(placeholder(picture?.src ?? '', alt, 'missing'));
    }, { once: true });
    img.src = source.url;
    this.dom.append(img);
    if (this.resizer) this.dom.append(this.handleFor(img, picture?.zoom ?? 1));
  }

  /**
   * Typora's corner: drag it and the picture follows, and on release the
   * zoom is written into the note. The picture is previewed at the new zoom
   * while the pointer moves, so what is seen is what will be written; Escape
   * puts it back and writes nothing.
   */
  private handleFor(img: HTMLImageElement, startZoom: number): HTMLElement {
    const handle = document.createElement('span');
    handle.className = 'noto-image-handle';
    handle.setAttribute('contenteditable', 'false');
    handle.title = 'Drag to resize';
    handle.addEventListener('pointerdown', (event) => {
      const resizer = this.resizer;
      if (!resizer || !resizer.editable() || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startWidth = img.getBoundingClientRect().width;
      if (startWidth <= 0) return;
      let zoom = startZoom;
      handle.setPointerCapture(event.pointerId);
      this.dom.dataset.resizing = 'true';
      const move = (moveEvent: PointerEvent) => {
        const factor = (startWidth + (moveEvent.clientX - startX)) / startWidth;
        zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, startZoom * factor));
        img.style.zoom = String(zoom);
      };
      const finish = (commit: boolean) => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', cancel);
        window.removeEventListener('keydown', onKey, true);
        delete this.dom.dataset.resizing;
        if (commit && Math.round(zoom * 100) !== Math.round(startZoom * 100)) resizer.commit(zoom);
        else img.style.zoom = startZoom === 1 ? '' : String(startZoom);
      };
      const up = () => finish(true);
      const cancel = () => finish(false);
      const onKey = (keyEvent: KeyboardEvent) => {
        if (keyEvent.key === 'Escape') { keyEvent.preventDefault(); finish(false); }
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', cancel);
      window.addEventListener('keydown', onKey, true);
    });
    return handle;
  }

  /**
   * Draw again under a changed context.
   *
   * A picture that loaded is left alone. One that failed is asked for again,
   * because the context changing is exactly what may make it load now. An
   * ordinary node update does not retry: the cursor moving past an image
   * changes its decorations, and that must not cost a request each time.
   */
  refresh(): void {
    this.render(this.picture, this.failed);
  }

  destroy(): void {
    this.registry.delete(this);
  }
}

export class ImageView implements NodeView {
  readonly dom: HTMLElement;
  private readonly frame: ImageFrame;

  constructor(
    private node: ProseNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    context: () => ImageContext,
    registry: Set<Refreshable>,
  ) {
    this.frame = new ImageFrame(context, registry);
    this.frame.resizer = {
      editable: () => this.view.editable,
      // A markdown image has nowhere to put a size, so a resized one becomes
      // the tag, which is what Typora writes when a picture is dragged.
      commit: (zoom) => {
        const pos = this.getPos();
        if (pos === undefined) return;
        const { alt, title } = this.node.attrs as { alt: string; title: string | null };
        const src = this.sourceOf();
        if (src === null) return;
        const tag = this.view.state.schema.nodes.inline_html.create({ value: tagForImage(src, alt, title, zoom) });
        this.view.dispatch(this.view.state.tr.replaceWith(pos, pos + this.node.nodeSize, tag));
      },
    };
    this.dom = this.frame.dom;
    this.render();
  }

  update(node: ProseNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  destroy(): void {
    this.frame.destroy();
  }

  /** The frame's children are ours; the editor must not read them as edits. */
  ignoreMutation(): boolean {
    return true;
  }

  private render(): void {
    const { alt, title } = this.node.attrs as { alt: string; title: string | null };
    const src = this.sourceOf();
    this.frame.render(src === null ? null : { src, alt, title });
  }

  /**
   * What the node names, or null when it names a definition the note lacks.
   *
   * A `![alt][id]` image carries no URL of its own; the URL is on a
   * `[id]: url` line somewhere in the note, which the parser keeps as a node.
   * Looked up on each draw, since a reference image is two in seven thousand
   * notes here and the walk stops at the first match.
   */
  private sourceOf(): string | null {
    const { src, referenceType, identifier } = this.node.attrs as {
      src: string; referenceType: string | null; identifier: string;
    };
    if (!referenceType) return src;
    let url: string | null = null;
    this.view.state.doc.descendants((candidate) => {
      if (url !== null) return false;
      if (candidate.type.name === 'link_definition' && candidate.attrs.identifier === identifier) {
        url = candidate.attrs.url as string;
        return false;
      }
      return true;
    });
    return url;
  }
}

const displayName = (src: string, alt: string): string =>
  (alt.trim().length > 0 ? alt : imageName(src));

function placeholder(src: string, alt: string, reason: Reason): HTMLElement {
  const frame = document.createElement('span');
  frame.className = 'noto-image-placeholder';
  frame.dataset.reason = reason;
  frame.title = `${EXPLANATIONS[reason]}\n${src}`;

  const name = document.createElement('span');
  name.className = 'noto-image-name';
  name.textContent = displayName(src, alt);

  const label = document.createElement('span');
  label.className = 'noto-image-reason';
  label.textContent = LABELS[reason];

  frame.append(name, label);
  return frame;
}

export function imageNodeViews(registry: Set<Refreshable>, context: () => ImageContext) {
  return {
    image: (node: ProseNode, view: EditorView, getPos: () => number | undefined) =>
      new ImageView(node, view, getPos, context, registry),
  };
}

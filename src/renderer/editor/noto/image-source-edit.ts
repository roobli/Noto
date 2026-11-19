/**
 * A picture's source, shown and edited where the picture is, as Typora does.
 *
 * In Typora a picture written `![alt](path)` reads as the picture until the
 * caret comes beside it; then its markdown opens above it, `![alt](path)`,
 * editable as text, and the picture stays underneath as the preview. Here the
 * picture is one atom in the document (an `image` node, or an `inline_html`
 * node holding a lone `<img>` tag), which the caret can only stand beside and
 * which edited only through Source Code Mode.
 *
 * This plugin gives it that face. When the caret stands right before or right
 * after a picture, and nothing is selected, the picture's markdown is drawn
 * over it as a field. The arrow keys walk into it from either side, as they
 * walk into text, and out of it at its ends. Typing in the field edits that
 * markdown; Enter, the arrows out, or a press elsewhere writes it back, and
 * Escape puts it back as it was, parsed as the note would
 * parse it, so `![a](b.png)` stays an image, `<img src=… style="zoom:50%">`
 * stays the tag, and anything else the text becomes (a link, words) is what
 * the note now says. The field writes nothing when its text is unchanged.
 *
 * A widget rather than a change to the document: the picture is never turned
 * into text while it is looked at, so moving the caret past a picture does
 * not make the note dirty, and undo sees one step per real edit.
 */

import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState } from 'prosemirror-state';
import { Fragment, Slice, type Node as ProseNode } from 'prosemirror-model';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { parseImageTag } from './html-image';
import { tagForImage, zoomedTag } from './image-tag';
import { sliceToMarkdown } from './clipboard';
import { sliceFromText } from './paste-text';

export const imageSourceKey = new PluginKey<ImageSourceState>('noto-image-source');

interface ImageSourceState {
  /** The picture whose source is open: its position, or null. */
  readonly at: number | null;
  /** A picture whose field was just closed, kept shut until the caret moves. */
  readonly shutAt: number | null;
}

/** Whether a node is drawn as a picture. */
export function isPicture(node: ProseNode | null | undefined): node is ProseNode {
  if (!node) return false;
  if (node.type.name === 'image') return true;
  return node.type.name === 'inline_html' && parseImageTag(String(node.attrs.value ?? '')) !== null;
}

/** The picture the caret stands beside, as its position, or null. */
export function pictureBeside(state: EditorState): number | null {
  const { selection } = state;
  // An arrow reaching an atom selects it whole; a picture selected so is one beside the caret.
  if (selection instanceof NodeSelection) return isPicture(selection.node) ? selection.from : null;
  if (!selection.empty || !(selection instanceof TextSelection)) return null;
  const $head = selection.$head;
  if (!$head.parent.isTextblock) return null;
  if (isPicture($head.nodeAfter)) return $head.pos;
  if (isPicture($head.nodeBefore)) return $head.pos - $head.nodeBefore!.nodeSize;
  return null;
}

/** A picture's markdown, as the note writes it. */
export function pictureSource(node: ProseNode): string {
  if (node.type.name === 'inline_html') return String(node.attrs.value ?? '');
  return sliceToMarkdown(new Slice(Fragment.from(node), 0, 0)).replace(/\n+$/, '');
}

/** Write `text` over the picture at `at`, parsed as the note would read it. Nothing when unchanged. */
function writeSource(view: EditorView, at: number, text: string): boolean {
  const state = view.state;
  const node = state.doc.nodeAt(at);
  if (!isPicture(node)) return false;
  if (text === pictureSource(node)) return false;
  const $at = state.doc.resolve(at);
  const slice = text.length === 0 ? Slice.empty : sliceFromText(text, $at);
  // One line of inline content is all a picture's place holds; anything with
  // blocks in it (a pasted list) goes in as the text it was typed as.
  const inline = slice.content.childCount === 1 && slice.content.firstChild!.type.name === 'paragraph'
    ? slice.content.firstChild!.content
    : Fragment.from(state.schema.text(text));
  const tr = state.tr.replaceWith(at, at + node.nodeSize, inline);
  // The caret goes after what was written, where it would be after typing it.
  tr.setSelection(TextSelection.create(tr.doc, Math.min(at + inline.size, tr.doc.content.size)));
  tr.setMeta(imageSourceKey, { at: null, shutAt: pictureBeside(view.state.apply(tr)) });
  view.dispatch(tr);
  return true;
}

function field(view: EditorView, at: number, node: ProseNode): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'noto-image-source';
  wrap.contentEditable = 'false';
  const input = document.createElement('input');
  input.className = 'noto-image-source-input';
  input.type = 'text';
  input.spellcheck = false;
  input.value = pictureSource(node);
  input.size = Math.max(8, Math.min(120, input.value.length + 1));
  input.setAttribute('aria-label', 'Picture source');
  input.dataset.testid = 'image-source';
  let done = false;
  const commit = (moveCaret: 'after' | 'before' | null) => {
    if (done) return;
    done = true;
    const wrote = writeSource(view, at, input.value);
    if (!wrote) {
      const node = view.state.doc.nodeAt(at);
      const size = node?.nodeSize ?? 0;
      const pos = moveCaret === 'before' ? at : at + size;
      const tr = view.state.tr;
      if (moveCaret !== null && pos <= view.state.doc.content.size) tr.setSelection(TextSelection.create(view.state.doc, pos));
      tr.setMeta(imageSourceKey, { at: null, shutAt: moveCaret === null ? at : null });
      view.dispatch(tr);
    }
    view.focus();
  };
  input.addEventListener('input', () => { input.size = Math.max(8, Math.min(120, input.value.length + 1)); });
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === 'Enter') { event.preventDefault(); commit('after'); }
    else if (event.key === 'Escape') { event.preventDefault(); input.value = pictureSource(node); commit(null); }
    else if (event.key === 'ArrowLeft' && input.selectionStart === 0 && input.selectionEnd === 0) { event.preventDefault(); commit('before'); }
    else if (event.key === 'ArrowRight' && input.selectionStart === input.value.length) { event.preventDefault(); commit('after'); }
    else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown')) { commit(null); }
  });
  // Left by a press elsewhere: written back after the press has been handled,
  // never in the middle of the editor drawing the change that removed it.
  input.addEventListener('blur', () => { setTimeout(() => commit(null), 0); });
  // A press in the field is the field's; the editor must not move its selection for it.
  for (const type of ['mousedown', 'pointerdown', 'click']) input.addEventListener(type, (event) => event.stopPropagation());
  wrap.append(input);
  return wrap;
}

/** Puts the keys in the open field, its caret at the start or the end. */
export function enterPictureSource(view: EditorView, end: 'start' | 'end'): boolean {
  const dom = view.dom.querySelector<HTMLInputElement>('.noto-image-source-input');
  if (!dom) return false;
  dom.focus();
  const at = end === 'start' ? 0 : dom.value.length;
  dom.setSelectionRange(at, at);
  return true;
}

export function imageSourcePlugin(): Plugin<ImageSourceState> {
  return new Plugin<ImageSourceState>({
    key: imageSourceKey,
    state: {
      init: () => ({ at: null, shutAt: null }),
      apply(tr, value, _old, next) {
        const meta = tr.getMeta(imageSourceKey) as ImageSourceState | undefined;
        if (meta) return meta;
        const at = pictureBeside(next);
        // Shut stays shut until the caret moves; a move opens it again.
        if (value.shutAt !== null && !tr.selectionSet) {
          const shutAt = tr.mapping.map(value.shutAt);
          if (at === shutAt) return { at: null, shutAt };
        }
        return { at, shutAt: null };
      },
    },
    props: {
      decorations(state) {
        const { at } = imageSourceKey.getState(state) ?? { at: null };
        if (at === null) return null;
        const node = state.doc.nodeAt(at);
        if (!isPicture(node)) return null;
        return DecorationSet.create(state.doc, [
          Decoration.widget(at, (view) => field(view, at, node), {
            side: -1,
            key: `image-source:${at}:${pictureSource(node)}`,
            stopEvent: () => true,
            ignoreSelection: true,
          }),
          Decoration.node(at, at + node.nodeSize, { class: 'noto-image-source-open' }),
        ]);
      },
      handleKeyDown(view, event) {
        if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
        const at = pictureBeside(view.state);
        if (at === null) return false;
        // A field shut by Escape or a write opens again for a key that goes into it.
        const open = () => {
          if ((imageSourceKey.getState(view.state)?.at ?? null) !== at) {
            view.dispatch(view.state.tr.setMeta(imageSourceKey, { at, shutAt: null }));
          }
        };
        // Walking toward the picture walks into its source, as into text.
        const { selection } = view.state;
        const node = view.state.doc.nodeAt(at);
        if (!node) return false;
        if (selection instanceof NodeSelection) {
          // Selected whole: an arrow goes in at the side it points from, Enter at the end.
          if (event.key === 'ArrowLeft' || event.key === 'Enter') { open(); return enterPictureSource(view, 'end'); }
          if (event.key === 'ArrowRight') { open(); return enterPictureSource(view, 'start'); }
          return false;
        }
        const head = selection.head;
        if (event.key === 'ArrowLeft' && head === at + node.nodeSize) { open(); return enterPictureSource(view, 'end'); }
        if (event.key === 'ArrowRight' && head === at) { open(); return enterPictureSource(view, 'start'); }
        return false;
      },
    },
  });
}

/** The zooms a right click on a picture offers, as Typora's Zoom Image menu does. */
export const PICTURE_ZOOMS: readonly number[] = [0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.5, 2];

const ZOOM_COMMAND = /^noto\.image-zoom-(\d{1,3})$/;

/** The picture at a point of the page: under the press, or the one selected. */
export function pictureAt(state: EditorState, pos: number | null, element: Element | null): number | null {
  const frame = element?.closest('.noto-image-frame, .noto-inline-html, .noto-html-preview');
  if (frame && pos !== null) {
    for (const at of [pos, pos - 1]) {
      if (at >= 0 && isPicture(state.doc.nodeAt(at))) return at;
    }
  }
  return pictureBeside(state);
}

/** The right-click lines for a picture: a zoom each, as an `<img>` tag would write it. */
export function pictureContextItems(state: EditorState, pos: number | null, element: Element | null): { title: string; command: string }[] {
  const at = pictureAt(state, pos, element);
  if (at === null) return [];
  const node = state.doc.nodeAt(at)!;
  const current = node.type.name === 'inline_html' ? parseImageTag(String(node.attrs.value ?? ''))?.zoom ?? 1 : 1;
  // Six lines, the most a right click shows of the editor's own, around the current size.
  const offered = [0.33, 0.5, 0.67, 1, 1.5, 2];
  return offered.map((zoom) => ({
    title: `${Math.abs(zoom - current) < 0.005 ? '\u2713 ' : ''}Zoom Picture ${Math.round(zoom * 100)}%`,
    command: `noto.image-zoom-${Math.round(zoom * 100)}`,
  }));
}

/**
 * Set the picture's zoom, as dragging its corner does: a markdown image becomes
 * the `<img>` tag, which is where markdown can hold a size, and a tag has its
 * zoom rewritten. 100% on a tag keeps the tag, without the zoom.
 */
export function zoomPicture(view: EditorView, command: string, at: number | null): boolean {
  const match = ZOOM_COMMAND.exec(command);
  if (!match || at === null) return false;
  const zoom = Number(match[1]) / 100;
  const node = view.state.doc.nodeAt(at);
  if (!isPicture(node)) return false;
  let value: string | null;
  if (node.type.name === 'inline_html') {
    value = zoomedTag(String(node.attrs.value ?? ''), zoom);
  } else {
    const { src, alt, title, referenceType } = node.attrs as { src: string; alt: string; title: string | null; referenceType: string | null };
    if (referenceType) return false;
    if (zoom === 1) return true;
    value = tagForImage(src, alt, title, zoom);
  }
  if (value === null) return false;
  const tag = view.state.schema.nodes.inline_html.create({ value });
  view.dispatch(view.state.tr.replaceWith(at, at + node.nodeSize, tag));
  return true;
}

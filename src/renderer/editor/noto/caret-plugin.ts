/**
 * The caret, drawn by Noto rather than by the browser.
 *
 * The browser's caret is one pixel wide and blinks hard on and off, so in a
 * page of text it was easy to lose, and in a new, empty note it was easy to
 * miss entirely. This one is two pixels in the accent, placed exactly where
 * the browser would draw its own: it is measured from the browser's selection,
 * so wrapped lines, CJK text and hidden markup all agree with it.
 *
 * It stays solid while the reader types or moves, so it is where the eye
 * expects it, and after a pause it breathes, fading softly rather than
 * vanishing. A short move along a line glides; a jump to another line does
 * not, since a long sweep across the page only draws the eye away from where
 * the caret went. When the note takes the keys, by a click or by focus coming
 * back, a brief halo shows where it landed. Reduce Motion keeps it solid and
 * still.
 *
 * It steps aside wherever another caret is the right one: while an input
 * method composes, in a field drawn inside the note, over a selection, in a
 * read-only note, and for the gap cursor between blocks.
 */

import { Plugin, PluginKey, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

export const caretKey = new PluginKey('noto-caret');

/** Typing or moving within this long keeps the caret solid before it starts to breathe. */
const SOLID_AFTER_MOVE_MS = 600;
/** A move farther than this, or to another line, is a jump and does not glide. */
const GLIDE_LIMIT_PX = 120;

const HOST_CLASS = 'noto-custom-caret';

class CaretLayer {
  private readonly layer: HTMLDivElement;
  private readonly caret: HTMLSpanElement;
  private readonly resize: ResizeObserver | null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private frame: number | null = null;
  private last: { left: number; top: number } | null = null;
  private composing = false;

  constructor(private readonly view: EditorView) {
    this.layer = document.createElement('div');
    this.layer.className = 'noto-caret-layer';
    this.layer.setAttribute('aria-hidden', 'true');
    this.caret = document.createElement('span');
    this.caret.className = 'noto-caret';
    this.caret.dataset.testid = 'caret';
    this.layer.append(this.caret);
    view.dom.before(this.layer);
    this.host()?.classList.add(HOST_CLASS);

    view.dom.addEventListener('focus', this.onFocus);
    view.dom.addEventListener('blur', this.onBlur);
    view.dom.addEventListener('mousedown', this.onPress);
    view.dom.addEventListener('compositionstart', this.onCompositionStart);
    view.dom.addEventListener('compositionend', this.onCompositionEnd);
    window.addEventListener('resize', this.schedule);
    this.resize = typeof ResizeObserver === 'function' ? new ResizeObserver(this.schedule) : null;
    this.resize?.observe(view.dom);
    this.draw(false);
  }

  update(): void {
    this.draw(false);
  }

  destroy(): void {
    if (this.idle) clearTimeout(this.idle);
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.resize?.disconnect();
    window.removeEventListener('resize', this.schedule);
    this.view.dom.removeEventListener('focus', this.onFocus);
    this.view.dom.removeEventListener('blur', this.onBlur);
    this.view.dom.removeEventListener('mousedown', this.onPress);
    this.view.dom.removeEventListener('compositionstart', this.onCompositionStart);
    this.view.dom.removeEventListener('compositionend', this.onCompositionEnd);
    this.host()?.classList.remove(HOST_CLASS);
    this.layer.remove();
  }

  private host(): HTMLElement | null {
    return this.view.dom.closest('.noto-editor-host');
  }

  private readonly schedule = () => {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.draw(false);
    });
  };

  private readonly onFocus = () => this.draw(true);
  private readonly onBlur = () => this.draw(false);
  // The click's selection lands on the next transaction; the halo goes with it.
  private readonly onPress = () => { this.pendingHalo = true; };
  private pendingHalo = false;
  private readonly onCompositionStart = () => { this.composing = true; this.draw(false); };
  private readonly onCompositionEnd = () => { this.composing = false; this.schedule(); };

  /** Where the browser would draw its caret, relative to the layer, or null when it should not show. */
  private measure(): { left: number; top: number; height: number } | null {
    const view = this.view;
    const selection = view.state.selection;
    if (!view.editable || !view.hasFocus() || this.composing) return null;
    if (!(selection instanceof TextSelection) || !selection.empty) return null;
    let rect: DOMRect | null = null;
    const dom = (view.root as Document).getSelection?.() ?? null;
    if (dom && dom.rangeCount > 0 && dom.isCollapsed && view.dom.contains(dom.anchorNode)) {
      const range = dom.getRangeAt(0);
      const rects = range.getClientRects();
      const candidate = rects.length > 0 ? rects[rects.length - 1]! : range.getBoundingClientRect();
      if (candidate.height > 0) rect = candidate;
    }
    let left: number;
    let top: number;
    let bottom: number;
    if (rect) {
      left = rect.left;
      top = rect.top;
      bottom = rect.bottom;
    } else {
      try {
        const coords = view.coordsAtPos(selection.head);
        left = coords.left;
        top = coords.top;
        bottom = coords.bottom;
      } catch {
        return null;
      }
    }
    if (bottom - top <= 0) return null;
    const origin = this.layer.getBoundingClientRect();
    return { left: left - origin.left, top: top - origin.top, height: bottom - top };
  }

  private draw(arrived: boolean): void {
    const at = this.measure();
    const caret = this.caret;
    if (!at) {
      caret.classList.remove('is-shown', 'is-solid', 'is-halo');
      this.last = null;
      return;
    }
    const jump = !this.last
      || Math.abs(at.top - this.last.top) > 2
      || Math.abs(at.left - this.last.left) > GLIDE_LIMIT_PX;
    caret.classList.toggle('is-gliding', !jump);
    caret.style.height = `${at.height}px`;
    caret.style.transform = `translate(${Math.round(at.left * 2) / 2 - 1}px, ${at.top}px)`;
    const moved = !this.last || this.last.left !== at.left || this.last.top !== at.top;
    this.last = { left: at.left, top: at.top };
    caret.classList.add('is-shown');

    // Solid while moving; breathing after a pause.
    if (moved || arrived) {
      caret.classList.add('is-solid');
      if (this.idle) clearTimeout(this.idle);
      this.idle = setTimeout(() => caret.classList.remove('is-solid'), SOLID_AFTER_MOVE_MS);
    }
    if (arrived || this.pendingHalo) {
      this.pendingHalo = false;
      caret.classList.remove('is-halo');
      // Restart the halo even when it is already running.
      void caret.offsetWidth;
      caret.classList.add('is-halo');
    }
  }
}

/** One per editor. */
export function caretPlugin(): Plugin {
  return new Plugin({
    key: caretKey,
    view: (view) => new CaretLayer(view),
  });
}

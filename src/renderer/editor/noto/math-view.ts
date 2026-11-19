/**
 * Rendering math without turning it into an opaque island.
 *
 * Typora's behaviour, read from its own code (TypeMark `frame.js`, the
 * `md-inline-math` and `md-mathblock-panel` parts) and the rule this file
 * follows: a formula reads as typeset mathematics until the caret enters it,
 * and then the whole formula is its source, one unit, delimiters and all.
 *
 * Inline, Typora's span is `<md-before>$</md-before><script>TeX</script>
 * <md-after>$</md-after>`; the two dollars are `md-meta`, hidden at rest and
 * shown when the span expands, and while it is expanded a typeset copy floats
 * under it (`#math-inline-preview`), redrawn on every keystroke. A block, while
 * edited, is a panel: a `$$` line, the TeX, a `$$` line, and the typeset
 * formula live beneath (`.md-mathjax-preview`).
 *
 * Here the node keeps its text content and ProseMirror keeps managing it. The
 * delimiters are drawn by the node view around the source, never part of the
 * document, so the saved bytes are the serializer's and nothing else's. The
 * typeset copy is a sibling: at rest it is all that shows; while editing it is
 * the live preview, under the source.
 */

import katex from 'katex';
// `\ce` and `\pu`, which Typora's MathJax carries and KaTeX keeps in a contrib module.
import 'katex/contrib/mhchem';
import type { Node as ProseNode } from 'prosemirror-model';
import { documentMathContext, prepared } from './math-context';
import { Plugin, PluginKey, TextSelection, type Command, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView, type NodeView } from 'prosemirror-view';

const MATH_TYPES = new Set(['math_block', 'math_inline']);

/**
 * Render LaTeX into an element.
 *
 * Errors are shown in place rather than thrown. A half typed formula is the
 * normal state of one being written, so it must not blank the document or
 * throw inside a ProseMirror update. At rest a formula that does not typeset
 * shows its own source, as Typora does, with a mark under it and the reason
 * on hover; KaTeX's sentence is said in full only in the card beside a formula
 * being edited, where the writer is looking for it.
 */
function render(target: HTMLElement, latex: string, displayMode: boolean, doc: ProseNode | null): void {
  const source = latex.trim();
  if (source.length === 0) {
    // Typora's own words for the empty state, in its preview.
    target.textContent = displayMode ? 'Empty math block' : 'Empty inline math';
    target.dataset.state = 'empty';
    return;
  }
  const ready = prepared(source, displayMode, doc ? documentMathContext(doc) : { labels: new Map(), macros: {} });
  try {
    katex.render(ready.source, target, {
      displayMode,
      macros: ready.macros,
      throwOnError: true,
      // Rendering runs on document content, so anything that could inject
      // markup or load a file is refused rather than trusted.
      trust: false,
      strict: false,
    });
    target.dataset.state = 'rendered';
    target.removeAttribute('title');
  } catch (error) {
    const reason = error instanceof Error ? error.message.replace(/^KaTeX parse error: /, '') : 'Could not render this formula';
    const written = globalThis.document.createElement('span');
    written.className = 'noto-math-written';
    written.textContent = source;
    const said = globalThis.document.createElement('span');
    said.className = 'noto-math-reason';
    said.textContent = reason;
    target.replaceChildren(written, said);
    target.title = reason;
    target.dataset.state = 'error';
  }
}

/** A delimiter drawn around the source while it is edited: `$` inline, a `$$` line for a block. */
function delimiter(tag: 'span' | 'div', text: string, side: 'open' | 'close'): HTMLElement {
  const element = globalThis.document.createElement(tag);
  element.className = `noto-math-delimiter noto-math-${side}`;
  element.textContent = text;
  element.contentEditable = 'false';
  element.setAttribute('aria-hidden', 'true');
  return element;
}

/**
 * A node view that shows typeset output beside the editable source.
 *
 * It deliberately does not decide when to show which. `selectNode` only fires
 * for a node selection, so a caret arriving through ordinary cursor movement
 * would never reach it and the formula would stay rendered while being typed
 * into. The plugin below watches the selection and sets `noto-math-editing`.
 */
class MathView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private readonly preview: HTMLElement;
  private latex: string;
  private redraw = 0;

  constructor(
    private node: ProseNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly displayMode: boolean,
    /** Reuse a typed stub shell so specialised remount skips replaceChild. */
    host?: HTMLElement,
  ) {
    const tag = displayMode ? 'div' : 'span';
    this.dom = host ?? globalThis.document.createElement(tag);
    if (host) this.dom.replaceChildren();
    this.dom.className = displayMode ? 'noto-math-block' : 'noto-math-inline';

    this.preview = globalThis.document.createElement(tag);
    this.preview.className = 'noto-math-render';
    // The rendered copy is decoration, so assistive technology reads the source
    // rather than KaTeX's markup.
    this.preview.setAttribute('aria-hidden', 'true');
    this.preview.contentEditable = 'false';
    this.preview.addEventListener('mousedown', (event) => this.focusSource(event));

    this.contentDOM = globalThis.document.createElement(tag);
    this.contentDOM.className = 'noto-math-source';
    this.contentDOM.spellcheck = false;

    // The source framed by its delimiters, as one unit: `$TeX$`, or a `$$`
    // line, the TeX and a `$$` line. The typeset copy after it, which is the
    // formula at rest and the live preview while the source is edited.
    const mark = displayMode ? '$$' : '$';
    const editing = globalThis.document.createElement(tag);
    editing.className = 'noto-math-edit';
    editing.append(delimiter(tag, mark, 'open'), this.contentDOM, delimiter(tag, mark, 'close'));
    this.dom.append(editing, this.preview);
    this.latex = node.textContent;
    render(this.preview, this.latex, displayMode, view.state.doc);
    views.set(this.dom, this);
  }

  update(node: ProseNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    if (node.textContent !== this.latex) {
      this.latex = node.textContent;
      // Every keystroke changes the source; the preview follows on the next
      // frame, so a run of typing typesets once per frame, not once per key.
      cancelAnimationFrame(this.redraw);
      this.redraw = requestAnimationFrame(() => {
        render(this.preview, this.latex, this.displayMode, this.view.state.doc);
        this.placePreview();
      });
    }
    return true;
  }

  destroy(): void {
    cancelAnimationFrame(this.redraw);
  }

  /**
   * Clicks on the preview are ours; everything else is ProseMirror's. While
   * the source is edited the preview is a card over the text around it, and a
   * press on it is swallowed rather than passed to whatever it covers.
   */
  stopEvent(event: Event): boolean {
    if (event.target === null || !this.preview.contains(event.target as globalThis.Node)) return false;
    if (this.dom.classList.contains('noto-math-editing') && event.cancelable) event.preventDefault();
    return true;
  }

  /**
   * Where the inline preview goes: above the formula, or below it near the top
   * of the page; and shifted left when it would run past the page's right edge,
   * so a long formula or an error message is read whole in a narrow window.
   */
  placePreview(): void {
    if (this.displayMode) return;
    const scroller = this.dom.closest('.noto-editor-host') ?? this.view.dom;
    const bounds = scroller.getBoundingClientRect();
    const own = this.dom.getBoundingClientRect();
    const needed = this.preview.getBoundingClientRect().height + 12;
    this.dom.dataset.place = own.top - bounds.top < Math.max(needed, 48) ? 'below' : 'above';
    this.preview.style.removeProperty('translate');
    const card = this.preview.getBoundingClientRect();
    const margin = 12;
    const over = card.right - (Math.min(bounds.right, window.innerWidth) - margin);
    const room = card.left - (Math.max(bounds.left, 0) + margin);
    const shift = over > 0 ? -Math.min(over, Math.max(0, room)) : 0;
    if (shift !== 0) this.preview.style.setProperty('translate', `${Math.round(shift)}px 0`);
  }

  ignoreMutation(mutation: MutationRecord | { target: globalThis.Node }): boolean {
    // Only the source is the editor's: the preview and the delimiters are ours.
    return !this.contentDOM.contains(mutation.target);
  }

  /**
   * Clicking the rendered form puts the caret in the source, ready to edit.
   *
   * As near the click as the source can say: the share of the way across the
   * typeset formula the click landed is taken as the share of the way through
   * its source, so clicking the left of `E = mc^2` puts the caret near the `E`.
   * While the source is being edited the rendered copy is the preview, and a
   * click on it leaves the caret where it is.
   */
  private focusSource(event: MouseEvent): void {
    const position = this.getPos();
    if (position === undefined) return;
    event.preventDefault();
    this.view.focus();
    if (this.dom.classList.contains('noto-math-editing')) return;
    const box = this.preview.getBoundingClientRect();
    const share = box.width > 0 ? Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) : 1;
    const size = this.node.content.size;
    const offset = this.displayMode ? size : Math.round(share * size);
    const { state } = this.view;
    const inside = Math.min(position + 1 + offset, state.doc.content.size);
    this.view.dispatch(
      state.tr.setSelection(TextSelection.near(state.doc.resolve(inside), -1)).scrollIntoView(),
    );
  }
}

export const mathEditingKey = new PluginKey<DecorationSet>('noto-math-editing');

/**
 * Mark the formula holding the selection so it shows its source.
 *
 * A decoration rather than state inside the node view, for the same reason the
 * active block uses one: it is derived from the selection, so it cannot drift
 * out of step with where the caret actually is.
 */
function editingDecorations(state: EditorState): DecorationSet {
  const { from, to } = state.selection;
  const decorations: Decoration[] = [];

  state.doc.nodesBetween(from, to, (node, position) => {
    if (!MATH_TYPES.has(node.type.name)) return true;
    decorations.push(Decoration.node(position, position + node.nodeSize, {
      class: 'noto-math-editing',
    }));
    return false;
  });

  return DecorationSet.create(state.doc, decorations);
}

export function mathEditingPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: mathEditingKey,
    state: {
      init: (_config, state) => editingDecorations(state),
      apply: (transaction, previous, _oldState, newState) =>
        (transaction.docChanged || transaction.selectionSet ? editingDecorations(newState) : previous),
    },
    props: {
      decorations: (state) => mathEditingKey.getState(state),
    },
    // The inline preview's side is chosen once its formula is laid out as edited.
    view: () => ({
      update(view) {
        for (const element of view.dom.querySelectorAll<HTMLElement>('.noto-math-inline.noto-math-editing')) {
          const owner = views.get(element);
          if (owner) requestAnimationFrame(() => owner.placePreview());
        }
      },
    }),
  });
}

/** Each inline formula's view, by its element, so the editing plugin can place its preview. */
const views = new WeakMap<HTMLElement, MathView>();

/**
 * Leave a math block for the paragraph after it, making one if there is none.
 *
 * Typora's Command-Enter, and its down arrow from the last line: the hint
 * under its panel reads "press Cmd+Enter or the down key". A math block is
 * code-like, so Enter inside it is a newline in the TeX and the plain keys
 * never leave it.
 */
export function leaveMathBlock(edge: 'any' | 'last-line'): Command {
  return (state, dispatch, view) => {
    const { $head, empty } = state.selection;
    if (!empty || $head.parent.type.name !== 'math_block') return false;
    if (edge === 'last-line') {
      if ($head.parent.textContent.slice($head.parentOffset).includes('\n')) return false;
      if (view && !view.endOfTextblock('down')) return false;
    }
    if (!dispatch) return true;
    const after = $head.after();
    const next = state.doc.resolve(after).nodeAfter;
    const tr = state.tr;
    if (next && next.isTextblock && next.type.name === 'paragraph') {
      tr.setSelection(TextSelection.create(tr.doc, after + 1));
    } else {
      tr.insert(after, state.schema.nodes.paragraph.create());
      tr.setSelection(TextSelection.create(tr.doc, after + 1));
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

export function mathNodeViews() {
  return {
    math_block: (
      node: ProseNode,
      view: EditorView,
      getPos: () => number | undefined,
      _decorations?: unknown,
      _inner?: unknown,
      host?: HTMLElement,
    ) => new MathView(node, view, getPos, true, host),
    math_inline: (node: ProseNode, view: EditorView, getPos: () => number | undefined) =>
      new MathView(node, view, getPos, false),
  };
}

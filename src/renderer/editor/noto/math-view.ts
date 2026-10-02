/**
 * Rendering math without turning it into an opaque island.
 *
 * Typora's behaviour, and the rule this file follows: a formula reads as
 * typeset mathematics until the caret enters it, at which point it becomes its
 * LaTeX source and can be edited like any other text. It is never a read-only
 * widget you have to open a dialog to change.
 *
 * That is why the node keeps its text content and ProseMirror keeps managing
 * it. The rendered output is a sibling element that is shown or hidden; the
 * source is the document, so nothing here can alter the bytes that get saved.
 * A node view that replaced the content with rendered HTML would break both
 * editing and byte fidelity.
 */

import katex from 'katex';
import type { Node as ProseNode } from 'prosemirror-model';
import { Plugin, PluginKey, TextSelection, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView, type NodeView } from 'prosemirror-view';

const MATH_TYPES = new Set(['math_block', 'math_inline']);

/**
 * Render LaTeX into an element.
 *
 * Errors are shown in place rather than thrown. A half typed formula is the
 * normal state of one being written, so it must not blank the document or
 * throw inside a ProseMirror update.
 */
function render(target: HTMLElement, latex: string, displayMode: boolean): void {
  const source = latex.trim();
  if (source.length === 0) {
    target.textContent = displayMode ? 'Empty formula' : '(empty)';
    target.dataset.state = 'empty';
    return;
  }
  try {
    katex.render(source, target, {
      displayMode,
      throwOnError: true,
      // Rendering runs on document content, so anything that could inject
      // markup or load a file is refused rather than trusted.
      trust: false,
      strict: false,
    });
    target.dataset.state = 'rendered';
  } catch (error) {
    target.textContent = error instanceof Error ? error.message : 'Could not render this formula';
    target.dataset.state = 'error';
  }
}

/**
 * A node view that shows typeset output beside the editable source.
 *
 * It deliberately does not decide when to show which. `selectNode` only fires
 * for a node selection, so a caret arriving through ordinary cursor movement
 * would never reach it and the formula would stay rendered while being typed
 * into. The plugin below watches the selection instead.
 */
class MathView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private readonly preview: HTMLElement;
  private latex: string;

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
    this.preview.addEventListener('mousedown', (event) => this.focusSource(event));

    this.contentDOM = globalThis.document.createElement(tag);
    this.contentDOM.className = 'noto-math-source';

    this.dom.append(this.preview, this.contentDOM);
    this.latex = node.textContent;
    render(this.preview, this.latex, displayMode);
  }

  update(node: ProseNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    if (node.textContent !== this.latex) {
      this.latex = node.textContent;
      render(this.preview, this.latex, this.displayMode);
    }
    return true;
  }

  /** Clicks on the preview are ours; everything else is ProseMirror's. */
  stopEvent(event: Event): boolean {
    return event.target !== null && this.preview.contains(event.target as globalThis.Node);
  }

  ignoreMutation(mutation: MutationRecord | { target: globalThis.Node }): boolean {
    // The preview is ours, so its DOM churn is never a document change. The
    // source is ProseMirror's, so mutations there must be reported.
    return this.preview.contains(mutation.target);
  }

  /** Clicking the rendered form puts the caret in the source, ready to edit. */
  private focusSource(event: MouseEvent): void {
    const position = this.getPos();
    if (position === undefined) return;
    event.preventDefault();
    this.view.focus();

    // The end of the formula, which is where someone who clicked to change it
    // usually wants to be.
    const { state } = this.view;
    const inside = Math.min(position + 1 + this.node.content.size, state.doc.content.size);
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
  });
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

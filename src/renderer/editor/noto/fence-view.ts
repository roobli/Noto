/**
 * A code fence on screen: line numbers, its language, and a copy button.
 *
 * The author's `fence-enhance` plugin does this for Typora by working around
 * CodeMirror; here the fence is ours, so it is a node view. The `pre` is the
 * node's element, as the schema draws it, with a gutter column beside the
 * code and a small tool bar in the corner. The code element is the content
 * the editor owns; the gutter and the tools are not content, and the editor
 * is told to ignore what happens in them.
 *
 * The gutter is a column of numbers set in the same face and leading as the
 * code, so the two line up as long as code never wraps, and it does not: a
 * long line scrolls inside the code column while the numbers stay put. Its
 * width follows the block's own line count, two digits at least.
 *
 * Tools (language field + copy) match the CSS contract: visible on hover or
 * while the caret is in the fence. They are mounted on first pointerenter /
 * focusin rather than in the constructor. Binding the shared language
 * datalist (`list=`) waits until the field is focused — resolving that id
 * against a document with tens of thousands of top-level stubs dominated
 * FenceView construction on remount (~18 ms per fence in happy-dom on huge).
 */

import type { Node as ProseNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import type { EditorView, NodeView } from 'prosemirror-view';
import { digitsForLineCount, gutterText, lineCount } from './fence-gutter';
import { supportedLanguages } from './highlight';
import { DiagramFrame, isDiagramLanguage } from './diagram-frame';
import { TimelineFrame, isTimelineLanguage } from './timeline';
import { copyThroughSelection } from './clipboard';

/** How long "Copied" stays before the button says "Copy" again. */
const COPIED_MS = 1400;

/** The id of the one datalist every fence's language field shares. */
const LANGUAGE_LIST_ID = 'noto-fence-languages';

/**
 * The languages offered as you type, made once for the document.
 *
 * A native datalist rather than a menu of our own: it is a real completion
 * control the platform draws, it takes the keyboard, and it costs nothing
 * per fence. The names are what the highlighter answers to, so choosing one
 * is choosing colour, not just a label.
 */
function languageList(): HTMLDataListElement {
  const existing = document.getElementById(LANGUAGE_LIST_ID);
  if (existing instanceof HTMLDataListElement) return existing;
  const list = document.createElement('datalist');
  list.id = LANGUAGE_LIST_ID;
  for (const name of supportedLanguages()) {
    const option = document.createElement('option');
    option.value = name;
    list.append(option);
  }
  document.body.append(list);
  return list;
}

export class FenceView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private readonly gutter: HTMLElement;
  private tools: HTMLElement | null = null;
  private language: HTMLInputElement | null = null;
  private copy: HTMLButtonElement | null = null;
  /** Whether the language field has been bound to the shared datalist. */
  private languageListBound = false;
  private lines = 0;
  /** Present while the fence is a diagram, which its language decides. */
  private diagram: DiagramFrame | null = null;
  /** Present while the fence is a timeline. */
  private timeline: TimelineFrame | null = null;
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private node: ProseNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
  ) {
    this.dom = document.createElement('pre');
    this.dom.className = 'noto-fence';

    this.gutter = document.createElement('div');
    this.gutter.className = 'noto-fence-gutter';
    this.gutter.contentEditable = 'false';
    this.gutter.setAttribute('aria-hidden', 'true');
    // A press on a number puts the caret at the start of that line, which is
    // what a gutter is for in every code editor and beats the editor guessing
    // a position from a click on something that is not content.
    this.gutter.addEventListener('mousedown', (event) => {
      event.preventDefault();
      // Prefer clientY over offsetY: synthetic CDP mouse clicks (Playwright)
      // often report offsetY as 0, which always mapped to the first line.
      const top = this.gutter.getBoundingClientRect().top;
      this.caretToLine(this.lineAt(event.clientY - top));
    });

    this.contentDOM = document.createElement('code');
    this.contentDOM.className = 'noto-fence-code';
    // Code is not prose, and every identifier in it would otherwise be a red squiggle.
    this.contentDOM.setAttribute('spellcheck', 'false');

    this.dom.append(this.gutter, this.contentDOM);
    // Tools stay off the remount path: CSS already shows them only on hover /
    // active-block / focus-within (see noto-editor.scss). Mount on demand.
    this.dom.addEventListener('pointerenter', this.ensureTools);
    this.dom.addEventListener('focusin', this.ensureTools);
    this.render();
  }

  /**
   * Build the language field and copy button once, when the reader reaches
   * for them. Safe to call repeatedly.
   */
  private readonly ensureTools = (): void => {
    if (this.tools) return;

    this.tools = document.createElement('div');
    this.tools.className = 'noto-fence-tools';
    this.tools.contentEditable = 'false';
    // The language is a field, not a label: the reader types it here, with
    // the highlighter's names offered as they type, and the block takes the
    // colour of what they chose. Typora puts the same field in the same
    // corner, which is where a hand that just typed a fence expects it.
    this.language = document.createElement('input');
    this.language.className = 'noto-fence-lang';
    this.language.type = 'text';
    this.language.placeholder = 'language';
    this.language.spellcheck = false;
    this.language.autocomplete = 'off';
    this.language.setAttribute('aria-label', 'Code block language');
    // Do not set `list=` here. Resolving the shared datalist id against a
    // document full of stub placeholders dominated FenceView construction on
    // remount; bind it when the field is actually focused.
    this.language.addEventListener('focus', this.bindLanguageList);
    this.language.addEventListener('change', () => this.commitLanguage());
    this.language.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.commitLanguage();
        this.view.focus();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        if (this.language) this.language.value = (this.node.attrs.lang as string) || '';
        this.view.focus();
      }
    });
    this.copy = document.createElement('button');
    this.copy.type = 'button';
    this.copy.className = 'noto-fence-copy';
    this.copy.textContent = 'Copy';
    this.copy.title = 'Copy the code';
    // Mousedown would move the editor's selection to the button; the click
    // is what the button is for.
    this.copy.addEventListener('mousedown', (event) => event.preventDefault());
    this.copy.addEventListener('click', () => this.copyCode());
    this.tools.append(this.language, this.copy);
    this.dom.append(this.tools);
    this.syncLanguageField();
  };

  private readonly bindLanguageList = (): void => {
    if (this.languageListBound || !this.language) return;
    this.language.setAttribute('list', languageList().id);
    this.languageListBound = true;
  };

  update(node: ProseNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  /** The gutter and the tools are ours. Only the code is the editor's. */
  ignoreMutation(mutation: MutationRecord | { type: 'selection'; target: Node }): boolean {
    if (this.contentDOM.contains(mutation.target)) return false;
    return true;
  }

  /** A click on the tools, the gutter or the drawing is not a click in the document. */
  stopEvent(event: Event): boolean {
    return event.target instanceof Node
      && ((this.tools !== null && this.tools.contains(event.target))
        || this.gutter.contains(event.target)
        || (this.diagram !== null && this.diagram.dom.contains(event.target))
        || (this.timeline !== null && this.timeline.dom.contains(event.target)));
  }

  /** Which line a vertical offset inside the gutter falls on, counted from zero. */
  private lineAt(offsetY: number): number {
    const style = getComputedStyle(this.gutter);
    const lineHeight = Number.parseFloat(style.lineHeight);
    const paddingTop = Number.parseFloat(style.paddingTop) || 0;
    const height = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 20;
    return Math.floor((offsetY - paddingTop) / height);
  }

  /** Put the caret at the start of line `index`, counted from zero and clamped. */
  private caretToLine(index: number): void {
    const base = this.getPos();
    if (base === undefined) return;
    const text = this.node.textContent;
    const lines = lineCount(text);
    const target = Math.min(Math.max(0, index), lines - 1);
    let offset = 0;
    for (let line = 0; line < target; line += 1) offset = text.indexOf('\n', offset) + 1;
    const position = base + 1 + offset;
    const { state } = this.view;
    this.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, position)).scrollIntoView());
    this.view.focus();
  }

  destroy(): void {
    if (this.copiedTimer !== null) clearTimeout(this.copiedTimer);
    this.dom.removeEventListener('pointerenter', this.ensureTools);
    this.dom.removeEventListener('focusin', this.ensureTools);
    this.language?.removeEventListener('focus', this.bindLanguageList);
    this.diagram?.destroy();
    this.timeline?.destroy();
  }

  /** Write the field's value into the node, as one undoable change. */
  private commitLanguage(): void {
    if (!this.language) return;
    const lang = this.language.value.trim().toLowerCase();
    if (lang === ((this.node.attrs.lang as string) || '')) return;
    const position = this.getPos();
    if (position === undefined) return;
    const { state } = this.view;
    this.view.dispatch(state.tr.setNodeMarkup(position, undefined, { ...this.node.attrs, lang }));
  }

  private syncLanguageField(): void {
    if (!this.language) return;
    const lang = (this.node.attrs.lang as string) || '';
    // Not while the reader is typing in it: a redraw mid-word would take
    // the word away.
    if (document.activeElement !== this.language) this.language.value = lang;
    this.language.size = Math.max(6, lang.length + 1);
  }

  private render(): void {
    const lang = (this.node.attrs.lang as string) || '';
    if (lang) this.dom.setAttribute('data-lang', lang);
    else this.dom.removeAttribute('data-lang');
    this.syncLanguageField();

    // A mermaid fence is drawn as its diagram, beside the source; a press on
    // the drawing puts the caret at the top of the source.
    if (isDiagramLanguage(lang)) {
      if (this.diagram === null) {
        this.diagram = new DiagramFrame(() => this.caretToLine(0));
        this.dom.append(this.diagram.dom);
      }
      this.diagram.render(this.node.textContent);
    } else if (this.diagram !== null) {
      this.diagram.destroy();
      this.diagram = null;
    }

    // A timeline fence paints a chronology beside the source; a press on the
    // drawing puts the caret at the top of the source, as mermaid does.
    if (isTimelineLanguage(lang)) {
      if (this.timeline === null) {
        this.timeline = new TimelineFrame(() => this.caretToLine(0));
        this.dom.append(this.timeline.dom);
      }
      this.timeline.render(this.node.textContent);
    } else if (this.timeline !== null) {
      this.timeline.destroy();
      this.timeline = null;
    }

    // Recounted on every update and rewritten only when the count moves, so
    // typing inside a line costs a scan of the text and nothing in the DOM.
    const lines = lineCount(this.node.textContent);
    if (lines === this.lines) return;
    this.lines = lines;
    this.gutter.textContent = gutterText(lines);
    this.dom.style.setProperty('--fence-digits', String(digitsForLineCount(lines)));
  }

  private copyCode(): void {
    if (!this.copy) return;
    if (!copyThroughSelection(this.node.textContent)) return;
    this.copy.textContent = 'Copied';
    this.copy.dataset.copied = '';
    if (this.copiedTimer !== null) clearTimeout(this.copiedTimer);
    this.copiedTimer = setTimeout(() => {
      if (this.copy) {
        this.copy.textContent = 'Copy';
        delete this.copy.dataset.copied;
      }
      this.copiedTimer = null;
    }, COPIED_MS);
  }
}

export function fenceNodeViews() {
  return {
    code_block: (node: ProseNode, view: EditorView, getPos: () => number | undefined) =>
      new FenceView(node, view, getPos),
  };
}

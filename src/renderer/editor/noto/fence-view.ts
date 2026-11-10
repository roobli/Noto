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
 * Tools (the language label and copy) match the CSS contract: visible on
 * hover or while the caret is in the fence. They are mounted on first
 * pointerenter / focusin rather than in the constructor, which keeps them off
 * the remount path of a document with thousands of fences.
 *
 * The label names the fence's language, or, when the fence names none, what
 * its code reads as (`detect-language.ts`), marked as a guess. A press on it
 * opens the language list (`language-picker.ts`).
 */

import type { Node as ProseNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import type { EditorView, NodeView } from 'prosemirror-view';
import { digitsForLineCount, gutterText, lineCount } from './fence-gutter';
import { guessedLanguage } from './highlight';
import { LanguagePicker } from './language-picker';
import { languageName, PLAIN_TEXT } from './languages';
import { DiagramFrame, isDiagramLanguage } from './diagram-frame';
import { TimelineFrame, isTimelineLanguage } from './timeline';
import { copyThroughSelection } from './clipboard';

/** How long "Copied" stays before the button says "Copy" again. */
const COPIED_MS = 1400;

/** Whether code lines wrap, which the shell sets on the root from the setting. */
const wrapsCode = (): boolean => globalThis.document?.documentElement.dataset.codeWrap !== 'off';

export class FenceView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private readonly gutter: HTMLElement;
  private tools: HTMLElement | null = null;
  private language: HTMLButtonElement | null = null;
  private copy: HTMLButtonElement | null = null;
  /** What the label says now, so a keystroke that changes nothing touches nothing. */
  private labelKey = '';
  private picker: LanguagePicker | null = null;
  private lines = 0;
  /** Present while the fence is a diagram, which its language decides. */
  private diagram: DiagramFrame | null = null;
  /** Present while the fence is a timeline. */
  private timeline: TimelineFrame | null = null;
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Where each line starts, from the top of the code, while lines wrap; null
   * while every line is one row and the plain column of numbers is right.
   */
  private wrappedTops: readonly number[] | null = null;
  private measureFrame = 0;
  private measureTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly resized: ResizeObserver | null;

  constructor(
    private node: ProseNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    /** Reuse a typed stub shell so specialised remount skips replaceChild. */
    host?: HTMLElement,
  ) {
    this.dom = host ?? document.createElement('pre');
    if (host) this.dom.replaceChildren();
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
    // A width change rewraps the lines, and so does turning wrapping on.
    this.resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.scheduleMeasure());
    this.resized?.observe(this.contentDOM);
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
    if (this.tools) {
      // A note can turn read-only without its fences changing.
      if (this.language) this.language.disabled = !this.view.editable;
      return;
    }

    this.tools = document.createElement('div');
    this.tools.className = 'noto-fence-tools';
    this.tools.contentEditable = 'false';
    // The language is a label until it is pressed, and then a list to choose
    // from with a field to search it, so the corner holds a word, not a box.
    this.language = document.createElement('button');
    this.language.type = 'button';
    this.language.className = 'noto-fence-lang';
    this.language.setAttribute('aria-haspopup', 'dialog');
    // The press must not move the note's selection; the click opens the list.
    this.language.addEventListener('mousedown', (event) => event.preventDefault());
    this.language.addEventListener('click', this.toggleLanguages);
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
    this.labelKey = '';
    this.syncLanguageLabel();
  };

  /** Open the language list under the label, or close it when it is open. */
  private readonly toggleLanguages = (): void => {
    if (this.picker?.isOpen) {
      this.picker.close(true);
      return;
    }
    if (!this.language || !this.view.editable) return;
    const current = String(this.node.attrs.lang ?? '').trim();
    this.dom.classList.add('is-picking');
    this.language.setAttribute('aria-expanded', 'true');
    this.picker = LanguagePicker.show(this.language, {
      current,
      guess: guessedLanguage(this.node),
      onPick: (lang) => this.commitLanguage(lang),
      onClose: (returnFocus) => {
        this.picker = null;
        this.dom.classList.remove('is-picking');
        this.language?.setAttribute('aria-expanded', 'false');
        if (returnFocus) this.view.focus();
      },
    });
  };

  update(node: ProseNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    // Typing can make a line wrap or stop wrapping without the count moving.
    // While no line wraps, finding out costs one height read a frame; once
    // lines wrap, placing every number waits for a pause in the typing, so a
    // long fence is not measured line by line on every key.
    if (this.wrappedTops !== null) this.scheduleMeasureAfterTyping();
    else if (wrapsCode()) this.scheduleMeasure();
    return true;
  }

  private scheduleMeasureAfterTyping(): void {
    if (this.measureTimer !== null) clearTimeout(this.measureTimer);
    this.measureTimer = setTimeout(() => {
      this.measureTimer = null;
      this.scheduleMeasure();
    }, 150);
  }

  private scheduleMeasure(): void {
    if (this.measureFrame !== 0) return;
    this.measureFrame = requestAnimationFrame(() => {
      this.measureFrame = 0;
      this.measureWraps();
    });
  }

  /**
   * Keep one number per line when long lines wrap.
   *
   * The gutter is a column of numbers set one per row, so a line that wraps
   * onto three rows pushed every number after it out of step. When any line
   * wraps, each number is placed where its line starts, read from the editor;
   * when none does, the plain column is put back, which costs nothing to draw.
   */
  private measureWraps(): void {
    const base = this.getPos();
    const text = this.node.textContent;
    const lines = lineCount(text);
    const style = getComputedStyle(this.contentDOM);
    const row = Number.parseFloat(style.lineHeight);
    const padding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
    const oneRowEach = !wrapsCode() || !Number.isFinite(row) || row <= 0
      || this.contentDOM.scrollHeight - padding <= lines * row + row / 2;
    if (oneRowEach || base === undefined || !this.dom.isConnected) {
      if (this.wrappedTops !== null) {
        this.wrappedTops = null;
        delete this.gutter.dataset.wrapped;
        this.gutter.textContent = gutterText(lines);
      }
      return;
    }
    const tops: number[] = [];
    let offset = 0;
    try {
      for (let line = 0; line < lines; line += 1) {
        tops.push(this.view.coordsAtPos(base + 1 + offset, 1).top);
        offset = text.indexOf('\n', offset) + 1;
      }
    } catch {
      return;
    }
    const first = tops[0] ?? 0;
    const relative = tops.map((top) => Math.round(top - first));
    if (this.wrappedTops && relative.length === this.wrappedTops.length && relative.every((top, index) => top === this.wrappedTops![index])) return;
    this.wrappedTops = relative;
    this.gutter.dataset.wrapped = '';
    const rows = relative.map((top, index) => {
      const number = document.createElement('div');
      number.className = 'noto-fence-number';
      number.textContent = String(index + 1);
      number.style.height = `${Math.max(row, (relative[index + 1] ?? top + row) - top)}px`;
      return number;
    });
    this.gutter.replaceChildren(...rows);
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
    if (this.wrappedTops !== null) {
      const paddingTop = Number.parseFloat(getComputedStyle(this.gutter).paddingTop) || 0;
      const y = offsetY - paddingTop;
      let line = 0;
      while (line + 1 < this.wrappedTops.length && this.wrappedTops[line + 1]! <= y) line += 1;
      return line;
    }
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
    if (this.measureFrame !== 0) cancelAnimationFrame(this.measureFrame);
    if (this.measureTimer !== null) clearTimeout(this.measureTimer);
    this.resized?.disconnect();
    this.dom.removeEventListener('pointerenter', this.ensureTools);
    this.dom.removeEventListener('focusin', this.ensureTools);
    this.picker?.close(false);
    this.diagram?.destroy();
    this.timeline?.destroy();
  }

  /** Write the chosen language into the node, as one undoable change. */
  private commitLanguage(chosen: string): void {
    const lang = chosen.trim().toLowerCase();
    if (lang === ((this.node.attrs.lang as string) || '')) return;
    const position = this.getPos();
    if (position === undefined) return;
    const { state } = this.view;
    this.view.dispatch(state.tr.setNodeMarkup(position, undefined, { ...this.node.attrs, lang }));
  }

  /**
   * The label: the fence's language by its name, or what the code reads as,
   * marked as a guess, or an invitation to choose when it reads as nothing.
   */
  private syncLanguageLabel(): void {
    const label = this.language;
    if (!label) return;
    const lang = String(this.node.attrs.lang ?? '').trim();
    const guess = lang ? null : guessedLanguage(this.node);
    const key = `${lang}\u0000${guess ?? ''}`;
    if (key === this.labelKey) return;
    this.labelKey = key;
    const name = document.createElement('span');
    name.className = 'noto-fence-lang-name';
    if (lang) {
      name.textContent = languageName(lang);
      label.dataset.state = 'set';
      label.title = lang === PLAIN_TEXT ? 'Plain text. Choose a language' : `\`\`\`${lang}. Choose another language`;
      label.replaceChildren(name);
    } else if (guess) {
      name.textContent = languageName(guess);
      const auto = document.createElement('span');
      auto.className = 'noto-fence-lang-auto';
      auto.textContent = 'auto';
      label.dataset.state = 'guess';
      label.title = `Reads as ${languageName(guess)}. Choose a language to write it into the fence`;
      label.replaceChildren(name, auto);
    } else {
      name.textContent = 'Language';
      label.dataset.state = 'none';
      label.title = 'Choose a language';
      label.replaceChildren(name);
    }
    label.setAttribute('aria-label', `Code block language: ${label.title}`);
    // A note that cannot be edited shows its language and offers no list.
    label.disabled = !this.view.editable;
  }

  private render(): void {
    const lang = (this.node.attrs.lang as string) || '';
    if (lang) this.dom.setAttribute('data-lang', lang);
    else this.dom.removeAttribute('data-lang');
    this.syncLanguageLabel();

    // A diagram fence (mermaid, or Typora's flow and sequence) is drawn as
    // its diagram, beside the source; a press on the drawing puts the caret at
    // the top of the source.
    if (isDiagramLanguage(lang)) {
      if (this.diagram === null) {
        this.diagram = new DiagramFrame(() => this.caretToLine(0));
        this.dom.append(this.diagram.dom);
      }
      this.diagram.render(this.node.textContent, lang);
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
    if (this.wrappedTops === null) this.gutter.textContent = gutterText(lines);
    else this.scheduleMeasure();
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
    code_block: (
      node: ProseNode,
      view: EditorView,
      getPos: () => number | undefined,
      _decorations?: unknown,
      _inner?: unknown,
      host?: HTMLElement,
    ) => new FenceView(node, view, getPos, host),
  };
}

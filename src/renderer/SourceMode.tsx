/**
 * Source Code Mode: the whole note as the text it is saved as.
 *
 * Typora's Command-slash. The rendered page goes and a plain column of
 * markdown takes its place, coloured the way a fence is coloured, and the
 * reader edits the text directly. What is typed here settles a moment after
 * each pause: block changes through the same block-wise replacement a
 * transform plugin uses, and gap-only (or other whole-buffer) changes through
 * an explicit full-source escape, so the outline, the word count, the dirty
 * mark and autosave keep working without rewriting provenance on every key.
 *
 * A textarea does the editing, over a coloured copy of the same text drawn
 * underneath it. The textarea's own text is invisible and only its caret
 * shows, which is the oldest way to colour an input and the one that keeps
 * the input native: undo, the Chinese input method, drag selection and the
 * system's spelling all belong to the browser and none of them had to be
 * written.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Prism from 'prismjs';
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-markdown';
import { blockAtOffset, offsetOfBlock } from './source-lines';

/** Typing pauses this long before the document takes the text. */
const SETTLE_MS = 350;

/**
 * Edits closer together than this are one step of Undo, as typing a word is
 * one step in any text field. The browser's own undo cannot be used: the
 * coloured copy of the text under the field is redrawn on every key, and
 * that ends the browser's typing group, so it undid a letter at a time.
 */
const UNDO_GROUP_MS = 800;
/** Steps kept; the oldest go first. */
const UNDO_LIMIT = 300;

interface SourceStep {
  readonly text: string;
  readonly caret: number;
}

export interface SourceModeProps {
  /** The text as the document holds it now. */
  readonly initialText: string;
  /** The block the caret was in, which is where the text opens. */
  readonly startBlock: number;
  /** Put the text into the document; true when anything changed. */
  readonly apply: (markdown: string) => boolean;
  /** Called when the mode is left, with the block the caret was in. */
  readonly onLeave: (block: number) => void;
  /** Lets the owner push pending text into the document before a save. */
  readonly registerFlush: (flush: (() => void) | null) => void;
  /** Lets the owner send Undo and Redo here while the mode is open; false when there was no step. */
  readonly registerHistory: (step: ((direction: 'undo' | 'redo') => boolean) | null) => void;
}

export function SourceMode({ initialText, startBlock, apply, onLeave, registerFlush, registerHistory }: SourceModeProps) {
  const [text, setText] = useState(initialText);
  const textRef = useRef(text);
  textRef.current = text;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<number | null>(null);
  const pending = useRef<string | null>(null);
  // The text the note was last given, so leaving can tell whether the field
  // still says something the note does not.
  const applied = useRef(initialText);
  const applyText = useCallback((draft: string) => {
    applied.current = draft;
    apply(draft);
  }, [apply]);

  const flush = useCallback(() => {
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
    if (pending.current !== null) {
      const draft = pending.current;
      pending.current = null;
      applyText(draft);
    }
  }, [applyText]);

  useEffect(() => {
    registerFlush(flush);
    return () => registerFlush(null);
  }, [flush, registerFlush]);

  // Text set from here, by Undo or Redo: the field, the colours and the note all follow.
  const restore = useCallback((step: SourceStep) => {
    const input = inputRef.current;
    if (!input) return;
    input.value = step.text;
    input.setSelectionRange(step.caret, step.caret);
    setText(step.text);
    pending.current = step.text;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (pending.current !== null) {
        const draft = pending.current;
        pending.current = null;
        applyText(draft);
      }
    }, SETTLE_MS);
  }, [applyText]);

  useEffect(() => {
    registerHistory((direction) => {
      const history = steps.current;
      const target = direction === 'undo' ? history.at - 1 : history.at + 1;
      if (target < 0 || target >= history.list.length) return false;
      history.at = target;
      // A step taken back is never extended by the next key.
      history.last = 0;
      restore(history.list[target]!);
      return true;
    });
    return () => registerHistory(null);
  }, [registerHistory, restore]);

  // The caret opens where the reader was, and the leave hands back where
  // they went. Ref-held so the unmount sees the last caret, not the first.
  const leaveRef = useRef(onLeave);
  leaveRef.current = onLeave;
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    // Set once and left to the browser after that. A controlled field had its
    // text written back by React on every key, which cut the browser's undo
    // into single characters: Cmd+Z took back one letter at a time.
    input.value = initialText;
    const at = offsetOfBlock(initialText, startBlock);
    input.focus();
    input.setSelectionRange(at, at);
    caret.current = at;
    // Scroll the caret's line into the middle rather than leaving it under
    // the fold: a textarea does not scroll to a programmatic selection.
    const lines = initialText.slice(0, at).split('\n').length - 1;
    const lineHeight = parseFloat(getComputedStyle(input).lineHeight) || 22;
    const scroller = input.closest('.canvas-scroll');
    if (scroller instanceof HTMLElement) {
      scroller.scrollTop = Math.max(0, lines * lineHeight - scroller.clientHeight / 3);
    }
    // Only on mount: the text changes on every key, and the caret is the reader's after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Where the caret is, kept as it moves: by the time the unmount runs the
  // textarea has been let go and cannot be asked.
  const caret = useRef(0);
  const noteCaret = useCallback(() => {
    const input = inputRef.current;
    if (input) caret.current = input.selectionStart;
  }, []);

  useEffect(() => () => {
    // Leaving: whatever is still pending goes in, then the caret's block is
    // handed back so the rendered document opens at the same place.
    const at = caret.current;
    const draft = pending.current ?? textRef.current;
    if (timer.current !== null) window.clearTimeout(timer.current);
    pending.current = null;
    // Whatever the field says goes in, settled or not: the rendered note must
    // open showing what was last seen here.
    if (draft !== applied.current) applyText(draft);
    leaveRef.current(blockAtOffset(draft, at));
    // Mount and unmount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Undo history: the text after each step, with the caret where the step left it.
  const steps = useRef<{ list: SourceStep[]; at: number; last: number }>({
    list: [{ text: initialText, caret: offsetOfBlock(initialText, startBlock) }],
    at: 0,
    last: 0,
  });
  const record = useCallback((next: string, caret: number) => {
    const history = steps.current;
    const now = Date.now();
    history.list.length = history.at + 1;
    if (history.at > 0 && now - history.last < UNDO_GROUP_MS) {
      history.list[history.at] = { text: next, caret };
    } else {
      history.list.push({ text: next, caret });
      if (history.list.length > UNDO_LIMIT) history.list.shift();
      history.at = history.list.length - 1;
    }
    history.last = now;
  }, []);

  const onChange = useCallback((next: string) => {
    setText(next);
    record(next, inputRef.current?.selectionEnd ?? next.length);
    pending.current = next;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (pending.current !== null) {
        const draft = pending.current;
        pending.current = null;
        applyText(draft);
      }
    }, SETTLE_MS);
  }, [applyText]);

  // Coloured the way a fence is: the same grammar library, the markdown
  // grammar, and a trailing newline so the last empty line still has height.
  const html = useMemo(() => Prism.highlight(`${text}\n`, Prism.languages.markdown, 'markdown'), [text]);

  return (
    <div className="noto-source" data-testid="source-mode">
      <pre className="noto-source-highlight" aria-hidden="true" dangerouslySetInnerHTML={{ __html: html }} />
      <textarea
        ref={inputRef}
        className="noto-source-input"
        data-testid="source-input"
        aria-label="Markdown source"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap="soft"
        onChange={(event) => { onChange(event.target.value); noteCaret(); }}
        onSelect={noteCaret}
        onKeyUp={noteCaret}
        onMouseUp={noteCaret}
        onKeyDown={(event) => {
          // Tab is an indent here, not the next control: the text is the
          // point of the mode. Through the command so it stays undoable.
          if (event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey) {
            event.preventDefault();
            document.execCommand('insertText', false, '  ');
          }
        }}
      />
    </div>
  );
}

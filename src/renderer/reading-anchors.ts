/**
 * Where each note was being read, so going back to it finds the same place.
 *
 * Every open note keeps its editor, but they all sit in one scrolling page,
 * so a note came to the front at the scroll offset of the note before it,
 * and Back did not find your place (daily-use audit, finding 7). An offset
 * would not survive the note changing above the fold or a later launch, so a
 * place is kept as the top level block at the top of the page and how far
 * into it the page was scrolled: the paragraph you were reading stays the
 * paragraph you see. Kept per open note while the window lives, and by path
 * in local storage for the next launch, the newest few hundred notes.
 */

import type { Node as ProseNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';

export interface ReadingAnchor {
  /** The top level block at the top of the page. */
  readonly block: number;
  /** How many pixels of it were above the top of the page. */
  readonly offset: number;
}

const STORAGE_KEY = 'noto.reading-anchors.v1';
/** Notes whose place is remembered across launches. */
const KEPT = 400;

const blockStarts = new WeakMap<ProseNode, number[]>();

/** The document position where each top level block starts, kept per document node. */
function startsOf(doc: ProseNode): number[] {
  let starts = blockStarts.get(doc);
  if (starts) return starts;
  starts = [];
  doc.forEach((_child, offset) => { starts!.push(offset); });
  blockStarts.set(doc, starts);
  return starts;
}

function blockElement(view: EditorView, start: number): HTMLElement | null {
  const dom = view.nodeDOM(start);
  return dom instanceof HTMLElement ? dom : null;
}

/** The block at the top of `container`, found by halving, since blocks run down the page in order. */
export function readingAnchor(view: EditorView, container: HTMLElement): ReadingAnchor | null {
  const starts = startsOf(view.state.doc);
  if (starts.length === 0) return null;
  const top = container.getBoundingClientRect().top;
  if (container.scrollTop <= 0) return { block: 0, offset: 0 };
  let low = 0;
  let high = starts.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const element = blockElement(view, starts[middle]!);
    if (!element) return null;
    const box = element.getBoundingClientRect();
    if (box.bottom > top) {
      found = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  if (found < 0) found = starts.length - 1;
  const element = blockElement(view, starts[found]!);
  if (!element) return null;
  return { block: found, offset: Math.round(top - element.getBoundingClientRect().top) };
}

/** Scroll `container` so the anchor's block sits where it did. False when there is no such block. */
export function restoreReadingAnchor(view: EditorView, container: HTMLElement, anchor: ReadingAnchor): boolean {
  const starts = startsOf(view.state.doc);
  if (starts.length === 0) return false;
  if (anchor.block === 0 && anchor.offset <= 0) {
    container.scrollTop = 0;
    return true;
  }
  const element = blockElement(view, starts[Math.min(anchor.block, starts.length - 1)]!);
  if (!element) return false;
  const delta = element.getBoundingClientRect().top - container.getBoundingClientRect().top;
  container.scrollTop += delta + anchor.offset;
  return true;
}

const isAnchor = (value: unknown): value is ReadingAnchor => typeof value === 'object' && value !== null
  && Number.isSafeInteger((value as ReadingAnchor).block) && (value as ReadingAnchor).block >= 0
  && Number.isFinite((value as ReadingAnchor).offset);

/** Places by note path, newest last, written at most once a second. */
export class ReadingAnchorStore {
  private places = new Map<string, ReadingAnchor>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null) {
    try {
      const parsed: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '[]');
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (Array.isArray(item) && typeof item[0] === 'string' && isAnchor(item[1])) this.places.set(item[0], item[1]);
        }
      }
    } catch {
      // A broken entry is a place forgotten, nothing worse.
    }
  }

  get(path: string): ReadingAnchor | null {
    return this.places.get(path) ?? null;
  }

  set(path: string, anchor: ReadingAnchor): void {
    this.places.delete(path);
    this.places.set(path, anchor);
    while (this.places.size > KEPT) this.places.delete(this.places.keys().next().value!);
    this.timer ??= setTimeout(() => this.flush(), 1000);
  }

  /** A note that moved keeps its place under its new path. */
  move(from: string, to: string): void {
    const anchor = this.places.get(from);
    if (!anchor) return;
    this.places.delete(from);
    this.set(to, anchor);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify([...this.places]));
    } catch {
      // Storage full or gone: the places of this session are still kept in memory.
    }
  }
}

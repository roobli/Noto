/**
 * The git gutter: a thin line beside each block of the open note that
 * differs from the note as last committed, and a small mark where committed
 * blocks were deleted.
 *
 * Read-only. Main works out which blocks changed (`git-blocks.ts`) and sends
 * their block ids; each lands on the top-level node whose origin is that
 * block, so the line stays beside the block it is about however much has been
 * typed elsewhere. Pressing the line shows the block as committed.
 *
 * Drawn as a layer beside the document, not as decorations in it. A node
 * decoration per changed block costs ProseMirror a scan of the top level for
 * every one of them on every keystroke (`NodeType.valid`), which on a long
 * note rewritten all over is tens of milliseconds a key. The layer costs
 * nothing while typing: the plugin state does not change for an edit inside a
 * block (the origin plugin keeps the same origins), and the layer is laid out
 * again, at most once a frame, only when the gutter changes, blocks come or go, or
 * the document's height changes (a ResizeObserver), which is when a line
 * could have moved.
 */

import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { NotoBlockOrigin } from '../../../shared/markdown/v3/contracts';
import type { WorkspaceGitBlocksV1 } from '../../../shared/workspace/v1/contracts';
import { originKey } from './origin-plugin';
import { GIT_BLOCK_WORDS, openGitPopover } from './git-popover';

export interface GitGutterEntry {
  readonly change: 'modified' | 'added';
  readonly head: string | null;
}

interface GitGutterState {
  readonly blocks: ReadonlyMap<string, GitGutterEntry>;
  /** Keyed by the block the deleted ones stood before; `''` for the end. */
  readonly deleted: ReadonlyMap<string, string>;
  readonly origins: readonly (NotoBlockOrigin | null)[] | null;
}

/** Where the gutter's marks sit, by top-level index. */
export interface GitGutterMarks {
  readonly lines: ReadonlyArray<{ readonly index: number } & GitGutterEntry>;
  /** `before` is the block count for a run deleted from the end. */
  readonly deleted: ReadonlyArray<{ readonly before: number; readonly head: string }>;
}

export const gitGutterKey = new PluginKey<GitGutterState>('noto-git-gutter');

const END = '';

const EMPTY: GitGutterState = { blocks: new Map(), deleted: new Map(), origins: null };

function originsOf(state: EditorState): readonly (NotoBlockOrigin | null)[] | null {
  return originKey.getState(state)?.origins ?? null;
}

function isEmpty(gutter: GitGutterState | undefined): boolean {
  return !gutter || (gutter.blocks.size === 0 && gutter.deleted.size === 0);
}

/** The meta that replaces what the gutter shows. */
export function setGitBlocks(tr: Transaction, event: WorkspaceGitBlocksV1 | null): Transaction {
  return tr.setMeta(gitGutterKey, event).setMeta('addToHistory', false);
}

/** Every mark, by the top-level node it belongs to. One pass over the top level. */
export function gitGutterMarks(state: EditorState): GitGutterMarks {
  const gutter = gitGutterKey.getState(state);
  const origins = originsOf(state);
  if (isEmpty(gutter) || !gutter || !origins) return { lines: [], deleted: [] };
  const lines: Array<{ index: number } & GitGutterEntry> = [];
  const deleted: Array<{ before: number; head: string }> = [];
  const count = state.doc.childCount;
  for (let index = 0; index < count; index += 1) {
    const origin = origins[index];
    if (!origin) continue;
    const removed = gutter.deleted.get(origin.blockId);
    if (removed !== undefined) deleted.push({ before: index, head: removed });
    const entry = gutter.blocks.get(origin.blockId);
    if (entry) lines.push({ index, ...entry });
  }
  const atEnd = gutter.deleted.get(END);
  if (atEnd !== undefined) deleted.push({ before: count, head: atEnd });
  return { lines, deleted };
}

/** What the gutter says about the top-level block at `index`, if anything. */
export function gitEntryAt(state: EditorState, index: number): GitGutterEntry | null {
  const gutter = gitGutterKey.getState(state);
  const origin = originsOf(state)?.[index] ?? null;
  if (!gutter || !origin) return null;
  return gutter.blocks.get(origin.blockId) ?? null;
}

/** The deleted run just before the top-level block at `index`, if any. */
export function gitDeletedBefore(state: EditorState, index: number): string | null {
  const gutter = gitGutterKey.getState(state);
  if (!gutter) return null;
  if (index >= state.doc.childCount) return gutter.deleted.get(END) ?? null;
  const origin = originsOf(state)?.[index] ?? null;
  return origin ? gutter.deleted.get(origin.blockId) ?? null : null;
}

function posOfChild(state: EditorState, index: number): number {
  let pos = 0;
  for (let child = 0; child < index; child += 1) pos += state.doc.child(child).nodeSize;
  return pos;
}

function blockElement(view: EditorView, index: number): HTMLElement | null {
  if (index < 0 || index >= view.state.doc.childCount) return null;
  const node = view.nodeDOM(posOfChild(view.state, index));
  return node instanceof HTMLElement ? node : null;
}

function openFor(view: EditorView, index: number, entry: GitGutterEntry): boolean {
  const anchor = blockElement(view, index);
  if (!anchor) return false;
  openGitPopover(view, anchor, entry.change === 'modified'
    ? { kind: 'modified', text: entry.head ?? '' }
    : { kind: 'added', text: null });
  return true;
}

function openDeleted(view: EditorView, before: number, head: string): boolean {
  const count = view.state.doc.childCount;
  const anchor = blockElement(view, before < count ? before : count - 1);
  if (!anchor) return false;
  openGitPopover(view, anchor, { kind: 'deleted', text: head });
  return true;
}

/**
 * Open the popover for the block holding the caret, for the keyboard: its
 * committed text, or the blocks deleted just before or after it. False when
 * the gutter has nothing to say there.
 */
export function showCommittedAtSelection(view: EditorView): boolean {
  const { state } = view;
  const index = state.selection.$from.index(0);
  const entry = gitEntryAt(state, index);
  if (entry) return openFor(view, index, entry);
  const before = gitDeletedBefore(state, index);
  if (before !== null) return openDeleted(view, index, before);
  const after = gitDeletedBefore(state, index + 1);
  if (after !== null) return openDeleted(view, index + 1, after);
  return false;
}

/**
 * Geometry, against the block's left edge (where its text starts):
 *
 * - A line's box is the column's 14px gutter, ending at the text. The bar is
 *   drawn against its right side, 8px from the text (noto-editor.scss), so
 *   at 2px its centre is 9px left of the text, and on hover it widens to 4px
 *   leftward, away from the text, with the 8px gap unchanged.
 * - The deleted triangle is 6px wide and 8px tall, its point on that 9px
 *   centre; its box is 16px square around it, centred in the gap.
 * - A bar beside the triangle stops 4px short of it.
 */
const LINE_BOX = 14;
const BAR_CENTRE = 9;
const TRIANGLE_HALF_HEIGHT = 4;
const TRIANGLE_CLEARANCE = 4;
const DELETED_BOX = 16;

/**
 * The layer: absolutely placed elements in a zero-height box just before the
 * document, inside the editor host, so they scroll with it and never enter
 * ProseMirror's DOM. Not in the tab order and hidden from assistive
 * technology: the keyboard and screen reader route is the palette's "Show
 * Block as Committed", which opens the same popover from the caret.
 */
class GutterLayer {
  private readonly layer: HTMLDivElement;
  private readonly resize: ResizeObserver | null;
  private frame: ReturnType<typeof setTimeout> | null = null;
  private marks: GitGutterMarks = { lines: [], deleted: [] };
  /** The top-level elements being watched for size, while there is a gutter. */
  private readonly watched = new Set<Element>();

  constructor(private readonly view: EditorView) {
    this.layer = document.createElement('div');
    this.layer.className = 'noto-git-gutter';
    this.layer.setAttribute('aria-hidden', 'true');
    this.layer.dataset.testid = 'git-gutter';
    view.dom.before(this.layer);
    this.layer.addEventListener('mousedown', this.onPress);
    this.resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.schedule()) : null;
    this.resize?.observe(view.dom);
    window.addEventListener('resize', this.schedule);
    this.schedule();
  }

  update(view: EditorView, previous: EditorState): void {
    if (gitGutterKey.getState(view.state) !== gitGutterKey.getState(previous)) this.schedule();
  }

  destroy(): void {
    if (this.frame !== null) clearTimeout(this.frame);
    this.resize?.disconnect();
    this.watched.clear();
    window.removeEventListener('resize', this.schedule);
    this.layer.remove();
  }

  /*
   * A timer rather than an animation frame: a window that is not producing
   * frames (hidden, occluded, or under a virtual display) would otherwise
   * hold the lines where they were. One frame's worth of delay, so a burst of
   * changes is one layout read.
   */
  private readonly schedule = (): void => {
    if (this.frame !== null) return;
    this.frame = setTimeout(() => {
      this.frame = null;
      this.draw();
    }, 16);
  };

  private readonly onPress = (event: MouseEvent): void => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-git-mark]');
    if (!target || event.button !== 0) return;
    // Keeps the caret and the focus where they were until the popover takes it.
    event.preventDefault();
    event.stopPropagation();
    const at = Number(target.dataset.gitAt);
    if (target.dataset.gitMark === 'deleted') {
      const run = this.marks.deleted.find((entry) => entry.before === at);
      if (run) openDeleted(this.view, run.before, run.head);
    } else {
      const line = this.marks.lines.find((entry) => entry.index === at);
      if (line) openFor(this.view, line.index, line);
    }
  };

  /*
   * Any block changing height can move the lines below it, and the document
   * itself does not always change size when one does (its minimum height can
   * hold it), so every top-level block is watched while there is a gutter.
   * ResizeObserver does the comparing natively and calls back only on a
   * change; this keeps the watched set to the blocks that are in the document.
   */
  private watch(on: boolean): void {
    const resize = this.resize;
    if (!resize) return;
    if (!on) {
      if (this.watched.size === 0) return;
      for (const element of this.watched) resize.unobserve(element);
      this.watched.clear();
      resize.observe(this.view.dom);
      return;
    }
    for (const element of this.watched) {
      if (element.parentElement !== this.view.dom) {
        resize.unobserve(element);
        this.watched.delete(element);
      }
    }
    for (const element of this.view.dom.children) {
      if (!this.watched.has(element)) {
        resize.observe(element);
        this.watched.add(element);
      }
    }
  }

  private draw(): void {
    const { view } = this;
    this.marks = gitGutterMarks(view.state);
    const { lines, deleted } = this.marks;
    if (lines.length === 0 && deleted.length === 0) {
      this.layer.replaceChildren();
      this.watch(false);
      return;
    }
    this.watch(true);
    // Element per top-level index, positions summed once.
    const wanted = new Set<number>();
    for (const line of lines) wanted.add(line.index);
    for (const run of deleted) {
      wanted.add(run.before);
      wanted.add(run.before - 1);
    }
    const elements = new Map<number, HTMLElement>();
    let pos = 0;
    const count = view.state.doc.childCount;
    for (let index = 0; index < count; index += 1) {
      if (wanted.has(index)) {
        const node = view.nodeDOM(pos);
        if (node instanceof HTMLElement) elements.set(index, node);
      }
      pos += view.state.doc.child(index).nodeSize;
    }
    const origin = this.layer.getBoundingClientRect();
    const children: HTMLElement[] = [];
    const existing = this.layer.children;
    const take = (at: number, kind: string): HTMLElement => {
      const reused = existing[children.length] as HTMLElement | undefined;
      const element = reused ?? document.createElement('div');
      element.className = `noto-git-mark noto-git-${kind}`;
      element.dataset.gitMark = kind;
      element.dataset.gitAt = String(at);
      element.dataset.testid = kind === 'deleted' ? 'git-deleted-mark' : 'git-line';
      children.push(element);
      return element;
    };
    // Triangles first: where they sit decides where the bars beside them stop.
    const triangles: Array<{ before: number; head: string; left: number; y: number }> = [];
    for (const run of deleted) {
      const next = elements.get(run.before)?.getBoundingClientRect();
      const previous = elements.get(run.before - 1)?.getBoundingClientRect();
      const reference = next ?? previous;
      if (!reference) continue;
      // Centred in the gap the deleted blocks left; above the first block or
      // below the last, as far out as it would be clear of a bar.
      const away = TRIANGLE_HALF_HEIGHT + TRIANGLE_CLEARANCE;
      const y = next && previous ? (previous.bottom + next.top) / 2
        : next ? next.top - away
        : reference.bottom + away;
      triangles.push({ before: run.before, head: run.head, left: reference.left, y });
    }
    for (const line of lines) {
      const block = elements.get(line.index);
      if (!block) continue;
      const rect = block.getBoundingClientRect();
      let top = rect.top;
      let bottom = rect.bottom;
      for (const triangle of triangles) {
        const clear = TRIANGLE_HALF_HEIGHT + TRIANGLE_CLEARANCE;
        if (triangle.before === line.index) top = Math.max(top, triangle.y + clear);
        if (triangle.before === line.index + 1) bottom = Math.min(bottom, triangle.y - clear);
      }
      if (bottom - top < 2) continue;
      const element = take(line.index, line.change);
      element.title = GIT_BLOCK_WORDS[line.change];
      place(element, rect.left - origin.left - LINE_BOX, top - origin.top, bottom - top);
    }
    for (const triangle of triangles) {
      const element = take(triangle.before, 'deleted');
      element.title = GIT_BLOCK_WORDS.deleted;
      // The box is centred on the point, the bar's centre line.
      place(element, triangle.left - origin.left - BAR_CENTRE - DELETED_BOX / 2, triangle.y - origin.top - DELETED_BOX / 2, DELETED_BOX);
    }
    while (existing.length > children.length) existing[existing.length - 1]!.remove();
    for (const element of children) if (element.parentElement !== this.layer) this.layer.append(element);
  }
}

function place(element: HTMLElement, left: number, top: number, height: number): void {
  element.style.left = `${Math.round(left)}px`;
  element.style.top = `${Math.round(top)}px`;
  element.style.height = `${Math.round(height)}px`;
}

export function gitGutterPlugin(): Plugin<GitGutterState> {
  return new Plugin<GitGutterState>({
    key: gitGutterKey,
    state: {
      init: () => EMPTY,
      apply(tr, previous, _old, next) {
        const meta = tr.getMeta(gitGutterKey) as WorkspaceGitBlocksV1 | null | undefined;
        if (meta !== undefined) {
          const blocks = new Map((meta?.blocks ?? []).map((block) => [block.blockId, { change: block.change, head: block.head }] as const));
          const deleted = new Map((meta?.deleted ?? []).map((run) => [run.beforeBlockId ?? END, run.head] as const));
          return { blocks, deleted, origins: originsOf(next) };
        }
        if (!tr.docChanged || isEmpty(previous)) return previous;
        const origins = originsOf(next);
        // The same origins array is the origin plugin saying no block came or
        // went: nothing in the gutter moved, and the state stays the same object.
        return origins === previous.origins ? previous : { ...previous, origins };
      },
    },
    view: (view) => new GutterLayer(view),
  });
}

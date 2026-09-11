/**
 * Stubbing scroller for long documents.
 *
 * Paint deferral (`viewport-layout.ts`) still leaves every top-level block in
 * the DOM. On the two-megabyte corpus that DOM size dominates a keystroke (see
 * `docs/performance/measurements.md`). This plugin replaces far-off top-level
 * blocks with height placeholders so ProseMirror does not build their inner
 * trees, while the selection neighbourhood and a window around the viewport
 * stay real content.
 *
 * Only default-rendered top-level types are stubbed in this slice (paragraph,
 * heading, lists, …). Fences, tables, math and HTML blocks keep their existing
 * node views and stay real — they are few relative to paragraphs in a long
 * note, and wrapping them is a larger behavioural risk.
 *
 * Enabled automatically once the document has enough top-level blocks that
 * medium-sized notes stay unaffected. Off below that threshold.
 *
 * Real blocks are the union of two windows — the scroller viewport and the
 * selection neighbourhood — checked with OR, not as one contiguous span from
 * the caret to the viewport. A contiguous span remounts every block between
 * them when the reader scrolls away from the caret, which is exactly the
 * mid/large scroll jank this layer exists to prevent.
 */

import { Plugin, PluginKey, type EditorState, type Selection, type Transaction } from 'prosemirror-state';
import { DOMSerializer, type Node as ProseNode } from 'prosemirror-model';
import { Decoration, DecorationSet, type EditorView, type NodeView, type NodeViewConstructor } from 'prosemirror-view';

export const viewportStubKey = new PluginKey<ViewportStubState>('noto-viewport-stub');

/** Below this, stubbing stays off — medium corpus notes stay fully real. */
export const STUB_MIN_TOP_LEVEL_BLOCKS = 3000;

/** Screens of real content above and below the visible scroller. */
export const STUB_SCREEN_BUFFER = 2;

/** Top-level neighbours of the selection that must stay fully real. */
export const STUB_SELECTION_RADIUS = 2;

/** Fallback line height guess when the host has not been measured yet. */
export const STUB_FALLBACK_EM_PX = 16;

/**
 * Vertical rhythm between top-level blocks (`editor.scss`: 0.74 × doc font size,
 * collapsing between neighbours). Stubs use `margin: 0` and fold this into their
 * height instead, so the height cache must count the same gap or remounting a
 * stub as real grows the document and the viewport window drifts off-screen.
 */
export const STUB_BLOCK_GAP_EM = 0.74;

/** Class on a stub placeholder element. */
export const STUB_CLASS = 'noto-block-stub';

/** Top-level types this slice knows how to stub. */
export const STUBBABLE_TYPES = [
  'paragraph',
  'heading',
  'blockquote',
  'bullet_list',
  'ordered_list',
  'horizontal_rule',
  'footnote_definition',
  'link_definition',
  'frontmatter',
  'source_block',
] as const;

export type StubbableType = (typeof STUBBABLE_TYPES)[number];

const STUBBABLE = new Set<string>(STUBBABLE_TYPES);

export interface BlockRange {
  readonly from: number;
  readonly to: number;
}

export interface ViewportStubState {
  readonly enabled: boolean;
  /** Inclusive top-level index window kept real for the scroller. */
  readonly viewport: BlockRange;
  /** Inclusive top-level index window kept real for the selection. */
  readonly selection: BlockRange;
  /**
   * Bounding span covering viewport and selection (for observability).
   * Membership uses `isIndexReal`, not this contiguous span — otherwise
   * scrolling away from the caret would keep every block between them real.
   */
  readonly real: BlockRange;
  /**
   * Per top-level-index height cache. Mutated in place after measuring real
   * blocks; treated as a cache, not as immutable plugin state.
   */
  readonly heights: Float64Array;
  /** Bumped when `real` changes so NodeViews can decide to remount. */
  readonly generation: number;
}

interface ViewportMeta {
  readonly viewport?: BlockRange;
}

function emptyRange(): BlockRange {
  return { from: 0, to: 0 };
}

function disabledState(childCount = 0): ViewportStubState {
  return {
    enabled: false,
    viewport: emptyRange(),
    selection: emptyRange(),
    real: emptyRange(),
    heights: new Float64Array(childCount),
    generation: 0,
  };
}

export function stubbingEnabled(childCount: number): boolean {
  return childCount >= STUB_MIN_TOP_LEVEL_BLOCKS;
}

export function clampRange(from: number, to: number, last: number): BlockRange {
  if (last < 0) return emptyRange();
  const start = Math.max(0, Math.min(from, last));
  const end = Math.max(start, Math.min(to, last));
  return { from: start, to: end };
}

export function unionRanges(a: BlockRange, b: BlockRange, last: number): BlockRange {
  return clampRange(Math.min(a.from, b.from), Math.max(a.to, b.to), last);
}

export function rangesEqual(a: BlockRange, b: BlockRange): boolean {
  return a.from === b.from && a.to === b.to;
}

/**
 * Top-level block indices that must stay real because of the selection.
 *
 * Same spirit as paint deferral's live neighbourhood, slightly wider so a
 * stub does not sit against the caret after a short move.
 */
export function selectionRealRange(
  doc: ProseNode,
  selection: Selection,
  radius: number = STUB_SELECTION_RADIUS,
): BlockRange {
  const last = doc.childCount - 1;
  if (last < 0) return emptyRange();
  let fromIndex = selection.$from.index(0);
  let toIndex = selection.$to.index(0);
  if (fromIndex > toIndex) {
    const swap = fromIndex;
    fromIndex = toIndex;
    toIndex = swap;
  }
  return clampRange(fromIndex - radius, toIndex + radius, last);
}

/** Whether `pos` is the start position of a direct child of the document. */
export function isTopLevelPos(doc: ProseNode, pos: number): boolean {
  return pos >= 0 && pos <= doc.content.size && doc.resolve(pos).depth === 0;
}

/** Top-level child index for a position that points at that child, else null. */
export function topLevelIndexAt(doc: ProseNode, pos: number): number | null {
  if (!isTopLevelPos(doc, pos)) return null;
  return doc.resolve(pos).index();
}

export function blockGapPx(emPx: number): number {
  return Math.max(0, emPx) * STUB_BLOCK_GAP_EM;
}

export function estimateBlockHeight(node: ProseNode, emPx: number): number {
  const line = Math.max(8, emPx) * 1.6;
  const gap = blockGapPx(emPx);
  let content: number;
  switch (node.type.name) {
    case 'horizontal_rule':
      content = Math.max(line, emPx * 2);
      break;
    case 'heading': {
      const level = Number(node.attrs.level ?? 1);
      content = line * (1.6 - Math.min(5, Math.max(0, level - 1)) * 0.08);
      break;
    }
    case 'code_block':
    case 'html_block':
    case 'frontmatter':
    case 'source_block': {
      const lines = Math.max(1, node.textContent.split('\n').length);
      // Fence chrome (lang badge / tools) adds roughly two lines beyond source.
      content = line * Math.min(48, lines + 3);
      break;
    }
    case 'math_block': {
      content = line * 3;
      break;
    }
    case 'bullet_list':
    case 'ordered_list':
      content = line * Math.max(1, node.childCount);
      break;
    case 'blockquote':
    case 'footnote_definition':
      content = line * Math.max(1, node.childCount);
      break;
    case 'paragraph': {
      const chars = node.textContent.length;
      const lines = Math.max(1, Math.ceil(chars / 72));
      content = line * lines;
      break;
    }
    case 'table':
      // Table frame padding + row chrome; under-estimates here shift the whole map.
      content = line * Math.max(3, node.childCount * 1.6 + 2);
      break;
    default:
      content = line;
      break;
  }
  return content + gap;
}

export function estimateAllHeights(doc: ProseNode, emPx: number): Float64Array {
  const heights = new Float64Array(doc.childCount);
  for (let index = 0; index < doc.childCount; index += 1) {
    heights[index] = estimateBlockHeight(doc.child(index), emPx);
  }
  return heights;
}

/** Prefix sums: cumulative[i] is the y offset of top-level block i. */
export function cumulativeHeights(heights: Float64Array): Float64Array {
  const cumulative = new Float64Array(heights.length + 1);
  for (let index = 0; index < heights.length; index += 1) {
    cumulative[index + 1] = cumulative[index] + Math.max(0, heights[index]);
  }
  return cumulative;
}

/**
 * Inclusive top-level index window whose estimated vertical span intersects
 * `[y0, y1)`.
 */
export function blockWindowForY(cumulative: Float64Array, y0: number, y1: number): BlockRange {
  const count = cumulative.length - 1;
  if (count <= 0) return emptyRange();
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);

  let from = 0;
  let high = count;
  while (from < high) {
    const mid = (from + high) >> 1;
    if (cumulative[mid + 1] <= top) from = mid + 1;
    else high = mid;
  }

  let to = from;
  while (to < count - 1 && cumulative[to + 1] < bottom) to += 1;
  return clampRange(from, to, count - 1);
}

export function rangeContains(range: BlockRange, index: number): boolean {
  return index >= range.from && index <= range.to;
}

/**
 * Whether a top-level index stays mounted as real content.
 *
 * Viewport and selection are separate windows. OR membership — never the
 * contiguous span between them — is what keeps scroll-away from the caret
 * from remounting thousands of blocks.
 */
export function isIndexReal(state: ViewportStubState, index: number): boolean {
  if (!state.enabled) return true;
  return rangeContains(state.viewport, index) || rangeContains(state.selection, index);
}

export function isIndexStubbed(
  state: ViewportStubState,
  index: number,
  typeName: string,
): boolean {
  if (!state.enabled) return false;
  if (!STUBBABLE.has(typeName)) return false;
  if (index < 0) return false;
  return !isIndexReal(state, index);
}

/** How many top-level blocks are currently mounted real (either window). */
export function countRealIndices(state: ViewportStubState, childCount: number): number {
  if (!state.enabled || childCount <= 0) return childCount;
  let count = 0;
  for (let index = 0; index < childCount; index += 1) {
    if (isIndexReal(state, index)) count += 1;
  }
  return count;
}

function remappedHeights(
  previous: ViewportStubState,
  oldDoc: ProseNode,
  newDoc: ProseNode,
  emPx: number,
): Float64Array {
  const heights = estimateAllHeights(newDoc, emPx);
  if (!previous.enabled || previous.heights.length === 0) return heights;

  // Best-effort: copy measured heights for a common prefix / suffix. Edits in
  // the middle fall back to estimates until the next measure pass.
  const shared = Math.min(previous.heights.length, heights.length, oldDoc.childCount, newDoc.childCount);
  for (let index = 0; index < shared; index += 1) {
    if (oldDoc.child(index).type === newDoc.child(index).type
      && oldDoc.child(index).nodeSize === newDoc.child(index).nodeSize
      && previous.heights[index] > 0) {
      heights[index] = previous.heights[index];
    }
  }
  return heights;
}

function buildState(
  state: EditorState,
  previous: ViewportStubState | null,
  viewport: BlockRange | null,
  emPx: number,
): ViewportStubState {
  const { doc, selection } = state;
  if (!stubbingEnabled(doc.childCount)) return disabledState(doc.childCount);

  const last = doc.childCount - 1;
  const selectionRange = selectionRealRange(doc, selection);
  const heights = previous && previous.heights.length === doc.childCount
    ? previous.heights
    : estimateAllHeights(doc, emPx);
  // Before the scroll listener has measured, keep a padded window around the
  // caret rather than "from zero to the caret", which would leave most of a
  // huge file real when the selection sits in the middle.
  const initialPad = 40;
  const viewportRange = clampRange(
    viewport?.from ?? previous?.viewport.from ?? (selectionRange.from - initialPad),
    viewport?.to ?? previous?.viewport.to ?? (selectionRange.to + initialPad),
    last,
  );
  const real = unionRanges(viewportRange, selectionRange, last);
  const generation = previous
    && rangesEqual(previous.viewport, viewportRange)
    && rangesEqual(previous.selection, selectionRange)
    ? previous.generation
    : (previous?.generation ?? 0) + 1;

  return {
    enabled: true,
    viewport: viewportRange,
    selection: selectionRange,
    real,
    heights,
    generation,
  };
}

function findScroller(view: EditorView): HTMLElement | null {
  let element: HTMLElement | null = view.dom.parentElement;
  while (element) {
    const style = getComputedStyle(element);
    if (/(auto|scroll)/.test(style.overflowY)) return element;
    element = element.parentElement;
  }
  return null;
}

function hostEmPx(view: EditorView): number {
  const host = view.dom.closest('.noto-editor-host') ?? view.dom;
  const size = Number.parseFloat(getComputedStyle(host).fontSize);
  return Number.isFinite(size) && size > 0 ? size : STUB_FALLBACK_EM_PX;
}


/**
 * Inclusive top-level index window whose DOM boxes intersect `[y0, y1)` in
 * viewport coordinates (getBoundingClientRect space).
 */
function blockWindowForClientY(
  children: HTMLCollection,
  last: number,
  y0: number,
  y1: number,
): BlockRange {
  if (children.length === 0 || last < 0) return emptyRange();
  const limit = Math.min(last, children.length - 1);

  let low = 0;
  let high = limit + 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    const box = children[mid]!.getBoundingClientRect();
    if (box.bottom <= y0) low = mid + 1;
    else high = mid;
  }
  const from = Math.min(low, last);

  let to = from;
  for (let index = from; index <= limit; index += 1) {
    const box = children[index]!.getBoundingClientRect();
    if (index > from && box.top >= y1) break;
    to = index;
  }
  return clampRange(from, to, last);
}

/**
 * Inclusive top-level window covering the scroller plus buffer screens.
 *
 * Uses the live DOM geometry of ProseMirror's top-level children rather than
 * the height cache. The cache still sizes stubs, but estimating y from it
 * drifted whenever always-real fences/tables or block rhythm disagreed with
 * the placeholder map — leaving the "real" window off-screen.
 */
function viewportFromScroll(view: EditorView, _heights: Float64Array): BlockRange | null {
  const scroller = findScroller(view);
  if (!scroller) return null;
  const last = view.state.doc.childCount - 1;
  if (last < 0) return emptyRange();

  const children = view.dom.children;
  if (children.length === 0) return emptyRange();

  const sc = scroller.getBoundingClientRect();
  const buffer = scroller.clientHeight * STUB_SCREEN_BUFFER;
  return blockWindowForClientY(children, last, sc.top - buffer, sc.bottom + buffer);
}

/** Strictly visible band (no buffer) — used to decide whether to remount. */
function visibleWindowFromScroll(view: EditorView): BlockRange | null {
  const scroller = findScroller(view);
  if (!scroller) return null;
  const last = view.state.doc.childCount - 1;
  if (last < 0) return emptyRange();
  const children = view.dom.children;
  if (children.length === 0) return emptyRange();
  const sc = scroller.getBoundingClientRect();
  return blockWindowForClientY(children, last, sc.top, sc.bottom);
}

/**
 * Remount only when the visible band would leave the current real window.
 * Scrolling inside the buffered region is free — the residual scroll-frame
 * cost was remounting on every step even when nothing on screen needed it.
 */
export function viewportNeedsRemount(current: BlockRange, visible: BlockRange): boolean {
  return visible.from < current.from || visible.to > current.to;
}

/**
 * Write measured heights for currently real blocks.
 *
 * Returns true when any stub height cache entry changed. A follow-up
 * viewport pass picks up geometry shifts after stub↔real remounts.
 */

function measureRealHeights(view: EditorView, stub: ViewportStubState): boolean {
  if (!stub.enabled) return false;
  const gap = blockGapPx(hostEmPx(view));
  let changed = false;
  let position = 0;
  for (let index = 0; index < view.state.doc.childCount; index += 1) {
    if (isIndexReal(stub, index)) {
      const nodeDom = view.nodeDOM(position);
      if (nodeDom instanceof HTMLElement && !nodeDom.classList.contains(STUB_CLASS)) {
        const height = nodeDom.offsetHeight;
        if (height > 0) {
          // offsetHeight omits margins; stubs fold the rhythm gap into height.
          // Never shrink a cached height during remount: a shorter real block
          // packs more indices into the visible band, which trips hysteresis
          // and remounts again (scroll-frame cascade). Growth is fine.
          const next = height + gap;
          if (next > stub.heights[index] + 0.5) {
            stub.heights[index] = next;
            changed = true;
          }
        }
      }
    }
    position += view.state.doc.child(index).nodeSize;
  }
  return changed;
}

function publishDataset(view: EditorView, stub: ViewportStubState): void {
  const host = view.dom.closest('.noto-editor-host');
  if (!(host instanceof HTMLElement)) return;
  if (!stub.enabled) {
    delete host.dataset.stubEnabled;
    delete host.dataset.stubReal;
    delete host.dataset.stubSelection;
    delete host.dataset.stubCount;
    return;
  }
  const stubbed = Math.max(0, view.state.doc.childCount - countRealIndices(stub, view.state.doc.childCount));
  host.dataset.stubEnabled = '1';
  // Viewport window (what is on screen), not the contiguous caret↔viewport span.
  host.dataset.stubReal = `${stub.viewport.from}-${stub.viewport.to}`;
  host.dataset.stubSelection = `${stub.selection.from}-${stub.selection.to}`;
  host.dataset.stubCount = String(stubbed);
}

function syncShellAttrs(dom: HTMLElement, node: ProseNode): void {
  switch (node.type.name) {
    case 'bullet_list': {
      if (node.attrs.spread) dom.setAttribute('data-spread', '');
      else dom.removeAttribute('data-spread');
      if (node.attrs.bullet && node.attrs.bullet !== '-') dom.setAttribute('data-bullet', String(node.attrs.bullet));
      else dom.removeAttribute('data-bullet');
      break;
    }
    case 'ordered_list': {
      if (node.attrs.start === 1) dom.removeAttribute('start');
      else dom.setAttribute('start', String(node.attrs.start));
      if (node.attrs.spread) dom.setAttribute('data-spread', '');
      else dom.removeAttribute('data-spread');
      if (node.attrs.delimiter && node.attrs.delimiter !== '.') {
        dom.setAttribute('data-delimiter', String(node.attrs.delimiter));
      } else {
        dom.removeAttribute('data-delimiter');
      }
      break;
    }
    case 'footnote_definition':
      dom.setAttribute('data-identifier', String(node.attrs.identifier ?? ''));
      break;
    case 'link_definition':
      dom.setAttribute('data-identifier', String(node.attrs.identifier ?? ''));
      dom.textContent = `[${node.attrs.label || node.attrs.identifier}]: ${node.attrs.url}`;
      break;
    case 'source_block':
      dom.setAttribute('data-original-kind', String(node.attrs.originalKind ?? 'paragraph'));
      break;
    default:
      break;
  }
}

class StubbableBlockView implements NodeView {
  dom!: HTMLElement;
  contentDOM!: HTMLElement | null;
  private node: ProseNode;
  private readonly view: EditorView;
  private readonly getPos: () => number | undefined;
  private stubbed: boolean;
  private generation: number;

  constructor(node: ProseNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    const stub = viewportStubKey.getState(view.state);
    this.generation = stub?.generation ?? 0;
    this.stubbed = this.computeStubbed(stub);
    if (this.stubbed) this.mountStub(stub);
    else this.mountReal();
  }

  private computeStubbed(stub: ViewportStubState | undefined): boolean {
    if (!stub?.enabled) return false;
    const pos = this.getPos();
    if (pos == null) return false;
    const index = topLevelIndexAt(this.view.state.doc, pos);
    if (index == null) return false;
    return isIndexStubbed(stub, index, this.node.type.name);
  }

  private heightPx(stub: ViewportStubState | undefined): number {
    const pos = this.getPos();
    const em = hostEmPx(this.view);
    if (pos == null || !stub) return estimateBlockHeight(this.node, em);
    const index = topLevelIndexAt(this.view.state.doc, pos);
    if (index == null) return estimateBlockHeight(this.node, em);
    const cached = stub.heights[index];
    return cached > 0 ? cached : estimateBlockHeight(this.node, em);
  }

  private mountStub(stub: ViewportStubState | undefined): void {
    this.dom = document.createElement('div');
    this.dom.className = STUB_CLASS;
    this.dom.dataset.stubType = this.node.type.name;
    this.dom.style.height = `${this.heightPx(stub)}px`;
    this.contentDOM = null;
  }

  private mountReal(): void {
    const toDOM = this.node.type.spec.toDOM;
    if (!toDOM) {
      this.dom = document.createElement('div');
      this.contentDOM = this.dom;
      return;
    }
    const rendered = DOMSerializer.renderSpec(document, toDOM(this.node));
    this.dom = rendered.dom as HTMLElement;
    this.contentDOM = (rendered.contentDOM as HTMLElement | null) ?? null;
    syncShellAttrs(this.dom, this.node);
  }

  update(node: ProseNode): boolean {
    if (node.type.name !== this.node.type.name) return false;
    const stub = viewportStubKey.getState(this.view.state);
    const wantStub = this.computeStubbed(stub);
    // Stubbed ↔ real transitions remount so contentDOM appears or disappears.
    if (wantStub !== this.stubbed) return false;
    this.generation = stub?.generation ?? this.generation;
    if (this.stubbed) {
      this.node = node;
      this.dom.style.height = `${this.heightPx(stub)}px`;
      return true;
    }
    if (node.type.name === 'heading' && node.attrs.level !== this.node.attrs.level) return false;
    this.node = node;
    syncShellAttrs(this.dom, node);
    return true;
  }

  ignoreMutation(): boolean {
    return this.stubbed;
  }

  destroy(): void {
    // Nothing owned outside the DOM node ProseMirror removes.
  }
}


/**
 * Node decorations on the current real window.
 *
 * Scroll updates only change plugin state. ProseMirror will not call
 * `NodeView.update` for an unchanged node unless its decorations change, so
 * these marks force remounts when a block enters or leaves the real window.
 */
function decorateRange(
  doc: ProseNode,
  range: BlockRange,
  generation: number,
  decorations: Decoration[],
  seen: Set<number>,
): void {
  let position = 0;
  for (let index = 0; index < range.from; index += 1) {
    position += doc.child(index).nodeSize;
  }
  for (let index = range.from; index <= range.to; index += 1) {
    const child = doc.child(index);
    const end = position + child.nodeSize;
    if (!seen.has(index) && STUBBABLE.has(child.type.name)) {
      seen.add(index);
      decorations.push(Decoration.node(position, end, {
        class: 'noto-stub-real',
      }, { stubGeneration: generation }));
    }
    position = end;
  }
}

function realWindowDecorations(doc: ProseNode, state: ViewportStubState): DecorationSet {
  if (!state.enabled) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  const seen = new Set<number>();
  // Two windows, not the span between them — see isIndexReal.
  decorateRange(doc, state.viewport, state.generation, decorations, seen);
  decorateRange(doc, state.selection, state.generation, decorations, seen);
  return DecorationSet.create(doc, decorations);
}

export function stubbableNodeViews(): Record<string, NodeViewConstructor> {
  const views: Record<string, NodeViewConstructor> = {};
  for (const type of STUBBABLE_TYPES) {
    views[type] = (node, view, getPos) => new StubbableBlockView(node, view, getPos);
  }
  return views;
}

export function viewportStubPlugin(): Plugin<ViewportStubState> {
  return new Plugin<ViewportStubState>({
    key: viewportStubKey,
    state: {
      init: (_config, state) => buildState(state, null, null, STUB_FALLBACK_EM_PX),
      apply: (transaction, previous, oldState, newState) => {
        const meta = transaction.getMeta(viewportStubKey) as ViewportMeta | undefined;
        if (!stubbingEnabled(newState.doc.childCount)) {
          return previous.enabled ? disabledState(newState.doc.childCount) : previous;
        }

        let heights = previous.heights;
        if (transaction.docChanged || heights.length !== newState.doc.childCount) {
          heights = remappedHeights(
            { ...previous, heights },
            oldState.doc,
            newState.doc,
            STUB_FALLBACK_EM_PX,
          );
        }

        const draft: ViewportStubState = { ...previous, heights, enabled: true };
        const viewport = meta?.viewport
          ?? (transaction.docChanged ? null : previous.viewport);
        return buildState(newState, draft, viewport, STUB_FALLBACK_EM_PX);
      },
    },
    props: {
      decorations: (editorState) => {
        const stub = viewportStubKey.getState(editorState);
        if (!stub?.enabled) return DecorationSet.empty;
        return realWindowDecorations(editorState.doc, stub);
      },
    },
    view: (editorView) => {
      let attached: HTMLElement | null = null;
      let frame = 0;
      let resyncFrame = 0;
      let lastMeasuredGeneration = -1;
      /** Caps measure→viewport feedback so remount height fixes can chase once. */
      let resyncBudget = 0;

      const dispatchViewport = (viewport: BlockRange) => {
        const current = viewportStubKey.getState(editorView.state);
        if (!current?.enabled) return;
        if (rangesEqual(current.viewport, viewport)) return;
        const transaction: Transaction = editorView.state.tr.setMeta(viewportStubKey, { viewport });
        editorView.dispatch(transaction);
      };

      const scheduleViewportFromScroll = () => {
        if (resyncFrame) return;
        resyncFrame = requestAnimationFrame(() => {
          resyncFrame = 0;
          const current = viewportStubKey.getState(editorView.state);
          if (!current?.enabled) return;
          const next = viewportFromScroll(editorView, current.heights);
          if (next) dispatchViewport(next);
        });
      };

      const onScroll = () => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          const current = viewportStubKey.getState(editorView.state);
          if (!current?.enabled) return;
          const visible = visibleWindowFromScroll(editorView);
          if (!visible) return;
          if (!viewportNeedsRemount(current.viewport, visible)) return;
          resyncBudget = 2;
          const next = viewportFromScroll(editorView, current.heights);
          if (next) dispatchViewport(next);
        });
      };

      const ensureScroll = () => {
        const scroller = findScroller(editorView);
        if (scroller === attached) return;
        attached?.removeEventListener('scroll', onScroll);
        attached = scroller;
        attached?.addEventListener('scroll', onScroll, { passive: true });
      };

      ensureScroll();
      const initial = viewportStubKey.getState(editorView.state);
      if (initial?.enabled) {
        resyncBudget = 6;
        const next = viewportFromScroll(editorView, initial.heights);
        if (next) dispatchViewport(next);
        publishDataset(editorView, viewportStubKey.getState(editorView.state) ?? initial);
      }

      return {
        update: (view) => {
          ensureScroll();
          const stub = viewportStubKey.getState(view.state);
          if (!stub?.enabled) {
            lastMeasuredGeneration = -1;
            publishDataset(view, stub ?? disabledState());
            return;
          }
          // Measuring every transaction forced layout across the whole real
          // window on each keystroke. Remounts (generation bumps) are what
          // need fresh stub sizes; typing into an already-real block can wait.
          const generationChanged = stub.generation !== lastMeasuredGeneration;
          let heightsChanged = false;
          if (generationChanged) {
            heightsChanged = measureRealHeights(view, stub);
            lastMeasuredGeneration = stub.generation;
          }
          publishDataset(view, stub);
          // DOM windowing usually self-corrects; one follow-up covers the case
          // where remount heights change geometry under the scrollport.
          if (heightsChanged && resyncBudget > 0) {
            resyncBudget -= 1;
            scheduleViewportFromScroll();
          }
        },
        destroy: () => {
          attached?.removeEventListener('scroll', onScroll);
          attached = null;
          if (frame) cancelAnimationFrame(frame);
          frame = 0;
          if (resyncFrame) cancelAnimationFrame(resyncFrame);
          resyncFrame = 0;
          const host = editorView.dom.closest('.noto-editor-host');
          if (host instanceof HTMLElement) {
            delete host.dataset.stubEnabled;
            delete host.dataset.stubReal;
            delete host.dataset.stubSelection;
            delete host.dataset.stubCount;
          }
        },
      };
    },
  });
}

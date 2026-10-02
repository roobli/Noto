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
 * Default-rendered top-level types (paragraph, heading, lists, …) are stubbed
 * via `StubbableBlockView`. Specialised top-level node views — fences, tables
 * and display math — are wrapped so a stub stands in off-viewport and the real
 * Fence/Table/Math view remounts when the block enters the real window (and
 * the reverse when it leaves). HTML and image blocks stay always-real in this
 * cut; they are rarer on the corpus and their remount surface is wider.
 *
 * Enabled automatically once the document has enough top-level blocks that
 * medium-sized notes stay unaffected. Off below that threshold.
 *
 * Real blocks are the union of two windows — the scroller viewport and the
 * selection neighbourhood — checked with OR, not as one contiguous span from
 * the caret to the viewport. A contiguous span remounts every block between
 * them when the reader scrolls away from the caret, which is exactly the
 * mid/large scroll jank this layer exists to prevent.
 *
 * Membership changes remount surgically (enter/leave indices only). Marking the
 * real window with node decorations forced ProseMirror to walk every top-level
 * child on each change; that path is gone.
 */

import { Plugin, PluginKey, type EditorState, type Selection, type Transaction } from 'prosemirror-state';
import { DOMSerializer, type Node as ProseNode } from 'prosemirror-model';
import { Decoration, DecorationSet, type DecorationSource, type EditorView, type NodeView, type NodeViewConstructor, type ViewMutationRecord } from 'prosemirror-view';

export const viewportStubKey = new PluginKey<ViewportStubState>('noto-viewport-stub');

/** Below this, stubbing stays off — medium corpus notes stay fully real. */
export const STUB_MIN_TOP_LEVEL_BLOCKS = 3000;

/**
 * Screens of real content above and below the visible scroller.
 *
 * Two was enough for small-step hysteresis, but a 0.75×view step then hit the
 * edge every couple of frames and paid the full remount spike (~75–79ms). Three
 * keeps large-step scrolling inside the buffer more often. Membership still
 * uses viewport OR selection; specialised fences/tables/math now stub too.
 */
export const STUB_SCREEN_BUFFER = 3;

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

/**
 * Shared prototype for stub placeholders. `cloneNode(false)` avoids repeating
 * `createElement` + className work once per top-level block on open — that path
 * dominated happy-dom EditorView construction on huge after specialised stubbing.
 */
let stubElementPrototype: HTMLDivElement | null = null;

function createStubElement(typeName: string, heightPx: number): HTMLElement {
  // Recreate when the document changes (happy-dom test resets); cloneNode from
  // a foreign document is undefined behaviour.
  if (!stubElementPrototype || stubElementPrototype.ownerDocument !== document) {
    stubElementPrototype = document.createElement('div');
    stubElementPrototype.className = STUB_CLASS;
  }
  const dom = stubElementPrototype.cloneNode(false) as HTMLDivElement;
  dom.dataset.stubType = typeName;
  dom.style.height = `${heightPx}px`;
  return dom;
}

/**
 * Default-rendered top-level types stubbed with `StubbableBlockView` (schema
 * `toDOM`, no specialised chrome).
 */
export const DEFAULT_STUBBABLE_TYPES = [
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

/**
 * Specialised node-view types that participate in stubbing via
 * `wrapSpecialisedStubbable` — stub off-viewport, remount the real view in the
 * real window.
 */
export const SPECIALISED_STUBBABLE_TYPES = [
  'code_block',
  'table',
  'math_block',
] as const;

/** Every top-level type this plugin may replace with a height stub. */
export const STUBBABLE_TYPES = [
  ...DEFAULT_STUBBABLE_TYPES,
  ...SPECIALISED_STUBBABLE_TYPES,
] as const;

export type DefaultStubbableType = (typeof DEFAULT_STUBBABLE_TYPES)[number];
export type SpecialisedStubbableType = (typeof SPECIALISED_STUBBABLE_TYPES)[number];
export type StubbableType = (typeof STUBBABLE_TYPES)[number];

const STUBBABLE = new Set<string>(STUBBABLE_TYPES);
const SPECIALISED_STUBBABLE = new Set<string>(SPECIALISED_STUBBABLE_TYPES);

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
  /**
   * Always empty. Membership remounts are surgical (see syncMembershipRemounts);
   * node decorations on the real window forced an O(doc) `updateChildren` walk
   * on every membership change and dominated remount spikes on huge notes.
   */
  readonly decorations: DecorationSet;
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
    decorations: DecorationSet.empty,
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

/**
 * Where each direct child of a document starts, computed once per document.
 *
 * `doc.resolve(pos)` finds the child at `pos` by walking the children from the
 * first, so it costs time in proportion to how far down the note `pos` is.
 * Every stubbable block asks for its own index as it is built, which made
 * building the view of a long note quadratic: on the 8 MB benchmark document,
 * 43,970 blocks, 3.4 seconds of opening it. A document never changes, so its
 * child offsets can be kept beside it and searched.
 */
const childStarts = new WeakMap<ProseNode, Float64Array>();

function startsOf(doc: ProseNode): Float64Array {
  let starts = childStarts.get(doc);
  if (!starts) {
    const table = new Float64Array(doc.childCount);
    doc.forEach((_child, offset, index) => { table[index] = offset; });
    childStarts.set(doc, table);
    starts = table;
  }
  return starts;
}

/** Top-level child index for a position that points at that child, else null. */
export function topLevelIndexAt(doc: ProseNode, pos: number): number | null {
  if (!Number.isInteger(pos) || pos < 0 || pos > doc.content.size) return null;
  // The end of the document is a top-level position too, after the last child.
  if (pos === doc.content.size) return doc.childCount;
  const starts = startsOf(doc);
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const start = starts[middle]!;
    if (start === pos) return middle;
    if (start < pos) low = middle + 1;
    else high = middle - 1;
  }
  return null;
}

/** Whether `pos` is the start position of a direct child of the document. */
export function isTopLevelPos(doc: ProseNode, pos: number): boolean {
  return topLevelIndexAt(doc, pos) !== null;
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
  // Common keystroke: same top-level count, one block's size changed. Reuse the
  // measured cache and re-estimate only the mismatched indices instead of
  // estimating every block then copying the cache back over.
  if (
    previous.enabled
    && previous.heights.length === oldDoc.childCount
    && oldDoc.childCount === newDoc.childCount
  ) {
    const heights = new Float64Array(previous.heights);
    for (let index = 0; index < newDoc.childCount; index += 1) {
      const before = oldDoc.child(index);
      const after = newDoc.child(index);
      if (before.type !== after.type || before.nodeSize !== after.nodeSize) {
        heights[index] = estimateBlockHeight(after, emPx);
      }
    }
    return heights;
  }

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
    // Filled by plugin apply/init — placeholder keeps the type complete.
    decorations: DecorationSet.empty,
  };
}

/**
 * Nearest scrollport above the editor.
 *
 * Reading *computed* `overflowY` on the ProseMirror mount's direct parent
 * forces layout over every top-level child (happy-dom: ~50ms on huge after a
 * remount; Chromium pays the same class of cost). The mount parent never
 * scrolls in product or tests — skip computed style there. Prefer inline
 * overflow and the known `.canvas-scroll` host, then computed style further up.
 */
export function findScroller(view: EditorView): HTMLElement | null {
  const mountParent = view.dom.parentElement;
  let element: HTMLElement | null = mountParent;
  while (element) {
    if (element === mountParent) {
      const inline = element.style.overflowY;
      if (inline === 'auto' || inline === 'scroll') return element;
    } else if (element.classList.contains('canvas-scroll')) {
      return element;
    } else {
      const inline = element.style.overflowY;
      if (inline === 'auto' || inline === 'scroll') return element;
      const style = getComputedStyle(element);
      if (/(auto|scroll)/.test(style.overflowY)) return element;
    }
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
export function visibleWindowFromScroll(view: EditorView): BlockRange | null {
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
 * Inclusive top-level window covering the scroller plus `bufferScreens`.
 *
 * Used by flagged deferred open enrich when viewport-stub is off (documents
 * below `STUB_MIN_TOP_LEVEL_BLOCKS`). When stubbing is on, prefer the stub
 * plugin's `viewport` range instead — it already includes `STUB_SCREEN_BUFFER`.
 */
export function visibleBlockRangeFromScroll(
  view: EditorView,
  bufferScreens = 1,
): BlockRange | null {
  const scroller = findScroller(view);
  if (!scroller) return null;
  const last = view.state.doc.childCount - 1;
  if (last < 0) return emptyRange();
  const children = view.dom.children;
  if (children.length === 0) return emptyRange();
  const sc = scroller.getBoundingClientRect();
  const buffer = scroller.clientHeight * Math.max(0, bufferScreens);
  return blockWindowForClientY(children, last, sc.top - buffer, sc.bottom + buffer);
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
 * Prefer an extend-then-slide remount over a hard recenter.
 *
 * `viewportFromScroll` returns the ideal visible±buffer window. Taking that
 * wholesale advances the trailing edge by roughly the whole buffer, so one
 * edge-crossing remounts half the real window even though only the leading
 * band is newly needed. Keep the trailing edge, extend the leading edge to
 * the ideal, and only slide the trailing edge once the window would exceed
 * `idealSpan * STUB_WINDOW_SLACK`.
 *
 * Membership rules (viewport OR selection; stubbable types) are unchanged.
 */
export const STUB_WINDOW_SLACK = 1.5;

export function slideViewportWindow(
  current: BlockRange,
  ideal: BlockRange,
  last: number,
): BlockRange {
  const idealSpan = Math.max(0, ideal.to - ideal.from);
  const maxSpan = Math.max(idealSpan, Math.ceil(idealSpan * STUB_WINDOW_SLACK));
  const overlaps = ideal.from <= current.to && ideal.to >= current.from;
  // Disjoint jump (scrollbar drag / big leap) — take the ideal window.
  if (!overlaps) return clampRange(ideal.from, ideal.to, last);
  // Scrolled down: leading edge needs to grow.
  if (ideal.to >= current.to && ideal.from >= current.from) {
    const nextTo = Math.max(current.to, ideal.to);
    let nextFrom = current.from;
    if (nextTo - nextFrom > maxSpan) nextFrom = nextTo - maxSpan;
    return clampRange(nextFrom, nextTo, last);
  }
  // Scrolled up.
  if (ideal.from <= current.from && ideal.to <= current.to) {
    const nextFrom = Math.min(current.from, ideal.from);
    let nextTo = current.to;
    if (nextTo - nextFrom > maxSpan) nextTo = nextFrom + maxSpan;
    return clampRange(nextFrom, nextTo, last);
  }
  // Partial overlap with mixed edges — prefer the ideal recenter.
  return clampRange(ideal.from, ideal.to, last);
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

interface MembershipRemountable {
  readonly stubbed: boolean;
  applyMembership(wantStub: boolean): void;
  dom: HTMLElement;
  contentDOM: HTMLElement | null;
}

class StubbableBlockView implements NodeView, MembershipRemountable {
  dom!: HTMLElement;
  contentDOM!: HTMLElement | null;
  private node: ProseNode;
  private readonly view: EditorView;
  private readonly getPos: () => number | undefined;
  stubbed: boolean;
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

  private resolveIndex(stub: ViewportStubState | undefined): number | null {
    if (!stub?.enabled) return null;
    const pos = this.getPos();
    if (pos == null) return null;
    return topLevelIndexAt(this.view.state.doc, pos);
  }

  private computeStubbed(stub: ViewportStubState | undefined): boolean {
    const index = this.resolveIndex(stub);
    if (index == null || !stub) return false;
    return isIndexStubbed(stub, index, this.node.type.name);
  }

  private heightPx(stub: ViewportStubState | undefined, index: number | null = null): number {
    const resolved = index ?? this.resolveIndex(stub);
    if (stub && resolved != null) {
      const cached = stub.heights[resolved];
      if (cached > 0) return cached;
    }
    return estimateBlockHeight(this.node, hostEmPx(this.view));
  }

  private mountStub(stub: ViewportStubState | undefined): void {
    const index = this.resolveIndex(stub);
    this.dom = createStubElement(this.node.type.name, this.heightPx(stub, index));
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

  /**
   * In-place stub ↔ real for surgical remounts. Reassigns `dom` / `contentDOM`;
   * the plugin view swaps the ViewDesc pointers and fills content when needed.
   */
  applyMembership(wantStub: boolean): void {
    if (wantStub === this.stubbed) return;
    const stub = viewportStubKey.getState(this.view.state);
    if (wantStub) this.mountStub(stub);
    else this.mountReal();
    this.stubbed = wantStub;
    this.generation = stub?.generation ?? this.generation;
  }

  update(node: ProseNode): boolean {
    if (node.type.name !== this.node.type.name) return false;
    const stub = viewportStubKey.getState(this.view.state);
    const wantStub = this.computeStubbed(stub);
    // Safety net when ProseMirror calls update (doc edits). Pure viewport
    // membership changes take the surgical path and never reach here.
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
 * Membership remounts no longer go through node decorations.
 *
 * Decorating the real window forced ProseMirror to run `updateChildren` over
 * every top-level child whenever membership changed (`DecorationsSet.eq` fails
 * → full walk + `renderDescs`). On huge that was ~500ms even for a one-block
 * slide. Stub ↔ real is applied surgically: only enter/leave indices replace
 * their DOM / ViewDesc, so a pure viewport meta update never walks the doc.
 */

interface PmViewDesc {
  parent: PmViewDesc | null | undefined;
  children: PmViewDesc[];
  dom: Node;
  contentDOM: HTMLElement | null;
  nodeDOM: Node;
  node: ProseNode;
  dirty: number;
  destroy: () => void;
  updateChildren: (view: EditorView, pos: number) => void;
  /** Custom NodeView instance when this desc wraps one. */
  spec?: MembershipRemountable;
}

interface MembershipWindows {
  readonly viewport: BlockRange;
  readonly selection: BlockRange;
}

function wasIndexReal(windows: MembershipWindows, index: number): boolean {
  return rangeContains(windows.viewport, index) || rangeContains(windows.selection, index);
}

function collectWindowIndices(windows: MembershipWindows, into: Set<number>): void {
  for (let index = windows.viewport.from; index <= windows.viewport.to; index += 1) {
    into.add(index);
  }
  for (let index = windows.selection.from; index <= windows.selection.to; index += 1) {
    into.add(index);
  }
}

function withDomObserverStopped(view: EditorView, run: () => void): void {
  const observer = (view as unknown as {
    domObserver?: { stop: () => void; start: () => void };
  }).domObserver;
  observer?.stop();
  try {
    run();
  } finally {
    observer?.start();
  }
}

/**
 * Remount a single top-level stubbable block in place.
 *
 * Replaces the NodeView's DOM, updates the owning ViewDesc pointers, and —
 * when becoming real — runs `updateChildren` only on that block's content,
 * never on the document's full child list.
 */
export function remountTopLevelIndex(view: EditorView, index: number): void {
  const doc = view.state.doc;
  if (index < 0 || index >= doc.childCount) return;
  const node = doc.child(index);
  if (!STUBBABLE.has(node.type.name)) return;

  const stub = viewportStubKey.getState(view.state);
  const wantStub = stub ? isIndexStubbed(stub, index, node.type.name) : false;

  const pos = startsOf(doc)[index]!;
  const dom = view.nodeDOM(pos);
  if (!dom) return;
  const desc = (dom as HTMLElement & { pmViewDesc?: PmViewDesc }).pmViewDesc;
  if (!desc?.spec || typeof desc.spec.applyMembership !== 'function') return;
  if (desc.spec.stubbed === wantStub) return;

  const oldDom = desc.dom;
  desc.spec.applyMembership(wantStub);
  const newDom = desc.spec.dom;
  const newContent = desc.spec.contentDOM;

  if (oldDom !== newDom && oldDom.parentNode) {
    oldDom.parentNode.replaceChild(newDom, oldDom);
  }
  // Mirror ViewDesc's own DOM ownership: clear the old node, claim the new one.
  if (oldDom !== newDom) {
    const oldDesc = (oldDom as HTMLElement & { pmViewDesc?: PmViewDesc }).pmViewDesc;
    if (oldDesc === desc) {
      (oldDom as HTMLElement & { pmViewDesc?: PmViewDesc }).pmViewDesc = undefined;
    }
  }
  desc.dom = newDom;
  desc.nodeDOM = newDom;
  desc.contentDOM = newContent;
  (newDom as HTMLElement & { pmViewDesc?: PmViewDesc }).pmViewDesc = desc;

  for (const child of desc.children) child.destroy();
  desc.children = [];
  if (newContent && !node.isLeaf) {
    desc.updateChildren(view, pos + 1);
  }
  desc.dirty = 0;
}

function expandAllStubs(view: EditorView): void {
  const stubEls = Array.from(view.dom.querySelectorAll(`.${STUB_CLASS}`));
  for (const el of stubEls) {
    let pos: number;
    try {
      pos = view.posAtDOM(el, 0);
    } catch {
      continue;
    }
    const index = topLevelIndexAt(view.state.doc, pos);
    if (index != null && index >= 0 && index < view.state.doc.childCount) {
      remountTopLevelIndex(view, index);
    }
  }
}

/**
 * Apply stub ↔ real for indices whose membership changed between `previous`
 * and the current plugin state. Returns the windows to seed the next diff.
 */
function syncMembershipRemounts(
  view: EditorView,
  previous: MembershipWindows | null,
  next: ViewportStubState,
): MembershipWindows | null {
  if (!next.enabled) {
    if (previous) withDomObserverStopped(view, () => expandAllStubs(view));
    return null;
  }

  const nextWindows: MembershipWindows = {
    viewport: next.viewport,
    selection: next.selection,
  };
  if (!previous) return nextWindows;

  const candidates = new Set<number>();
  collectWindowIndices(previous, candidates);
  collectWindowIndices(nextWindows, candidates);

  const toRemount: number[] = [];
  for (const index of candidates) {
    if (wasIndexReal(previous, index) !== isIndexReal(next, index)) {
      toRemount.push(index);
    }
  }
  if (toRemount.length > 0) {
    withDomObserverStopped(view, () => {
      for (const index of toRemount) remountTopLevelIndex(view, index);
    });
  }
  return nextWindows;
}

export function stubbableNodeViews(): Record<string, NodeViewConstructor> {
  const views: Record<string, NodeViewConstructor> = {};
  for (const type of DEFAULT_STUBBABLE_TYPES) {
    views[type] = (node, view, getPos) => new StubbableBlockView(node, view, getPos);
  }
  return views;
}

/**
 * Wrap a specialised NodeView so it participates in viewport stubbing.
 *
 * Off-viewport: a height stub (no inner chrome). Entering the real window
 * returns false from `update` so ProseMirror destroys the stub and constructs
 * the specialised view fresh — Fence/Table/Math remount with their own
 * contentDOM, selection, and focus behaviour intact. Leaving the real window
 * remounts the stub the same way.
 */
export function wrapSpecialisedStubbable(inner: NodeViewConstructor): NodeViewConstructor {
  return (node, view, getPos, decorations, innerDecorations) => (
    new SpecialisedStubbableView(node, view, getPos, inner, decorations, innerDecorations)
  );
}

/**
 * Merge default stubbable views with specialised constructors.
 *
 * Types in `SPECIALISED_STUBBABLE_TYPES` are wrapped so stubbing can stand in
 * for them; other specialised views (images, HTML, inline math) pass through
 * unchanged and stay always-real.
 */
export function mergeStubAwareNodeViews(
  specialised: Record<string, NodeViewConstructor>,
): Record<string, NodeViewConstructor> {
  const views: Record<string, NodeViewConstructor> = {
    ...stubbableNodeViews(),
    ...specialised,
  };
  for (const type of SPECIALISED_STUBBABLE_TYPES) {
    const ctor = specialised[type];
    if (ctor) views[type] = wrapSpecialisedStubbable(ctor);
  }
  return views;
}

class SpecialisedStubbableView implements NodeView, MembershipRemountable {
  dom!: HTMLElement;
  contentDOM!: HTMLElement | null;
  private node: ProseNode;
  private readonly view: EditorView;
  private readonly getPos: () => number | undefined;
  private readonly createInner: NodeViewConstructor;
  private decorations: readonly Decoration[];
  private innerDecorations: DecorationSource;
  private inner: NodeView | null = null;
  stubbed: boolean;

  constructor(
    node: ProseNode,
    view: EditorView,
    getPos: () => number | undefined,
    createInner: NodeViewConstructor,
    decorations: readonly Decoration[],
    innerDecorations: DecorationSource,
  ) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.createInner = createInner;
    this.decorations = decorations;
    this.innerDecorations = innerDecorations;
    const stub = viewportStubKey.getState(view.state);
    this.stubbed = this.computeStubbed(stub);
    if (this.stubbed) this.mountStub(stub);
    else this.mountInner();
  }

  private resolveIndex(stub: ViewportStubState | undefined): number | null {
    if (!stub?.enabled) return null;
    if (!SPECIALISED_STUBBABLE.has(this.node.type.name)) return null;
    const pos = this.getPos();
    if (pos == null) return null;
    return topLevelIndexAt(this.view.state.doc, pos);
  }

  private computeStubbed(stub: ViewportStubState | undefined): boolean {
    const index = this.resolveIndex(stub);
    if (index == null || !stub) return false;
    return isIndexStubbed(stub, index, this.node.type.name);
  }

  private heightPx(stub: ViewportStubState | undefined, index: number | null = null): number {
    const resolved = index ?? this.resolveIndex(stub);
    if (stub && resolved != null) {
      const cached = stub.heights[resolved];
      if (cached > 0) return cached;
    }
    return estimateBlockHeight(this.node, hostEmPx(this.view));
  }

  private mountStub(stub: ViewportStubState | undefined): void {
    this.inner = null;
    const index = this.resolveIndex(stub);
    this.dom = createStubElement(this.node.type.name, this.heightPx(stub, index));
    this.contentDOM = null;
  }

  private mountInner(): void {
    this.inner?.destroy?.();
    const created = this.createInner(
      this.node,
      this.view,
      this.getPos,
      this.decorations,
      this.innerDecorations,
    );
    this.inner = created;
    this.dom = created.dom as HTMLElement;
    this.contentDOM = (created.contentDOM as HTMLElement | null | undefined) ?? null;
  }

  applyMembership(wantStub: boolean): void {
    if (wantStub === this.stubbed) return;
    const stub = viewportStubKey.getState(this.view.state);
    if (wantStub) {
      this.inner?.destroy?.();
      this.mountStub(stub);
    } else {
      this.mountInner();
    }
    this.stubbed = wantStub;
  }

  update(
    node: ProseNode,
    decorations: readonly Decoration[],
    innerDecorations: DecorationSource,
  ): boolean {
    if (node.type.name !== this.node.type.name) return false;
    this.decorations = decorations;
    this.innerDecorations = innerDecorations;
    const stub = viewportStubKey.getState(this.view.state);
    const wantStub = this.computeStubbed(stub);
    // Safety net for doc-edit updates; viewport membership uses surgical remount.
    if (wantStub !== this.stubbed) return false;
    if (this.stubbed) {
      this.node = node;
      this.dom.style.height = `${this.heightPx(stub)}px`;
      return true;
    }
    this.node = node;
    if (this.inner?.update) return this.inner.update(node, decorations, innerDecorations);
    return true;
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    if (this.stubbed) return true;
    return this.inner?.ignoreMutation?.(mutation) ?? false;
  }

  stopEvent(event: Event): boolean {
    if (this.stubbed) return false;
    return this.inner?.stopEvent?.(event) ?? false;
  }

  selectNode(): void {
    this.inner?.selectNode?.();
  }

  deselectNode(): void {
    this.inner?.deselectNode?.();
  }

  setSelection(anchor: number, head: number, root: Document | ShadowRoot): void {
    this.inner?.setSelection?.(anchor, head, root);
  }

  destroy(): void {
    this.inner?.destroy?.();
    this.inner = null;
  }
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
        // decorations stay empty — membership remounts are surgical in view().
        return buildState(newState, draft, viewport, STUB_FALLBACK_EM_PX);
      },
    },
    props: {
      decorations: (editorState) => {
        const stub = viewportStubKey.getState(editorState);
        return stub?.decorations ?? DecorationSet.empty;
      },
    },
    view: (editorView) => {
      let attached: HTMLElement | null = null;
      let frame = 0;
      let resyncFrame = 0;
      let lastMeasuredGeneration = -1;
      /** Caps measure→viewport feedback so remount height fixes can chase once. */
      let resyncBudget = 0;
      /** Last windows whose stub↔real DOM we synced — for enter/leave diffing. */
      let syncedWindows: MembershipWindows | null = null;

      const dispatchViewport = (viewport: BlockRange) => {
        const current = viewportStubKey.getState(editorView.state);
        if (!current?.enabled) return;
        if (rangesEqual(current.viewport, viewport)) return;
        const transaction: Transaction = editorView.state.tr.setMeta(viewportStubKey, { viewport });
        editorView.dispatch(transaction);
      };

      let measureFrame = 0;
      const scheduleDeferredMeasure = (budget: number) => {
        if (measureFrame) return;
        measureFrame = requestAnimationFrame(() => {
          measureFrame = 0;
          const current = viewportStubKey.getState(editorView.state);
          if (!current?.enabled) return;
          const heightsChanged = measureRealHeights(editorView, current);
          publishDataset(editorView, current);
          if (heightsChanged && budget > 0 && resyncBudget > 0) {
            resyncBudget -= 1;
            scheduleViewportFromScroll();
          }
        });
      };

      const scheduleViewportFromScroll = () => {
        if (resyncFrame) return;
        resyncFrame = requestAnimationFrame(() => {
          resyncFrame = 0;
          const current = viewportStubKey.getState(editorView.state);
          if (!current?.enabled) return;
          // Height fixes after a remount must not bypass hysteresis — doing so
          // recentered the window on the next frame and left the visible band
          // against an edge, so the next large-step scroll remounted again.
          const visible = visibleWindowFromScroll(editorView);
          if (visible && !viewportNeedsRemount(current.viewport, visible)) return;
          const ideal = viewportFromScroll(editorView, current.heights);
          if (!ideal) return;
          const next = slideViewportWindow(current.viewport, ideal, editorView.state.doc.childCount - 1);
          dispatchViewport(next);
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
          const ideal = viewportFromScroll(editorView, current.heights);
          if (!ideal) return;
          const next = slideViewportWindow(
            current.viewport,
            ideal,
            editorView.state.doc.childCount - 1,
          );
          dispatchViewport(next);
        });
      };

      const ensureScroll = () => {
        // Re-resolve only when the cached scroller is gone. findScroller is
        // cheap for inline/class hits, but every membership dispatch used to
        // re-enter it and — before the mount-parent skip — force layout over
        // the whole top-level child list.
        if (attached && attached.isConnected && attached.contains(editorView.dom)) return;
        const scroller = findScroller(editorView);
        if (scroller === attached) return;
        attached?.removeEventListener('scroll', onScroll);
        attached = scroller;
        attached?.addEventListener('scroll', onScroll, { passive: true });
      };

      ensureScroll();
      const initial = viewportStubKey.getState(editorView.state);
      if (initial?.enabled) {
        // Seed before the first scroll dispatch so sync can diff construction
        // windows against the measured viewport without an O(doc) deco walk.
        syncedWindows = { viewport: initial.viewport, selection: initial.selection };
        resyncBudget = 6;
        const next = viewportFromScroll(editorView, initial.heights);
        if (next) dispatchViewport(next);
        const after = viewportStubKey.getState(editorView.state) ?? initial;
        syncedWindows = syncMembershipRemounts(editorView, syncedWindows, after);
        publishDataset(editorView, after);
      }

      return {
        update: (view) => {
          ensureScroll();
          const stub = viewportStubKey.getState(view.state);
          if (!stub?.enabled) {
            lastMeasuredGeneration = -1;
            syncedWindows = syncMembershipRemounts(view, syncedWindows, stub ?? disabledState());
            publishDataset(view, stub ?? disabledState());
            return;
          }
          // Surgical stub↔real for enter/leave before measure/dataset work.
          syncedWindows = syncMembershipRemounts(view, syncedWindows, stub);
          // Measuring every transaction forced layout across the whole real
          // window on each keystroke. Remounts (generation bumps) are what
          // need fresh stub sizes; typing into an already-real block can wait.
          // Defer the measure one frame so the scroll remount's own layout
          // paint is not compounded by offsetHeight across the real window.
          const generationChanged = stub.generation !== lastMeasuredGeneration;
          if (generationChanged) {
            lastMeasuredGeneration = stub.generation;
            publishDataset(view, stub);
            if (resyncBudget > 0) {
              const budgeted = resyncBudget;
              scheduleDeferredMeasure(budgeted);
            }
            return;
          }
          publishDataset(view, stub);
        },
        destroy: () => {
          attached?.removeEventListener('scroll', onScroll);
          attached = null;
          if (frame) cancelAnimationFrame(frame);
          frame = 0;
          if (resyncFrame) cancelAnimationFrame(resyncFrame);
          resyncFrame = 0;
          if (measureFrame) cancelAnimationFrame(measureFrame);
          measureFrame = 0;
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

/**
 * Sparse docView: range spacers for off-window top-level runs.
 *
 * Per-block stubs (#303–#310) still left O(blocks) ViewDescs on open. This
 * module patches the document NodeViewDesc.updateChildren so that, when
 * viewport stubbing is enabled, far-off runs collapse to one tall spacer
 * ViewDesc whose `size` equals the covered nodeSize sum. Real window and
 * selection neighbourhood keep ordinary NodeViewDescs.
 *
 * See docs/performance/spacer-virtualization.md (phase 1).
 */

import { Schema } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { DecorationSet, EditorView, type DecorationSource } from 'prosemirror-view';
import type { Node as ProseNode } from 'prosemirror-model';

import {
  STUB_CLASS,
  blockWindowForY,
  cumulativeHeights,
  isIndexStubbed,
  viewportStubKey,
  type BlockRange,
  type ViewportStubState,
} from './viewport-stub';

/** Class on a multi-block height spacer (also carries STUB_CLASS). */
export const RANGE_SPACER_CLASS = 'noto-range-spacer';

/** Marker on a spacer ViewDesc — not a NodeViewDesc (`node` stays undefined). */
const SPACER_BRAND = '__notoRangeSpacer';

export interface RangeSpacerDesc {
  readonly [SPACER_BRAND]: true;
  parent: unknown;
  children: unknown[];
  dom: HTMLElement;
  contentDOM: null;
  dirty: number;
  /** Inclusive top-level index range covered by this spacer. */
  indexFrom: number;
  indexTo: number;
  /** Sum of `nodeSize` over the covered range — ViewDesc.size override. */
  readonly size: number;
  destroy: () => void;
  parseRule: () => { ignore: true };
  localPosFromDOM: (dom: Node, offset: number, bias: number) => number;
  domFromPos: (pos: number, side?: number) => { node: Node; offset: number; atom?: number };
  ignoreMutation: () => boolean;
  matchesWidget: () => boolean;
  matchesMark: () => boolean;
  matchesNode: () => boolean;
  matchesHack: () => boolean;
  stopEvent: () => boolean;
  domAtom: boolean;
  border: number;
}

type AnyDesc = {
  parent: unknown;
  children: AnyDesc[];
  dom: Node;
  contentDOM: HTMLElement | null;
  node?: ProseNode;
  nodeDOM?: Node;
  dirty: number;
  size: number;
  border: number;
  destroy: () => void;
  updateChildren?: (view: EditorView, pos: number) => void;
  update?: (
    node: ProseNode,
    outerDeco: unknown[],
    innerDeco: DecorationSource,
    view: EditorView,
  ) => boolean;
  matchesNode?: (
    node: ProseNode,
    outerDeco: unknown[],
    innerDeco: DecorationSource,
  ) => boolean;
  parseRule?: () => { ignore: true } | null;
  ignoreMutation?: (mutation?: unknown) => boolean;
  matchesWidget?: () => boolean;
  matchesMark?: () => boolean;
  matchesHack?: () => boolean;
  stopEvent?: () => boolean;
  localPosFromDOM?: (dom: Node, offset: number, bias: number) => number;
  domFromPos?: (pos: number, side?: number) => { node: Node; offset: number; atom?: number };
  spec?: unknown;
  [SPACER_BRAND]?: true;
  indexFrom?: number;
  indexTo?: number;
};

type NodeViewDescCtor = {
  new (...args: never[]): AnyDesc;
  create: (
    parent: AnyDesc,
    node: ProseNode,
    outerDeco: unknown[],
    innerDeco: DecorationSource,
    view: EditorView,
    pos: number,
  ) => AnyDesc;
  prototype: {
    updateChildren: (this: AnyDesc, view: EditorView, pos: number) => void;
    matchesNode: (
      this: AnyDesc,
      node: ProseNode,
      outerDeco: unknown[],
      innerDeco: DecorationSource,
    ) => boolean;
  };
};

type ViewDescCtor = {
  new (parent: AnyDesc | undefined, children: AnyDesc[], dom: Node, contentDOM: HTMLElement | null): AnyDesc;
  prototype: object;
};

interface PmInternals {
  NodeViewDesc: NodeViewDescCtor;
  ViewDesc: ViewDescCtor;
  originalUpdateChildren: (this: AnyDesc, view: EditorView, pos: number) => void;
  originalMatchesNode: (
    this: AnyDesc,
    node: ProseNode,
    outerDeco: unknown[],
    innerDeco: DecorationSource,
  ) => boolean;
}

let internals: PmInternals | null = null;
let installAttempted = false;

/** Last stub generation whose sparse children match the live docView. */
const syncedGeneration = new WeakMap<EditorView, number>();

export function isRangeSpacer(desc: unknown): desc is RangeSpacerDesc {
  return !!desc && typeof desc === 'object' && (desc as RangeSpacerDesc)[SPACER_BRAND] === true;
}

/**
 * Capture ViewDesc / NodeViewDesc and patch document-level updateChildren.
 *
 * Must run before the first stubbing-enabled EditorView is constructed.
 * Safe to call repeatedly; no-ops after the first successful install.
 */
export function ensureSparseDocViewInstalled(): void {
  if (internals || installAttempted) return;
  installAttempted = true;
  if (typeof document === 'undefined') return;

  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: {
        group: 'block',
        content: 'text*',
        toDOM: () => ['p', 0],
        parseDOM: [{ tag: 'p' }],
      },
      text: { group: 'inline' },
    },
  });
  const warmDoc = schema.node('doc', null, [
    schema.node('paragraph', null, schema.text('warm')),
  ]);
  const mount = document.createElement('div');
  // Detached mount — warm-up must not touch the product DOM.
  const warmView = new EditorView(mount, {
    state: EditorState.create({ doc: warmDoc }),
  });
  try {
    const docView = (warmView as unknown as { docView: AnyDesc }).docView;
    const NodeViewDesc = Object.getPrototypeOf(docView).constructor as NodeViewDescCtor;
    const ViewDesc = Object.getPrototypeOf(NodeViewDesc.prototype).constructor as ViewDescCtor;
    const originalUpdateChildren = NodeViewDesc.prototype.updateChildren;
    const originalMatchesNode = NodeViewDesc.prototype.matchesNode;

    NodeViewDesc.prototype.updateChildren = function patchedUpdateChildren(
      this: AnyDesc,
      view: EditorView,
      pos: number,
    ): void {
      // Only the document desc has no parent. Nested blocks keep stock PM.
      if (this.parent) {
        originalUpdateChildren.call(this, view, pos);
        return;
      }
      const stub = viewportStubKey.getState(view.state);
      if (!stub?.enabled) {
        syncedGeneration.delete(view);
        originalUpdateChildren.call(this, view, pos);
        return;
      }
      rebuildSparseChildren(this, view, stub, NodeViewDesc, ViewDesc);
    };

    // Force docView.update when membership generation advances so sparse
    // rebuild runs before selectionToDOM (plugin view() is too late).
    NodeViewDesc.prototype.matchesNode = function patchedMatchesNode(
      this: AnyDesc,
      node: ProseNode,
      outerDeco: unknown[],
      innerDeco: DecorationSource,
    ): boolean {
      if (!this.parent) {
        // Document desc — check whether some EditorView owns us.
        const owner = findOwnerView(this);
        if (owner) {
          const stub = viewportStubKey.getState(owner.state);
          if (stub?.enabled && syncedGeneration.get(owner) !== stub.generation) {
            return false;
          }
        }
      }
      return originalMatchesNode.call(this, node, outerDeco, innerDeco);
    };

    internals = { NodeViewDesc, ViewDesc, originalUpdateChildren, originalMatchesNode };
  } finally {
    warmView.destroy();
  }
}

/** Reverse lookup: docView → EditorView via contentDOM.pmViewDesc ownership. */
const ownerByDocView = new WeakMap<AnyDesc, EditorView>();

function findOwnerView(docView: AnyDesc): EditorView | null {
  return ownerByDocView.get(docView) ?? null;
}

function rememberOwner(docView: AnyDesc, view: EditorView): void {
  ownerByDocView.set(docView, view);
}

function spacerHeight(heights: Float64Array, from: number, to: number): number {
  let sum = 0;
  for (let index = from; index <= to; index += 1) {
    sum += heights[index] ?? 0;
  }
  return Math.max(sum, 1);
}

function spacerSize(doc: ProseNode, from: number, to: number): number {
  let size = 0;
  for (let index = from; index <= to; index += 1) {
    size += doc.child(index).nodeSize;
  }
  return size;
}

function createRangeSpacer(
  ViewDesc: ViewDescCtor,
  parent: AnyDesc,
  doc: ProseNode,
  heights: Float64Array,
  from: number,
  to: number,
  starts: Float64Array,
): AnyDesc {
  const size = spacerSize(doc, from, to);
  const height = spacerHeight(heights, from, to);
  const dom = document.createElement('div');
  dom.className = `${STUB_CLASS} ${RANGE_SPACER_CLASS}`;
  dom.dataset.stubRange = `${from}-${to}`;
  dom.contentEditable = 'false';
  dom.style.height = `${height}px`;
  dom.style.margin = '0';
  // Avoid paint work inside the tall placeholder.
  dom.style.contain = 'strict';
  dom.style.overflow = 'hidden';

  const spacer = new ViewDesc(parent, [], dom, null);
  (spacer as AnyDesc)[SPACER_BRAND] = true;
  (spacer as AnyDesc).indexFrom = from;
  (spacer as AnyDesc).indexTo = to;

  Object.defineProperty(spacer, 'size', {
    configurable: true,
    enumerable: true,
    get: () => size,
  });
  Object.defineProperty(spacer, 'border', {
    configurable: true,
    get: () => 0,
  });
  Object.defineProperty(spacer, 'domAtom', {
    configurable: true,
    get: () => true,
  });

  spacer.parseRule = () => ({ ignore: true });
  spacer.ignoreMutation = () => true;
  spacer.matchesWidget = () => false;
  spacer.matchesMark = () => false;
  spacer.matchesNode = () => false;
  spacer.matchesHack = () => false;
  spacer.stopEvent = () => false;

  // Map a click on the spacer to the estimated block start via height cache.
  spacer.localPosFromDOM = (_dom: Node, _offset: number, bias: number) => {
    const box = dom.getBoundingClientRect();
    // Without an event Y, bias toward start (bias<0) or end of the range.
    if (bias < 0) return starts[from]!;
    if (bias > 0) return starts[to]! + doc.child(to).nodeSize - 1;
    // Mid: first block of the range (selection neighbourhood remounts it).
    return starts[from]!;
  };

  // Override after the fact when we have clientY from posAtCoords — see
  // `posInsideSpacer`. Default domFromPos: treat as atom at start of range.
  spacer.domFromPos = (_pos: number) => ({
    node: dom,
    offset: 0,
    atom: starts[from]! + 1,
  });

  return spacer;
}

/**
 * Reposition `localPosFromDOM` using a client Y when available. Called from
 * the click path via posAtCoords wrapping is optional; the default bias is
 * enough for selection neighbourhood remount.
 */
export function refineSpacerPosForClientY(
  desc: RangeSpacerDesc,
  doc: ProseNode,
  heights: Float64Array,
  starts: Float64Array,
  clientY: number,
): number {
  const box = desc.dom.getBoundingClientRect();
  const localY = Math.max(0, clientY - box.top);
  const slice = heights.subarray(desc.indexFrom, desc.indexTo + 1);
  const cumulative = cumulativeHeights(slice);
  const window = blockWindowForY(cumulative, localY, localY + 1);
  const index = Math.min(desc.indexTo, desc.indexFrom + window.from);
  return starts[index]!;
}


function collectReusable(
  previous: AnyDesc[],
): { byIndex: Map<number, AnyDesc>; spacers: AnyDesc[] } {
  const byIndex = new Map<number, AnyDesc>();
  const spacers: AnyDesc[] = [];
  let index = 0;
  for (const child of previous) {
    if (isRangeSpacer(child)) {
      spacers.push(child);
      index = (child.indexTo ?? index) + 1;
      continue;
    }
    if (child.node) {
      byIndex.set(index, child);
      index += 1;
    }
  }
  return { byIndex, spacers };
}

function mustMountIndividual(
  stub: ViewportStubState,
  index: number,
  typeName: string,
): boolean {
  // Always-real types and everything inside a real window stay individual.
  return !isIndexStubbed(stub, index, typeName);
}

function renderChildren(parentDOM: HTMLElement, descs: AnyDesc[]): void {
  // Open path: parent is empty — bulk append.
  if (!parentDOM.firstChild) {
    const fragment = document.createDocumentFragment();
    for (const desc of descs) fragment.appendChild(desc.dom);
    parentDOM.appendChild(fragment);
    return;
  }
  // Sync path (same spirit as PM renderDescs, without MarkView nesting).
  let cursor: ChildNode | null = parentDOM.firstChild;
  for (const desc of descs) {
    const childDOM = desc.dom;
    if (childDOM.parentNode === parentDOM) {
      while (cursor && cursor !== childDOM) {
        const remove: ChildNode = cursor;
        cursor = cursor.nextSibling;
        parentDOM.removeChild(remove);
      }
      cursor = childDOM.nextSibling;
    } else {
      parentDOM.insertBefore(childDOM, cursor);
    }
  }
  while (cursor) {
    const remove: ChildNode = cursor;
    cursor = cursor.nextSibling;
    parentDOM.removeChild(remove);
  }
}

function rebuildSparseChildren(
  docView: AnyDesc,
  view: EditorView,
  stub: ViewportStubState,
  NodeViewDesc: NodeViewDescCtor,
  ViewDesc: ViewDescCtor,
): void {
  rememberOwner(docView, view);
  const doc = view.state.doc;
  const childCount = doc.childCount;
  const emptyDeco: DecorationSource = DecorationSet.empty;
  const outerDeco: unknown[] = [];

  // Starts for spacer click mapping / create pos.
  const starts = new Float64Array(childCount);
  let cursor = 0;
  for (let index = 0; index < childCount; index += 1) {
    starts[index] = cursor;
    cursor += doc.child(index).nodeSize;
  }

  const { byIndex, spacers: prevSpacers } = collectReusable(docView.children as AnyDesc[]);
  const reused = new Set<AnyDesc>();
  const next: AnyDesc[] = [];

  let index = 0;
  let pos = 0;
  while (index < childCount) {
    const typeName = doc.child(index).type.name;
    if (mustMountIndividual(stub, index, typeName)) {
      const node = doc.child(index);
      const existing = byIndex.get(index);
      let desc: AnyDesc | null = null;
      if (existing) {
        if (existing.matchesNode?.(node, outerDeco, emptyDeco)) {
          desc = existing;
        } else if (existing.update?.(node, outerDeco, emptyDeco, view)) {
          desc = existing;
        }
      }
      if (!desc) {
        desc = NodeViewDesc.create(docView, node, outerDeco, emptyDeco, view, pos);
        if (desc.contentDOM && desc.updateChildren) {
          desc.updateChildren(view, pos + 1);
        }
      } else if (desc.contentDOM && desc.dirty && desc.updateChildren) {
        desc.updateChildren(view, pos + 1);
        desc.dirty = 0;
      }
      reused.add(existing ?? desc);
      next.push(desc);
      byIndex.delete(index);
      pos += node.nodeSize;
      index += 1;
      continue;
    }

    // Contiguous stubbed run → one spacer.
    const from = index;
    while (
      index < childCount
      && isIndexStubbed(stub, index, doc.child(index).type.name)
    ) {
      index += 1;
    }
    const to = index - 1;
    if (from > to) continue;

    const size = spacerSize(doc, from, to);
    const height = spacerHeight(stub.heights, from, to);
    let spacer = prevSpacers.find(
      (candidate) =>
        !reused.has(candidate)
        && candidate.indexFrom === from
        && candidate.indexTo === to
        && candidate.size === size,
    );
    if (spacer) {
      const el = spacer.dom as HTMLElement;
      if (el.style.height !== `${height}px`) el.style.height = `${height}px`;
      reused.add(spacer);
    } else {
      spacer = createRangeSpacer(ViewDesc, docView, doc, stub.heights, from, to, starts);
    }
    next.push(spacer);
    for (let walked = from; walked <= to; walked += 1) {
      pos += doc.child(walked).nodeSize;
    }
  }

  // Destroy leftovers (replaced reals / old spacers).
  for (const leftover of byIndex.values()) {
    if (!reused.has(leftover)) leftover.destroy();
  }
  for (const spacer of prevSpacers) {
    if (!reused.has(spacer)) spacer.destroy();
  }
  // Drop parent links on discarded children still listed on docView.
  for (const child of docView.children as AnyDesc[]) {
    if (!next.includes(child) && !reused.has(child)) {
      // destroy already called for map leftovers; ensure parent cleared
      child.parent = undefined;
    }
  }

  docView.children = next;
  if (docView.contentDOM) renderChildren(docView.contentDOM, next);
  docView.dirty = 0;
  syncedGeneration.set(view, stub.generation);
}

/**
 * Top-level desc covering `index` under a sparse docView.
 * Returns a real NodeViewDesc or the RangeSpacer that contains the index.
 */
export function sparseTopLevelDescAt(view: EditorView, index: number): AnyDesc | null {
  const docView = (view as unknown as { docView?: AnyDesc }).docView;
  if (!docView || index < 0) return null;
  const childCount = view.state.doc.childCount;
  if (index >= childCount) return null;

  let cursor = 0;
  for (const child of docView.children as AnyDesc[]) {
    if (isRangeSpacer(child)) {
      if (index >= child.indexFrom && index <= child.indexTo) return child as AnyDesc;
      cursor = child.indexTo + 1;
      continue;
    }
    if (child.node) {
      if (cursor === index) return child;
      cursor += 1;
    }
  }
  return null;
}

/**
 * Inclusive block window intersecting `[y0, y1)` using sparse DOM geometry:
 * live boxes for real children, height-cache within spacers.
 */
export function sparseBlockWindowForClientY(
  view: EditorView,
  heights: Float64Array,
  y0: number,
  y1: number,
): BlockRange {
  const docView = (view as unknown as { docView?: AnyDesc }).docView;
  const last = view.state.doc.childCount - 1;
  if (!docView || last < 0) return { from: 0, to: 0 };

  let from = last;
  let to = 0;
  let hit = false;

  for (const child of docView.children as AnyDesc[]) {
    if (!(child.dom instanceof HTMLElement)) continue;
    const box = child.dom.getBoundingClientRect();
    if (box.bottom <= y0 || box.top >= y1) continue;

    if (isRangeSpacer(child)) {
      const localY0 = Math.max(0, y0 - box.top);
      const localY1 = Math.min(box.height, Math.max(localY0 + 1, y1 - box.top));
      const slice = heights.subarray(child.indexFrom, child.indexTo + 1);
      const cumulative = cumulativeHeights(slice);
      const sub = blockWindowForY(cumulative, localY0, localY1);
      const subFrom = child.indexFrom + sub.from;
      const subTo = child.indexFrom + sub.to;
      from = Math.min(from, subFrom);
      to = Math.max(to, subTo);
      hit = true;
    } else if (child.node) {
      // Find index of this real desc.
      let index = 0;
      for (const sibling of docView.children as AnyDesc[]) {
        if (sibling === child) break;
        if (isRangeSpacer(sibling)) index = sibling.indexTo + 1;
        else if (sibling.node) index += 1;
      }
      from = Math.min(from, index);
      to = Math.max(to, index);
      hit = true;
    }
  }

  if (!hit) {
    // Fallback: everything above → last, everything below → 0 (same as empty).
    return { from: 0, to: Math.min(0, last) };
  }
  return {
    from: Math.max(0, Math.min(from, last)),
    to: Math.max(0, Math.min(to, last)),
  };
}



/**
 * Count DOM children under the ProseMirror root that are block shells or spacers
 * (excludes trailing hacks / widgets without our classes when possible).
 */
export function countSparseDomChildren(view: EditorView): number {
  return view.dom.childElementCount;
}

/**
 * Rebuild the document ViewDesc with stock ProseMirror `updateChildren`.
 * Used when stubbing turns off so range spacers do not linger.
 */
export function forceStockDocRebuild(view: EditorView): void {
  if (!internals) return;
  const docView = (view as unknown as { docView?: AnyDesc }).docView;
  if (!docView) return;
  syncedGeneration.delete(view);
  // Call the original implementation directly (bypass the sparse patch).
  internals.originalUpdateChildren.call(docView, view, 0);
}


// Touch STUB_FALLBACK_EM_PX so the import stays used if heights are empty.

# Spacer / virtualization (open-path elephant)

Status: **design only** (2026-10-02). No product code in this cut.
Remount ladder (#303–#310) and save splices (#311–#313) are done. What remains
of EditorView open on `huge` is building one stub DOM node and one ViewDesc per
top-level block (~44k). This note is the architecture for collapsing that to
O(real window).

## Residual (why this exists)

Happy-dom EditorView open on this Linux agent (post-#313, wrapped specialised
stubbing, `PROFILE_SPECIALISED_STUB=1`):

| corpus | blocks | view open (wrapped) |
| ------ | -----: | ------------------: |
| large  | 10,982 | ~0.7 s (quiet ~0.4 s) |
| huge   | 43,970 | ~4.4 s (quiet ~3.5 s) |

Microbench of the DOM piece alone (happy-dom, same box):

| work | n=10,982 | n=43,970 |
| ---- | -------: | -------: |
| `cloneNode` + `append` stub shells | ~240 ms | ~600 ms |
| comment node + minimal desc each | ~43 ms | ~145 ms |
| two height spacers only | <1 ms | <1 ms |
| ~80 real shells + two spacers | ~5 ms | ~4 ms |

So the floor is not "make stubs cheaper again". Per-block stubs are already
typed prototypes, in-place remount, no membership decorations, no observer
tear-down. The remaining cost is **cardinality**: ProseMirror's
`docView.updateChildren` creates one child ViewDesc and one DOM node per
top-level doc child. Until that list is sparse, open stays O(blocks).

Packaged open still has parse / IPC before the view; this design only attacks
the view-construction elephant (~1.7–2.2 s of the earlier packaged residual on
`huge`, same shape as the happy-dom view numbers above).

## What we already have (reuse, do not rebuild)

`viewport-stub.ts` already owns the hard policy:

- Enable at `STUB_MIN_TOP_LEVEL_BLOCKS` (3000).
- Real membership = viewport window **OR** selection neighbourhood (never the
  contiguous span between them).
- Height cache (`Float64Array`) + estimates + measure-on-real.
- Surgical enter/leave remount (`remountTopLevelIndex`, `syncMembershipRemounts`).
- Typed stub shells and specialised host reuse (Fence/Table/Math).
- Live DOM geometry for the visible band (`blockWindowForClientY`) because a
  pure estimate map drifted when always-real blocks / rhythm disagreed.

Virtualization replaces **how far-off blocks are represented in the view**, not
those rules. Membership, hysteresis (`viewportNeedsRemount` /
`slideViewportWindow`), and specialised remount semantics stay.

## Target shape

While stubbing is enabled, `docView.children` is a **sparse** list:

```
[ RangeSpacer(0 .. V.from-1),
  real NodeViewDesc*,          // viewport band
  RangeSpacer(...),            // gap if selection is disjoint
  real NodeViewDesc*,          // selection band (if disjoint)
  RangeSpacer(V.to+1 .. n-1) ]
```

Each `RangeSpacer`:

- One DOM node: `div.noto-range-spacer` (or reuse `STUB_CLASS` with
  `data-stub-range="from-to"`), `height = sum(heights[from..to])`.
- One ViewDesc whose `size` equals the sum of `nodeSize` over that index range
  (not a single doc child).
- No per-block NodeView, no per-block stub element.

DOM child count ≈ real blocks in the two windows + number of spacer runs
(typically 1–3), not `doc.childCount`.

On the huge corpus, always-real top-level HTML/image count is **zero**, so
phase 1 may assume stubbable-only off-window content. Always-real holes inside
a stub run (punch a real NodeView and split the spacer) are phase 2.

## Why not the tempting shortcuts

| Shortcut | Why it fails |
| -------- | ------------ |
| Cheaper per-stub DOM (comments, fragments) | Still O(n) ViewDescs + append; comments ~145 ms on huge, fragments were *slower* in happy-dom. |
| Collapse after mount | Open already paid O(n) construction; post-pass helps memory, not open. |
| Windowed ProseMirror doc | Breaks identities, undo, save units, outline positions — different product. |
| Hide stubs with CSS / `content-visibility` | Nodes still constructed; open unchanged. Paint deferral already did the CSS half. |
| One shared stub element reused as `dom` | `appendChild` moves the node; previous ViewDescs lose their DOM. |

The only design that removes the open floor is a sparse `docView` child list
with multi-node spacer descs.

## Integration point

ProseMirror does not export a sparse-doc API. `NodeViewDesc.updateChildren`
always walks every doc child (`iterDeco` → `addNode` / `updateNextNode`).

Noto already mutates ViewDesc pointers for surgical remount. The virtualization
cut extends that ownership to the **document** level:

1. Install a patch on the document `NodeViewDesc.updateChildren` (obtained once
   from `view.docView`'s prototype, same style as today's `docView` casts).
2. When `viewportStubKey` is disabled → call the original implementation
   (medium notes unchanged).
3. When enabled → `rebuildSparseChildren(view)` (or a surgical spacer
   split/merge on pure membership transactions).

Patch install must run **before** the first full-doc `updateChildren`. Plugin
`view()` is too late (EditorView constructs `docView` first). Install from
`viewportStubPlugin()` / `mergeStubAwareNodeViews()` at module init, or from a
tiny warm-up view used only to capture the prototype — whichever keeps the
patch local to the stub layer and reversible when stubbing disables mid-session.

Initial state already knows the selection neighbourhood and an estimated
viewport (`buildState` pad). First sparse build can use that without waiting
for scroll measure; the existing `view()` path then slides the window once
geometry is live.

## Position mapping and input

A spacer covers many doc positions with one element. Required behaviour:

- **`coordsAtPos` / `posAtCoords`**: map through cumulative heights inside the
  spacer (binary search on the height cache), bias to block boundaries.
  Clicking a spacer moves the selection into that estimated block → selection
  neighbourhood remounts it real (existing OR rule).
- **Keyboard / IME**: caret never sits *inside* a spacer's phantom content;
  entering a stubbed index remounts before edit (same as today's "selection
  forces real").
- **`topLevelDescAt` / surgical remount**: index → either a real NodeViewDesc
  or a spacer that contains the index (split on enter, merge on leave).
- **Drawers that assume `view.dom.children[i] === block i`** must stop.
  `viewportFromScroll` / `blockWindowForClientY` today index children by block.
  With spacers, visible-band detection becomes:
  - live geometry over **real** DOM children, plus
  - height-cache y for spacer ranges,
  or a single walk of sparse descs with each desc knowing its index span.
  This is the main correctness rewrite beside remount.

## Membership remount under spacers

Replace "flip stub ↔ real on an existing per-block NodeView" with:

- **Enter index `i`**: find spacer containing `i`; split into
  `spacer(left) + NodeView(i) + spacer(right)` (drop empty spacers); run the
  existing real mount path for that one block (`updateChildren` only on that
  block's content).
- **Leave index `i`**: destroy the NodeViewDesc; merge with neighbouring
  spacers into one run; set combined height from the cache.

Slide +1 and mid-band remount keep the same enter/leave diff
(`syncMembershipRemounts`); only the per-index primitive changes. Same-window
dispatch stays free.

Doc edits (`docChanged`):

- Prefer rebuilding sparse children from membership + new height remap
  (`remappedHeights` already exists).
- Reuse real NodeViewDescs whose node still `matchesNode` when possible
  (same spirit as PM's updater), so typing in the real band does not rebuild
  the band.

## Phased delivery

### Phase 0 — this document

Design + measured residual. No behaviour change.

### Phase 1 — sparse open (first code PR)

Goal: happy-dom EditorView open on `huge` drops by ≥2× with correctness for:

- open at caret start / mid (selection pad);
- scroll slide + remount mid;
- type in a remounted paragraph and fence;
- stubbing off below threshold.

Scope:

- `RangeSpacer` desc + DOM;
- patched doc `updateChildren` sparse rebuild;
- enter/leave split-merge;
- geometry walk that does not assume `children[i] === block i`;
- unit tests extending `viewport-stub-specialised.test.ts` (childCount ≪
  doc.childCount; remount; caret edit);
- profile hook asserting DOM child count and open ms.

Out of scope for phase 1: always-real holes, collaborative cursors, drag-drop
across spacers, print/export DOM (export already serializes from the doc).

### Phase 2 — holes and drift

- Split spacers around always-real HTML/image (and any future always-real).
- Re-measure height drift on packaged macOS; tighten estimates if spacers
  expose map error that live-per-block geometry had hidden.

### Phase 3 — only if measured

- Idle prefetch of near-edge blocks beyond `STUB_SCREEN_BUFFER`.
- Spacer element pooling.

## Correctness invariants (tests must lock)

1. With stubbing on, `view.dom.querySelectorAll('.noto-block-stub, .noto-range-spacer').length`
   is O(windows), not O(doc) — exact bound: ≤ realCount + spacerRuns.
2. `view.dom.scrollHeight` (or scroller scrollHeight) matches
   `sum(heights)` within the same tolerance today's stubs already accept.
3. `posAtCoords` / `coordsAtPos` round-trip for positions in the real band;
   for positions in a spacer, land on that block's start (or remounted real).
4. Selection neighbourhood blocks are never inside a spacer.
5. Medium docs (`childCount < 3000`) take the unpatched PM path (no spacers).
6. Specialised fence/table/math still remount in place via host reuse when
   entering from a spacer (spacer yields a fresh typed shell, then host mount).

## Risks

- **Patching `updateChildren`** couples us to `prosemirror-view` internals.
  Pin behaviour with tests; on PM upgrades, re-run specialised + residual
  profiles. Prefer a narrow proto patch over a fork.
- **Height-map drift** forced today's live-geometry viewport. Spacers put
  trust back on the cache for off-screen y; measure carefully after phase 1.
- **Half-wired virtualization** (spacers without split-merge, or sparse open
  without geometry rewrite) will desync caret and scroll. Do not land partial
  wiring on `main`.

## Decision for this cut

No code PR that changes runtime behaviour. The first honest implementation is
phase 1 above — larger than the remount micro-cuts, and wrong if split into
"spacers without mapping". Next actionable PR is phase 1 with before/after
happy-dom open numbers and the invariants above going green.

# Large documents

## Typing on a very large document, measured 2026-09-02

The corpus files under `out/bench/corpus` are 66KB, 525KB, 2MB and 8MB. The
author's own vault has three notes over a megabyte, the largest 2.9MB, and
thirty-three over 200KB.

| document | blocks | opens in | median keystroke |
| --- | --- | --- | --- |
| medium, 525KB | 2,742 | 1.1s | 21ms |
| large, 2MB | 10,982 | 3.9s | 113ms |
| huge, 8MB | 43,970 | 24s | 1.4s |

Where the time goes. Every decoration plugin's share of a keystroke was timed
on the 8MB document by applying transactions to a state with each plugin alone:
alerts, Typora's inline marks, the active block and the syntax highlighter
together cost 14ms per twenty keystrokes, or 0.7ms each. The remaining 1.4s is
the view: ProseMirror reconciling a document of forty-four thousand top level
nodes. Nothing in the editor's own logic accounts for it.

One real fault was found and fixed by that measurement. The alert plugin
rebuilt its whole decoration set on every keystroke, which cost 11ms a letter
in the state and far more in the view, since a wholly new set gives ProseMirror
nothing to compare and it revisits every block. It is incremental now, like the
highlighter and the marks: the set is mapped through the transaction and only
the blocks the change or the selection touched are rescanned. On the 8MB
document the 95th percentile keystroke fell from 5.2s to 1.5s.

The view layer was then tested by removing plugins from a real build rather
than by inference. With the alert plugin, the inline marks and the active
block all taken out, the 2MB document still took 113ms a keystroke, the same
as with them. No decoration this editor draws accounts for the cost: it is
ProseMirror reconciling a document whose top level holds eleven thousand
children, and shortening that would mean rendering only what is on screen,
which is a different architecture rather than a tuning.

What is left is the view layer, and it is the honest limit of this design at
this size. A 2MB note, which is larger than all but three notes in the vault,
takes 113ms a keystroke: perceptible, and short of where it should be.

## Selective paint deferral, 2026-09-10

The view cost above is mostly the engine laying out every top level block on
each keystroke. `contain: layout` alone took about thirteen percent off that.
Blanket `content-visibility: auto` took about forty percent off a keystroke on
the two megabyte corpus and broke markdown input rules, because style
containment on the block under the caret stops ProseMirror reading the DOM back
after a keystroke.

The editor now keeps that paint deferral for every top level block that is not
near the selection, and forces the selection's neighbourhood fully painted.
Input rules keep working; off-screen blocks are not laid out. Reproduce the
layout split with `scripts/bench/profile-typing.mjs` against a packaged build.

## Stubbing scroller, 2026-09-10

Paint deferral still left every top level block in the DOM. The next step is
now landed as a measured vertical slice rather than more CSS.

`viewport-stub.ts` replaces far-off top level blocks with height placeholders
once a document has at least 3,000 top level blocks (between the medium and
large corpus sizes). Near-viewport blocks (two screens of buffer) and the
selection neighbourhood stay real ProseMirror content. The first stubbing slice covered default-rendered types —
paragraphs, headings, lists, rules, blockquotes, frontmatter, source blocks,
footnote and link definitions. Fences, tables and display math stayed
always-real until the specialised wrap cut below; HTML and image blocks are
still always-real.

The feature is default-on for those large documents and off below the
threshold, so ordinary notes are unchanged. Host dataset attributes
`data-stub-enabled`, `data-stub-real` and `data-stub-count` expose the window
for packaged benches.

### Body-feel targets (same corpus files as Typora)

Pinned before further tuning, so the next cut answers a feel debt rather than a
micro-benchmark:

| corpus | Typora | Noto body-feel target |
| --- | --- | --- |
| medium (525KB, 2742 blocks) | opens and edits | keystroke and scroll-frame ≤ ~16ms (one frame). Stubbing stays off. |
| large (2MB, 10982 blocks) | never loads | still aim for immediate writing: keystroke toward one frame; scroll without remounting the gap between caret and viewport. |
| huge (8MB) | never loads | usable at all is already ahead of Typora; polish after large feels good. |

### Contiguous real-window bug, fixed 2026-09-11

Stubbing kept a single contiguous `real` span from `min(selection, viewport)` to
`max(...)`. Scrolling away from the caret therefore remounted every block
between them. On the Linux packaged `large` corpus that meant a mid-document
scroll left `real=0-7334` (~3600 real paragraphs) and a median scroll-frame of
about **947ms**. Membership is now OR of the two windows; the gap stays stubbed.

Measured on this Linux box with `node scripts/bench/profile-typing.mjs` against
`out/e2e/Noto-linux-x64` (same probe: scroll `.canvas-scroll` to mid, then type
and step-scroll). Numbers are not the macOS baseline table, but they are
before/after on one machine:

| | mid stubbed | mid real `<p>` | scroll-frame | mid keystroke total |
| --- | --- | --- | --- | --- |
| before (contiguous union) | 3647 | 3667 | 947 ms | 16 ms* |
| after (OR windows) | 10864 | 59 | 60 ms | 17 ms |

\* Keystroke looked fine once thousands of blocks had already remounted; the
feel debt was the scroll that got them there.

macOS packaged re-measure remains useful for the original Apple-silicon table
(`BENCH_RUNS=3 node scripts/bench/run-noto.mjs` /
`node scripts/bench/profile-typing.mjs large`). Unit coverage for windowing,
the enable threshold, and scroll-away gap stubbing lives in
`tests/unit/viewport-stub.test.ts`.



### Height-map drift after remount, fixed 2026-09-11

After the OR-window fix, Linux packaged `large` still sat near **60ms** median
scroll-frame — and worse, the height *cache* used for windowing omitted the
0.74em top-level block rhythm while always-real fences/tables disagreed with
their estimates. The "real" indices were consistent with the cache but sat
tens of thousands of pixels above the visible scrollport (stubs on screen).

This cut keeps the same stubbing architecture and changes three local pieces:

1. **DOM-geometry windowing** — `viewportFromScroll` binary-searches live
   `getBoundingClientRect` of top-level children instead of cumulative estimates.
2. **Remount hysteresis** — scroll only remounts when the strict visible band
   would leave the current buffered window (idle scrolling inside the buffer is
   free).
3. **Gap-aware stub heights + generation-gated measure** — estimates fold the
   0.74em rhythm; `measureRealHeights` runs on stub generation changes (not every
   keystroke) and never shrinks a cached height (shrinks re-expanded the visible
   index band and remount-cascaded).

Packaged Linux `out/e2e/Noto-linux-x64`, `node scripts/bench/profile-typing.mjs large`
(2026-09-11). macOS packaged binaries are **not** on this agent box — no
`Noto-darwin-arm64`; do not invent Apple-silicon numbers.

| | scroll-frame 0.25×view | scroll-frame 0.75×view | mid caret-in-viewport script / paint | visible real in scrollport |
| --- | --- | --- | --- | --- |
| before (OR + height-cache window) | n/a | ~61 ms | not measured (selection stuck at top; real window off-screen) | no |
| after (DOM window + hysteresis) | ~18 ms | ~78 ms | ~4.7 / ~94 ms | yes |

Caret-in-viewport **script** is inside a frame; **paint** (~97ms) is the next
feel residual once scroll tracks the scrollport. Unit coverage:
`tests/unit/viewport-stub.test.ts`.


### Caret-in-viewport paint neighbourhood, 2026-09-11

After DOM windowing, mid-document caret-in-viewport **script** was already
inside a frame (~4.7ms) while the profile probe's "layout and paint" half sat
near **~94ms**. A Chrome trace of that gap was mostly main-thread work after
`execCommand` returned (decoration mapping / full-doc decoration rescans /
per-keystroke React `setState` for autosave ticking and `fileTags` markdown),
not Chromium paint. Paint deferral (`content-visibility: auto` +
`noto-layout-live`) was still applied.

This cut does not change stub membership. It keeps token decorations for
always-real fences **outside** the selection/viewport neighbourhood off the
keystroke path when stubbing is on, makes wiki-link updates incremental, avoids
empty sidenote full-doc rescans on caret moves, and stops the shell from
re-rendering / re-serializing markdown on every letter (autosave timer reset in
a ref; `fileTags` chips debounced).

Packaged Linux `out/e2e/Noto-linux-x64`, `node scripts/bench/profile-typing.mjs large`
(2026-09-11). Stub membership unchanged. Large-step scroll left alone (~78ms).

| | mid caret-in-viewport script / paint |
| --- | --- |
| before (DOM window + hysteresis) | ~4.7 / ~94 ms |
| after (neighbourhood decorations + origin map + shell debounce) | **~4.5 / ~18 ms** |

macOS packaged re-measure remains useful; do not invent Apple-silicon numbers.


### Large-step scroll remount batch, 2026-09-11

After #53, caret-in-viewport paint was inside a frame while Linux packaged
`large` **scroll-frame(0.75×view)** still sat near **75–79ms**. Splitting the
probe by remount showed idle large steps at ~10–20ms; the spike was the frame
that remounted the stub window. Always-real fences/tables/math (549×3 on the
corpus) were **not** stubbed — membership rules unchanged — and were not proven
to be the sole cause; the remount path itself was.

This cut keeps OR membership and the always-real set, and changes three local
pieces:

1. **Extend-then-slide** — `slideViewportWindow` keeps the trailing edge when
   the visible band just crosses, remounting only the newly needed leading band
   until the window exceeds `idealSpan * 1.5`.
2. **Buffer 2 → 3 screens** — large-step scrolls stay inside hysteresis more
   often, so the spike fires less often in the 0.75× probe.
3. **Hysteresis on height-resync + deferred measure** — post-remount
   `measureRealHeights` no longer recenters on the next frame (which had paired
   remounts and left the visible band against an edge).

Packaged Linux `out/e2e/Noto-linux-x64`, `node scripts/bench/profile-typing.mjs large`
(×3, 2026-09-11). Stub membership unchanged. Always-real fences/tables/math still
mounted. Quick-open wiki-follow e2e flake left alone.

| | scroll-frame 0.25×view | scroll-frame 0.75×view | mid caret-in-viewport script / paint |
| --- | --- | --- | --- |
| before (#53) | ~18–24 ms | **~75–79 ms** | ~4.5 / ~18 ms |
| after (extend-slide + buffer 3 + deferred measure) | ~27–28 ms | **~38–42 ms** | ~4.5 / ~18 ms |

Remount spikes alone (0.75× steps that change `data-stub-real`) dropped from
~75–79ms to ~14–16ms; remaining median is idle-frame variance and occasional
non-remount layout cost, still above one frame.


### Specialised fence/table/math stubbing, 2026-10-01

Always-real fences, tables and display math dominated open on the corpus once
paragraphs were stubbed: **1,647** specialised top-level blocks on `large`,
**6,596** on `huge` (549×3 and 2,199×3). They kept their specialised NodeViews
because `NotoEditor.nodeViews` spread specialised constructors *after*
`stubbableNodeViews`, so stub membership never reached them.

This cut wraps those three constructors through `wrapSpecialisedStubbable`:

1. Off-viewport → height stub (`div.noto-block-stub`, `data-stub-type`).
2. Entering the real window → `update` returns false → ProseMirror remounts the
   real Fence/Table/Math view with a fresh contentDOM.
3. Leaving the real window → remounts the stub the same way.
4. Selection neighbourhood still forces specialised blocks under the caret real,
   so editing/selection/focus do not land on a stub.

HTML and image node views stay always-real (rarer on the corpus; wider remount
surface). Medium notes (`childCount < 3000`) are unchanged.

#### Microbench (Linux agent, happy-dom EditorView open)

`PROFILE_SPECIALISED_STUB=1 pnpm vitest run tests/unit/open-view-specialised-profile.test.ts`
writes `out/bench/open-view-specialised.txt`. Same machine, legacy merge
(specialised always-real) vs wrapped stubbing — view construction only, not the
macOS packaged open baseline:

| corpus | legacy specialised-always-real | wrapped specialised-stubbing | ratio |
| --- | --- | --- | --- |
| large (10,982 blocks) | 1,899 ms | 782 ms | 2.43× |
| huge (43,970 blocks) | 10,017 ms | 4,715 ms | 2.12× |

Unit remount / edit coverage: `tests/unit/viewport-stub-specialised.test.ts`
(happy-dom). Packaged macOS re-measure remains useful; do not invent
Apple-silicon numbers from this table.


### Stub open floor + decoration reuse, 2026-10-02

After specialised stub membership (#303), happy-dom EditorView open still spent
most of its time building one placeholder DOM node per top-level block, and
every transaction rebuilt the real-window `DecorationsSet` via
`DecorationsSet.create` (O(doc) even when membership was unchanged).

This cut keeps membership rules and specialised remount behaviour, and changes
two local pieces:

1. **Stub element prototype** — `createStubElement` clones a shared
   `div.noto-block-stub` instead of `createElement` + className per block;
   height lookups use the cached estimate without a redundant `getComputedStyle`
   when the cache already has a value.
2. **Decoration set reuse** — viewport-stub stores the real-window decorations
   in plugin state; unchanged membership reuses the same set, doc edits with
   the same windows `map` it, and only membership changes rebuild.

Linux agent, happy-dom view open (`PROFILE_SPECIALISED_STUB=1`), same machine
before/after (wrapped specialised stubbing). Medians of three after runs; before
was one run immediately prior on the same box:

| corpus | before (post-#303) | after | ratio |
| --- | --- | --- | --- |
| large (10,982 blocks) | 631 ms | **424 ms** | 1.49× |
| huge (43,970 blocks) | 5,445 ms | **3,476 ms** | 1.57× |

Remount spikes when the window actually moves are largely unchanged — ProseMirror
still walks every top-level child on decoration membership changes. Residual
probe: `PROFILE_RESIDUAL=1 pnpm vitest run tests/unit/open-view-residual-profile.test.ts`.
Packaged macOS re-measure remains useful; do not invent Apple-silicon numbers.

### Surgical membership remount, 2026-10-02

After #304, remount spikes when the real window moved were still dominated by
ProseMirror: node decorations on the real band made `DecorationsSet.eq` fail, so
`updateChildren` walked every top-level child and `renderDescs` resynced the
whole list. On huge, a one-block slide cost about as much as remounting a
61-block band (~460–550 ms) — the walk, not the band.

This cut keeps OR membership and specialised stubbing, and changes the remount
signal:

1. **No membership decorations** — the stub plugin's decoration set stays empty.
   A pure viewport meta update no longer fails `matchesNode`, so the O(doc) walk
   does not run.
2. **Surgical stub ↔ real** — on generation change the plugin view diffs the
   previous and next windows and remounts only enter/leave indices in place
   (`applyMembership` on the NodeView, ViewDesc pointer fixup, `updateChildren`
   only on that block's content).

Linux agent, happy-dom (`PROFILE_RESIDUAL=1`), same machine before/after.
Medians of three after runs; before from the post-#304 residual on this box:

| corpus | remount mid (~61) before | after | slide +1 before | after |
| --- | ---: | ---: | ---: | ---: |
| large (10,982 blocks) | 82 ms | **49 ms** | 51 ms | **11 ms** |
| huge (43,970 blocks) | 582 ms | **182 ms** | 460 ms | **76 ms** |

Remount mid still pays for building ~61 real blocks; slide +1 is the walk cut.
HTML/image stay always-real. Packaged macOS re-measure remains useful; do not
invent Apple-silicon numbers.


### Scroller lookup without mount-parent layout, 2026-10-02

After #305, remount-mid still looked like "band build" cost, but a residual
breakdown showed every viewport meta dispatch on huge paying ~45–70 ms before
any stub↔real work: `ensureScroll` → `findScroller` → computed `overflowY` on
the ProseMirror mount's direct parent. That parent wraps every top-level child;
reading its computed overflow forces layout over the whole list (happy-dom;
same class of cost in Chromium). Building the ~61-block band was real, but so
was this tax on every membership update — including no-op same-window
dispatches (~47 ms on huge).

This cut keeps surgical remounts and membership rules, and changes two local
pieces:

1. **`findScroller`** — never reads computed overflow on the mount parent
   (inline only there). Prefers `.canvas-scroll` and inline `overflowY` further
   up, then computed style for other ancestors.
2. **`ensureScroll`** — keeps the attached scroller across plugin updates while
   it still contains the editor; does not re-walk on every transaction.

Linux agent, happy-dom (`PROFILE_RESIDUAL=1`), same machine before/after.
Medians of three runs:

| corpus | remount mid before | after | slide +1 before | after | same-window before | after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| large (10,982 blocks) | 36 ms | **37 ms** | 10 ms | **5 ms** | 5.5 ms | **0.2 ms** |
| huge (43,970 blocks) | 178 ms | **146 ms** | 79 ms | **42 ms** | 47 ms | **0.4 ms** |

Remount mid on huge still pays for entering the real band (specialised FenceView
construction dominates applyMembership for the three fences in the mid corpus
band). Same-window and slide +1 show the layout tax removed. HTML/image stay
always-real. Packaged macOS re-measure remains useful; do not invent
Apple-silicon numbers.


### Lazy fence tools (defer datalist), 2026-10-02

After #306, remount-mid on huge still paid ~80 ms inside `applyMembership` for
the three `code_block`s in the mid band. A ctor breakdown showed bare
`FenceView` construction was cheap on a tiny document (~0.2 ms) but ~25 ms per
fence amid the huge stub DOM — almost entirely
`input.setAttribute('list', datalistId)`. Resolving the shared language
datalist against tens of thousands of top-level stubs dominated specialised
enter. Table and math chrome were already cheap (~2 ms / ~0.5 ms for three).

This cut keeps specialised stubbing and surgical remount, and changes fence
chrome only:

1. **Lazy tools** — language field + copy button mount on first `pointerenter`
   / `focusin`, matching the existing CSS (tools visible on hover / active-block
   / focus-within). The remount path builds `pre` + gutter + `code` only.
2. **Deferred datalist bind** — `list=` attaches on language focus, not at tool
   mount, so a hover that only reveals Copy does not pay the id-resolution tax.

Linux agent, happy-dom (`PROFILE_RESIDUAL=1`), same machine before/after
(post-#306 baseline). Medians of three runs:

| corpus | remount mid before | after | slide +1 before | after |
| --- | ---: | ---: | ---: | ---: |
| large (10,982 blocks) | 37 ms | **23 ms** | 5 ms | **9 ms** |
| huge (43,970 blocks) | 146 ms | **85 ms** | 42 ms | **41 ms** |

Forced re-realify apply for `code_block`×3 in the mid band: **80 → 0.6 ms**.
`FenceView` ctor amid huge DOM: **25 → 0.07 ms**. Slide +1 is unchanged (walk
already cut). HTML/image stay always-real. Packaged macOS re-measure remains
useful; do not invent Apple-silicon numbers.


### Band-enter without observer tear-down, 2026-10-02

After #307, remount-mid on huge still sat near **85 ms** for a ~61-block band,
and slide +1 near **41 ms** for two remounts. A breakdown showed two separate
taxes on every membership batch:

1. **`MutationObserver` disconnect / re-observe** — `withDomObserverStopped`
   tore the observer down around surgical remounts. On a mount with ~44k
   children that cost ~12–15 ms each way in happy-dom (~24 ms of every slide +1).
2. **`view.nodeDOM` → `descAt`** — each remount walked `docView.children` from
   index 0. Mid-document lookups for a 61-block band cost ~15–22 ms; head-band
   lookups were free. `getPos` → `posBeforeChild` is the same class of walk when
   leave remounts call it.

This cut keeps surgical enter/leave and specialised stubbing, and changes the
DOM path only:

1. **Ignore mutations without disconnect** — suppress `flush`, discard
   `takeRecords` / the observer queue, restore flush. Remounts stay invisible
   to ProseMirror without O(children) observe.
2. **Index ViewDesc lookup** — `topLevelDescAt` uses `docView.children[index]`
   when the child list lines up with the doc (optional trailing hack); otherwise
   counts NodeViewDescs so top-level widgets still remount correctly. Pass the
   index into `applyMembership` so stub mount skips `getPos`.
3. **Deferred measure** uses the same index lookup instead of `nodeDOM`.

Linux agent, happy-dom (`PROFILE_RESIDUAL=1`), same machine before/after
(post-#307 baseline). Medians of three runs:

| corpus | remount mid before | after | slide +1 before | after |
| --- | ---: | ---: | ---: | ---: |
| large (10,982 blocks) | 23 ms | **15 ms** | 9 ms | **0.6 ms** |
| huge (43,970 blocks) | 85 ms | **28 ms** | 41 ms | **1.1 ms** |

Slide +1 is now essentially the two remounts. Remount mid on huge was still
mostly `replaceChild` + building ~61 real shells (`updateChildren`) — addressed
in the next section. HTML/image stay always-real. Packaged macOS re-measure
remains useful; do not invent Apple-silicon numbers.

### In-place default stub remount, 2026-10-02

After #308, remount-mid on huge still sat near **29 ms** for a ~61-block band
(enter) plus a handful of leave remounts. A phase breakdown showed
`replaceChild` alone at ~12 ms (swaps against a ~44k-child mount), with shell
construction and `updateChildren` secondary. `renderSpec` for the band was
under half a millisecond — the cost was detaching and attaching nodes, not
building them.

Default stubbable types always used a `div.noto-block-stub` placeholder, so
every stub→real had to replace that div with a typed `p` / `hN` / `ul` / ….
This cut keeps surgical enter/leave and specialised stubbing, and changes
default shells only:

1. **Typed stubs** — `StubbableBlockView` clones a per-tag stub prototype
   (`p`, `h2`, `ul`, …) via a static tag map (no `toDOM` on open) so the
   placeholder already matches the real shell tag.
2. **In-place flip** — stub→real clears stub chrome and restores schema attrs
   on the same node; real→stub clears children/attrs and paints stub chrome.
   No `replaceChild` when the tag matches.
3. **Specialised unchanged** — fences/tables/math still mount a `div` stub and
   swap to their NodeView root (10 of 64 enter+leave on a mid remount).

Linux agent, happy-dom (`PROFILE_RESIDUAL=1`), same machine before/after
(post-#308 baseline). Medians of three consecutive runs (quiet window):

| corpus | remount mid before | after | slide +1 before | after |
| --- | ---: | ---: | ---: | ---: |
| large (10,982 blocks) | ~25 ms | **~12 ms** | 0.8 ms | **0.5 ms** |
| huge (43,970 blocks) | 29 ms | **12 ms** | 1.0 ms | **0.7 ms** |

Large wall-clock is noise-dominated on both sides. Instrumented mid remount
on huge: **same=54 / replaced=10** (all defaults keep the node; specialised
still swap). Under load, after runs ranged ~10–22 ms (still below the ~29 ms
before median). HTML/image stay always-real. Residual specialised
`replaceChild` is addressed in the next section; band `updateChildren`
remains. Packaged macOS re-measure remains useful; do not invent
Apple-silicon numbers.

### In-place specialised stub remount, 2026-10-02

After #309, remount-mid on huge still paid `replaceChild` for the specialised
fraction of the band (instrumented mid remount: **same=54 / replaced=10**, all
swaps fences/tables/math). Default types already flipped in place; specialised
stubs were always a `div`, while FenceView roots a `pre` and Table/Math root a
`div` of their own — so every specialised enter/leave detached and attached
against the ~44k-child mount (~3 ms of the mid remount).

This cut keeps surgical enter/leave and specialised stubbing, and changes
specialised shells only:

1. **Typed specialised stubs** — `code_block` stubs as `pre`, `table` /
   `math_block` as `div`, via the same per-tag prototype path as defaults.
2. **Host reuse** — Fence/Table/Math constructors accept an optional `host`
   shell; `SpecialisedStubbableView` passes the stub node on stub→real and
   paints stub chrome back onto it on real→stub. No `replaceChild` when the
   tag matches.
3. **HTML/image unchanged** — still always-real. The huge corpus has **zero**
   always-real top-level blocks, so stubbing them has no corpus ROI.

Linux agent, happy-dom (`PROFILE_RESIDUAL=1`), same machine before/after
(post-#309 baseline). Medians of three consecutive separate-process runs:

| corpus | remount mid before | after | slide +1 before | after |
| --- | ---: | ---: | ---: | ---: |
| large (10,982 blocks) | 23 ms | **11 ms** | 0.6 ms | **0.5 ms** |
| huge (43,970 blocks) | 22 ms | **19 ms** | 0.7 ms | **0.5 ms** |

Huge wall-clock is noise-dominated on both sides. Instrumented mid remount on
huge: **replaceCount 10 → 0** (replace phase ~3 → 0 ms). Residual is band
`updateChildren` / specialised ctor work (tables still the heaviest
specialised enter). Packaged macOS re-measure remains useful; do not invent
Apple-silicon numbers.

### Spacer / virtualization phase 1, 2026-10-02

Remount micro-cuts bottomed out on per-block stubs: open stayed O(top-level
blocks) (~44k ViewDescs on `huge`). Phase 1 collapses off-window runs into
range spacers (`sparse-doc-view.ts`) — see
[spacer-virtualization.md](./spacer-virtualization.md).

Happy-dom EditorView open (Linux agent, `PROFILE_SPARSE_DOC=1`):

| corpus | before (per-block stubs) | after (sparse) | DOM children |
| --- | ---: | ---: | ---: |
| large | ~0.7 s | ~16–50 ms | ~4 |
| huge | ~4.4 s | ~30–35 ms | ~4 |

Phase 2 (2026-10-02): always-real holes confirmed + decoration pass-through
(`innerDeco` / top-level widgets / real-band node deco). Packaged height-map
drift still needs macOS.

### Keystroke after sparse: highlight + origin, 2026-10-02

After spacer phase 1–2, happy-dom open and remount were already near their
architectural floor (~30–55 ms open, ~19 ms remount mid on huge). The remaining
typing residual was plugin work on every caret move:

1. **Syntax highlight under stubbing** rebuilt the token `DecorationSet` on
   every `selectionSet`, even when stub viewport/selection windows were
   unchanged (~20 ms of the selection-only path on huge). Document edits with
   stable windows also took the full rebuild instead of the incremental
   map+patch the non-stub path already used.
2. **Origin mapping** rebuilt 2×`childCount` top-level range objects and
   remapped every origin on each interior keystroke (~15 ms on huge), even
   though in-block typing cannot change top-level identity.

This cut keeps stub membership and origin semantics, and changes two local
pieces:

1. **Highlight** — selection-only with stable stub windows returns the previous
   set; doc edits with stable windows map incrementally; window changes still
   rebuild. Stub-window decoration walks stop at the later real window.
2. **Origin** — interior top-level edits (every step inside one block, child
   count unchanged) reuse the previous origins array; merge/split/delete still
   remap.

Linux agent, happy-dom, huge corpus (43,970 blocks), mid real band, plugins as
in product (`PROFILE_TYPING_RESIDUAL` probe). Before = main at `eb01dfe`; after
= this cut. Before was one quiet run; after = median of three:

| suite | keystroke before | after | selection-only before | after |
| --- | ---: | ---: | ---: | ---: |
| stub+origin+highlight | 43 ms | **~7 ms** | 21 ms | **~0.6 ms** |
| all (origin+stub+alert+active+marks+highlight) | 43 ms | **~9 ms** | 22 ms | **~2.5 ms** |

Coverage: `tests/unit/highlight-stub-incremental.test.ts`,
`tests/unit/origin-interior-fast-path.test.ts`. Packaged macOS re-measure
remains useful; do not invent Apple-silicon numbers.


# Open-path / `parseDocument` — measured cuts

Status: **lazy / deferred wire nodes + viewport-driven enrich + incremental PM patch** under the flagged `@roobli/md` path.
Product default remains micromark. Do **not** flip `NOTO_MARKDOWN_ENGINE`
default-on from this work.

## Evidence (already recorded)

After wire `nodes` and outline-from-wire, `docs/performance/measurements.md`
concluded there was no further opportunistic micromark slice: one full dialect
parse dominates open. That is still true on the **default** path.

The flagged `@roobli/md` path changes the picture. Native structural split is
~100× faster than micromark (`@roobli/md` `bench:ab`), but Noto’s adapter was
re-attaching mdast with **`parseMarkdown` once per span**. That made flagged
`parseDocument` *slower* than micromark on the same corpus.

### Cut 1 — bulk attach (PR #85)

Linux box, 2026-09-15, median of 5 timed runs after one warm
(`tests/unit/open-profile.test.ts` / former probe):

| phase | small | medium | large |
| ----- | ----- | ------ | ----- |
| micromark `parseDocument` | 155 ms | 653 ms | 2958 ms |
| roobli structural | 5 ms | 10 ms | 25 ms |
| roobli enrich **none** | 1 ms | 6 ms | 21 ms |
| roobli enrich **per-span** (old) | 119 ms | 846 ms | 3591 ms |
| roobli enrich **bulk** | 81 ms | 656 ms | 2967 ms |
| micromark `splitBlocksMicromark` | 73 ms | 633 ms | 3036 ms |

On medium, bulk removes ~190 ms versus per-span (~22%); on large ~620 ms
(~17%). Bulk lands in the same band as a single micromark split — the N×
penalty is gone. Structural / `none` stay ~10–25 ms.

Corpus span counts match a single full-document `topLevelNodes(parseMarkdown(text))`
(small 338 / medium 2742), so bulk zip-by-ordinal is sound on the public bench
corpus; disagreeing counts fall back to per-span (never silent).

### Cut 2 — lazy / deferred wire nodes (this PR)

Bulk attach still costs ~one full micromark on open. Matching Typora at medium
(~343 ms felt) needs the structural ~4–25 ms path on the **critical path**, with
dialect enrich only for what first paint needs.

| phase (flagged) | role |
| ----- | ---- |
| `enrich: 'none'` on main `parseDocument` | structural file-truth + stand-in wire nodes (`nodesEnrichment: 'deferred'`) |
| `enrichSpansInRange(0, OPEN_LAZY_INITIAL_SPANS)` in renderer | one dialect parse of the first-paint window (not N×) |
| viewport / idle `enrichNextDeferredInRange` | visible±pad on scroll (prefer `viewport-stub` membership); idle chunks of `OPEN_VIEWPORT_ENRICH_BUDGET`; `applyDialectEnrichedSpans` if still clean |

`splitBlocks` / paste / single-block / reparse windows still use **bulk** (or
per-span for small N) under the flag — only **open/reload `parseDocument`** is
deferred.

Linux box, 2026-09-15, median of 5 `PROFILE_OPEN` runs after warm corpus:

| phase (flagged) | small | medium | large |
| ----- | ----- | ------ | ----- |
| enrich **none** | 1 ms | 4 ms | 23 ms |
| enrich **bulk** (prior cut) | 87 ms | 699 ms | 3080 ms |
| **lazy critical** (none + first 80) | 20 ms | **26 ms** | **43 ms** |
| lazy remainder (after paint) | 78 ms | 663 ms | 3131 ms |
| **parseDocument (deferred)** | **5 ms** | **14 ms** | **70 ms** |

Medium: main deferred open **14 ms** vs bulk enrich **699 ms** (~50×). Renderer
first-paint window **26 ms** vs full bulk **699 ms**. Remainder still ≈ one
dialect pass but **after** first paint. Large: deferred **70 ms** / lazy
critical **43 ms** vs bulk **3080 ms**.

Numbers also mirrored in `docs/performance/measurements.md`.

## API

- `SplitBlocksViaRoobliOptions.enrich`: `'bulk' | 'per-span' | 'none'`
- Default adapter enrich: `'bulk'` (paste / non-open)
- `enrichSpansInRange(spans, text, { from, to })` — one dialect parse for a
  contiguous span window; count mismatch → per-span for that window only
- `resolveDeferredOpenSpans` — first consumer helper (`OPEN_LAZY_INITIAL_SPANS = 80`)
- Viewport / idle: see **API (additions)** under Cut 3
- Wire: `nodesEnrichment?: 'full' | 'deferred'`

### Cut 3 — viewport-driven enrich

A full remainder pass after paint still costs ≈ one dialect parse (medium
~663 ms / large ~3 s). Scrolling into stand-ins before that finishes showed raw
paragraphs; the post-paint frame also competed with input.

| phase (flagged) | role |
| ----- | ---- |
| `createEnrichFlags` + `enrichNextDeferredInRange` | track deferred indices; one budget-capped window per tick |
| scroll / mount | enrich visible±`OPEN_VIEWPORT_ENRICH_PAD`, preferring `viewport-stub.viewport` when stubbing is on |
| idle drain | chunked `OPEN_VIEWPORT_ENRICH_BUDGET` until flags are clear |

Linux box, 2026-09-15, median of 5 `PROFILE_OPEN` runs after warm corpus:

| phase (flagged) | small | medium | large |
| ----- | ----- | ------ | ----- |
| lazy critical (none + first 80) | 19 ms | 24 ms | 42 ms |
| lazy remainder **(full, prior)** | 82 ms | 704 ms | 3084 ms |
| **viewport enrich tick** | **49 ms** | **58 ms** | **82 ms** |
| **idle enrich tick** | **45 ms** | **54 ms** | **71 ms** |
| parseDocument (deferred) | 4 ms | 17 ms | 67 ms |

Medium: one scroll/idle tick **~58 ms** vs full remainder **704 ms** (~12×).
Large: **82 ms** vs **3084 ms** (~38×). Post-paint critical path is one budgeted
window, not a full dialect pass.

Does **not** flip default-on. No alpha bump.

## API (additions)

- `createEnrichFlags` / `countDeferredFlags` / `nextDeferredEnrichWindow`
- `enrichNextDeferredInRange` / `enrichRangeFromVisibleInclusive`
- `OPEN_VIEWPORT_ENRICH_BUDGET` (120) / `OPEN_VIEWPORT_ENRICH_PAD` (40)
- Renderer: `DeferredViewportEnrichController`, `visibleBlockRangeFromScroll`,
  `NotoEditor.beginDeferredViewportEnrich`

### Cut 4 — incremental PM patch per enrich tick

Each viewport / idle tick used to call `applyDialectEnrichedSpans` with a full
`docFromSpans` + `EditorState.create`. That rebuilt every top-level node and
reset plugin state while only a budgeted window had changed.

| phase (flagged) | role |
| --------------- | ---- |
| `enrichPmPatchForWindow` | top-level `replaceWith` range for the enriched window |
| `applyDialectEnrichedSpans(spans, window)` | incremental dispatch; full rebuild only as fallback |

Linux apply microbench (same corpus / window as Cut 3; no plugins in the
harness — product path also keeps live plugin state):

| apply path | small | medium | large |
| ---------- | ----- | ------ | ----- |
| full `EditorState` rebuild | 1.1 ms | 1.4 ms | 5.4 ms |
| **incremental `replaceWith`** | **0.4 ms** | **1.1 ms** | **1.9 ms** |

Large apply **~2.8×**; absolute save is small beside dialect enrich (tens of ms)
but avoids resetting viewport-stub / alert / history on every tick.

## API (additions for Cut 4)

- `enrichPmPatchForWindow(doc, spans, window)`
- `applyDialectEnrichedSpans(spans, window?)` — window enables incremental path

## Next residual (not this PR)

1. **Engine-owned IR → PM** — avoid mdast entirely for common blocks once
   `@roobli/md` can feed `docFromSpans` without dialect trees.
2. Kind-aware structural stand-ins (heading/fence/…) so a long remainder gap is
   less visually raw if the user scrolls before idle enrich catches up.
3. Keep growing `tests/fixtures/markdown-golden/` (more dialect edges) before
   default-on; alerts / footnotes / indented-code / tight-quotes landed this cut.

Do not defer main’s file-truth structural parse; do not flip the product
default from this doc.

## How to re-measure

```
node scripts/bench/corpus.mjs
PROFILE_OPEN=1 pnpm vitest run tests/unit/open-profile.test.ts
```

Packaged wall-clock open still needs macOS `out/e2e` for end-to-end quotes;
this cut is claimed on the Linux `PROFILE_OPEN` phases above.

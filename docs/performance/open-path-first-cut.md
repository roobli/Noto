# Open-path / `parseDocument` — measured cuts

Status: **lazy / deferred wire nodes + viewport-driven enrich + incremental PM patch + kind-aware stand-ins + engine-owned IR→PM (common blocks + simple quotes incl. nested plain + lists-in-quotes + hard breaks in quotes + lazy nest continuation + true no-`>` lazy + simple flat / nested lists (same-family or mixed-marker) any depth incl. hard breaks + unindented lazy soft-wrap + simple GFM tables (incl. escaped pipes + ragged body rows) + simple footnote-defs incl. empty + hard breaks + plain/simple-marked/simple-marked-title callouts + simple marked phrasing `**`/`*`/`~~`/`` ` `` + simple inline links/images + simple reference links/images + simple bare http(s) + angle-bracket http(s) + www. + email autolinks + simple wiki links + simple-marked callout titles + setext-`---` headings)** under the flagged `@roobli/md` path.
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

### Cut 5 — engine-owned IR → PM (common blocks)

Leaf kinds (`fenced-code` / `indented-code` / `thematic-break` / `frontmatter` /
`html` / `display-math`), **parseable link-definitions**, **simple
footnote-definitions** (plain single-paragraph body; optional soft-wrap
continuations), **plain** paragraph/heading (no inline dialect markers),
**simple blockquotes** (every line `>`-prefixed; plain paragraphs incl. hard
breaks, nested plain quotes, simple flat / nested lists (incl. mixed-marker) inside the
quote at any reasonable depth, and CommonMark lazy continuation of nested plain
paragraphs via fewer `>` markers), **simple flat lists**
and **nested lists** (same-family or mixed-marker, any depth; plain single-paragraph items incl.
hard breaks; optional task checkboxes / loose / soft-wrap), **simple
footnote-definitions** (plain or empty body incl. hard breaks), and **simple GFM
tables** (header + alignment row + optional body; plain or simple-marked cells
incl. escaped pipes; consistent or ragged body columns; leading `|` after 0–3 spaces) build ProseMirror directly from
engine kind + source (`pm/from-engine.ts`) — **no mdast**. `blockFromSpan`
prefers that path; `enrichSpansInRange` finalizes those spans without
`parseMarkdown`; deferred enrich flags mark them done past the first-paint
prefix.

Plain paragraph IR→PM drops trailing spaces that are not hard breaks
(CommonMark/mdast; avoids `See  [[` after open+type). Hard breaks
(` {2,}\n`) are engine-owned as `hard_break` nodes (serialize keeps two
trailing spaces), including inside simple quote paragraphs, simple list items,
and simple footnote bodies. Soft newlines stay in text (`pre-wrap`). Flat simple marked phrasing (`*`/`**`/`_`/`__`/`~~`/`` ` ``)
and one-level nested marks (`**bold _em_**`, `*em **strong** em*`) are
engine-owned; deep / ambiguous nests / multi-line HTML / math still take the dialect path. Simple inline HTML is engine-owned. Simple reference links/images (`[text][id]` / `[text][]` / `![alt][id]` / `![alt][]`) are engine-owned. Simple bare http(s) autolinks (`https://…` / `http://…`; text === href) and simple angle-bracket http(s) (`<https://…>`) are engine-owned. Setext `===` and setext-`---` / `-` headings are engine-owned via
`parseHeadingSource` (`@roobli/md` ≥ v0.1.12 Phase 15 closes the former
split gap; covered by `simple-setext-dash-headings.md`). Mixed-marker nested lists
need `@roobli/md` ≥ v0.1.13 (Phase 16; `simple-mixed-marker-nested-lists.md`).

Cross-family nests, multi-block items, heavy callout titles, complex /
complex tables (HTML/math-in-cells, delimiter≠header), deep / ambiguous nested marks / multi-line HTML / math still need dialect (ragged body rows on simple tables are engine-owned)
enrich + `from-mdast` (empty footnote bodies, nests at any depth incl. mixed-marker,
nested plain quotes, simple lists-in-quotes, hard breaks in quotes, lazy nest
continuation via fewer `>` **or true no-`>`**, hard breaks inside simple lists /
footnotes, unindented list soft-wrap, flat simple marked phrasing incl.
underscore with snake_case literal, and one-level nested marks are engine-owned
with `@roobli/md` ≥ v0.1.9).
Does **not** flip default-on.

## API (additions for Cut 5)

- `pm/from-engine.ts` — `blockFromEngineSpan` / `canSkipDialectEnrich` /
  `engineSemanticKey` / fence+heading+simple-quote (incl. nested plain + lists-in-quotes + hard breaks + lazy nest)+flat-or-nested-list (incl. hard breaks)+simple-table+simple-footnote-def (incl. empty + hard breaks) source parsers
- `createEnrichFlags(length, enrichedExclusiveTo, spans?)` — optional spans
  mark engine-owned remainder as already enriched
- `enrichSpansInRange` — skips micromark for engine-owned spans; contiguous
  dialect runs still one parse each

## Next residual (not this PR)

1. ~~Engine-owned IR → PM (common blocks)~~ — shipped: leaf + plain
   paragraph/heading + parseable link-definition + simple footnote-definition
   (incl. empty) + simple quote + simple flat / nested list (any
   depth) + simple GFM table skip mdast (`pm/from-engine.ts`); enrich flags +
   `enrichSpansInRange` honour the skip.
2. ~~Kind-aware structural stand-ins (heading/fence/…)~~ — shipped (#90).
3. Extend IR→PM to more kinds when safe (complex tables with HTML/math in cells, deep
   nested marks / multi-line HTML / math, marked footnote bodies with heavy
   inline, heavy callout titles still dialect; simple escapes + escaped pipes in simple tables + simple inline HTML owned; collapsible/plain-titled/simple-marked-title callouts owned; simple flat + one-level
   nested `**`/`*`/`__`/`_`/`~~`/`` ` `` marks owned across paras/headings/lists/
   tables/quotes/callouts/footnotes; simple inline links/images + simple reference
   links/images + simple bare + angle-bracket http(s) + www. + email + simple wiki `[[…]]` (literal text) owned; snake_case underscores stay literal). Plain hard-break paragraphs/headings,
   nested lists (same-family or mixed-marker, any depth, incl. hard breaks), nested plain quotes,
   simple lists-in-quotes, plain / simple-marked GFM alerts / callouts, hard
   breaks in quotes, lazy nest continuation via fewer `>` **and true no-`>`**,
   and hard breaks in simple footnotes are engine-owned.
4. Keep growing `tests/fixtures/markdown-golden/` before default-on; GFM inline,
   nested lists, simple-nested-lists (depth-2+), simple-nested-quotes,
   simple-lists-in-quotes, simple-hard-breaks-in-quotes,
   simple-lazy-continuations-in-quotes, simple-hard-breaks-in-lists,
   simple-hard-breaks-in-footnotes, simple-callouts,
   HTML blocks, callout edges, hr/setext, link-defs, simple quotes, simple flat
   lists, simple GFM tables, simple footnote-defs, empty footnote-defs, CJK
   emphasis, hard-breaks, images, empty/meta fences, escapes, table-align,
   ordered-start, inline HTML, simple-reference-links landed; intentional engine gaps documented in
   that README; simple-angle-autolinks / simple-www-autolinks / simple-email-autolinks / simple-escapes / simple-escapes-in-tables / simple-ragged-tables / simple-inline-html / simple-marked-callout-titles / simple-setext-dash-headings / simple-mixed-marker-nested-lists landed.

Do not defer main’s file-truth structural parse; do not flip the product
default from this doc.

## How to re-measure

```
node scripts/bench/corpus.mjs
PROFILE_OPEN=1 pnpm vitest run tests/unit/open-profile.test.ts
```

Packaged wall-clock open still needs macOS `out/e2e` for end-to-end quotes;
this cut is claimed on the Linux `PROFILE_OPEN` phases above.

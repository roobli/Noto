# Open-path / `parseDocument` — first measured cut

Status: **bulk mdast attach landed under the flagged `@roobli/md` path**
(`SpanEnrichMode: 'bulk'`). Product default remains micromark. Do **not** flip
`NOTO_MARKDOWN_ENGINE` default-on from this work.

## Evidence (already recorded)

After wire `nodes` and outline-from-wire, `docs/performance/measurements.md`
concluded there was no further opportunistic micromark slice: one full dialect
parse dominates open. That is still true on the **default** path.

The flagged `@roobli/md` path changes the picture. Native structural split is
~100× faster than micromark (`@roobli/md` `bench:ab`), but Noto’s adapter was
re-attaching mdast with **`parseMarkdown` once per span**. That made flagged
`parseDocument` *slower* than micromark on the same corpus.

Linux box, 2026-09-15, median of 5 timed runs after one warm
(`tests/unit/open-profile.test.ts` / former probe):

| phase | small | medium | large |
| ----- | ----- | ------ | ----- |
| micromark `parseDocument` | 155 ms | 653 ms | 2958 ms |
| roobli structural | 5 ms | 10 ms | 25 ms |
| roobli enrich **none** | 1 ms | 6 ms | 21 ms |
| roobli enrich **per-span** (old) | 119 ms | 846 ms | 3591 ms |
| roobli enrich **bulk** (this cut) | 81 ms | 656 ms | 2967 ms |
| micromark `splitBlocksMicromark` | 73 ms | 633 ms | 3036 ms |

On medium, bulk removes ~190 ms versus per-span (~22%); on large ~620 ms
(~17%). Bulk lands in the same band as a single micromark split — the N×
penalty is gone. Structural / `none` stay ~10–25 ms and are the next residual.

Corpus span counts match a single full-document `topLevelNodes(parseMarkdown(text))`
(small 338 / medium 2742), so bulk zip-by-ordinal is sound on the public bench
corpus; disagreeing counts fall back to per-span (never silent).

## First cut (this PR)

**Replace N× per-span dialect parses with one bulk dialect parse** when
`splitBlocksViaRoobli` builds wire-ready spans (the open / `parseDocument`
path under `NOTO_MARKDOWN_ENGINE=roobli-md`).

- API: `SplitBlocksViaRoobliOptions.enrich`: `'bulk' | 'per-span' | 'none'`
- Default: `'bulk'`
- `'per-span'`: legacy A/B for `PROFILE_OPEN`
- `'none'`: structural scaffolding (stand-in nodes, `semanticKey === kind`) for
  the **next** implement — file-truth / early wire without mdast

Single-block and incremental reparse windows still use per-span enrich (small
N; not the open critical path).

Measured claim to quote: **flagged open no longer pays N× micromark**; bulk
attach is one dialect pass (parity with the default open cost shape) while
keeping the native structural split available at ~4 ms medium / ~20 ms large.

## Next residual (not this PR)

Bulk attach still costs ~one full micromark on open. Matching Typora at medium
(~343 ms felt) needs the structural ~4 ms path to *be* the critical path:

1. **Lazy / viewport wire nodes** — `enrich: 'none'` (or structural file-truth)
   on main; attach mdast only for the first paint neighbourhood (or Worker
   progressive enrich). Prep hook is the `'none'` mode.
2. **Engine-owned IR → PM** — avoid mdast entirely for common blocks once
   `@roobli/md` can feed `docFromSpans` without dialect trees.
3. Grow `tests/fixtures/markdown-golden/` before default-on.

Do not defer main’s file-truth structural parse; do not flip the product
default from this doc.

## How to re-measure

```
node scripts/bench/corpus.mjs
PROFILE_OPEN=1 pnpm vitest run tests/unit/open-profile.test.ts
```

Packaged wall-clock open still needs macOS `out/e2e` for end-to-end quotes;
this cut is claimed on the Linux `PROFILE_OPEN` phases above.

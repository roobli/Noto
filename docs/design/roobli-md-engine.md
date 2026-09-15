# `@roobli/md` — parse backend adapter

Noto’s markdown v3 stack (`src/shared/markdown/v3/`) still defaults to micromark.
The long-term engine that should own that hot path is the public MIT package
**[@roobli/md](https://github.com/roobli/md)** v0.1.7 (“WYSIWYG-first markdown
engine for Noto”).

## Why

Open cost on mid/large files is dominated by one full dialect parse (Linux
`parseDocument` ≈ 570 ms medium / 2.3 s large after wire `nodes` removed the
duplicate renderer pass). The editor already wants block spans, gaps, and
byte-exact untouched regions — a WYSIWYG-oriented engine, not only a correct
mdast dump.

## Dependency

```
"@roobli/md": "github:roobli/md#v0.1.7"
```

pnpm must allow its `prepare` (tsc) build — see `allowBuilds` in
`pnpm-workspace.yaml`.

## Feature flag (default off)

| Switch | Effect |
| ------ | ------ |
| unset / anything else | micromark path (product default) |
| `NOTO_MARKDOWN_ENGINE=roobli-md` | route `splitBlocks` / `parseSingleBlock`, flagged `replaceMarkdown`, and block-mode `serializeDocument` (identity / single-block / multi-block insert-delete) through the adapter; `source` mode stays on Noto |
| `setMarkdownEngineForTests('roobli-md' | 'micromark' | null)` | unit-test override |

Implementation:

- `src/shared/markdown/v3/engine-flag.ts` — env + test override
- `src/shared/markdown/v3/roobli-md-adapter.ts` — thin mapping
- `src/shared/markdown/v3/blocks.ts` — `splitBlocksMicromark` baseline; `splitBlocks` respects the flag

### How to enable locally

```bash
NOTO_MARKDOWN_ENGINE=roobli-md pnpm start
# or for unit tests that should exercise the adapter path:
NOTO_MARKDOWN_ENGINE=roobli-md pnpm test
```

Product / CI stay on micromark until broader golden gates pass; tight adjacent
quotes/callouts and native indented-code match micromark (`@roobli/md` v0.1.2+).

## Adapter mapping

| Noto | `@roobli/md` |
| ---- | ------------ |
| `splitBlocks` / `parseBlocks` | `parseBlocks` (+ bulk dialect enrich by default; open uses `none` + renderer `enrichSpansInRange`) |
| edited verify / middle replace | `reparseBlocks` / `reparseFromText` (Phase 11) |
| block-mode save (identity / single / multi insert-delete) | `serializeDocument` / `joinSplit` / `identityUnits` |

**Kept in the Noto layer:** branded IDs, `sha256`, envelope endings / BOM,
`semanticKey` computation, wire `nodes` (mdast). Native engine spans ship
`node: null`; the adapter attaches mdast via Noto’s `syntax.ts` dialect when a
ProseMirror-ready node is required. Engine serialize + split dialect (Phase
7–11 in `@roobli/md` v0.1.7) owns hard-break → two spaces, list marker /
delimiter from `node.data`, verbatim runs (wiki / alert / footnote / TOC /
snake_case), bare http(s) autolinks, table delimiter widening (vault
three-dash; content cells stay unpadded), line-prefix offset alignment
(0–3 leading ASCII spaces → leading/gaps, micromark parity), and
`sourceEditBetween` / `reparseFromText` host helpers. Noto’s
`syntax.ts` remains the micromark-default path serializer until the flagged
backend is default-on.

## Parity tests

`tests/unit/roobli-md-adapter.test.ts` plus synthetic fixtures under
`tests/fixtures/roobli-md-parity/` (no RooB private content):

1. **Structural parity** — `start` / `end` / `markdown` / gaps vs micromark on
   synthetic samples and the g002 subset that already matches.
2. **Flag routing** — `splitBlocks` / `parseSingleBlock` honour the override.
3. **`reparseBlocks`** — middle window rewrite keeps untouched prefix object
   identity on the structural split.
4. **Serialize identity** — engine `serializeDocument(identityUnits)` bytes
   equal Noto `identityTransaction` output on the same sources.

Tight adjacent quotes/callouts (`quote-callout.md`, g004 quote→callout) match
micromark as of `@roobli/md` v0.1.1 (CommonMark: unprefixed blank ends a quote).
Native **indented-code** spans (exact offsets, internal blanks kept) shipped in
`@roobli/md` v0.1.2 and are covered by the adapter parity suite. Phase 7
(`v0.1.3`) hard-break + list-marker; Phase 8 (`v0.1.4`) verbatim runs + bare
autolink; Phase 9 (`v0.1.5`) table delimiter widening (vault three-dash);
Phase 10 (`v0.1.6`) line-prefix offset alignment; Phase 11 (`v0.1.7`)
`sourceEditBetween` / `reparseFromText` on the flagged backend.

## Golden gates (option B — before default-on)

Curated A/B fixtures live under `tests/fixtures/markdown-golden/` and are
wired by `tests/unit/markdown-golden-gates.test.ts`. They compare the
**micromark** product path against an explicit `roobli-md` override on the same
sources — they do **not** flip `NOTO_MARKDOWN_ENGINE` for the rest of the suite.

| Gate | Assertion |
| ---- | --------- |
| Split boundaries | `kind` / `start` / `end` / `markdown` + leading/gaps/trailing equal |
| Identity serialize (#82) | flagged `serializeDocument` `outputBytes` equal micromark identity |
| Multi-block serialize | multi-dirty / insert / delete `outputBytes` equal micromark on each fixture |

Coverage today: headings, lists (bullet/ordered/task), tables, wiki links,
math fences + code fences, YAML frontmatter, CJK mixed inline. Intentional
diffs must be listed in `tests/fixtures/markdown-golden/README.md`; silent
divergence fails the gate loudly (`GOLDEN GATE FAIL …`).

### How to run

```bash
# golden gates only
pnpm exec vitest run tests/unit/markdown-golden-gates.test.ts

# full unit suite (default engine still micromark)
pnpm test

# exercise the flagged product path locally (does not change CI default)
NOTO_MARKDOWN_ENGINE=roobli-md pnpm start
```

### What “green gates” mean

Green means every fixture in `markdown-golden/` matches on split boundaries,
identity serialize, and multi-block insert/delete/multi-dirty serialize under
both engines. That is necessary but **not** sufficient for default-on:
open-path / `parseDocument` wire nodes and a broader corpus still block
flipping the product default. Expand the fixture set (and document any
intentional diffs) before considering `NOTO_MARKDOWN_ENGINE` default
`roobli-md`.

## Bridge docs (engine repo)

- Vision: https://github.com/roobli/md/blob/main/docs/design/vision.md
- Roadmap: https://github.com/roobli/md/blob/main/docs/design/roadmap.md
- Noto bridge: https://github.com/roobli/md/blob/main/docs/design/noto-bridge.md
- Contract v0: https://github.com/roobli/md/blob/main/docs/design/contract-v0.md

## Status

**Adapter spike landed (default-off).** `@roobli/md` v0.1.7 is the pinned
flagged backend; micromark remains the product default. Quote/callout and
indented-code split parity are closed; engine serialize dialect (hard-break /
list-marker / verbatim / bare autolink / table delimiters), Phase 10
line-prefix offsets, and Phase 11 `reparseFromText` are available on the
flagged path.

**Host wiring (flagged `replaceMarkdown`).** `PriorSplitCache`
(`src/shared/markdown/v3/prior-split-cache.ts`) seeds a structural split on
open / reload from the resolved spans (no extra parse). When
`NOTO_MARKDOWN_ENGINE=roobli-md`, `NotoEditor.replaceMarkdown` calls
`spansForReplace` → `reparseFromTextViaRoobli` with `neighborSlack: 1`.
WYSIWYG typing / paste invalidates the cache (`apply` skips invalidation while
`replaceInFlight`); the next replace falls back to a full split and reseeds.
Micromark path unchanged when the flag is off. Unit coverage:
`tests/unit/prior-split-cache.test.ts`.

**Host wiring (flagged block-mode serialize).** When the same flag is on,
`serializeDocument` routes all block-mode saves — identity, single-block, and
multi-block insert/delete — through `@roobli/md` `serializeDocument` (via
`toEngineDocument` / `toSerializeUnits`). Noto still validates forged origins,
re-attaches `sha256` on preserved ranges, and keeps branded `documentId` /
revision ids. `source` mode stays on the Noto serializer (host escape hatch).
Micromark path unchanged when the flag is off. Unit coverage:
`tests/unit/roobli-md-serialize-host.test.ts`.

**Open-path cuts (flagged).** `splitBlocksViaRoobli` defaults to bulk mdast
attach for paste / non-open. Flagged `parseDocument` uses `enrich: 'none'`
(`nodesEnrichment: 'deferred'`); the renderer calls `enrichSpansInRange` for a
first-paint window then viewport / idle `enrichNextDeferredInRange` — see
`docs/performance/open-path-first-cut.md`. Product default stays micromark.

Next: engine IR→PM, grow `tests/fixtures/markdown-golden/`, then reconsider
default-on. Do **not** flip the product default yet.

**Noto `0.0.2-alpha.9`** shipped the adapter (#37) plus `@roobli/md` v0.1.1 quote/
callout parity (#38). Pin is now `@roobli/md` v0.1.7 (Phase 11 reparse helpers
on top of Phase 10 / 9 / 8 / 7 / v0.1.2). Optional:
`NOTO_MARKDOWN_ENGINE=roobli-md` (micromark remains default).

# `@roobli/md` — parse backend adapter

Noto’s markdown v3 stack (`src/shared/markdown/v3/`) still defaults to micromark.
The long-term engine that should own that hot path is the public MIT package
**[@roobli/md](https://github.com/roobli/md)** v0.1.13 (“WYSIWYG-first markdown
engine for Noto”).

## Why

Open cost on mid/large files is dominated by one full dialect parse (Linux
`parseDocument` ≈ 570 ms medium / 2.3 s large after wire `nodes` removed the
duplicate renderer pass). The editor already wants block spans, gaps, and
byte-exact untouched regions — a WYSIWYG-oriented engine, not only a correct
mdast dump.

## Dependency

```
"@roobli/md": "github:roobli/md#v0.1.13"
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
7–16 in `@roobli/md` v0.1.13) owns hard-break → two spaces, list marker /
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
`sourceEditBetween` / `reparseFromText`; Phase 12 (`v0.1.8`) CJK emphasis
serialize lock-in on the flagged backend.

## Golden gates (option B — before default-on)

Curated A/B fixtures live under `tests/fixtures/markdown-golden/` and are
wired by `tests/unit/markdown-golden-gates.test.ts` (core set plus GFM inline,
nested lists, HTML blocks, denser CJK+wiki, callout edges, hr/setext,
link-definitions, trailing-spaces/soft-break, simple quotes, simple footnote-defs, empty footnote-defs, CJK emphasis, hard-breaks, images, empty/meta fences, escapes, table-align, ordered-start, inline HTML). They compare the
**micromark** product path against an explicit `roobli-md` override on the same
sources — they do **not** flip `NOTO_MARKDOWN_ENGINE` for the rest of the suite.

| Gate | Assertion |
| ---- | --------- |
| Split boundaries | `kind` / `start` / `end` / `markdown` + leading/gaps/trailing equal |
| Identity serialize (#82) | flagged `serializeDocument` `outputBytes` equal micromark identity |
| Multi-block serialize | multi-dirty / insert / delete `outputBytes` equal micromark on each fixture |

Coverage today: headings, lists (incl. nested any depth, mixed-marker), tables, wiki,
math/code fences, frontmatter, CJK, alerts/callout edges, footnotes,
indented-code, tight quotes, GFM strikethrough/autolink, HTML blocks,
setext+hr, link-definitions, simple quotes, simple flat lists, simple-nested-lists, simple GFM
tables, simple footnote-defs, empty footnote-defs, CJK emphasis, hard-breaks (incl. in quotes + lazy nest)/images/empty-fence/escapes/table-align/ordered-start/fence-meta/html-inline. Intentional diffs (mixed-marker nested lists closed in v0.1.13; setext-`---` closed in v0.1.12) are listed in `tests/fixtures/markdown-golden/README.md` and
kept out of the strict directory; silent divergence fails the gate loudly
(`GOLDEN GATE FAIL …`).

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


## Default-on checklist (do **not** flip yet)

Product default stays micromark until **all** of the following are green and
reviewed:

| Gate | Status |
| ---- | ------ |
| Split / identity / multi-block golden on current `markdown-golden/` | Green (expanded; keep growing) |
| Broader corpus / vault-shaped edges (GFM inline, nested lists, HTML, callout edges, link-defs, simple quotes, simple flat lists, simple GFM tables, simple footnote-defs, empty footnote-defs, CJK emphasis, hard-breaks, images, empty/meta fences, escapes, table-align, ordered-start, inline HTML) in golden | Landed this cycle; more edges welcome |
| Flagged open-path deferred + viewport enrich + IR→PM leaf/plain(incl. hard-break)/link-def/simple-footnote(incl. empty + hard breaks)/simple-quote(incl. nested + lists-in-quotes + hard breaks)/flat-or-nested-list(any depth, incl. hard breaks)/simple-table(incl. ragged body) | Landed (still flagged-only) |
| Flagged serialize (identity / single / multi) + `reparseFromText` host wiring | Landed |
| Packaged / e2e open feel on medium under the flag | Not a flip gate alone; measure before flip |
| Intentional diffs documented in `markdown-golden/README.md` | Mixed-marker nested lists closed (v0.1.13 + `simple-mixed-marker-nested-lists.md`); setext-`---` closed (v0.1.12 + `simple-setext-dash-headings.md`) |

**Prefer not flipping** until golden coverage is obviously broader than the
current curated set and open-path IR→PM has a clear story for marked-up
paragraphs (still dialect today). Optional local: `NOTO_MARKDOWN_ENGINE=roobli-md`.

## Bridge docs (engine repo)

- Vision: https://github.com/roobli/md/blob/main/docs/design/vision.md
- Roadmap: https://github.com/roobli/md/blob/main/docs/design/roadmap.md
- Noto bridge: https://github.com/roobli/md/blob/main/docs/design/noto-bridge.md
- Contract v0: https://github.com/roobli/md/blob/main/docs/design/contract-v0.md

## Status

**Adapter spike landed (default-off).** `@roobli/md` v0.1.13 is the pinned
flagged backend; micromark remains the product default. Quote/callout and
indented-code split parity are closed; engine serialize dialect (hard-break /
list-marker / verbatim / bare autolink / table delimiters / Phase 12 CJK
emphasis), Phase 10 line-prefix offsets, Phase 11 `reparseFromText`, and
Phase 13 CommonMark lazy continuation (no-`>` quotes / unindented list soft-wrap) and
Phase 14 nest/interrupt parity (definition lazy; GFM tables interrupt paragraphs;
list-nested indented blocks; v0.1.11 adjacent defs stay separate spans) and
Phase 15 setext-`---` vs thematic-break parity (v0.1.12) and Phase 16 mixed-marker nested lists (v0.1.13) are available on the flagged path.

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
first-paint window then viewport / idle `enrichNextDeferredInRange` with
incremental PM patch. **Engine-owned IR → PM** (`pm/from-engine.ts`) skips
mdast for leaf kinds + plain paragraph/heading (incl. hard breaks as
`hard_break` nodes) + parseable link-definitions +
simple footnote-definitions (plain or empty single-paragraph body; optional
soft-wrap / hard breaks) +
simple blockquotes (every line `>`-prefixed; plain paragraphs incl. hard breaks,
nested plain quotes, simple lists-in-quotes, plain-body GFM alerts / callouts,
and lazy nest continuation via fewer `>` markers) +
simple flat lists and nested lists (same-family or mixed-marker, any depth; plain items incl. hard
breaks; nested children may nest only) + simple GFM tables (alignment row; plain
or simple-marked cells incl. escaped pipes; consistent or ragged body columns);
enrich flags mark those done — see `docs/performance/open-path-first-cut.md`.
Cross-family nests, multi-block items, heavy callout titles, complex tables
(HTML / math in cells, delimiter≠header), and heavy inline (deep / ambiguous
nested marks, multi-line HTML, math, nested-bracket wiki) stay on dialect.
Ragged body rows on otherwise-simple GFM tables are engine-owned.
Empty footnote bodies, nested lists (incl. mixed-marker) at
any depth, nested plain quotes, simple lists-in-quotes, plain / simple-marked
callouts, hard breaks in quotes, lazy nest continuation via fewer `>` **and
true no-`>`**, hard breaks inside simple lists / footnotes, flat simple marked
phrasing (`**` / `*` / `__` / `_` / `~~` / `` ` ``; snake_case literal),
**one-level nested marks** (`**bold _em_**`, `*em **strong** em*`, code inside
marks), **simple inline links / images** (`[text](url)`, `![alt](url)`,
optional title; plain or simple-marked link text), **simple reference links /
images** (`[text][id]` / `[text][]` / `![alt][id]` / `![alt][]`), **simple bare
http(s) autolinks**, **simple angle-bracket http(s) autolinks**, **simple www. autolinks**, **simple email autolinks** (bare + angle / mailto), **simple wiki links** (`[[target]]` / `[[target|alias]]` as literal text; decoration
plugin owns display), and **simple backslash escapes** (ASCII punctuation + trailing-`\` hard breaks), including **escaped pipes in simple GFM table cells**, **ragged body rows on
simple GFM tables**, and **simple inline HTML** (single-line tags / comments / PI / declarations / CDATA as `inline_html` atoms), are engine-owned.
Product default stays micromark.

Next: keep growing `markdown-golden/` (more GFM / vault edges), extend IR→PM
only where micromark parity is locked (complex tables with HTML/math in cells /
deeper mark nests / multi-line HTML / math), then reconsider
default-on. Hard-breaks, images, empty/meta fences, escapes, table-align,
ordered-start, inline HTML, simple-flat-lists, simple-nested-lists,
simple-nested-quotes, simple-lists-in-quotes, simple-hard-breaks-in-quotes,
simple-lazy-continuations-in-quotes, simple-no-marker-lazy-in-quotes,
simple-lazy-list-continuations, simple-hard-breaks-in-lists,
simple-hard-breaks-in-footnotes, simple-callouts, simple-titled-collapsible-callouts, simple-marked-callout-titles, simple-marked-phrasing,
simple-underscore-emphasis, simple-nested-marks, simple-inline-links, simple-bare-autolinks, simple-angle-autolinks, simple-www-autolinks, simple-email-autolinks / simple-escapes / simple-escapes-in-tables / simple-ragged-tables / simple-inline-html, simple-reference-links, simple-wiki-links, simple-gfm-tables,
simple-footnote-defs, empty-footnote-defs, simple-setext-dash-headings, simple-mixed-marker-nested-lists, and cjk-emphasis goldens landed.
Do **not** flip the product default yet.

**Noto `0.0.2-alpha.9`** shipped the adapter (#37) plus `@roobli/md` v0.1.1 quote/
callout parity (#38). Pin is now `@roobli/md` v0.1.13 (Phase 16 mixed-marker nested lists on top of Phase 15 setext-`---` /
Phase 14 nest/interrupt + adjacent-def / Phase 13 lazy / Phase 12 CJK / Phase 11 / 10 / 9 / 8 / 7 / v0.1.2). Optional:
`NOTO_MARKDOWN_ENGINE=roobli-md` (micromark remains default).

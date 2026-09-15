# `@roobli/md` — parse backend adapter

Noto’s markdown v3 stack (`src/shared/markdown/v3/`) still defaults to micromark.
The long-term engine that should own that hot path is the public MIT package
**[@roobli/md](https://github.com/roobli/md)** v0.1.6 (“WYSIWYG-first markdown
engine for Noto”).

## Why

Open cost on mid/large files is dominated by one full dialect parse (Linux
`parseDocument` ≈ 570 ms medium / 2.3 s large after wire `nodes` removed the
duplicate renderer pass). The editor already wants block spans, gaps, and
byte-exact untouched regions — a WYSIWYG-oriented engine, not only a correct
mdast dump.

## Dependency

```
"@roobli/md": "github:roobli/md#v0.1.6"
```

pnpm must allow its `prepare` (tsc) build — see `allowBuilds` in
`pnpm-workspace.yaml`.

## Feature flag (default off)

| Switch | Effect |
| ------ | ------ |
| unset / anything else | micromark path (product default) |
| `NOTO_MARKDOWN_ENGINE=roobli-md` | route `splitBlocks` / `parseSingleBlock` through the adapter |
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
| `splitBlocks` / `parseBlocks` | `parseBlocks` (+ dialect enrichment for `node` / `semanticKey`) |
| edited verify / middle replace | `reparseBlocks` |
| identity / single-block save checks | `serializeDocument` / `joinSplit` / `identityUnits` |

**Kept in the Noto layer:** branded IDs, `sha256`, envelope endings / BOM,
`semanticKey` computation, wire `nodes` (mdast). Native engine spans ship
`node: null`; the adapter attaches mdast via Noto’s `syntax.ts` dialect when a
ProseMirror-ready node is required. Engine serialize + split dialect (Phase
7–10 in `@roobli/md` v0.1.6) owns hard-break → two spaces, list marker /
delimiter from `node.data`, verbatim runs (wiki / alert / footnote / TOC /
snake_case), bare http(s) autolinks, table delimiter widening (vault
three-dash; content cells stay unpadded), and line-prefix offset alignment
(0–3 leading ASCII spaces → leading/gaps, micromark parity). Noto’s
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
Phase 10 (`v0.1.6`) line-prefix offset alignment on the flagged backend.

## Bridge docs (engine repo)

- Vision: https://github.com/roobli/md/blob/main/docs/design/vision.md
- Roadmap: https://github.com/roobli/md/blob/main/docs/design/roadmap.md
- Noto bridge: https://github.com/roobli/md/blob/main/docs/design/noto-bridge.md
- Contract v0: https://github.com/roobli/md/blob/main/docs/design/contract-v0.md

## Status

**Adapter spike landed (default-off).** `@roobli/md` v0.1.6 is the pinned
flagged backend; micromark remains the product default. Quote/callout and
indented-code split parity are closed; engine serialize dialect (hard-break /
list-marker / verbatim / bare autolink / table delimiters) and Phase 10
line-prefix offsets are available on the flagged path. Next: optionally cache
prior splits so `NotoEditor.replaceMarkdown` can call `reparseBlocks` instead
of a full native split, then consider default-on behind broader golden gates.

**Noto `0.0.2-alpha.9`** shipped the adapter (#37) plus `@roobli/md` v0.1.1 quote/
callout parity (#38). Pin is now `@roobli/md` v0.1.6 (Phase 10 line-prefix
offsets on top of Phase 9 / 8 / 7 / v0.1.2). Optional:
`NOTO_MARKDOWN_ENGINE=roobli-md` (micromark remains default).

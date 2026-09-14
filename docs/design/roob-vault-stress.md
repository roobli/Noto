# RooB vault stress checks against Noto assumptions

Read-mostly pass against shared `/workspace/RooB` (≈7185 markdown files).
Deny dirs were not opened. Preferred probes only: `Z900_MOCs/*` hubs,
`A000_Theoretical_Knowledge/A404_Linux/*` samples, `A300_AI/.../vllm_RTFS.md`,
`P000_Public/*`, plus `vault.yaml` / `.tools` READMEs.

Gold standard named for this pass: **related panel** / **read-only index** /
**byte-for-byte unchanged**.

## 1. Graph build

Command (from vault root):

```bash
node .tools/note-assistant/build-graph.mjs --root /workspace/RooB
```

| | |
|---|---|
| Result | Wrote `.note-assistant/graph.json` + `report.md` (gitignored; not committed) |
| Size | ≈17 MB (`17136883` bytes) |
| Wall time | ≈33 s on this box (Node 22.13 after nvm; first run also paid shell/nvm setup) |
| Scanned | 7183 notes |
| Target notes | 4898 |
| Graph notes | allow-dir rebuild 2026-09-11: 3536 (3385 content + 151 MOC hubs); earlier full-target run was 4664 content-only |
| Sparse related blocks | 0 (`heuristicBlocksEnabled: false`, no AI cache) |
| Schema | `schemaVersion: 2` |

`Z900_MOCs` is in `vault.yaml` targets with `graph: true`. As of the
2026-09-11 note-assistant fix, `moc: true` hubs stay in the enrich resolve map
and emit **lightweight hub rows** (`moc: true`, `shouldGenerateBlock: false`,
no AI pending). Index-block wiki links are kept for edge extraction (related
blocks still stripped). An allow-dir rebuild
(`A000`/`B000`/`Z000`/`Z900_MOCs`/`V000`/`P000`) produced **151** hub rows;
`Z900_MOCs/代理与隧道.md` had **3** inbound `explicitLinks` (including
`mihomo/README.md`) and **118** outbound; overall **58** notes carried an
`explicitLinks` edge to some MOC path (was **0** on 2026-09-10).

## 2. Wiki-link density and resolve rate

Full-vault `vault.mjs lint` was **not** run (it walks deny dirs). Resolve rate
was measured on preferred files only, using the same order Noto/`vault.mjs`
document: note-relative → root-relative → unique basename via graph paths.

| Path | Wiki-links | Resolve | Notes |
|---|---:|---:|---|
| `Z900_MOCs/代理与隧道.md` | **119** | **100%** (all note-relative) | Entirely inside `<!-- note-assistant:index:* -->` |
| `Z900_MOCs/LLM推理部署.md` | 51 | 100% note-relative | Same; index-shaped MOC |
| `A000_Theoretical_Knowledge/A404_Linux/00_Linux总览.md` | 102 | 100% note-relative | `moc: true` + index markers |
| `.../跨境高RTT链路的TCP调优.md` | 4 | 100% | In graph: 3 explicit / 2 back / 2 related |
| `.../vllm_RTFS/vllm_RTFS.md` | 1 “link” | 0% | False positive: `[[100, 101, ...]]` array text, not a note |
| `P000_Public/首页.md` | 0 | — | In graph (backlink only) |
| `P000_Public/P001_DailyNews/00_索引.md` | 1 | 0% | Placeholder target `路径`, not a real note |

Allow-dir marker census (paths only): ≈176 files with
`note-assistant:index:start` under A/B/D/P/V/Z; **0** files with issued
`<!-- note-assistant:start -->` related blocks right now (matches graph
`notesWithBlocks: 0`). ≈159 `moc: true` notes under the allow tops sampled.

## 3. Noto vs tpl note-assistant / RooB habits — concrete gaps

Surfaces checked on current `main` (post MOC graph-rail):
`wiki-link-plugin`, `wiki-target` (+ `wikiTargetFor`), `QuickOpen` Alt+Enter,
`RailLinks` + `seed-links` + `note-graph` (`linksFor` / `deriveLinksFor`),
`index-block` (index vs related families) + HTML comment quieting in `html-view`.

| Habit (RooB / typora-plugin-lite) | Noto today | Gap |
|---|---|---|
| Follow `[[target]]` / `[[target\|label]]` without rewriting bytes | Decorations in `wiki-link-plugin.ts`; Cmd/Ctrl-click | **OK** — right risk model |
| Resolve note-relative then root then name | `wikiCandidates` in `wiki-target.ts` | **OK** for MOC `../A000/...` links |
| Related panel from `.note-assistant/graph.json` | `note-graph.ts` + `RailLinks`; **#14** seeds **Links to** from in-note wiki when `graph.notes` misses a MOC; **MOC graph-rail** additionally derives **Linked from** / **Related** by scanning other rows’ `explicitLinks` and related/candidate edges that point at the hub path (or bare title alias); when note-assistant emits lightweight hub rows, `linksFor` / `known: true` also works | **Closed** — Noto rail + RooB data (hub rows + MOC-pointing `explicitLinks` after 2026-09-11 note-assistant fix). Rebuild local `graph.json` to pick up; file stays gitignored |
| Issued in-note `<!-- note-assistant:start -->` Related Notes blocks | **#14** `index-block.ts` keeps `index:*` vs bare `note-assistant:start/end` as distinct families; related draws `.noto-related` chrome | **Closed** (chrome distinct); vault still has **0** issued related blocks, so unexercised in RooB |
| Directory / MOC indexes as compact read-only UI | `index-block` widget + click `onFollow`; caret restores source | **Mostly OK** — 100+ link MOCs are the intended shape. #17 stub scroller helps **large documents** when far-off blocks leave the viewport; it does **not** virtualize *inside* one index widget |
| Quiet HTML comment markers | `isHtmlComment` in `html-view.ts` | **OK** |
| Quick open → insert wiki link (Alt+Enter / `[[` trigger) | **#14** inserts note-relative `wikiTargetFor` targets with `\|title` when the path is not the bare name (wiki-trigger / QuickOpen) | **Closed** |
| Rebuild graph from editor | Typora plugin rebuild shortcut | **Not in Noto** (out of scope unless productized) |
| Tags line inside related blocks | Related chrome can show tags when present; Rail graph titles otherwise | N/A while sparse blocks = 0 |

#14 closed MOC Links seed, distinct related chrome, and Alt+Enter note-relative
insert. MOC graph-rail closes the remaining rail gap on the Noto side (derive
backlinks / inverse-related from existing edges; honest empty Related; no
regression for notes that already have graph rows). RooB note-assistant
(2026-09-11) now keeps hubs in the resolve map and emits lightweight MOC rows,
so rebuilt `graph.json` carries hub edges for the rail.

## 4. Three scenarios — pass / fail / risk

### A. Related panel

- **Pass (narrow):** Opening an eligible content note that exists in
  `graph.notes` (e.g. the TCP-tuning sample) can populate Linked from / Links
  to / Related from the same `graph.json` Typora’s plugin reads.
- **Pass (hub Links to, #14):** Preferred MOCs absent from `graph.notes` seed
  RailLinks **Links to** from in-note wiki targets (`seed-links`).
- **Pass (hub Linked from / Related, Noto):** When other graph rows carry
  edges aimed at the hub path, `deriveLinksFor` fills Linked from and/or
  Related while `known` stays false; Related is omitted when empty; non-MOC
  notes still use `linksFor` unchanged.
- **Pass (RooB vault data, 2026-09-11):** Allow-dir rebuild yields lightweight
  hub rows + MOC-pointing `explicitLinks` (e.g. `代理与隧道` inbound from
  mihomo README). Hub `linksFor` / derive fallback both have edges to read.
  Related on hubs stays sparse unless candidate/related scores point at the
  hub — Linked from is the main win.
- **Risk:** Stale local `graph.json` still shows empty hub Linked from until
  rebuild. Noto will not rebuild the vault graph in-app.

### B. Read-only index

- **Pass:** Index markers are recognized (old + new families); region is
  decoration/widget only; file bytes stay untouched while caret is outside;
  119-link MOC is structurally what the widget was built for; HTML comment
  markers stay quiet.
- **Risk:** Performance/UX on very large **single** index widgets still not
  measured in-app; #17 stub scroller does not slice inside one widget.
  Related vs index chrome is no longer conflated (#14). False-positive
  `[[digits, digits, ...]]` array text in code-heavy notes (vllm sample) is
  ignored by the wiki decoration scanner.

### C. Byte-for-byte unchanged

- **Pass (display path):** Wiki links and index UI are decorations/widgets;
  they cannot rewrite saved bytes by themselves — matches the wiki-plugin
  design comment and the index-block “pipeline never sees a difference” claim.
- **Risk (edit path):** Untouched blocks stay byte-exact; **edited** blocks
  still go through the serializer dialect (documented in `typora-gap.md`).
  Stress here is “open hub → click around → save without editing” should be
  clean; “touch one list item inside an index region” re-enters source and
  can diverge if the author saves after an accidental edit.

## 5. Recommendations

1. **MOC / Links UX:** **Done in #14** for outbound seed (`seed-links`);
   **done in Noto** for derived Linked from / Related when edges exist;
   **done in RooB note-assistant (2026-09-11)** for resolve-map hubs +
   lightweight MOC rows (no related-block issuance into hub files).
2. **Keep marker families distinct:** **Done in #14** (`index` vs `related`
   chrome in `index-block.ts`).
3. **QuickOpen Alt+Enter parity:** **Done in #14** (`wikiTargetFor` + `\|title`).
4. **Ignore digit-array false positives:** **Done** — `findWikiLinks` skips
   targets that are only a comma-separated list of integers (optional spaces),
   so RTFS-style `[[100, 101, ...]]` no longer decorates as a wiki link.
5. **Do not** commit RooB `.note-assistant/graph.json`; rebuild locally for
   tests as done here.

## 6. What was not done

- No deny-dir reads; no `vault.mjs lint` full-vault write.
- No RooB commit; no apply-graph / AI enrich.
- No in-app vault graph rebuild (read-only scan of existing `graph.json` only).

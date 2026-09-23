# Markdown golden fixtures (A/B gates)

Small public fixtures for comparing the **micromark** product path against
`NOTO_MARKDOWN_ENGINE=roobli-md` before default-on.

| File | Covers |
| ---- | ------ |
| `headings.md` | ATX headings + following paragraph |
| `lists.md` | bullet / ordered / task lists |
| `tables.md` | GFM table + trailing paragraph |
| `wiki.md` | `[[wiki]]` / aliased wiki in paragraphs |
| `math-fences.md` | display math `$$` + fenced code |
| `frontmatter.md` | YAML frontmatter + body |
| `cjk.md` | CJK + Latin mixed heading/lists/table/wiki |
| `alerts.md` | GitHub alerts (`[!NOTE]` / `[!TIP]` / `[!WARNING]`) |
| `footnotes.md` | footnote references + definitions |
| `indented-code.md` | indented code block (not fenced) |
| `tight-quotes.md` | adjacent plain quote, callout, multi-line quote |
| `gfm-inline.md` | GFM strikethrough + bare / bracketed autolinks |
| `nested-lists.md` | nested bullet and nested ordered (same-marker family) |
| `html-blocks.md` | HTML block + HTML comment block |
| `cjk-wiki.md` | denser CJK + wiki in heading/list/table |
| `callouts-edge.md` | IMPORTANT / CAUTION / multi-line / title-marker edge |
| `hr-setext.md` | setext `===` heading + thematic breaks (`***` / `---` / `___`) |
| `simple-setext-dash-headings.md` | setext level-2 (`text` + `---` / `-`) + standalone thematic breaks; closes Phase 15 intentional gap |
| `link-defs.md` | reference links + link definition blocks |
| `trailing-spaces.md` | trailing spaces stripped; soft break (single newline, no hard break) |
| `simple-quotes.md` | simple `>` quotes (single / continuation / multi-para / indent / trailing spaces / CJK); no nested, lists, or callouts |
| `simple-nested-quotes.md` | nested plain `>` quotes (any reasonable depth; sibling nests; blank separators); no callouts, lists-in-quotes, marks, or lazy continuations |
| `simple-lists-in-quotes.md` | simple bullet/ordered/task lists inside `>` quotes (incl. same-family nest); no callouts, marks, hard breaks, or lazy continuations |
| `simple-hard-breaks-in-quotes.md` | hard breaks (two trailing spaces) inside simple `>` quotes (incl. nested plain); no callouts, marks, lists-in-quotes with hard breaks, or lazy continuations |
| `simple-lazy-continuations-in-quotes.md` | CommonMark lazy continuation of nested plain `>` paragraphs via fewer `>` markers (incl. hard-break lazy); no no-`>` lazy, marked lazy, or lazy-into-list |
| `simple-hard-breaks-in-lists.md` | hard breaks (two trailing spaces) inside simple flat / nested list items (incl. task / ordered); no marked items or multi-para |
| `simple-hard-breaks-in-footnotes.md` | hard breaks inside simple `[^id]:` footnote definition bodies; soft-wrap still covered; no marked bodies |
| `simple-callouts.md` | plain-body GFM alerts / callouts (`> [!NOTE]` …); no marks, collapsible `-`, or titled alerts |
- `simple-titled-collapsible-callouts.md` — collapsible `[!NOTE]-`/`+` and plain same-line titles owned on the flagged IR→PM path.
- `simple-marked-callout-titles.md` — same-line callout titles with simple marks / wiki / autolinks owned on the flagged IR→PM path; heavy titles stay dialect.
| `simple-marked-phrasing.md` | flat `**` / `*` / `~~` / `` ` `` marks in paragraphs, headings, lists, tables, callouts, footnotes; underscore covered separately; one-/two-/three-/four-/five-/six-/seven-/eight-/nine-/ten-/eleven-/twelve-/thirteen-/fourteen-/fifteen-/sixteen-level nest in `simple-nested-marks.md` / `simple-two-level-nested-marks.md` / `simple-three-level-nested-marks.md` / `simple-four-level-nested-marks.md` / `simple-five-level-nested-marks.md` / `simple-six-level-nested-marks.md` / `simple-seven-level-nested-marks.md` / `simple-eight-level-nested-marks.md` / `simple-nine-level-nested-marks.md` / `simple-ten-level-nested-marks.md` / `simple-eleven-level-nested-marks.md` / `simple-twelve-level-nested-marks.md` / `simple-thirteen-level-nested-marks.md` / `simple-fourteen-level-nested-marks.md` / `simple-fifteen-level-nested-marks.md` / `simple-sixteen-level-nested-marks.md`; no links / wiki |
| `simple-underscore-emphasis.md` | flat `__strong__` / `_em_` + snake_case literal; one-level nest covered in `simple-nested-marks.md` |
| `simple-inline-links.md` | simple `[text](url)` / `![alt](url)` (optional title; plain or simple-marked link text) in para/heading/list/quote |
| `simple-bare-autolinks.md` | simple bare `http(s)://…` autolinks (text === href; trailing punct trim) in para/heading/list/quote with plain or simple-marked surrounds |
| `simple-angle-autolinks.md` | simple angle-bracket `<http(s)://…>` autolinks (text === href; brackets not in text) in para/heading/list/quote with plain or simple-marked surrounds |
| `simple-www-autolinks.md` | simple GFM `www.…` autolinks (href `http://www.…`; trailing punct trim) in para/heading/list/quote with plain or simple-marked surrounds; alnum-previous stays literal |
| `simple-email-autolinks.md` | simple GFM bare email + CommonMark angle `<user@host>` / `<mailto:…>` autolinks in para/heading/list/quote; `NDCG@10` / `user@localhost` stay literal |
| `simple-reference-links.md` | simple `[text][id]` / `[text][]` / `![alt][id]` / `![alt][]` (plain or simple-marked label) in para/heading/list/quote + matching link-defs; shortcut bare `[text]` / nested-bracket / footnotes stay dialect |
| `simple-wiki-links.md` | simple `[[target]]` / `[[target|alias]]` (literal text; decoration displays) in para/heading/list/quote with plain or simple-marked surrounds; nested-bracket wiki stay dialect |
| `simple-nested-marks.md` | one-level nested marks (`**bold _em_**`, `*em **strong** em*`, `` **`code`** ``) in para/heading/list/table/callout/footnote; two-/three-/four-/five-/six-/seven-/eight-/nine-/ten-/eleven-/twelve-/thirteen-/fourteen-/fifteen-/sixteen-level in sibling fixtures; `***` / same-delimiter / seventeen+ / links / wiki stay dialect |
| `simple-two-level-nested-marks.md` | two-level nested marks (`**bold *em ~~strike~~ more* bold**`, `*em **bold _nested_** more*`, code inside nested em) in para/heading/list/table/callout/footnote; three-/four-/five-/six-/seven-/eight-/nine-/ten-/eleven-/twelve-/thirteen-/fourteen-/fifteen-/sixteen-level in sibling fixtures; `***` / same-delimiter / seventeen+ stay dialect |
| `simple-three-level-nested-marks.md` | three-level nested marks (`**a *b ~~c _d_ c~~ b* a**`, `~~del **bold *em* rest** del~~`) in para/heading/list/table/callout/footnote; four-/five-/six-/seven-/eight-/nine-/ten-/eleven-/twelve-/thirteen-/fourteen-/fifteen-/sixteen-level in sibling fixtures; `***` / same-delimiter / seventeen+ stay dialect |
| `simple-four-level-nested-marks.md` | four-level nested marks (`**a *b ~~c _d `e` d_ c~~ b* a**`, `*em **bold ~~del _x `y` x_~~ more** rest*`) in para/heading/list/table/callout/footnote; five-/six-/seven-/eight-/nine-/ten-/eleven-/twelve-/thirteen-/fourteen-/fifteen-/sixteen-level in sibling fixtures; `***` / same-delimiter / seventeen+ stay dialect |
| `simple-five-level-nested-marks.md` | five-level nested marks (`**v *w ~~x _y *z `a` z* y_ x~~ w* v**`, `*em **bold ~~del _x *y `z` y* x_~~ more** rest*`) in para/heading/list/table/callout/footnote; six-/seven-/eight-/nine-/ten-/eleven-/twelve-/thirteen-/fourteen-/fifteen-/sixteen-level in sibling fixtures; `***` / same-delimiter / seventeen+ stay dialect |
| `simple-six-level-nested-marks.md` | six-level nested marks (`**u *v ~~w _x *y _z `a` z_ y* x_ w~~ v* u**`, `*em **bold ~~del _x *y _z `a` z_ y* x_~~ more** rest*`) in para/heading/list/table/callout/footnote; seven-/eight-/nine-/ten-/eleven-/twelve-/thirteen-/fourteen-/fifteen-/sixteen-level in sibling fixtures; `***` / same-delimiter / seventeen+ stay dialect |
| `simple-seven-level-nested-marks.md` | seven-level nested marks (`**t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t**`, `*em **bold ~~del _x *y _z *w `a` w* z_ y* x_~~ more** rest*`) in para/heading/list/table/callout/footnote; eight-/nine-/ten-/eleven-/twelve-/thirteen-/fourteen-/fifteen-/sixteen-level in sibling fixtures; `***` / same-delimiter / seventeen+ stay dialect |
| `simple-eight-level-nested-marks.md` | eight-level nested marks (`**s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s**`, `*em **bold ~~del _x *y _z *w _v `a` v_ w* z_ y* x_~~ more** rest*`) in para/heading/list/table/callout/footnote; nine-/ten-/eleven-/twelve-/thirteen-/fourteen-/fifteen-/sixteen-level in sibling fixtures; `***` / same-delimiter / seventeen+ stay dialect |
| `simple-nine-level-nested-marks.md` | nine-level nested marks (`*r **s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s** r*`, `**em *bold ~~del _x *y _z *w _v *u `a` u* v_ w* z_ y* x_~~ more* rest**`) in para/heading/list/table/callout/footnote; ten-/eleven-/twelve-/thirteen-/fourteen-/fifteen-/sixteen-level in sibling fixtures; `***` / same-delimiter / seventeen+ stay dialect |
| `simple-ten-level-nested-marks.md` | ten-level nested marks (`_q *r **s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s** r* q_`, `*em **bold ~~del _x *y _z *w _v *u _t `a` t_ u* v_ w* z_ y* x_~~ more** rest*`) in para/heading/list/table/callout/footnote; eleven-/twelve-/thirteen-/fourteen-/fifteen-/sixteen-level in sibling fixtures; `***` / same-delimiter / seventeen+ stay dialect |
| `simple-eleven-level-nested-marks.md` | eleven-level nested marks (`**p _q *r **s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s** r* q_ p**`, `_p *em **bold ~~del _x *y _z *w _v *u _t `a` t_ u* v_ w* z_ y* x_~~ more** rest* p_`) in para/heading/list/table/callout/footnote; twelve-/thirteen-/fourteen-/fifteen-/sixteen-level in `simple-twelve-level-nested-marks.md` / `simple-thirteen-level-nested-marks.md` / `simple-fourteen-level-nested-marks.md` / `simple-fifteen-level-nested-marks.md` / `simple-sixteen-level-nested-marks.md`; `***` / same-delimiter / seventeen+ stay dialect |
| `simple-twelve-level-nested-marks.md` | twelve-level nested marks (`*o **p _q *r **s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s** r* q_ p** o*`, `**o _p *em **bold ~~del _x *y _z *w _v *u _t `a` t_ u* v_ w* z_ y* x_~~ more** rest* p_ o**`) in para/heading/list/table/callout/footnote; thirteen-/fourteen-/fifteen-/sixteen-level in `simple-thirteen-level-nested-marks.md` / `simple-fourteen-level-nested-marks.md` / `simple-fifteen-level-nested-marks.md` / `simple-sixteen-level-nested-marks.md`; `***` / same-delimiter / seventeen+ stay dialect |
| `simple-thirteen-level-nested-marks.md` | thirteen-level nested marks (`_n *o **p _q *r **s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s** r* q_ p** o* n_`, `*n **o _p *em **bold ~~del _x *y _z *w _v *u _t `a` t_ u* v_ w* z_ y* x_~~ more** rest* p_ o** n*`) in para/heading/list/table/callout/footnote; fourteen-/fifteen-/sixteen-level in `simple-fourteen-level-nested-marks.md` / `simple-fifteen-level-nested-marks.md` / `simple-sixteen-level-nested-marks.md`; `***` / same-delimiter / seventeen+ stay dialect |
| `simple-fourteen-level-nested-marks.md` | fourteen-level nested marks (`**m _n *o **p _q *r **s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s** r* q_ p** o* n_ m**`, `_m *n **o _p *em **bold ~~del _x *y _z *w _v *u _t `a` t_ u* v_ w* z_ y* x_~~ more** rest* p_ o** n* m_`) in para/heading/list/table/callout/footnote; fifteen-/sixteen-level in `simple-fifteen-level-nested-marks.md` / `simple-sixteen-level-nested-marks.md`; `***` / same-delimiter / seventeen+ stay dialect |
| `simple-fifteen-level-nested-marks.md` | fifteen-level nested marks (`*l **m _n *o **p _q *r **s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s** r* q_ p** o* n_ m** l*`, `**l _m *n **o _p *em **bold ~~del _x *y _z *w _v *u _t `a` t_ u* v_ w* z_ y* x_~~ more** rest* p_ o** n* m_ l**`) in para/heading/list/table/callout/footnote; sixteen-level in `simple-sixteen-level-nested-marks.md`; `***` / same-delimiter / seventeen+ stay dialect |
| `simple-sixteen-level-nested-marks.md` | sixteen-level nested marks (`_k *l **m _n *o **p _q *r **s _t *u ~~v _w *x _y *z `a` z* y_ x* w_ v~~ u* t_ s** r* q_ p** o* n_ m** l* k_`, `*k **l _m *n **o _p *em **bold ~~del _x *y _z *w _v *u _t `a` t_ u* v_ w* z_ y* x_~~ more** rest* p_ o** n* m_ l** k*`) in para/heading/list/table/callout/footnote; `***` / same-delimiter / seventeen+ stay dialect |
| `simple-flat-lists.md` | flat bullet/ordered/task lists (markers `-*+`, `.`/`)`, start≠1, loose, soft-wrap); no nest or marked items |
| `simple-nested-lists.md` | same-family nested bullet/ordered at any depth (plain items; soft-wrap then nest; depth-2+); no marked items |
| `simple-mixed-marker-nested-lists.md` | mixed-marker nests (bullet under ordered / ordered under bullet / deep mix); closes Phase 16 intentional gap; plain items only |
| `simple-gfm-tables.md` | simple GFM pipe tables (align row; plain cells; indent; compact); no marked/ragged cells |
| `simple-ragged-tables.md` | ragged body rows (short / long cell counts) on simple GFM tables owned on the flagged IR→PM path |
| `simple-table-header-delim-columns.md` | GFM table header/delimiter column-count parity (`@roobli/md` ≥ v0.1.14 Phase 17): mismatched counts stay paragraph; matching counts + ragged body stay table; mismatch does not interrupt a preceding paragraph |
| `simple-math-html-in-tables.md` | simple `$…$` / `$$…$$` and simple inline HTML tags inside GFM table cells owned on the flagged IR→PM path (docs previously claimed dialect — stale) |
| `simple-footnote-defs.md` | simple `[^id]:` footnote definitions (plain body, soft-wrap, cased label) |
| `empty-footnote-defs.md` | empty / whitespace-only `[^id]:` footnote definitions (cased label) |
| `cjk-emphasis.md` | Typora-shaped CJK flanking strong (`**注意：**…`) + mixed emphasis |
| `hard-breaks.md` | hard break (two trailing spaces) + soft break + mixed soft/hard |
| `images.md` | inline image + reference image + link-def |
| `empty-fence.md` | empty fenced code (plain + language) |
| `escapes.md` | backslash-escaped emphasis / code / brackets / pipe |
| `simple-escapes.md` | simple CommonMark backslash escapes (ASCII punctuation + `\\` hard breaks) owned on the flagged IR→PM path; math / multi-line HTML stay dialect |
| `simple-escapes-in-tables.md` | escaped `|` inside simple GFM table cells owned on the flagged IR→PM path |
| `simple-inline-html.md` | simple single-line inline HTML (`<span>`, `</span>`, `<br/>`, comments) owned on the flagged IR→PM path; multi-line / exotic HTML stay dialect |
| `simple-inline-math.md` | simple inline math (`$…$` / `$$…$$`) owned on the flagged IR→PM path; multi-line HTML stay dialect |
| `simple-image-alts.md` | simple image alts with math / marks / escapes / literal HTML (micromark-equivalent plain alt string) in para/heading/list/quote/table + reference forms; nested-bracket / `***` / unmatched stay dialect |
| `table-align.md` | GFM table with left / center / right alignment |
| `ordered-start.md` | ordered list starting at 2 |
| `fence-meta.md` | fenced code with language + meta info string |
| `html-inline.md` | inline HTML inside a paragraph |

## Intentional diffs

Documented engine gaps **not** shipped as strict golden fixtures (samples kept
out of this directory so the suite stays loud-fail-only on match):

1. ~~**Setext level-2 (`text` + `---`) vs thematic-break**~~ — **closed** in
   `@roobli/md` v0.1.12 (Phase 15). Covered by `simple-setext-dash-headings.md`
   (setext `---` / single `-` plus standalone thematic breaks).
2. ~~**Mixed-marker nested lists**~~ — **closed** in `@roobli/md` v0.1.13
   (Phase 16). Covered by `simple-mixed-marker-nested-lists.md` (bullet under
   ordered / ordered under bullet / deep mix). Same-family nests remain in
   `simple-nested-lists.md`.
3. ~~**GFM table header/delimiter column-count**~~ — **closed** in
   `@roobli/md` v0.1.14 (Phase 17). Covered by
   `simple-table-header-delim-columns.md` (mismatched counts → paragraph;
   matching + ragged body → table; mismatch does not interrupt a preceding
   paragraph).

Every fixture **in this directory** is expected to match on:

1. split span boundaries (`start` / `end` / `markdown` / `kind`) and gaps
2. identity `serializeDocument` `outputBytes` (flagged path from Noto #82)
3. multi-block serialize `outputBytes` — multi-dirty (first+last), insert after
   first block, and delete of the middle block when the fixture has ≥3 blocks

If a future fixture must diverge, document it here and exclude it from the
strict suite (or assert the documented delta explicitly) — silent drift is not
allowed.
- `simple-no-marker-lazy-in-quotes.md` — true no-`>` lazy inside quotes (needs `@roobli/md` ≥ v0.1.9)
- `simple-lazy-list-continuations.md` — unindented CommonMark lazy soft-wrap in lists

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
| `link-defs.md` | reference links + link definition blocks |

## Intentional diffs

Documented engine gaps **not** shipped as strict golden fixtures (samples kept
out of this directory so the suite stays loud-fail-only on match):

1. **Setext level-2 (`text` + `---`) vs thematic-break** — micromark treats a
   short underdash run as setext heading; `@roobli/md` may split paragraph +
   `thematic-break`. Strict fixture uses setext `===` only, plus unambiguous
   thematic breaks on their own lines.
2. **Mixed-marker nested lists** — an ordered list whose children are indented
   bullet lists can stay one ordered span under micromark but split into
   ordered / bullet / ordered under `@roobli/md`. Strict fixture nests
   same-family markers only (bullet-under-bullet, ordered-under-ordered).

Every fixture **in this directory** is expected to match on:

1. split span boundaries (`start` / `end` / `markdown` / `kind`) and gaps
2. identity `serializeDocument` `outputBytes` (flagged path from Noto #82)
3. multi-block serialize `outputBytes` — multi-dirty (first+last), insert after
   first block, and delete of the middle block when the fixture has ≥3 blocks

If a future fixture must diverge, document it here and exclude it from the
strict suite (or assert the documented delta explicitly) — silent drift is not
allowed.

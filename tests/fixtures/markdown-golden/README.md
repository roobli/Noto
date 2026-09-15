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

## Intentional diffs

None yet. Every fixture in this directory is expected to match on:

1. split span boundaries (`start` / `end` / `markdown` / `kind`) and gaps
2. identity `serializeDocument` `outputBytes` (flagged path from Noto #82)
3. multi-block serialize `outputBytes` — multi-dirty (first+last), insert after
   first block, and delete of the middle block when the fixture has ≥3 blocks

If a future fixture must diverge, document it here and exclude it from the
strict suite (or assert the documented delta explicitly) — silent drift is not
allowed.

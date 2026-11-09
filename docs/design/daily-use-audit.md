# Daily use against Typora: the audit of 2026-10-27

`typora-gap.md` closed the gaps you can see in a still frame. This audit asked a different question: what makes a day of writing in Noto worse than a day in Typora, for an author who knows Typora's keys by heart? It drove the packaged app (v0.0.4-alpha.1, ce6dfe7) through Playwright against a copy of about 900 of the author's notes. The copy included long Chinese notes with hundreds of fences, table-heavy notes, notes with local images and math, and a 2.9 MB reference dump. The app ran at 1440×900 and at the 720×560 minimum, light and dark.

The look and the speed are not the problem. Notes of 80 to 130 KB open in 120 to 170 ms, and a cold start reaches an open document in about 450 ms. From keystroke to the next frame the median is 3 to 13 ms and the p95 is at most 26 ms. Wheel scrolling holds 16.7 ms frames even in the 2.9 MB note. Muted text keeps a contrast of at least 4.5:1 in both themes, and the type, the tree and the chrome match what `typora-gap.md` measured.

What makes Noto feel worse is typing, and state that does not belong to the note.

## Patterns

Typing ran on a regex over the last keystroke, with no Markdown parser in the loop. Inline marks were applied by rules that deleted from the start of the match, and that start included a guard character. No rule applied CommonMark's flanking. Block rules fired only on a typed space. Links had no rule. Auto-pair ran after the rules, so it never knew that a rule had just closed a pair. Findings 1 to 5 and 12 all come from this design. The load path already parses with micromark; the typing path should converge on the same rules.

Defaults were set against the author's habits, and in one case against Noto's own documented intent. Smart punctuation shipped on, although the input rules said it was off. The rail starts hidden, no note is reopened at launch, single-dollar math is on, and Typora's macOS keys are partly reassigned.

View state is not owned per document. The scroll offset belongs to the shared canvas rather than to the note, source mode does not map position, and a rename does not refresh the title.

Commands live in the menu bar only. The palette, the context menu and the keymap are not fed from one registry, so a command without a Typora key is reachable only by mouse.

## Findings, ranked by daily-use impact

| # | Surface | What happens | Severity | Status |
| --- | --- | --- | --- | --- |
| 1 | Typing `*em*` or `_em_` | Deletes the character before the opener: `中文*斜体*` saved as `中*斜体*`, `2*3*4` as `*3*4`, `a*a* b` as `a b` | Blocks daily use | Closed 2026-10-27 |
| 2 | Typing `snake_case_name` | Becomes italics and loses a letter: `snak*case*name` | Blocks daily use | Closed 2026-10-27 |
| 3 | Auto-pair with backticks | Leaves a stray backtick after `` `x` ``; ```` ``` ```` shows four, and the spare one lands in the code block | Blocks daily use | Closed 2026-10-27 |
| 4 | ```` ```js ```` then Return | No code block; the rule fired only on a space. `$$` then Return, the same | Blocks daily use | Closed 2026-10-27 |
| 5 | Typing `[text](url)` | Stays text and saves escaped, `\[text]\(https\://…)`, while pasting the same text works | Blocks daily use | Closed 2026-10-27 for links; a typed inline tag (`<kbd>`) is still escaped |
| 6 | Smart punctuation | Shipped on: `"--flag"` saved as `“—flag”` | Annoys daily | Closed 2026-10-27 for new installs; an existing settings file keeps its stored value |
| 7 | Switching notes | A note opens at the previous note's scroll offset; Back does not restore yours | Annoys daily | Closed 2026-11-09: each note keeps the top block and offset at the top of the page, per open note and by path for later launches (`reading-anchors.ts`) |
| 8 | Cmd+/ (source mode) | Toggling there and back lands about 14,000 px away from where you were | Annoys daily | Closed 2026-11-09: the place on the way into source mode is put back on the way out; a caret moved out of view is brought into it |
| 9 | Launch | Restores the folder but opens no note and keeps the rail hidden; after a folder opens, the empty page still says "Open a folder" | Annoys daily | Closed 2026-11-09: a launch reopens the note in front at the last quit, at its place; an open folder with no note offers its index note, recent notes, New Note and Find a Note |
| 10 | Cmd+N | Focus stays outside the editor, and `Untitled.md` is written at the vault root at once | Annoys daily | Closed before 2026-11-09 (new-note specs): the note is made beside the note in front, named on its row, then takes the keys |
| 11 | Quick open | Any query with a space returns nothing (`docker es`) | Annoys daily | Closed 2026-11-09: each word matches the name or the path on its own |
| 12 | Dollar amounts | `$8,000 - $50,000` renders as math; 694 lines in 124 of the author's notes match | Annoys daily | Closed 2026-11-09: Pandoc's dollar rule in both parsers and while typing; an edited line of prices saves without backslashes |
| 13 | Typora's macOS keys | Shift+Cmd+O opens the outline, F8/F9 do nothing, Cmd+\ does nothing, Cmd+]/[ change the page width outside a list | Annoys daily | Closed 2026-11-09: F8, F9, ⌃⌘1 for the outline, ⇧⌘O for Quick Open on a Mac, ⌘\ for Clear Format; Wider and Narrower stay on the brackets, as in the author's own Typora plugin |
| 14 | Narrow window | The rail covers a third of the page and stays after a pick or Escape | Annoys daily | Closed 2026-11-09: a pick in the tree or outline and Escape put the laid-over rail away; the page behind is dimmed |
| 15 | Command palette | Holds export, git and plugin commands only; "focus" finds nothing | Annoys daily | Closed 2026-11-09: the palette lists every menu command with its keys and runs it through the menu |
| 16 | Rename the open note | The title bar keeps the old name | Annoys daily | Closed before 2026-11-09; checked 2026-11-09 by renaming the open note with F2 |
| 17 | File tree | No keyboard model: arrows, Enter and F2 do nothing | Polish | Closed 2026-11-09: a tree with one Tab stop; arrows, Home, End, F2 and typing a name |
| 18 | Editor context menu | Clipboard items only | Polish | Closed 2026-11-09: Format, Paragraph and Insert submenus from the menu bar, Copy as Markdown over a selection |
| 19 | Tree, sideways swipe | Names slide under pinned icons and read garbled | Polish | Fixed 2026-11-06: the rail no longer scrolls sideways; names are cut keeping their end and shown whole on a rest |
| 20 | Paste HTML code | `language-*` is dropped from the fence | Polish | Open |
| 21 | Cmd+Down in a 2.9 MB note | Stops at the end of the mounted range | Polish | Open |

The rail and title bar fix of the same day (gap 16 in `typora-gap.md`) came from the author's own side-by-side capture, not from this audit.

## What it could not test

Real macOS IME composition was simulated through CDP, not exercised through the native input client. Native menu accelerators were read from the live menu rather than pressed. Native context menus were captured as templates. Typora was not driven, so comparisons rest on `typora-gap.md`, the author's theme, Typora's own stylesheets and its documented defaults. Drag from Finder, multiple windows and screen readers were not exercised.

## How to use this list

Work it top down. Each finding is closed the way the parity run closed gaps: reproduce it in a test that types or clicks as a person would and fails, fix the cause, then mark the row closed with the date. The typing fixes added `tests/unit/input-rules.test.ts`, which types character by character through the editor's own input rules and auto-pair, in the editor's order, and checks the Markdown that would be saved. New typing findings belong there first.

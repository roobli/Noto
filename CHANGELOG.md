# Changelog

What changed in Noto, for the person updating. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Engine-level detail
lives in [`@roobli/md`'s changelog](https://github.com/roobli/md/blob/main/CHANGELOG.md).

How releases are made, and what each channel receives, is in
[RELEASING.md](RELEASING.md). The first release outside alpha is `0.0.3`; it is not signed or notarized yet.

## [Unreleased]

### Added

- View > Show Git Changes, and a Git changes switch in Settings > Editor,
  hide the bars beside changed blocks and the marks on changed notes in the
  tree, for a clean screenshot. Turned back on, the current changes show at
  once.

- File > Refresh Folder (Cmd-Alt-R) reads the open folder again: the tree,
  Quick Open and the git marks. The folder was already followed on disk; this
  is the same work on request.
- Plugins can add to the editor. A trusted plugin registers an editor
  extension (ProseMirror plugins and named commands) that every open note
  picks up at once and drops when the plugin is switched off.
- **See a note's unsaved changes before saving them.** While a note has
  unsaved changes, its name in the title bar opens them, as does Show Unsaved
  Changes in the command palette. Three layouts: side by side, stacked with
  the saved file above the note, and inline with what went struck through and
  what came marked where it happened. Each changed block is marked, and inside
  an edited block the words that changed are marked too (Chinese a character at
  a time). Pointing at a change lights it in both panes, the arrows (or N and
  P) step through the changes, long unchanged stretches fold away, and the view
  opens in the layout last chosen. Escape closes it.
- **Typora's `flow` and `sequence` diagrams draw.** The flowchart.js and
  js-sequence-diagrams fences Typora notes use are drawn as diagrams in the
  theme's colours, alongside mermaid. A line that is not their syntax is named
  in the message under the fence.
- **Web pages a note embeds with `<iframe>` show.** Typora notes embed pages
  with `<iframe>`, often scaled down inside a clipping `<div>` so a wide page
  fits, and both forms now draw. Pages do not load by themselves: each shows
  a card naming the site with a button that loads that one, until Load web
  pages embedded in notes is switched on under Images. A page loads in a
  sandboxed frame that cannot reach the app, open windows, download files or
  take the window anywhere; only `https:` pages qualify, and not ones on this
  machine or the local network (an address, `localhost`, `.local` and the
  like). While a block is being edited its pages wait until the caret leaves,
  so a half-typed address is never fetched.

- **Plugins you install yourself: from a folder, from GitHub, or from a
  marketplace.** Plugin Center can add a plugin from a folder you pick, from a
  GitHub repository (or a folder in one), or from a marketplace, a GitHub
  repository whose `index.json` lists plugins (set under Settings as
  `pluginMarketplace`, `roobli/noto-plugins` by default). Each shows what the
  plugin may do before anything is written, installs switched off, and loads
  at the next start; a marketplace entry can pin the code's digest, and the
  install is refused unless it matches. Installed plugins run sandboxed, in a
  worker with no page, no app API and no network, reach the note only
  through the capabilities their manifest declares, and cannot add a web
  address to a note, where the page would fetch it. A plugin installed or
  updated starts switched off. A plugin can be trusted
  fully, after a warning, to run inside the editor as a bundled one does;
  trust ends by itself when its code changes. Plugins can also be dropped
  into the plugins folder by hand, and one that cannot load is listed with
  the reason. `docs/plugins.md` says how to write and publish one.
- **A board of every shortcut, each with a switch.** Settings has a
  Shortcuts pane listing every key the app answers to, grouped by the menu it
  sits in, with where each comes from (the menu, the editor, the window or a
  plugin) and the key written as the menu bar writes it. A search finds one by
  name, key or source. Switching one off frees the key everywhere it was
  bound: the menu stops claiming it and the editor and plugins ignore it, and
  Turn all back on undoes every change. Keys the app cannot do without, and
  the system's own (Copy, Quit), are listed as always on. The list is read
  from the menu and the keymap themselves, so it cannot drift from them, and
  a key held by two things is flagged.

### Changed

- Sidenotes are a bundled plugin, Sidenotes, switched on by default and
  turned off in Plugin Center rather than in Settings > Markdown. Its key,
  Cmd-Alt-S, wraps the selection in a note as before; the Format menu no
  longer lists it.
- File > New Note makes the note beside the note in front instead of at the
  root of the open folder.
- A press on a pinned row at the top of the tree brings that row back to its
  place instead of collapsing the folder under the pointer.
- **Settings use the window.** The panes' list is wider, grouped under General
  and Advanced, and marks the open pane with a filled pill. Each pane opens
  with its name and a line saying what it is for, and its settings sit in
  grouped cards on a wider column centred in the pane, where they were a
  narrow strip of rows.
- **Quick open is taller.** It lists up to thirty notes and grows to most of
  the window's height, where it showed twelve in a strip high on the page.
- **The log says why, and the remote control can debug.** A failed operation
  is logged with its reason, and opening and closing a note log how many are
  open; the log moves aside past 4 MB. The remote control has three read-only
  debug routes: the state of what is open with the last failures, the log's
  last events, and the window's recent console lines, held in memory only.
  `NOTO_REMOTE_PORT` gives a second copy of the app a port of its own.
- **Diagrams and pictures on a line of their own are centred.** A diagram is
  centred in the column, and so is a picture that stands alone on its line,
  whether written as markdown or as the `<img>` tag Typora pastes. A picture
  with words beside it stays in their run.

### Fixed

- A click on a note opens that note when another open note has the same
  bytes. Every new note starts empty, and so does an untouched copy of a
  template, so a working folder often holds several identical files. A
  note's identity was the hash of its bytes, so a click on the second empty
  note showed the first, the tree marked the first as the one in front, and
  a save could be routed to the wrong file. Each open note now has an
  identity of its own.
- Off macOS, Inline Math and Toggle Task Status no longer share Control-M
  and Control-X with Minimize and Cut, and Close Window no longer shares
  Control-W with Close Tab. They move to Alt+Shift+M, Alt+Shift+X and
  Control+Shift+W; macOS keeps Typora's keys.
- On Windows and Linux, a click far down a long note no longer scrolls the
  page. The blocks painted since the note opened (frontmatter, an opening
  fence) fell back to a one-line placeholder when the caret left them,
  because the browser there had not remembered their height. Each block now
  keeps the height it was painted at as its fallback.
- A click in a paragraph shows the source of the span it lands in and moves
  nothing else. Highlight, superscript, subscript and inline tags such as
  `<u>` and `<kbd>` showed every delimiter in the paragraph as soon as the
  caret entered it, so the words after each stepped right by its width.
  They now reveal one span at a time, as bold, emphasis, code and links
  already did.
- A note with a tab, a no-break space or a full-width space before `>` no
  longer freezes when it opens. The Markdown engine's quote test and quote
  strip disagreed on such a line and its loop never ended; fixed in
  `@roobli/md` 0.1.24, which also reads a space or a tab wherever CommonMark
  means one, so a line of full-width spaces no longer splits a paragraph.
- Quitting cannot hang on a step that never finishes. Each step of the
  shutdown (plugins, the plugin runtime, the service, settings) has a
  deadline and is logged when it runs past it.
- Unsaved edits are asked about before they are lost. Close Tab on an
  unsaved note asks Save, Don't Save or Cancel; quitting or closing the
  window with unsaved notes asks Review Changes or Discard and Quit; Trash
  says when it would close notes with unsaved edits. Nothing asked before,
  and autosave is off by default.
- A save lands on the note it was taken from. Moving to another note while a
  save was in flight marked that other note saved with this one's baseline.
  With autosave on, a note left with a save pending is saved.
- Reload from Disk discards unsaved edits when the file has not changed, as
  its confirm says, instead of keeping them.
- Quick Open finds a note Noto just made, duplicated or imported.
- Renaming a note to a name with a dot in it (`Meeting 3.5`) keeps its
  extension instead of making it vanish from the tree; a name starting with
  a dot is refused.
- Two opens of the same note at once share one, instead of leaving a stray
  copy that raised a false "Changed on disk".
- Reopen Closed File offers only notes the reader closed, and keeps one whose
  reopen failed.
- `noto notes.md` with Noto already running opens the notes.md beside the
  shell it was run from.
- A folder past the tree's 2000-entry cap lists the same rows every time.

- Sidenotes stay drawn in the margin wherever the caret is, and from the
  moment a note opens; they used to show only while the caret was in or next
  to their paragraph.
- Quick Open lists a folder's notes before anything is typed, instead of an
  empty panel for a folder nobody had opened a note from, and Backspace steps
  out of a nested folder one level at a time.
- **A plugin's saved state survives a plugin going away.** A saved state
  that named a plugin no longer installed was taken for damage, and every
  plugin failed at the next launch. The entry is now kept, so a plugin that
  comes back finds its switch where it was left.
- **Browse Tags has a key that works: Option-Shift-Command-T.** It shared
  Shift-Command-T with Reopen Closed File, which on macOS took the key, so
  tags could not be reached from the keyboard. The check for doubled keys
  compared the two spellings as text and missed it; it compares keys now.
- **Shift-Command-Up and Down select to the top and bottom again.** Title
  Shift's chords were caught even while the plugin was off, so the system's
  selection keys did nothing. A plugin's keys are now caught only while it is
  on.
- **A note opened after a settings change follows it.** Auto-pairing,
  typewriter mode and the check date reached only the notes already open
  when they changed; a note opened later started from the defaults.
- **The help panel's keys for Back and Forward are right.** It listed the
  bracket keys, which indent a list item; they are Option-Command and the
  arrows.
- **Notes open however many have been opened before.** Every note opened
  stayed loaded, and with no tab bar to close one, the 25th was refused, and
  the refusal was shown nowhere, so the tree simply stopped opening files. The
  window now keeps the twelve notes most recently in front and lets the older
  ones go, never one with unsaved changes. Opening another note no longer asks
  about losing the unsaved one, since nothing is lost, and a note that cannot
  be opened says why in the status line.
- **Enter with a Chinese input method types the letters.** Confirming what was
  typed with a Chinese, Japanese or Korean input method opened the first
  result in quick open, named a new note half-typed, and acted early in the
  command palette, find bar, rail search, tag browser, settings fields, a code
  block's language and the link editor. Each now leaves that Enter to the
  input method.
- **A click no longer makes the page jump.** The blocks around the caret
  forgot how tall they were, so after scrolling on and clicking elsewhere a
  table, a code block or the frontmatter above would shrink to one line, and
  the page and the caret jumped by that much; the first click below the top of
  a note did this almost every time. Blocks keep their size now, and the page
  stays where it was.
- **The tree lets go of the old branch when another note opens.** Folders on
  the path to the previous note kept their held band and lit elbow after a
  note in another folder was opened.
- **The tree's guide lines run through the folders held at the top of the
  sidebar.** A held folder row covered the whole width of the sidebar, so the
  vertical lines of every level above it disappeared and each held row was
  left with a short arm in empty space. The held row now starts at its own
  indent, as in Typora, and each one hangs off its line the way it does when
  it is not held.
- **Folder icons are solid again.** A leftover rule drew every folder at about
  a quarter of its colour, so the tree's folders read as pale smudges. Folder
  and note icons are now drawn in the same muted ink as the names, as Typora
  draws them, and an open folder keeps the same shape as a closed one; the
  arrow beside it says which.
- **A note's tags line up with its text.** The tags above a note were a
  centred strip of grey pills that hung off to the right of the page in the
  wide and full widths. They are now a quiet line of `#tag` words at the head
  of the page, starting where the text starts at every width, with no fill
  until the pointer is on one. A click still opens the notes that share it.

## [0.0.4-alpha.2] - 2026-10-27

Typing no longer changes what a note saves, the sidebar runs the full height
of the window again, and the folder follows notes renamed or moved outside
Noto. Out of the usual weekly rhythm because the typing fixes protect files.
Like `0.0.3`, it is not signed.

### Fixed
- **Typing no longer changes what is saved.** Five ordinary things did:
  emphasis deleted the character before it (`中文*斜体*` was saved as
  `中*斜体*`), an underscore inside a word became italics (`snake_case_name`
  was saved as `snak*case*name`), inline code left a stray backtick after the
  caret, three typed backticks showed four, and a typed `[text](url)` was
  saved escaped. Emphasis now follows CommonMark, and a typed link becomes a
  link when its closing parenthesis is typed.
- **The sidebar runs from the top of the window to the bottom**, with the
  window buttons on it, as in Typora and Finder. It used to start below a band
  across the whole window. The sidebar button stays where it is when the
  sidebar opens or closes, and the note's name is centred over the page.
- **The file tree, quick open and wiki links follow notes renamed or moved
  outside Noto**, in Finder, another editor or git, and after Noto's own
  renames, about a quarter of a second after the folder goes quiet. Quick open
  used to keep the folder as it was when it opened.

### Added
- **Return after a fence line opens a code block**, as in Typora: type
  ```` ```js ```` and press Return. `$$` and Return opens a math block.

### Changed
- **Smart quotes, dashes and ellipsis are off for new installs.** They change
  the bytes a note holds, and in technical notes the change is usually wrong
  (`"--flag"` became `“—flag”`). Turn them on in Settings → Markdown. A
  settings file that already holds a choice keeps it.

## [0.0.4-alpha.1] - 2026-10-25

The first alpha after `0.0.3`, on the Testing channel. Git changes show in the
file tree and beside each block, the command palette and narrow windows work
from the keyboard and at 720px, and a round of fixes makes saving, recovery
and what a note may read from disk safer. Like `0.0.3`, it is not signed.

### Added
- **The file tree shows what changed since the last commit** when the folder
  is in a git repository: an amber dot on a changed note, a green plus on a new
  one, and a ring on folders holding a change, including a deleted note.
  Noto only reads git, through the `git` command already installed, and never
  writes to the repository. Without git or a repository nothing is shown.
- **The open note shows which blocks changed since the last commit**: a thin
  solid amber line beside a changed block, a dashed green one beside a new block, and a
  small red marker where blocks were deleted. Pressing the line or the marker
  shows the block as committed, read-only; Escape closes it. From the
  keyboard, "Show Block as Committed" in the command palette does the same
  for the block holding the caret. The gutter compares the saved note, so it
  updates on save, and is not drawn for notes over 1 MB or notes git does not
  track.
- **A changed or deleted block can go back to how it was committed.** The
  popover from the gutter has "Revert to Committed", and "Revert Block to
  Committed" in the command palette does the same for the block at the caret.
  A new block offers "Remove Block". It is an ordinary edit: the note is
  unsaved until you save, and undo takes it back. Noto still never writes to
  the repository.

### Changed
- **Updates no longer install themselves while builds are unsigned.** On
  every platform, an update Noto finds opens its download on the release
  page, and the setting to download updates automatically is hidden. In-app
  install returns with signed builds. `0.0.3` itself can still install an
  update on macOS and Windows.
- **The command palette is a real dialog.** It takes the keyboard when it
  opens, so a key typed no longer lands in the note behind it. A field at the
  top filters the commands, the arrow keys and Enter pick one, and Escape,
  Close or a press outside puts it away and returns you to the note.
- **A narrow window keeps its files.** Below 900px wide the sidebar button
  stays, and the sidebar opens over the page instead of pushing the text; a
  press outside puts it away. At any width, opening the sidebar now moves the
  text along with it instead of jumping first.
- **Two inline formulas that come to touch become one.** Markdown cannot
  write `$x$` and `$y$` with nothing between them, so deleting the text
  between them, or pasting one beside the other, joins them as `$x y$`. One
  undo takes back the edit and the join together.
- **Easier to read and to hit.** Muted text in the dark theme and code
  comments in both themes are a little stronger, readable text no longer dims
  by transparency, shadows in the dark theme darken instead of glowing, and
  the small sidebar and table controls answer a press across 24px.
- **Calmer motion.** Panels opened from the keyboard appear at once; opened
  with the pointer they still arrive. With Reduce Motion on, they fade instead
  of moving, and a press no longer scales a button.
- When a note changed on disk while you were editing it, the alert now offers
  **Keep editing**, which hides it until you next save.
- Settings rows no longer stretch across a wide window, and the status line
  keeps its message and word count in place however many recent notes it
  shows.
- In the file tree, the arrow and icon of a row stay in view when a long name
  is scrolled sideways, the folder at the top is set apart from its contents,
  and the active Files or Outline tab is underlined again.

### Removed
- The `NOTO_MARKDOWN_ENGINE=micromark` switch and the old Markdown pipelines
  behind it. `@roobli/md` has been the default since `0.0.2-alpha.112` and is
  now the only engine.

### Fixed
- **Typing during a save is kept.** Keys pressed while a save was still being
  written could be marked as saved without being written, and were lost when
  the window closed. Two saves started at once can no longer do the same.
- **A note deleted on disk while open can be saved back** to where it was.
  If Noto quits partway through that save, the next launch finishes it; and if
  another file appears at that path during the save, Noto leaves that file
  alone and keeps your note unsaved.
- **A note can no longer read files outside its folders.** Pictures in an
  export (HTML, PDF and the Pandoc formats) come only from the folders Noto
  has open, Pandoc runs sandboxed, and a network path (`\\server\share`) is
  refused without contacting the server. Save a Copy writes only where you
  chose in its dialog.
- With web images turned off, a web picture inside an HTML block is no longer
  downloaded. Switching web images on or off now redraws pictures in HTML
  blocks at once, rather than after the block was edited.
- The window no longer goes blank when a folder opens after Noto started
  without one.
- Changing several settings in quick succession no longer loses one of them.
- A paragraph of thousands of unmatched stars (`*a *a *a …`) no longer crashes
  the window.
- Strikethrough beside Chinese, Japanese or Korean text no longer reopens as
  literal tildes in a paragraph that also holds a character reference or a
  `***` run.
- More text comes back as written after its paragraph is edited and saved:
  italic inside bold glued to a word, struck text that is itself `~~`, a
  literal star beside bold or italic, a space before the end of a link's
  text or of a style around another, and link text starting with `^` or `[`.
- Text such as `a*.*b`, `foo_(bar)_baz` or `[x][y]` with no definition now
  opens as plain text, as other Markdown apps show it, instead of as emphasis
  or a link.
- Inside quotes and list items, a heading, fence, rule or nested quote now
  ends the paragraph before it, a line shaped like a link definition no longer
  splits a paragraph, and a nested quote's paragraph carries on through a line
  without `>`.
- A long folder name in the title bar shortens before it runs under the
  window controls or the Settings button.
- The `h1`–`h6` badge beside the heading being written is on one line again,
  not stacked.
- A backslash right before a letter that touches italic, bold or
  strikethrough (`C:\d` before italic `(see)`) no longer turns the letter into
  `&#x64;` text when its paragraph is edited and saved. The letter is written
  as a character reference there, and the bare backslash in front escaped it
  (`C:\&#x64;*(see)*`). The backslash is now written as `\\`.
- A dollar sign in text followed by a character that also needs escaping
  (`$_GET`, `$[x]`, `$*`) no longer turns the text up to the next dollar into
  math when its paragraph is edited and saved. Its escape was dropped
  (`$\_GET`), so on reopen it opened math. It is now saved as `\$\_GET`.
- Strikethrough no longer turns into literal tildes on save when it starts or
  ends with punctuation next to a letter (`.txt` struck in `notes.txt`), or
  starts or ends with a tilde (`~5 min` struck). The letter is written as a
  character reference there, as bold and italic already were
  (`note&#x73;~~.txt~~`), and the tilde is escaped (`~~\~5 min~~`).
- Italic text right next to bold text no longer loses the bold on save when
  punctuation sits where the two meet (`foo` in italic, `(x)` in bold). The
  italic is written with underscores there, `_foo_**(x)**`.
- A long note no longer counts as unsaved as soon as it opens. That also
  stopped the rest of the note from finishing loading.
- Emptying a paragraph no longer makes the whole save fail.
- Deleting the first word of a paragraph, or leaving a space at the edge of
  bold or italic text, no longer saves a `&#x20;` that then shows in the text.
- A reference link (`[text][label]`) or footnote reference (`[^label]`) whose
  definition is elsewhere in the note no longer opens as literal brackets in
  paragraphs that also use less common syntax.
- In a long note, editing a block before it had finished loading, or using
  Replace All, no longer saves its formatting as escaped characters
  (`***bold***` turning into `\*\*\*bold\*\*\*`).
- A literal star after a letter (`a*b*c`) or inside italic or bold text,
  whether typed or already escaped in the file, no longer turns text into
  italics when the paragraph is edited and saved. Such a star is now written
  escaped (`a\*b\*c`).
- Character references such as `&amp;`, `&nbsp;`, `&copy;` or `&#35;` now show
  as the character they stand for instead of as their code, and an edited
  paragraph saves them as they were written. Editing one used to save
  `&amp;` as `\&amp;`, which every other app then showed as `&amp;`.
- An `&` that cannot start a character reference (`Q&A`, or the `&` between a
  link's query parameters) is no longer saved as `\&` when its paragraph is
  edited.
- Two lists that end up next to each other, because the paragraph between them
  was emptied or deleted, no longer reopen as one list. The second is saved
  with the other marker (`*` after `-`, `1)` after `1.`), which is what keeps
  them apart in Markdown.
- Italic text with bold words inside it (`*see **this** here*`) no longer
  breaks apart when its paragraph is edited and saved. It used to be written
  as `*see&#x20;****this****&#x20;here*`, which reopened with the bold lost or
  doubled. Strikethrough and links inside italic are written plainly too.
- Striking through, or making italic or bold, a selection that ends in a
  space, or deleting the last word of a styled phrase, now saves the space just
  outside the style (`~~done~~ now`). A strikethrough written that way used to
  reopen as literal tildes, and italic or bold wrote character references into
  the file, `*done&#x20;*&#x6E;ow`, that stayed there.

## [0.0.3] - 2026-10-17

The first full release since `0.0.1`, on the Stable channel. It carries
everything from the `0.0.2` alphas below, summarised here.

**This release is not signed.** On macOS it is ad-hoc signed and not
notarized, and on Windows the installer is not code-signed. That is
expected, not a broken download; signed and notarized builds will follow in
a later release. First open:

- **macOS:** unzip and open `Noto.app` once, then System Settings → Privacy
  & Security → Open Anyway (Right-click → Open on macOS 14 and older), or run
  `xattr -cr Noto.app && open Noto.app`.
- **Windows:** when SmartScreen appears, choose *More info → Run anyway*.

Full steps are in [docs/install.md](docs/install.md).

### Added
- **Source Code Mode** for the whole note (`Cmd+/`), a read-only viewer for
  non-Markdown files, sidenotes, timeline fences, tags and task dates,
  export with diagrams and callouts, and a command palette (`Cmd+K`).
- **Links in the rail** (*Links to*, *Linked from*, *Related*), opt-in.
- **Settings as one page**, with Plugins inside it, and **update channels**:
  Stable for full releases, Testing for alphas.
- **Intel Macs are supported again**, with a separate Intel zip.

### Changed
- **A new Markdown engine**, `@roobli/md`, is the default; untouched blocks
  are still saved byte for byte.
- **Long notes are much faster.** In the packaged benchmark on macOS, an
  8 MB note opens in about 1.1–1.3 seconds (about 10 at the end of
  September), a keystroke takes about 16–21 ms instead of 86, and a save
  under half a second instead of about 3.
- Quieter source markers, empty state and title bars on Windows and Linux.

### Fixed
- Long notes no longer freeze after typing (spell check and word count),
  and Select All no longer draws the whole note.
- Stable no longer offers alphas.
- Fences, math and comments opened by a change on disk, Source Mode or a
  transform show what the file says; a note starting with `---` keeps its
  lists.
- macOS downloads are no longer reported as "damaged".

## [0.0.2-alpha.114] - 2026-10-12

Two weeks of work on long notes. Everything below was measured on the
benchmark's generated documents; the largest is 8 MB and 43,970 blocks.

### Added
- **Intel Macs are supported again.** Each release carries an Intel zip beside
  the Apple silicon one, and the update feed lists both, so each Mac's updater
  takes the build it can run.
- Release builds can be signed and notarized as soon as the Apple credentials
  exist; see [RELEASING.md](RELEASING.md). This release is still not
  notarized.

### Changed
- **A long note opens much faster.** Fences, tables and display math far from
  the caret are drawn when they scroll into view rather than all at open,
  runs of off-screen blocks are kept as single placeholders, the document
  crosses between the app's processes once instead of twice, and work the
  open repeated is done once. The 8 MB document opens in about 1.3 seconds in
  this release's packaged benchmark on macOS, where the build measured on
  29 September took about 10.
- **Scrolling, typing and saving in a long note are lighter.** A block coming
  into view reuses the placeholder it replaces, a fence's language and copy
  controls are built the first time you hover or focus it, moving the caret
  or typing inside a block no longer rebuilds the whole note's highlighting
  and block positions, and a save writes out only the blocks that changed.
  In the same benchmark, a keystroke in the 8 MB document went from about
  86 ms to about 21 ms, and a save from about 3.1 seconds to under 0.5.
- The README and the docs site lead with what Noto is for: *Edit the page.
  Keep the file.* The download table lists what releases actually carry.

### Fixed
- **A long note no longer freezes when you stop typing.** Each time typing
  paused, the spell checker went through the whole note in one go, and the
  window ignored every click until it finished: about 37 seconds, twice, in
  the 8 MB document. In a note of a few thousand paragraphs or more, spelling
  is now checked in the paragraphs around the caret; shorter notes are
  checked whole, as before.
- **Counting words no longer stalls a long note.** The status bar counted
  every character of the note each time typing stopped. Counts are now kept
  per block and reused for blocks an edit left alone, and the first count of
  a note runs in small slices, so the longest stall after typing stops in the
  8 MB document fell from about 380 ms to under 20.
- **Select All in a long note no longer draws the whole note.** Selecting
  everything, or shift-clicking from one end to the other, made every block
  real again, which took seconds on the largest documents. Only the
  neighbourhoods of the selection's two ends are drawn now.
- **Settings → Updates → Stable no longer offers alphas.** Some alphas were
  published without GitHub's prerelease flag, and Stable trusted that flag
  alone. A version with a prerelease component is now always treated as a
  prerelease, and every existing release has been re-flagged.
- An Intel Mac with no Intel build to update to is sent to the release page
  instead of being handed the Apple silicon zip, which it cannot run.
- **Leaving Source Mode, taking a change made on disk, or running a text
  transform shows what the file says.** When the new text opened a code fence,
  a math block or an HTML comment without closing it, the editor showed it as
  one short block and kept the old blocks after it, while in the file
  everything after it is inside the fence. It now shows the fence running to
  the end, as the file reads. (`@roobli/md` 0.1.20.)
- **A list in a note that begins with a horizontal rule is a list again.** A
  note whose first line was `---` with nothing below to close it as frontmatter
  had every list in it drawn as a line of text, and editing one could write
  escape characters into the file. The frontmatter parser now only runs when a
  note opens with a closed `---` fence.

### For contributors
- The packaged benchmark runs on every tag and reports post-type idle lag
  beside open, keystroke and save; its probe no longer counts the open's own
  long task. Skip it locally with `BENCH_IDLE_LAG=0`.
- A unit test fails if a one-block save at *4n* paragraphs takes more than ten
  times one at *n*, so the quadratic save lookup cannot return quietly.
- Measurements and profiles for each change above are in
  [docs/performance/measurements.md](docs/performance/measurements.md).

## [0.0.2-alpha] - 2026-09-10 to 2026-09-28

113 alphas, `v0.0.2-alpha.1` to `v0.0.2-alpha.113`, on the Testing channel.
Grouped here by what changed for a reader rather than by alpha.

### Added
- **Source Code Mode** for the whole note on `Cmd+/`, including edits to the
  blank lines between blocks.
- **A read-only viewer** for non-Markdown files; `.drawio` opens as XML and
  `.drawio.svg` as a picture with a source toggle; HTML and SVG files preview
  in isolation.
- **Sidenotes, timeline fences, tags and task dates.** Frontmatter tags show
  as chips and open the other notes that share them; a checked task records
  the day; tab characters in fences are marked.
- **Export** carries diagrams and callouts; a **command palette** on `Cmd+K`.
- **Links in the rail**: *Links to*, *Linked from* and *Related*, built from
  a vault's index graph. Off by default; turn it on in Settings → Appearance.
- **Settings as one full-page surface**, with Plugins inside it.
- **Update channels.** Stable and Testing, with checks that stay quiet and are
  off until turned on.
- **Reload from disk** with a confirmation when the file changes underneath an
  unsaved note.

### Changed
- **A new Markdown engine.** `@roobli/md` is the default from
  `v0.0.2-alpha.112`: opening parses once, far-off blocks of a large document
  are drawn lazily, and saves still write untouched blocks back byte for byte.
  `NOTO_MARKDOWN_ENGINE=micromark` restores the previous parser.
- Source markers appear only for the block the caret is in, and a wiki link's
  brackets only while the caret is on that link.
- A quieter empty state; the Windows and Linux title bars are first-class
  rather than adapted from macOS; the rail can be dragged to at most 35% of
  the window.
- **macOS builds are Apple silicon only** from `v0.0.2-alpha.19`. Intel Macs
  cannot run them.

### Fixed
- macOS downloads reported as "damaged": the app is ad-hoc re-signed after
  packaging. It is still not notarized, so the first open needs the step in
  [docs/install.md](docs/install.md).
- The remote control rejected the token it had just shown, and would open a
  path outside the open folder.
- Number arrays such as `[[1, 2, 3]]` were drawn as wiki links.
- Glyphs from the file tree bled through its sticky rows.

## [0.0.1] - 2026-09-05

The first release with downloadable builds for macOS, Windows and Linux.

### Added
- Rendered editing of headings, lists, task lists, tables, fenced code,
  footnotes, callouts, KaTeX math, mermaid diagrams, frontmatter and the raw
  HTML notes commonly carry, with every block the reader did not touch saved
  byte for byte.
- Typora's habits: Source Code Mode, focus and typewriter modes, table
  keys, Select Word / Line / Styled Scope, Paste as Plain Text, Print.
- Pictures pasted or dropped are filed beside the note, in a chosen folder,
  or uploaded through PicGo.app.
- A file tree, an outline, quick open across names and contents, and `[[`
  to link a note.
- An optional loopback-only remote control for scripts on the same machine.

[Unreleased]: https://github.com/roobli/Noto/compare/v0.0.3...main
[0.0.3]: https://github.com/roobli/Noto/compare/v0.0.1...v0.0.3
[0.0.2-alpha.114]: https://github.com/roobli/Noto/compare/v0.0.2-alpha.113...v0.0.2-alpha.114
[0.0.2-alpha]: https://github.com/roobli/Noto/compare/v0.0.1...v0.0.2-alpha.113
[0.0.1]: https://github.com/roobli/Noto/releases/tag/v0.0.1

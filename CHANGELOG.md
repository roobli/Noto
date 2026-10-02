# Changelog

What changed in Noto, for the person updating. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Engine-level detail
lives in [`@roobli/md`'s changelog](https://github.com/roobli/md/blob/main/CHANGELOG.md).

How releases are made, and what each channel receives, is in
[RELEASING.md](RELEASING.md). The first release outside alpha will be `0.1.0`.

## [Unreleased]

### Changed
- **Faster stub remount when the viewport moves (scroller lookup).** Finding the
  scrollport no longer reads computed `overflowY` on the ProseMirror mount
  parent (that forced layout over every top-level child on each membership
  dispatch). Inline overflow and `.canvas-scroll` are preferred; the plugin
  keeps the attached scroller across updates. Linux happy-dom residual, same
  machine before/after (median of 3): remount mid huge **178 → 146 ms**; slide +1
  huge **79 → 42 ms**; same-window dispatch huge **47 → 0.4 ms** (large same
  **5.5 → 0.2 ms**). Remount-mid large stays ~36 ms (noise).
- **Faster remount spikes when the stub window moves.** Viewport stubbing no
  longer marks the real band with node decorations (that forced ProseMirror to
  walk every top-level child on each membership change). Enter/leave indices
  remount surgically in the plugin view instead. Linux happy-dom residual
  remount mid / slide +1, same machine before/after: large **82 → 49 ms** /
  **51 → 11 ms**, huge **582 → 182 ms** / **460 → 76 ms**.
- **Faster stub DOM on long-note open, and cheaper membership-stable decoration updates.**
  Stub placeholders are cloned from a shared prototype instead of `createElement`
  per top-level block, and viewport-stub kept its real-window `DecorationsSet`
  across transactions that did not change membership (mapping it on doc edits).
  Superseded for membership signaling by surgical remount above; the open-floor
  `cloneNode` cut remains. Linux happy-dom EditorView open after specialised
  stubbing (#303), same machine before/after: large **631 → 424 ms** (median of 3),
  huge **5445 → 3476 ms**.

### Added
- **Long notes stub off-screen fences, tables and display math.** Once a note
  has enough top-level blocks for viewport stubbing, those specialised blocks
  use a height placeholder until they scroll (or the caret) into the real
  window, then remount their normal editing chrome. HTML and images stay
  fully real. Linux view-open microbench on the corpus: about 2.1–2.4× faster
  constructing the editor for large/huge versus always-real specialised views.

- **The packaged benchmark records post-type idle lag.** After a typing burst
  it measures the longest main-thread stall until the renderer goes quiet, so a
  freeze like the Chromium ColdModeSpellCheckRequester case (tens of seconds on
  the 8 MB document with every keystroke still under a frame) cannot land
  without a number next to it. Reported for every corpus size in CI beside
  open, keystroke and save; skip locally with `BENCH_IDLE_LAG=0`.
- A unit test that times a one-block save at *n* and at *4n* paragraphs and
  fails if the larger one takes more than ten times as long, so an accidental
  return of the quadratic save lookup cannot land quietly.
- **Intel Macs are supported again.** Each release carries an Intel zip beside
  the Apple silicon one, and the update feed lists both, so each Mac's updater
  takes the build it can run.
- Release builds can be signed and notarized as soon as the Apple credentials
  exist; see [RELEASING.md](RELEASING.md).

### Fixed
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
- **A long note no longer freezes when you stop typing.** Each time typing
  paused, the spell checker went through the whole note in one go, and the
  window ignored every click until it finished: about 37 seconds, twice, in
  the 8 MB benchmark document. In a note of a few thousand paragraphs or more,
  spelling is now checked in the paragraphs around the caret; shorter notes are
  checked whole, as before.
- **Counting the words in a long note no longer walks the whole note after
  every pause.** The status bar counted every character of the document each
  time typing stopped, about 0.6 s on the 8 MB benchmark document, which was
  the longest task left after the spell-check fix. Counts are now kept per
  top-level block and reused for blocks an edit left alone, so a one-paragraph
  change costs about that paragraph.
- **A long note opens faster.** Building the view of a note took time in
  proportion to the square of its number of blocks, because every block looked
  up its own position by walking the note from the top. The 8 MB benchmark
  document now opens in a packaged build on Linux in about 5.5 seconds instead
  of 9.
- **Saving a long note is faster.** Part of every save took time in
  proportion to the square of the number of blocks in the note, and now grows
  only with the number. On the 8 MB benchmark document, 44,000 blocks, that
  part fell from over five seconds to under one, and a whole save in the
  packaged app from between 3.2 and 4.5 seconds to 2.6. A save also no longer
  parses the file twice, and only what changed now travels between the app's
  processes, in both directions; the same save in a packaged build on Linux
  now takes under a second.

### Changed
- The README and the docs site lead with what Noto is for: *Edit the page.
  Keep the file.* The download table lists what releases actually carry.

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

[Unreleased]: https://github.com/roobli/Noto/compare/v0.0.2-alpha.113...main
[0.0.2-alpha]: https://github.com/roobli/Noto/compare/v0.0.1...v0.0.2-alpha.113
[0.0.1]: https://github.com/roobli/Noto/releases/tag/v0.0.1

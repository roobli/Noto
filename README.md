# Noto

Noto is a Markdown editor that edits the rendered document and keeps the file
byte for byte. You type into headings, tables, task lists, math and fenced code
directly; there is no separate preview pane and no read-only source island that
you have to leave the document to edit. When you save, every block you did not
touch is written back exactly as it was found, including its line endings and
whatever whitespace it happened to have.

It runs on macOS, Windows and Linux, and it is built with TypeScript, Electron,
React and ProseMirror.

![Noto editing a document, with the file rail open](docs/images/noto-light.png)

<details>
<summary>The same window in the dark theme</summary>

![Noto in the dark theme](docs/images/noto-dark.png)

</details>

## Project status

Noto is usable and under active development. The current line is
0.0.2-alpha; 0.0.1 was the first release with downloadable builds. The honest
summary of where it stands is worth reading before you depend on it.

All three platforms are now verified the same way: the packaged application is
built and then driven through its real interface, and the whole suite of 237
packaged tests passes on macOS, Windows and Linux on every change, alongside
about 1,200 unit tests. Windows was unproven until the run that proved it,
which is also the run that found two faults nobody could have read out of the
code: every plugin came up needing recovery because a durability step that
only POSIX has was being treated as a failure, and the remote control refused
the token its own Settings pane had shown, because the file's permissions
mean nothing there and the token was being replaced on every read.

Which is the honest summary: it is exercised most on macOS, where it is used
daily against a vault of about seven thousand notes, and the other two are
proven by machine rather than by living in them.

The performance story is likewise mixed rather than a clean win, and the
numbers are below.

## Download

Builds for macOS, Windows and Linux are on the
[releases page](https://github.com/lr00rl/Noto/releases/latest). Take the
installer for your system where there is one, or the archive, which needs no
installing: unpack it and run what is inside.

| Platform | Installer | Archive |
| --- | --- | --- |
| macOS, Apple silicon or Intel | | `Noto-<version>-macos-<arch>.zip` |
| Windows, x64 | `NotoSetup-<version>.exe` | `Noto-<version>-windows-<arch>.zip` |
| Linux, Debian and Ubuntu | `noto_<version>_amd64.deb` | `Noto-<version>-linux-<arch>.tar.gz` |
| Linux, Fedora and openSUSE | `noto-<version>-1.x86_64.rpm` | `Noto-<version>-linux-<arch>.tar.gz` |

Nothing is signed by a paid certificate, so each system says so once. On macOS
the first open needs Control-click then Open, or
`xattr -dr com.apple.quarantine /Applications/Noto.app`. On Windows, SmartScreen
shows "Windows protected your PC": choose More info, then Run anyway.

## Getting started

You need Node 22 and pnpm 11. Newer Node majors are rejected on purpose, since
the packaging path is pinned to the runtime it was verified against.

```sh
pnpm install
node node_modules/electron/install.js   # see the note below
pnpm start
```

The second line fetches Electron's own binary. The published `electron` package
declares a `postinstall` script, but the copy pnpm 11 installs arrives without
a `scripts` field, so nothing runs it and `node_modules/electron/dist` never
appears. Without that directory, packaging fails and the app cannot launch.
`pnpm rebuild electron` does not help, because from pnpm's side there is no
build to run.

## Using it

Open a file with `Cmd+O`, or open a folder with `Cmd+Alt+O` to get the
workspace tree. Open notes sit behind a quiet Recent strip in the status bar
rather than a classic tab bar. The rail on the left holds Files, Outline and
Links; the one control at the top left opens and closes it, and
`Cmd+Shift+L` and `Cmd+Shift+O` open it directly on the view they name.
`Cmd+F` finds, `Cmd+Alt+F` finds and replaces, `Cmd+K` opens the command
palette, and `Cmd+,` opens Settings — a full-page shell with categories, where
plugins are turned on under the Plugins section. On Windows and Linux, read
Control for Command.

The title bar carries the filename and nothing else that is not an action you
can take right now: Save appears when there is something to save and is absent
when there is not. The gear is the single Settings entry; Plugins is reached
from Settings' left nav, not a second top-bar icon. What the chrome is for, and
why it is this quiet, is written down in
[`docs/design/chrome.md`](docs/design/chrome.md).

Settings carries the document's typography, so text size, line height and
line width are yours to set rather than fixed: the width is a character count,
not a pixel width, so it holds as the size changes. Saving automatically is
there too, off by default and debounced against typing, and it refuses in
exactly the cases the Save button refuses. A custom stylesheet can be pointed at
any absolute path and wins over the built-in theme, so `:root { --accent: … }`
is enough to retheme the app without editing it.

`Cmd+P` is quick open: type part of a note's name or its path and it ranks the
whole folder by how well it matches and by how often and how recently you open
it, so an empty box already shows the few notes you probably want. `Enter`
opens the note; `Alt+Enter` writes a `[[wiki link]]` to it at the caret instead.
Wiki links render inline wherever they appear, and `Cmd+click` follows one.

The links are decorations rather than a node type, so they cannot reach the
saved bytes: `[[a note]]` is ordinary text in the file, exactly as you typed it.

`Cmd+Shift+F` searches inside the notes rather than across their names, and
`Tab` switches between the two without leaving the box. A content result shows
the lines it was found on, and opening one lands on the match with the find bar
already carrying the query. The scan reads the folder on demand rather than
keeping an index: on a vault of 7,066 notes and 82.5 MB it takes about 1.3
seconds cold and 274 ms once the operating system has the files cached, which is
what the adaptive debounce is for.

The open folder names itself on the tree's first row; an ellipsis on that
row holds what acts on the folder: open another, reveal it in the file manager,
refresh, and the folders you opened before. `Cmd+Shift+R` reveals the current
note instead.

`Cmd+/` opens Source Code Mode: the whole note as the Markdown it is saved as,
the way Typora's Command-slash does. `Cmd+Alt+/` still toggles source for the
single block under the caret, which is the escape hatch when you want to fix
one paragraph, one table or one fence without leaving the rest rendered.

Markdown input rules work as you type: `#` for a heading, `-` for a list,
`` ``` `` for a code fence. The syntax markers for the block you are editing
appear while you are in it and fold away when you leave, so the document stays
readable without hiding what it is made of.

## Byte-exact saving

This is the property the rest of the design is arranged around. Most editors
that render Markdown round-trip it through a serializer, so opening and saving
a file rewrites parts of it you never touched: a list marker changes, emphasis
switches from `_` to `*`, a table's padding is normalized, trailing whitespace
disappears.

Noto parses the file into blocks, records the exact source bytes of each one
along with its origin and hash, and on save writes back the recorded bytes for
every block that was not edited. Only blocks you actually changed are
serialized. A document you open and save without touching is identical to the
byte.

The same block record is what detects an external change: if the file on disk
no longer matches what was accepted, the save is refused and you are offered a
copy rather than an overwrite.

## Performance

Measured against Typora on the same machine, opening the same four generated
documents, with a clock inside each application rather than a stopwatch
outside it. Full method, corpus and failed approaches are in
[`docs/performance/measurements.md`](docs/performance/measurements.md).

| document |     bytes | Noto      | Typora       |
| -------- | --------- | --------- | ------------ |
| small    |    66,061 | 268 ms    | 282 ms       |
| medium   |   524,952 | 903 ms    | 343 ms       |
| large    | 2,097,661 | 4,017 ms  | never loaded |
| huge     | 8,389,427 | 22,467 ms | never loaded |

This is a split result. At 66 KB the two are level. At 525 KB Typora is 2.6
times faster, which is a real gap and not a rounding difference. At 2 MB and
above Typora does not load the document at all: its editor still reports an
empty document after three minutes, which was checked three separate ways
before being written down. So Noto opens files Typora will not open, and Typora
opens mid-sized files faster than Noto does.

Profiling says where Noto's time goes, and corrects the obvious guess. Opening
currently parses the document twice, once in the main process to establish the
block records and once in the renderer to build the editor document. Building
the ProseMirror document from the parsed nodes is free, 4 ms for 2,742 blocks,
so there is no win hiding in the editor's node construction. The entire cost is
the Markdown parse itself. Removing the duplicate would take roughly 330 ms off
the 903 ms and land near 570 ms, still behind Typora's 343 ms, so closing that
gap needs the parse to leave the critical path or get cheaper per byte rather
than merely to happen once.

## Plugins

Plugins are explicit: each one declares the capabilities it wants, and the main
process brokers every one of them. A renderer plugin can decorate or transform
the document only if it asked for that; a service plugin gets a filesystem
grant scoped to a path, revocable, and denied everywhere else. Nothing is
ambient.

Four plugins ship in the build. Title Shift promotes and demotes heading
levels, and Markdown Padding applies CJK spacing rules; both are ports of the
author's Typora plugins. Semantic Focus and Fixture Reader are bundled
examples, one per runtime kind, kept so that a plugin author has a working
plugin of each shape to read and so the capability broker has something that
exercises it.

Writing one is described in [docs/plugins.md](docs/plugins.md), which also
says plainly where the model stops today: plugins ship inside the
application, and the sandboxed runtime for third-party code is built but not
yet opened. Theming, which needs no plugin at all, is one CSS file named in
Settings; [docs/theming.md](docs/theming.md) lists what it can reach.

## Building and verifying

```sh
pnpm verify          # typecheck and the unit suite
pnpm package:e2e     # package the variant the end-to-end suite drives
pnpm test:e2e        # run that suite against the packaged app
pnpm make:release    # installers for the host platform
```

`pnpm make:release` produces a zip on macOS, a Squirrel installer on Windows,
and deb and rpm packages on Linux. Signing is read from the environment, so an
unsigned local build and a signed release build take the same path: set
`NOTO_APPLE_SIGNING_IDENTITY`, and `APPLE_ID`, `APPLE_PASSWORD` and
`APPLE_TEAM_ID` to notarize, or `WINDOWS_CERTIFICATE_FILE` and
`WINDOWS_CERTIFICATE_PASSWORD` on Windows. With none of them set the build
still succeeds and is simply unsigned, which is what a contributor without
certificates needs.

The end-to-end suite runs against a packaged application rather than a
development server, because the things most likely to break in an Electron app
are exactly the things a development server does not exercise: the preload
bridge, the fuses, what is inside the asar, and the application menu.

## How it is put together

The main process owns the file: reading, block records, saving, recovery, the
workspace, recent files and settings. The renderer owns the editor and never
touches the filesystem. A separate service process handles plugin filesystem
access, so a plugin's file reads are not running inside the window. The preload
bridge exposes four narrow, versioned APIs and validates every message on both
sides.

The Markdown pipeline is `micromark` and `mdast` with GFM, math and frontmatter
extensions, mapped onto a ProseMirror schema that keeps each block's original
source alongside its rendered form. That mapping is what makes both byte-exact
saving and per-block source mode possible from one representation.

Further reading lives in `docs/`: the performance measurements, the Linux
verification record, and a review of what the release build asks the operating
system for.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).

Third-party dependency licenses are inventoried in
`resources/provenance/THIRD_PARTY_NOTICES.md`, regenerated with
`pnpm license:inventory`.

Typora is a behavior reference only. Noto contains no Typora code, markup,
assets, strings, themes or private protocols.

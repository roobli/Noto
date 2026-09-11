# Theming Noto

Noto is themed with one CSS file of your own. You name it once in
Settings, under Appearance, and reload it from the same place while you
edit it in your usual editor. Nothing is pasted into a text area and nothing
is compiled: the file is read as it is and layered over the built-in styles.

This guide covers what the file can reach, what it cannot, and the handful of
rules that make a theme hold up across light and dark, the width modes, and
the settings a reader may change under it.

## Loading a theme

Settings, Appearance, Custom stylesheet. The field takes an absolute path
to a `.css` file, committed on blur or Enter. Reload re-reads the file; a path
that cannot be read is reported beside the field rather than failing quietly.
The file is limited to a size a stylesheet should never approach, and a
relative path is refused because it would resolve against whatever the process
happened to consider its working directory.

The stylesheet is applied through the document's adopted style sheets, not as
a `<style>` element, because the renderer's content security policy allows no
inline styles. That is also why a theme cannot `@import` a remote sheet or load
a web font: the policy allows fonts only from the application itself. Use
fonts installed on the machine.

## The palette is yours to override

Every colour in the app comes from a small set of custom properties on the
root element. They are declared inside a cascade layer named `noto-tokens`,
and a theme file is unlayered, so any value you set on `:root` wins over the
built-in one with no selector tricks and no `!important`. The two themes are
distinguished by `data-theme="light"` and `data-theme="dark"` on the root.

```css
:root { --accent: #2f6f9f; }
:root[data-theme='dark'] { --accent: #7fb3d5; }
```

| Property | What it colours |
| --- | --- |
| `--paper` | The document canvas and the window ground |
| `--panel` | The rail, the title bar and Settings |
| `--raised` | Hover surfaces, code fences, quiet fills, the find bar |
| `--overlay` | A panel floating over the scrim: Settings and quick open |
| `--ink` | Body text |
| `--ink-strong` | Headings, bold, a table's first column |
| `--muted` | Secondary text, folder names, labels |
| `--hairline` | Rules and borders |
| `--line-strong` | A table's outer rules, the rule under a stuck folder row |
| `--accent` | The one mark for where you are, links, the caret |
| `--code-ink`, `--code-fill` | Inline code's text and fill |
| `--code-text` | The text of a fenced block, before any highlighting |
| `--code-guide` | The rules at each tab stop of a code line's indentation |
| `--code-keyword`, `--code-string`, `--code-number`, `--code-symbol`, `--code-muted` | The five colours a fenced block is drawn in: reserved words, text, numbers, names the code defines, and comments |
| `--surface-active` | The fill behind the current file's row |
| `--quote-ink`, `--quote-line` | A blockquote's text and its rule |
| `--task-done` | A finished task item |
| `--alert-note`, `--alert-tip`, `--alert-important`, `--alert-warning`, `--alert-caution` | The rule, tint and title of each kind of `[!NOTE]` callout |
| `--mark-fill` | The fill behind `==highlighted==` text and `<mark>` |
| `--success`, `--warning`, `--danger` | Status only |
| `--focus` | Keyboard focus rings |
| `--scrim` | The wash behind Settings and quick open |
| `--tree-line` | The connector lines in the file tree and outline |

Set light values on `:root` and dark values on `:root[data-theme='dark']`. A
theme that sets only one of the two leaves the other as shipped, which is
usually what you want while you work.

## Typography and the page

The document's size and leading come from settings and arrive as properties
on the root: `--doc-font-size` and `--doc-line-height`. A theme should not set
these; the reader owns them. Everything in the document that has a size is in
`em`, so it follows the setting: headings are 1.84, 1.48, 1.24 and 1.12 of the
body, code is 0.9, tables 0.92. Override the ratios if you want a different
scale, and it will still follow the reader's size.

```css
.ProseMirror h1 { font-size: 2em; }
.ProseMirror :not(pre) > code { font-size: 0.88em; }
```

The width of the writing column is a mode, not a number: `default`, `wide` or
`full`, carried on the root as `data-width-mode`. Each mode is the smaller of
the canvas less its gutters and a cap, so the column can never be wider than
the canvas and the document never scrolls sideways. The cap for each mode is
`--measure-cap`, and the gutter is `--canvas-gutter`; a theme may change
either, and should keep the `min()` shape if it replaces `--measure` outright.

```css
:root { --measure-cap: 760px; }
:root[data-width-mode='wide'] { --measure-cap: clamp(900px, 72%, 1100px); }
```

The prose face, the interface face and the monospace face are set in the
stylesheet rather than as properties. The prose stack is the author's Typora
stack face for face, so a machine missing the first one falls back the way
Typora would. To change them, set `font-family` on
`.ProseMirror` for the document and on `body` for the chrome.

## What the document is made of

The editor is ProseMirror, so the document is ordinary HTML under
`.ProseMirror` with a few classes of Noto's own. The ones a theme is likely to
want:

- Block rhythm is `margin` on `.ProseMirror > *`. The block holding the caret
  carries `.noto-active-block`; inline syntax revealed around the caret is
  `.noto-syntax`.
- A code fence is `pre.noto-fence` with `.noto-fence-gutter` (the line
  numbers), `code.noto-fence-code`, and `.noto-fence-tools` holding
  `.noto-fence-lang` and `.noto-fence-copy`. The gutter's width is
  `--fence-digits` characters, set per block. Syntax tokens are Prism's
  `.token` classes, coloured from the palette.
- A mermaid fence carries `data-lang="mermaid"` and holds a `.noto-diagram`
  with the drawing in `.noto-diagram-frame` and, when it failed, a
  `.noto-diagram-status`; its `data-state` is `rendering`, `rendered` or
  `failed`. The drawing takes its colours from the palette tokens above, read
  each time it is drawn, so a theme file reaches it without styling the frame.
- A picture is `img.noto-image` inside `.noto-image-frame`; one that could not
  be shown is `.noto-image-placeholder` with a `data-reason`.
- A table is wrapped in `.noto-table-frame`, which also holds the rails it is
  taken hold of by: `.noto-table-rails` with `.noto-table-rail-rows` and
  `.noto-table-rail-columns`, each holding one `.noto-table-handle` per track,
  and `.noto-table-drop` for the line showing where a dragged track will land.
  The handles are invisible until the frame is hovered, carry
  `.noto-table-handle-held` while dragged, and the rails carry
  `data-dragging="row"` or `"column"` for as long as a drag lasts. Tables draw
  horizontal rules only, from `--line-strong` and a mix of `--muted`; a raw HTML block is `.noto-html-block`, a math block
  `.noto-math-block`, frontmatter `.noto-frontmatter`.
- A GitHub alert is a `blockquote.noto-alert` with `.noto-alert-note` or one
  of the other four kinds, carrying `--alert-color`; its title chip is
  `.noto-alert-title` and the hidden marker `.noto-alert-marker`. While the
  caret is inside, the quote carries `.noto-alert-editing`.
- Typora's inline marks are decorations over plain text: `.noto-mark-highlight`,
  `.noto-mark-sup`, `.noto-mark-sub`, with the delimiters in
  `.noto-typora-delim`. Bare inline HTML tags are drawn the same way: the tag
  is `.noto-inline-tag`, the text between carries `.noto-html-kbd`,
  `.noto-html-sub`, `.noto-html-sup`, `.noto-html-u` and so on, and a `<br>`
  is `.noto-inline-break`. A text block whose selection is touching any of
  these carries `.noto-marks-editing`, and that is when the syntax shows
  (editor focus required). Wiki-link brackets use `.noto-wiki-bracket` and
  reveal only inside the caret's `.noto-source-editing` textblock while the
  editor is focused.
- Task list items are `li.noto-task-item` with `data-checked`; the box is drawn
  with `::before` and `::after`.

Focus mode is `data-focus-mode="on"` on the root, and quietens
`.ProseMirror > *:not(.noto-active-block)`. A theme that wants a different
treatment, a blur or a colour rather than an opacity, overrides that one rule.

Selectors here are stable for the life of a major version. Anything without a
`noto-` prefix, such as ProseMirror's own classes, is not something a theme
should depend on.

## The chrome

The height of one tree row is `--tree-row` and the sticky offsets are
multiples of it, so a theme that changes the row height gets the stack right
for free.

The rail is `.workspace-rail`, its tree `.tree-root`; rows are `.tree-row`
with `.tree-directory` or `.tree-file`, the current file `.tree-file-active`,
the folder's own row `.tree-vault-row`. Connector lines are drawn with
`--tree-line` and the indent is `--tree-indent` on `.tree-level`. Open folder
rows are sticky; a row that is actually stuck carries `data-stuck`.

The title bar is `.titlebar`, its icons `.icon-button`. Settings is
`.settings-panel`. The width of the rail is a setting and arrives as
`--rail-width`.

Keep in mind the app's one rule for the chrome: the accent marks where you
are and nothing else. A theme that spends the accent on every button will read
as louder, not richer.

## Checking a theme

Look at it three ways before you keep it: in both themes, since the app
follows the system by default; at the narrowest window you use, since the
width modes converge there; and with the text size setting at both ends, since
everything in the document should follow it. A theme that only works at one
size is a theme for one afternoon.

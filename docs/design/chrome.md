# The chrome

What surrounds the document, and why it is shaped this way. The document itself
is specified by the editor stylesheet; this covers the title bar, the rail, the
tabs, the status line and preferences.

## Who this is for

One person, in the app for hours a day, writing and reading long technical notes
in Chinese with English code identifiers, inside a folder tree that is four
levels deep and has a few thousand files in it. That single fact settles most of
what follows: the more hours a day someone spends in a tool, the less decoration
it should carry and the more precision it needs. Beauty buys tolerance on first
contact and that credit does not renew. Everything here is judged by whether it
still reads well in month three.

Typora is the reference for how little chrome a writing surface needs. It is not
a reference for what Noto does, which includes tabs, a plugin tier and settings
Typora does not have.

## The one idea

**The only thing the chrome marks is where you are.** A terracotta spine, two
pixels wide, on the left edge of the current thing: the current file in the
tree, the current heading in the outline, the current block in the document.
Same colour, same width, same meaning, three places.

Everything else in the chrome is ink, muted, or hairline. No filled accent
buttons, no accent underlines on tabs, no accent borders around toggles. The
previous build spent the accent on nine unrelated things at once, which is why
none of them read as important.

Remove the spine and the app is still completely usable. That is the test an
accent has to pass.

## Layers

The chassis is editorial: a serif measure of 60 to 75 characters, generous
leading, one spacing scale, near-zero motion. The evidence is the Markdown
document, which occupies the whole canvas and needs no help. The accent is the
spine, and it is under five percent of any viewport.

## Title bar

38 pixels. It carries identity, not actions.

The filename sits in the optical centre of the window at 13px in `--muted`, with
the unsaved dot beside it. On macOS the bar reserves 78px on the left for the
traffic lights and nothing else goes there except the rail toggle.

Icons only, at 26×26 with a 15px stroke glyph, `--muted` at rest, `--ink` on
hover, `--accent` while the surface they open is open. No borders. No fills. No
labels. Six bordered text buttons in a row is a toolbar from 2005 and it competed
with the document on every screen.

What is on it: the rail toggle, then back and forward, on the left; plugins,
preferences and save on the right. Back and forward walk the trail, three
notes each way, from the author's plugin of that name, and they fade rather
than vanish when there is nowhere to go, so the pair keeps its place. The
filename in the centre is preceded by where the note is: inside an open
folder, the path from the folder's own name, otherwise the shortened
directory, and only its last two segments, since a title bar is not the place
to read a six-level path in full. What is not on it, and where it went
instead:

| Was a button | Now |
| --- | --- |
| Open… | File menu, the empty state, the tree |
| Outline | A tab inside the rail |
| Theme | Preferences, under Appearance |
| Find | `Cmd+F` and the Edit menu |

**Save appears only when there is something to save.** A permanently greyed Save
is noise in a window that is saved almost all of the time, and it says nothing
when it finally lights up. The dot on the filename is the state; the icon is the
action, and it arrives with the state.

The state word itself (`Opened`, `Unsaved changes`, `Saved`) stays in the DOM as
a live region for assistive technology and is not drawn. Sighted users get the
dot. Exceptional states are not whispered here at all: they take the alert.

## Rail

One region on the left, 240px, holding two views rather than two panels. The
previous build opened Files and Outline as separate columns, so asking for both
spent 470 pixels of a 1280 pixel window on navigation.

The header is two words, `Files` and `Outline`, with a 1.5px rule that slides
between them in 180ms. Not a bordered segmented control: that is a component
out of a kit, it repeats the panel border it already sits inside, and its filled
half becomes the second heaviest thing in the rail. The rule moves because
moving is what says the two are one control and that you went from one to the
other. It is positioned by a custom property the current view sets, so nothing
is measured after paint and the first frame is never in the wrong place.

The rail toggle in the title bar opens and closes the region; the menu items
open it on the view they name. At the right of the two words sits a search
glyph that opens quick open, the same one the chord opens: a vault is entered
by search as often as by browsing, and the hand on the mouse should not have
to reach for the keyboard to do it.

`Cmd+]` and `Cmd+[` walk the page width through three modes, default, wide and
full, in a ring. Each mode is a share of the canvas beside the rail with a
ceiling: the reading column up to 860px, which is the width of Typora's page;
78% held between 1000px and 1180px, for code that runs past the column; and
everything beside the rail up to 1680px. The share is taken from the canvas
rather than the window, so the rail is already subtracted, and every mode is at
most the canvas less its gutters. The document therefore never scrolls
sideways, whatever the mode and however narrow the window; a code block that
is wider than the column scrolls inside its own box. The numbers and the ring
are the author's `wider` plugin for Typora, ported.

Its width is dragged from the right edge and remembered as a pixel width, not
as a fraction that reflows while you type. The live drag ceiling is
`floor(windowWidth × 0.35)` (minimum 190): wide enough for a six-level vault,
narrow enough that the rail cannot eat the canvas on a small window. A stored
width that outgrows a later, narrower window is clamped when applied, not left
to shove the document aside. `SETTING_RANGES.railWidth.max` is only a soft
absolute for persistence when no window width is known — not the hard drag
cap. That vault is the case that settles the floor: at six levels the indent
alone spends seventy pixels before the first character of a name, and at the
old fixed 248 five sibling folders all read `Done_TaskGro...`, which is a tree
that has stopped answering the only question it exists to answer. The drag
target is 7px wide because a 1px border is not something anyone can hit, and
arrow keys move it too, because a control that only takes a pointer is a
control some people do not have.

The width follows the pointer through a custom property written straight to the
element, and the setting is written once on release. Routing every pointer move
through React state and a settings round trip puts that whole path between the
pointer and the edge it is dragging, which is the lag that makes a resize feel
broken.

Tree rows are 26px, which is the density a four-level tree needs. No background
at rest, `--raised` on hover, and the current file gets a tint plus the spine.
The folder itself is the first row, set in ink at weight 600 with nothing to
press, and the first level hangs from it the way every deeper level hangs from
its parent: a tree whose lines began one level down read as a list with a tree
inside it. The path to the current file is sticky, which is the rule measured
from the author's own Typora theme rather than the one first guessed: each open
ancestor of the current file holds a row below its parent while its contents
scroll past, and the file's own row holds beneath them, so the top of the rail
always reads as where the file you are in lives. Other open folders scroll like
anything else, and so does the folder's own row. A stuck row spans the whole
rail, flush against the top of the scrollport, with a rule beneath it and the
corner of its own branch drawn on the row itself: as an indented box it left
the stems of every level to its left sliding past in the open, which read as
light leaking through the stack. The tree tells a stuck row from one merely
resting in place by how far the browser has displaced it from its own node.

The branch to the current file is lit. Each level on the way down draws its
stem in the accent as far as the child on the path, and the arms to those
children and to the file are in the accent too. This is the second of the
author's four guide-line schemes, "one stroke, current branch lit", and it
answers the one question a tree is asked, which branch am I in, without an
element of its own: the tree sets the lit length on each level and the
stylesheet stacks the accent stem over the quiet one.

A branch can only light up to a row that is there, so the tree opens to the
current file. A note opened from the shell, from quick open or through a link
has every folder between the root and itself expanded and loaded, and its row
is brought into view once, the first time it exists. After that the rail is
the reader's: a folder they close on the path stays closed until the file
changes, and a folder opening elsewhere never moves the rail.

The tree is set in the body serif, as Typora's sidebar is: the rail reads as
part of the page it navigates, not as a panel from another program. Folder
glyphs are filled shapes, files are outlines, and the two labels over the
tree are set as Typora sets its sidebar heading, in small capitals with no
indicator.

A name that does not fit the rail is scrolled to, never cut to an ellipsis.
Rows are as wide as their names and at least the rail, so the pane scrolls
sideways the way Typora's does, which is what a vault of long Chinese
filenames needs.
Every row carries a glyph, a folder or a file, drawn inline in the title bar's
stroke style in the muted tier; they are what makes a column of names read as
files rather than as an outline, and a file row carries the twisty's width as
a spacer so the glyphs of one level line up.
The previous build drew a filled rounded rectangle in accent tint around the
current file and every open folder, so a third of the tree was orange.

### Connector lines

Both trees in the rail draw them, and they are the reason a deep tree is
readable at all: without them a four-level tree is a column of names at varying
indents and the eye has to measure pixels to see what belongs to what.

Three parts. Each level carries a 1px vertical stem as a background gradient, so
no positioning context is created and nothing is measured in script. Each row
draws a horizontal arm into that stem. The last row of a level draws a rounded
corner instead and masks the stem below it.

That last part is the whole difference. A tee on every row including the last
reads as a grid of ticks; a corner that closes the branch reads as a tree. The
technique is the one in the author's own Typora theme, which draws the same
three parts with inline SVG; here the markup is ours, so borders and a
`border-bottom-left-radius` do it without the data URIs.

Indent is 13px per level, and every row carries its full name as a tooltip,
because past four levels some names truncate at any rail width worth having.

The line colour is `--tree-line`, an ink or paper wash at 14 to 18 percent. Low
enough that a deep tree reads as texture rather than as a diagram, which is the
difference between a guide and a schematic.

### Indicators are bars, not inset shadows

`box-shadow: inset 2px 0 0` on a element with a border radius follows that
radius: it comes out thick in the middle and pinched to nothing at both ends, a
crescent rather than a bar. Every "you are here" mark in the app is its own
absolutely positioned element with its own 1px radius and a 5px inset top and
bottom, so it is a straight bar with round caps and looks like a decision.

## Recent documents, in the status bar

There was a tab bar. It was a row of chrome across the top of every screen, the
loudest thing in the window, and it was doing a job nobody asked for: managing
a set of open documents. What is actually wanted is a way back to the note you
were just in.

So it keeps four, sits in the status bar where a hint belongs, and has no close
buttons, no drag, no overflow and no order to maintain. Four is what can be
taken in without reading; past that it is a list, and a list of documents is the
file tree, two feet to the left. The documents are still open behind it and
`Cmd+W` still closes one; this is a signpost, not a manager.

The current one is set in ink rather than boxed. At eleven pixels a filled chip
is a smudge, and weight reads at any size.

## Rail footer

The folder's name, and the actions that operate on the folder rather than on a
file: open another, refresh, and the folders opened before. At the bottom
because it answers "which folder", which is asked far less often than "which
note" and belongs further from the hand. The menu opens upward, since it is
anchored to the bottom of the window.

Recent folders are the same store as recent documents, instantiated twice: a
folder is a path with a name and a timestamp exactly as a document is.

Reveal takes a kind, not a path. Main already knows which folder is open and
which document is in front, so the renderer names `folder` or `document` and
nothing else; a request carrying a path is refused outright. That keeps the one
capability in the workspace API that reaches outside the app to "open the file
manager at something this window is already showing you", which is small enough
to reason about. The label follows the platform, because Finder, File Explorer
and file manager are three names for the idea and only one of them is true on
any given machine. Before
this, moving between two vaults meant walking the file dialog to the same place
every time.

The tree above it no longer names the folder. The footer does, and a header
saying the same thing above the same tree was the name twice with two ways to
change it.

## Status line

28px, `--muted`, 11px. The containing folder on the left, shortened to a leading
tilde inside the home directory, with the full path on hover. The fidelity line
on the right, which is the one thing in the window that says the file is being
kept byte for byte, and which nothing else says.

Not the filename: the title bar has it, and repeating it spends the only other
line the window has on something already read.

## Preferences

One dialog, 720×560, reached from the gear or `Cmd+,`. Sections down the left,
content on the right: Appearance, Editor, Plugins.

No rule between rows. A line under every setting draws a table where there is
only a list, and the last row of a section always ended up floating above the
footer's own rule with nothing between them. Space separates; a label and its
control are already a pair by sharing a line.

Appearance carries the theme, the typographic settings, and the custom
stylesheet. Text size and line height are sliders with the value beside them in
its own units, because a slider alone hides the number and a number field alone
turns finding a comfortable line height into typing and re-typing. Page width
is the same three-way control as the theme, since it is three modes rather than
a number and the pixels each mode resolves to depend on the canvas; the hint
under the label names the chord that walks them.

Range inputs are painted rather than left alone. A bare one uses the operating
system's accent colour, which is neither this app's accent nor anything the
palette knows about: a strip of macOS blue in a warm paper window.

The custom stylesheet is a path, not a text area: a theme is a file you keep
open in your own editor and reload, and a picker would make you find it again
every time. It is committed on blur or Enter rather than per keystroke, so a
half-typed path is never written and never reported unreadable.

Two things make that stylesheet actually able to retheme the app. The palette
lives in a `@layer`, because an unlayered rule beats a layered one whatever its
specificity, and without that a user's `:root { --accent: … }` would silently
lose to the theme's `:root[data-theme='light']`. And the stylesheet is applied
as a constructed sheet through `adoptedStyleSheets` rather than as a `<style>`
element, because the renderer's `style-src 'self'` refuses inline style elements
outright: the element appears in the DOM and the browser declines to apply it,
a failure whose only symptom is the theme not working. A sheet built by script
is not parsed from markup, so the policy stays exactly as strict as it was.

Plugins live here because they are configuration, not a workspace panel. They
had a right sidebar of their own that pushed the document sideways whenever it
opened, and it read as a debug console: `Disabled` in bold, a paragraph of
capability jargon, and a full-width `Enable` slab, four times over. As a
preferences section each plugin is one row, name and a plain sentence on the
left, the action on the right at its natural width. Diagnostics stay collapsed
behind a disclosure, because that is what they are.

Copy in this dialog is written for the person using the editor. "Editor
decoration only. No filesystem access." is a capability declaration and belongs
in the manifest, not on screen. What the reader needs is what the plugin does.

## Saving automatically

Off by default, and debounced against typing rather than fired when the document
turns dirty. A save costs between 226 ms and several seconds depending on the
document, so saving mid-word on a large file would stall the very typing that
triggered it.

It refuses in exactly the cases the Save button refuses: a save already in
flight, a recovery record standing, a file changed underneath us. Automatic
saving must not reach a path the manual one guards, and an external conflict
resolved automatically is data loss nobody watched happen.

## What the chrome must never do

Move the document sideways when a panel opens is unavoidable with a rail, but
nothing else may. Panels do not float over text. Controls do not appear and
disappear on hover except the tab close. Nothing animates on load. The accent
never appears twice in one region.

## The furniture, and how little of it there is

Typora spends the top of its window on the file's name and nothing else. Noto
keeps a title bar of 32px because it has a few controls that must stay
reachable, and that is the whole of its permanent furniture. The rail has no
footer: the folder names itself on the tree's first row, and the folder's
actions are an ellipsis on that row, shown to the pointer and to the keyboard
and while its own menu is open. The strip along the foot carries the recent
notes and one line of state, and that line fades once it has been read, so
the foot is empty at rest.

The title bar carries the rail's ground above the rail and the page's above
the page, so the divide between the two columns runs from the top of the
window to the bottom rather than being cut across by a band.

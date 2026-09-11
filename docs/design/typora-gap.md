# Where Noto stands against Typora

Measured against the Typora on this machine, its stylesheets on disk, the
author's own theme (`Typora_Claude-Like_Theme`), and the author's vault: 7,066
notes, 82.5 MB of markdown, 343 image files, six levels deep. Every assessment
names its evidence, and where a number appears it was measured rather than
estimated: from the running Typora through its remote control, from the
packaged app through a driver, or from the vault itself.

Grouped by what part of the experience each one is about, rather than by when
it was found. Speed is not here: `docs/performance/large-documents.md` carries
what a large document costs and where the cost is.

# The document, as it is drawn

## 1. Images did not render. Closed.

2,466 of the 7,066 notes embed an image, and until this week Noto showed none
of them. A local `![](./pic.png)` failed with `net::ERR_UNEXPECTED`; a remote
one was refused by the renderer's content security policy, which was
`img-src 'self' data: blob:` with `connect-src 'none'`. Most of the vault's
images are remote: 5,516 are `https:` and 7 are `http:`, 2,482 of them on a
Huawei OBS bucket and 2,871 on `nihaixiahope.com`. 204 are paths relative to
the note, and most of those climb to a sibling assets folder
(`../.gitbook/assets/...`); 136 are percent-encoded; 5 are absolute.

What shipped. Web images load, behind a switch that is on by default because
that is what a reader expects, with a line in preferences saying that every one
is a request to the server that holds it. The switch is gated in the renderer,
so turning it off takes effect on the page in front rather than after a
restart; `connect-src` stays `'none'`, so a note can show a picture and still
cannot fetch anything, and the seven `http:` pictures are asked for over TLS
rather than in the clear. Local images are served by main through the app's own
origin from two roots and no others: the open folder, and the folder the note
in front is in. The real path is checked after every link is followed, and
only names that end in an image extension are served. A picture that cannot be
shown, for any reason, is a small labelled frame carrying the note's own alt
text and the reason, not a gap. Opening a folder after the note redraws the
note's images, so a picture in a sibling folder that was refused a moment ago
appears without the note being reopened.

The remainder, now closed: 960 pictures in this vault are raw HTML `<img>`
tags rather than markdown images, 767 of them in the shape Typora pastes
(`<img src alt style="zoom:50%" />`), 736 alone on a line and 164 inside a
sentence. Raw HTML is still never rendered live. A lone `<img>` tag is parsed,
strictly, into the few attributes a picture needs, the source, alt, title,
width, height, and a zoom or width from the style, and everything else is
dropped; those are drawn through the same frame as a markdown image, so the
zoom Typora wrote is honoured. While the caret is elsewhere the tag shows as
its picture; when the caret enters the block the source comes back, which is
Typora's rule. The source is never removed from the block, only kept out of
sight, so editing is unchanged.

## 2. The prose was a size louder than the theme, and headings did not scale. Closed.

The author's theme sets a 16px body at 1.58 leading with headings in em, so
`h1` is 1.84em, `h2` 1.48em, `h3` 1.24em, weight 600, and they follow the body.
Noto set an 18px body at 1.62 with headings in pixels: 34, 27, 22, fixed. Two
consequences. Every heading was a step louder relative to its paragraph than
the theme the author reads all day. And the text size setting moved the body
and left the headings where they were, because a pixel does not know what an
em is.

Now the default is 15px at the theme's 1.58 (a step under the theme's own 16:
set beside Typora, 16 still read a size louder to the author's eye, and 15 is
where the two windows matched), the headings are the theme's em
ratios with its margins scaled by the document size rather than the root, and
the block rhythm is its 0.74em above and below, collapsing. Bold is 600 in the
strong ink tier, links are in the accent with the underline held to a third,
lists have the theme's indent and a muted marker, and a loose list is drawn
with room inside its items while a tight one is not, which needed the parser's
`spread` flag to reach the DOM. The reading column is 860px, which is the
theme's width at this size.

## 3. Tables drew every cell border. Closed.

The theme draws horizontal rules only: a strong rule above the header and below
the table, a lighter rule between rows, no vertical lines at all, and no
alternating fill. Noto drew a 1px border on every cell. In the author's own
screenshot the table was the most visible difference between the two windows.
Noto now draws the theme's rules, in the prose face at 0.92em with lining
tabular figures, and the first column in the strong ink tier as the theme has
it.

## 4. Code blocks had no line numbers. Closed, bar two extras.

The author's `fence-enhance` plugin adds a gutter of line numbers, a language
label and a copy button to every fence. Noto showed the language on hover and
nothing else. The line numbers are the part that changes how a code block
reads at a glance.

A fence is now a node view: a gutter column of numbers in the plugin's rule,
as wide as the block's own line count and never narrower than two digits,
beside the code, which no longer wraps so the two stay in step; the language
and a copy button share the corner and show while the pointer is over the
block or the caret is in it. The numbers are not content: a selection never
takes them and copying copies code. A switch turns them off, on by default as
the author's Typora is set. Indent guides and tab markers followed; both are
closed below.

## 5. Blocks did not share the text's left edge. Closed.

Every top-level block carried a 14px padding for the heading markers, so a
paragraph's first letter sat 14px in from the block's edge while a fence, a
table or a quote drew its box from that edge: every filled block stuck out to
the left of the text it sat between, which the author drew a red line against.
The gutter is now the document's, once, on the editor itself, and a block's
box and a paragraph's first glyph share one left edge.

## 6. Inline code was bare. Closed.

The theme gives inline code a border, a fill, a small radius and `0.9em`. Noto
set a monospace face at 14px and nothing else, so `A400_Languages` sat in a
sentence with no edge. Small, but it is in nearly every paragraph of this
vault. Inline code now has the theme's hairline, fill, radius and its own warm
ink, at 0.9em of the prose so it follows the size setting; a fence has the
same hairline and no edge on the code inside it, since the fence is the edge.

## 7. Alerts rendered as plain quotes. Closed.

`> [!NOTE]` and its four siblings, which the vault holds by the hundred, drew
as a quote with the marker showing. They are now callouts as Typora draws
them: a rule and a tint in the kind's colour, an icon and a title in place of
the marker, the marker itself back while the caret is inside. Decorations over
an ordinary quote, so the file keeps its marker line byte for byte.

## 8. Typora's own inline marks were plain text. Closed.

`==highlight==` is in 960 places in the vault, `^superscript^` in 363 and
`~subscript~` in 254. None is CommonMark, so the parser kept them as text and
the editor showed the delimiters. They are now drawn as Typora draws them,
through decorations: the inner text takes the mark, the delimiters hide, and
both come back muted while the selection touches the block. The file keeps
every delimiter. The scan is incremental, one paragraph per keystroke, so the
two-megabyte corpus documents pay nothing for it.

## 9. The inline HTML a note writes for a key, a formula or a break showed as source. Closed.

`<br>` sits in 567 lines of the vault, `<sub>` in 86, `<kbd>` in 81, `<sup>`
in 37 and `<u>` in 20. A bare formatting tag with no attributes, and the text
between it and its closing tag, is now drawn as the shape it names; the tags
hide and return with the caret. A `<br>` breaks the line and shows its source
only while the block is being edited. A tag carrying attributes, `<span
style>` above all, is left as source, since drawing an author's inline
style would mean trusting it.

## 10. A mermaid fence showed its source. Closed.

The vault fences 121 mermaid diagrams in 77 notes, flowcharts and sequence
diagrams above all, and Typora draws every one. Noto showed the source in a
code box. A mermaid fence is now drawn as its diagram: only the drawing while
the caret is elsewhere, on the page and not in a box, and the source above
the drawing in the fence's own box while the caret is in it; a press on the
drawing puts the caret in the source, and a diagram that cannot be drawn says
so under where it would be, with the source untouched. The palette is the
document's, read from the tokens at each drawing, so a theme file and the
dark theme reach the diagram too.

The drawing happens in a frame sandboxed to nothing. Mermaid writes an SVG
full of inline styles, which the editor's content security policy refuses,
and it draws text the reader wrote, which the editor does not run; so the
frame has no origin, no bridge to main and no way to reach the page that
holds it, and the only thing that crosses is the source and the palette going
in and a height or an error coming out. The file keeps its bytes: the drawing
is a view of the fence, never its content.

## 11. A formula was drawn as an exhibit. Closed.

Typora gives a block of maths no box at all: centred on the page at the
body's own size, with room above and below and nothing drawn around it. This
put a rule and a fill and a smaller size around every one, so a document of
working read as a document of quotations. Inline maths was boxed too, and set
smaller than the sentence holding it.

## 12. A line the author broke is now drawn broken. Closed.

CommonMark reads a single newline inside a paragraph as a space, and so did
this. Typora draws it as a break, and the difference showed on any note with
a two-line quote or a wrapped sentence. The reasoning for collapsing had been
that such a newline is only where an editor happened to wrap the source; a
census of the vault says otherwise. There is no wrapping convention in it at
all, lines running from a few characters to nearly three thousand, and 2.7%
of its 213,471 paragraphs hold a newline. These notes were written in Typora,
where Enter starts a paragraph and only Shift+Enter puts a newline inside
one, so every one of those is a break somebody typed. They are kept now, and
drawn where they were typed.

## 13. Bold beside Chinese was not bold. Closed.

The largest single fault found in this run, and it was found by re-serializing
the vault rather than by looking at it. CommonMark decides whether a `**` run
can close from what sits either side of it, and it counts CJK punctuation as
punctuation, so `**注意：**一定` never closes: the reader saw asterisks where
they had written bold. A census of 300 notes found 596 of their 3,220 bold
runs unparsed for this reason, in a quarter of the files. Typora closes them,
and so does anybody reading the file.

Both halves of the CommonMark community's own CJK-friendly amendment are in
now, the reading half and the writing half. The reading half fixes the
rendering; the writing half matters just as much, because without it the
serializer keeps the old rules, decides the run cannot close, and escapes the
Chinese character after it into a numeric reference. Missed runs fell from 596
to 179.

## 14. A bare URL was not left as one. Closed.

Found by rendering real notes rather than a made-up one. Two faults, both on a
construct the vault uses 6,200 times.

Editing any paragraph holding a bare URL wrote it back as `<url>`. That is the
serializer's own default for a link whose text is its address, and it is
correct markdown, but it is not what these files say: 6,200 bare against 145
in angle brackets. A bare URL is written bare now, and only where that is
unambiguous, since GFM trims a trailing full stop or bracket off a bare
address and one that ends in punctuation has to keep its brackets or come back
a character shorter.

The other fault was on screen. Putting the caret in a paragraph reveals the
markdown of the inline thing it is in, and a bare URL was revealed as
`[url](url)`, showing syntax the file does not contain and inviting an edit
that would turn it into a different construct. A link whose text is its own
address now reveals nothing, because there is nothing to reveal.

# The window around it

## 15. The file tree had no icons. Closed.

Typora prefixes every row with a file or folder glyph; the author's tree shows
them. Noto's rows were text and a twisty. With the connector lines in place the
tree was legible without them, but they are what makes a row of names read as
files rather than as an outline. Every row now carries one, drawn inline in
the title bar's stroke style in the muted tier, a folder's flap lifting when
it is open; a file row carries the twisty's width as a spacer so the glyphs of
one level form a column.

## 16. The title bar was a band across the window. Closed.

Typora's sidebar and page each carry their own ground from the top of the
window to the bottom, so the two columns read as columns. This drew a single
panel-coloured bar across the whole width, which cut the page off from its
own title. The bar now carries the rail's ground above the rail and the
page's above the page, and the divide runs floor to ceiling.

## 17. Three bars of furniture where Typora has one. Closed.

Typora spends the top 28px of its window on the file's name and draws nothing
else: no bar down the side of the rail, no strip along the foot. This had
three. The rail carried a footer naming the folder, which the tree's own
first row already names, with the folder's actions behind it; those actions
now live on that first row, as a quiet ellipsis that comes up when the
pointer is on it, which is where an action belongs, on the thing it acts on.
The foot of the window carried a sentence that was always there, and a
promise that is always on screen stops being read; it is said when it
changes and fades. The title bar is 32 rather than 38.

## 18. Quick open read as ten copies of one path. Closed.

Every result showed its whole path, truncated at the right, and in a vault
whose paths share long prefixes that left ten rows reading identically: the
same forty characters, then an ellipsis. What tells two results apart is the
folder the note is in, so the filename goes, since the row already names it,
and the last two folders are what survives. The whole path is still there on
hover.

The keyboard's focus ring was drawn in near-black ink, which on a bordered
control read as a second border or as something being wrong. It is the accent
now, which is the one thing this interface uses to say where you are.

## 19. The outline never said which heading you were in. Closed.

A list of headings is asked two different questions. Navigating, it is asked
where to go, and this answered that. Writing, it is asked where am I, and this
said nothing: the outline looked the same whatever the caret was doing.
Typora marks the heading you are under; so does this now, in the same warm
grey the current file gets in the tree, following the caret as it moves and
resolving a paragraph to the heading above it.

The editor reports the top level block the caret is in whenever it changes,
which is a thing worth having anyway and cost one comparison per transaction.

# Measured against the running Typora

## 20. Frame by frame against the author's window. Closed, for this frame.

The author's Typora window and Noto were put on the same note at the same
size, 1274 by 698, and compared. What differed, and what changed:

Tables were the loudest. Noto laid them out with fixed, equal columns and let
words break anywhere, so `patents_detail.description` wrapped mid-word and
every row was two lines tall; Typora sizes each column to what it holds.
Columns now take their content's width, long words break only when the
table has run out of room, and the cells carry the theme's padding, row
rule and hover wash.

The sidebar was set in the interface sans; Typora's is in the body serif,
which makes the tree read as part of the same page as the note. It is the
serif now, the folder glyph is a filled shape as Typora's is rather than a
wire outline, the stuck rows carry the theme's hairline and its faint
shadow rather than a strong rule, the tabs are set as Typora sets its
sidebar heading, small capitals with no indicator, and the rail opens at
272 rather than 248, which is what a vault of long Chinese names needs.

The title bar cut the file name to an ellipsis to make room for two folders
and a marker. Only the folder the note is in is shown now, and it gives way
before the name does. The status strip repeated the path under a rule on a
panel of its own; Typora has no such bar. The strip keeps the state and the
recent notes on the page itself, with no rule and no fill. Scrollbars were
the system's classic ones; they are the theme's thin thumb now, shown
while the pointer is over the pane.

Smaller: the quote is the theme's box, a quiet rule on a fill with text a
step lighter; a fence has the theme's radius and its extra air; a rule is
as faint as the theme draws it; a picture has the theme's inside hairline;
the caret is the accent, and a selection is the accent at a wash, where
before it was the system blue because nothing had set it.

## 21. Measured against the running Typora, not guessed at. Closed.

With the remote control working, both editors could be asked the same
question at the same window size and their answers compared field by field:
every font, size, leading, weight, colour, margin, padding, border and
radius, for every construct in one note that holds them all.

The type was already right. Every difference in the document was the base
size and nothing else: Typora sets 16px, this is set to 15 at the author's
asking, and since everything is in em the two are the same drawing at
different sizes. What the measurement did find:

The reading column was 64px too wide. Typora caps its page at 860 including
its own 32px gutters, so the text is 796 across; the cap here had been set to
the whole box. The page had 26px of air above and 80 below; Typora has 32 and
104, and the deep foot is what lets the last paragraph be scrolled to eye
level. Three colours were near misses rather than matches: the strong ink,
and the quote's text and rule, are now the theme's own values.

Code was drawn in status colours, a string in the green that means success
and a keyword in the accent. The theme gives code five colours of its own,
and they are now read from it: purple for what the language reserves, green
for text, warm brown for numbers, blue for names the document defines, and
the muted tier for comments.

The tree was a size smaller and a third tighter than Typora's: 26px rows of
13px text against 32px rows of 14px. It is Typora's now, with the row height
in one place since the sticky offsets are multiples of it, every row quiet
except the one you are in, and the theme's own warm grey behind it.

A task item hung outside its list, because the whole item was pulled left to
make room for the box rather than the box being put where the bullet goes. A
finished one now recedes to the theme's colour, and is struck through only
when it is a loose item, which is the theme's own rule.

An alert's title sat on the same line as its first sentence.

## 22. A second pass with fresh eyes. Closed.

Six things a reader who had not been staring at it all day picked out.
Preferences opened with a focus ring around its Done button, so the eye landed
on a button before the settings; the dialog takes the focus now, which traps
the keys without drawing anything, and the ring appears when somebody actually
tabs. The panel was a fixed 560 tall, which left the shortest section a void
under its last control and a footnote pinned to an edge it had nothing to do
with; it is as tall as what is in it. The sidebar toggle turned into a filled
box when the rail was open, making the heaviest mark in the title bar an
accident of state; a mode that is on says so in colour, as the rail's own tabs
do, and the fill is kept for a button holding a menu open below it. In the
dark theme the lit branch was the loudest thing in the window, because the
same accent carries much further on a near-black rail than on paper; the tree
has its own accent now, the same hue at 62% in the dark. The scrollbars left
an opaque square where they met. And focus mode dimmed text but not fills, so
a quote or a callout still read as a solid rectangle beside a nearly
vanished paragraph; the author's theme answers this the same way, by taking
the fill off a callout in focus mode.

Frontmatter, which 3,440 notes in the vault carry, had a rule down its left
and 12px of padding against Typora's none and 16.

# Editing

## 23. A fence had a label but no way to set its language. Closed.

The language in the fence's corner is now a field, with the highlighter's
names offered as you type, and setting it writes the fence's info string as
one undoable change and colours the block.

## 24. The highlighter knew twenty languages; the vault fences forty. Closed.

Haskell alone is fenced 319 times, and it was not loaded; nor were Ruby, Lua,
PHP, C#, PowerShell, HTTP, Vim script, Nginx, INI, Dockerfile or Makefile,
which together account for a thousand more. Every language the vault fences
more than fifty times now has its grammar, with the short names an author
actually types (`hs`, `rb`, `ps1`, `dockerfile`, `jsonc`, `elisp`) mapped to
it. `text`, `console` output and the odd `undefined` stay unpainted, which is
right for them.

## 25. The keys Typora gives to the marks markdown has no key for. Closed.

Read out of Typora's own menus rather than from memory. Its headings, strong
and emphasis were already the same. What was missing: Underline on Command+U,
Highlight on Shift+Command+H, and, on Control rather than Command, inline code
on Control+`, strike on Control+Shift+`, and inline maths on Control+M. Its
Increase and Decrease Heading Level, Command+= and Command+-, walk the one
scale from a paragraph up to a first-level heading and back down again rather
than jumping to a level by number. All of those are bound now, alongside the
bindings this already had.

Its block types are on Option and Command together: a maths block on B, a
fence on C, a quote on Q, an ordered list on O, a bullet list on U, a task
list on X and a rule on the minus. Those are bound too. Opening a folder moved
off Option and Command with O, since a menu accelerator wins over the editor's
own keys and a list is made far more often than a folder is opened.

Two of them cannot be written as text. A `<u>` typed into a paragraph is
escaped when the paragraph is saved, because a bare `<` could open anything,
and comes back as `\<u>`; a `$` is escaped for the same reason. Underline
goes in as inline HTML nodes and maths as a maths node, so each is what it
says it is and survives the round trip. Highlight is plain `==`, which needs
no escaping and so can be exactly the characters the file will hold.

## 26. Typora's two writing modes were missing. Closed.

Focus mode and typewriter mode are in Typora's View menu and are part of what
people mean when they say they write in Typora. Focus mode quietens every
block but the one the caret is in; the block is already marked for the syntax
reveal, so knowing which one it is costs nothing, and it recedes rather than
disappearing so the shape of the page is still there to navigate by.
Typewriter mode keeps the line being written at 42% of the way down the pane
and moves the page under it. It only ever acts on a caret, never on a range,
because a page sliding under a drag is unusable, and it moves the page at
once rather than animating, since it runs on every keystroke that changes the
line and an animation would spend its time chasing the last one.

Both are settings, so they are remembered, and both are in the View menu
where Typora keeps them. Neither has a shortcut, which is also Typora's
choice: they are settled once for a session rather than reached for mid
sentence.

## 27. A table could be read but not edited. Closed.

The vault holds 42,330 table rows and there was no way to add one. Tab moved
between cells and stopped at the last; nothing anywhere could insert a row or
a column, delete one, or make a table at all.

Tab at the last cell now makes a row and puts the caret in it, which is what
every table editor does and the only way a table grows without leaving the
keyboard. Typora's own Table submenu is there too, under a Paragraph menu
that also gives the block shapes a home: insert a table, add a row above or
below, add a column before or after, delete a row, a column or the table.

The Paragraph menu closes a second gap. The block bindings taken from Typora
were real but invisible, reachable only by somebody who already knew them.
Every item in that menu runs the same editor command its shortcut runs, so
the two cannot drift apart, and the menu is where a hand goes looking.

## 28. A bracket did not close itself. Closed.

The author's Typora pairs brackets and quotes, which its own settings confirm,
and this did not. Typing an opening bracket now writes its partner and leaves
the caret between them; typing it with something selected wraps the selection;
typing a closing bracket where that same bracket already sits walks past it
rather than doubling it; and a backspace between an empty pair takes both.
The CJK brackets are in the set as well as the ASCII ones, since the notes are
written in Chinese.

The rule that makes it bearable is where it refuses. A quote after a letter is
an apostrophe, so `don't` stays `don't`, and a bracket in front of a word is
nearly always meant as one character. It is a setting, on by default, because
this is the kind of help that is either invisible or infuriating and which of
the two depends on the person.

## 29. There was no menu on a right click, so spell check had no answers. Closed.

Nothing at all came up on a right click, which meant the spell checker could
underline a word and offer nothing to do about it. There is a menu now, built
in main because that is where the clipboard roles and the dictionary's own
suggestions live. It shows only what the click is about: the spelling
section over a misspelled word, with up to five suggestions and a way to add
the word; a link's or a picture's address when the click is on one; and
otherwise the clipboard, including pasting as plain text, which for a file
made of markdown is what is wanted more often than the fragment's own markup.

Pasting itself was already right and had no test. A fragment copied from a web
page arrives as the markdown it means, headings at their own level, bold and
links as marks, lists as lists, and the file it saves has no HTML in it. A
fragment pasted into the middle of a sentence merges with that sentence, which
is what every editor does; on a line of its own the blocks survive.

## 30. Editing a block rewrote more of it than it had to. Closed, in part.

A block nobody touches is copied from the original bytes, but an edited one is
written afresh, and the serializer's dialect is not this vault's. Measured by
parsing and re-serializing every block of 400 notes: 15.2% came back
different. Four causes, worth 6 points between them.

Emphasis was written with an underscore where the vault writes a star, 5,280
to 364. Every underscore in a paragraph was escaped, so any sentence naming
`mcp__claude_api` came back as `mcp\_\_claude\_api`; CommonMark will not
read emphasis from an underscore with a word character on each side, which is
the rule that lets snake_case be written plainly, so an identifier is now
emitted whole. An alert's own `[!TIP]` marker was escaped, which turned the
callout back into a plain quote the first time anybody edited it. And the CJK
emphasis above. Together: 15.2% down to 9.4%.

Tables were the next largest and are now mostly closed. The serializer padded
every cell out to its column's width and shortened each delimiter cell to a
single dash; the vault does neither, writing two thirds of its 43,076 table
rows unpadded and 4,039 of its delimiter rows with three dashes. Padding is
off and the delimiter cells are widened back, colons kept where they were.
Table churn fell by 44%, and the total from 9.4% to 8.7%.

A third pass took it to 7.3%, and is written up below.

## 31. A code block had no indent guides. Closed.

`fence-enhance`, which the author runs in Typora, rules a hairline at each tab
stop of a line's indentation, and the vault has 285,431 indented lines across
31,372 fences. They were listed as not ported because each one seemed to need
an element per line, which a document of ten thousand code lines cannot
afford.

It does not. The rules are a gradient carried by the line's own leading
whitespace, which is real text already in the file, so nothing is inserted and
no element is added. The step is the block's own: the common divisor of the
indents it actually uses, so a file indented by three is ruled at three. A line
gets a rule for each step to its left and none at its own, because a rule under
the first character would underline the code rather than mark the step. They
are drawn by the syntax highlighter, which already rebuilds only the block that
changed, so they cost what the highlighting costs and nothing more.

# Faults found on the way

## 32. A plugin enabled last time did not always come back. Closed.

Found through a test that failed about one run in three under load and passed
every time on its own, which is the shape of a race rather than of slowness.
An enabled plugin waits for an editor, and the announcement that one exists
was made from the editor's side only, guarded by a snapshot of the plugin
lifecycle. On a restart those two arrive independently, the editor from
opening the document and the snapshots from main over IPC; whenever the
snapshots were second, nothing ever announced the editor and the plugin sat at
"enabled, waiting for editor" for the life of the window.

The editor now announces if it can and arms a one-shot if it cannot, which the
first snapshot batch of that same startup spends. Deliberately one shot: a
plugin the reader enables later is meant to stay idle until they activate it,
and an announcement left standing would start it the moment it was enabled.

## 33. The shell would open anything, and draw it as prose. Closed.

The tree lists Markdown and plain text, the search index holds the same, and
the Open dialog filters to it. The command line took whatever it was given, so
`Noto main.ts` opened a source file and drew it as prose: the indentation
gone, a template literal read as a code span, and any block the reader touched
written back as markdown rather than as the code it is.

The four now give the same answer, from one list rather than the two copies
that each carried a comment saying they had to match. Opening something else
says what the editor is for instead of quietly making a mess of the file.

## 34. Opened against the vault, note by note. Nothing broke.

220 notes spread across the whole vault were opened one after another in a
packaged window, with every console error collected and every render compared
against the file's own length. Four notes reported a problem and all four were
the same thing: an image whose remote address no longer answers, which the
editor draws as a labelled frame carrying the note's alt text and the reason.
No note failed to open, none rendered empty, and none lost its content.

The script is `scratchpad/probe/sweep.mjs`, and it is worth running again after
any change to the parser or the editor's plugins: it exercises constructs no
made-up document contains.

## 35. A note was written back in a dialect its author does not use. Closed.

Three findings from the same corpus measurement, taking it from 8.7% to 7.3%.

A paragraph opening with a highlight had its first `=` escaped, because an `=`
at the start of a line can underline a setext heading. `\==text==` is not a
highlight any more, so the feature broke itself the first time anybody saved.

A hard break was written as a backslash. The vault ends a line with two spaces
16,328 times and with a backslash 237 times, so editing one paragraph of an old
note rewrote every break in it into a form the file has never used. Both mean
the same thing to every parser here, so the file's own convention wins. Inside
a setext heading or a table cell, where no newline can go, the break still
degrades to a space.

The carriage returns were a false alarm. The pipeline works in LF and the
writer restores the file's own endings, which the measurement was not
accounting for; a packaged test now drives the real app against a CRLF note and
reads the file back. What remains is mostly a block written in a style of its
own, a rule of six dashes or an aligned delimiter row, and those are only ever
rewritten if the block itself is edited. A test covers a neighbouring edit
leaving both untouched.

## 36. There was no way to move a line, a row or a block. Closed.

Typora puts three behaviours on Option and an arrow, and which one you get
depends on where the caret is: a line of code moves inside its fence, a row
moves inside its table, and anywhere else the block itself moves among its
siblings. When a block has no sibling on that side the move is tried again on
its parent, so the last item of a list carries the whole list with it. Columns
move left and right on Command, Control and an arrow. The bindings are read
from the running Typora rather than remembered: `alt+up`, `alt+down`,
`command+control+left`, `command+control+right`.

A table's first row is its header, and markdown cannot write a table without
one, so the header stays where it is and no row moves above it. One difference
is deliberate: Typora stops at the line inside a fence, which leaves a fence
with nothing above it stuck where it is, while here the move carries on to the
block. The intent behind the key is the same either way.

## 37. A table could only be rearranged from the menu. Closed.

Typora grows a slim rail above the columns and beside the rows when the pointer
is over a table. The rail was found by reading the running app rather than from
memory: `#typora-table-row-tracker` and `#typora-table-col-tracker`, each with a
drag area and a data area, and `#typora-table-row-insert-marker` beside them.
Typora fills the tracker with a clone of the row so the row itself follows the
pointer.

Noto draws the same rail, one handle per track, quiet until the table is under
the pointer. Clicking a handle selects its row or column; dragging carries it,
with a line in the accent colour showing where it will land, and Escape or a
cancelled pointer puts everything back because nothing is dispatched until the
drop. The header has no handle and nothing may pass above it.

Two things were learned building it. Handles drawn to the full length of their
track join into one continuous bar and stop reading as one grip per column, so
each is inset three pixels at both ends. And anything written to the node view's
own element, `data-dragging` in the first attempt, is a change the editor did
not make: it rebuilds the view and the drag dies on the first pointer move.
Everything the drag touches now lives inside the rails, which the view is told
to ignore.

## 38. Every window, looked at rather than reasoned about. Three faults.

Preferences, quick open, the plugin centre, find and the empty state were
opened and photographed at 1280 by 820 in both themes. Three things were
wrong, and all three were only visible in a picture.

Opening a note from Finder left the workspace with no folder, so the tree was
empty and quick open said there was nothing to search while sitting in a
directory full of notes. That is written up above.

The find bar reserved five and a half characters for a match count that never
needs more than "No results", and closed with a button filled in the ink
colour, which made the loudest thing in the window the one control that is not
the reason the bar is open. Escape closes it anyway. The count now reserves
what it needs and the button reads as one more control.

The two buttons on the empty state sat at different heights, because the
primary carried a top margin of its own inside a centred row. Both now take
their shape from one rule and only the colours differ.

A fourth came out of photographing the same windows in the dark theme.
Preferences and quick open were drawn in the paper colour on a ground that was
the paper colour under a scrim, which in the light theme is a pale card on a
grey field and in the dark theme is two nearly identical dark greys: 0x1F1E1C
against roughly 0x0F0E0D, with a black shadow contributing nothing. A panel
over a scrim now has its own token and is lifted above the page in the dark
rather than matched to it. The find bar keeps the raised colour, because it
floats without a scrim and has to differ from the page it sits on. The two
cases look like one and are not.

## 39. There was no way to make a link, or to change one. Closed.

Typora's menu was read out of its own bundle, 301 labels, and set beside
Noto's. Most of what it had that Noto did not was export, printing and
document conversion; export is closed below. One entry was not like the others: Hyperlink, on Command
and K, which Noto had no command for at all, on any menu or key. Making a link
is among the most common things anybody does in markdown.

Worse, an existing link could not be changed either. The delimiters revealed
around the caret show a link's destination because it is the part a reader
cannot otherwise see, but they are decorations and nobody can type into a
decoration, so the only way to correct an address was to leave for source mode.

Command and K now opens a small panel under the link. With text selected it
makes one; with the caret in a link it opens on that link and shows its
address; Enter writes, Escape and clicking away leave the file alone because
nothing is dispatched until then, and Remove takes the link off and keeps the
words. It declines inside a fence, which holds its text as literal source and
takes no marks.

Three things about the panel were only findable by driving it. `display: flex`
outranks the browser's own rule for the hidden attribute, so the panel was
never actually hidden. A command run from the menu focuses the editor again as
soon as it returns, which blurred the field, and blurring is the dismissal, so
the panel opened and shut in the same tick; the field now takes focus on the
next frame. And pressing Remove blurred the field before the click landed, so
by the time the button's handler ran there was nothing left to act on; a press
inside the panel no longer moves focus.

## 40. The revealed delimiters were lying about the file. Closed.

The reveal showed `_` for emphasis while a save wrote `*`, ever since the
serializer moved to the star the vault actually uses. There was a test for
exactly this, and it passed the whole time, because it asserted the characters
against themselves rather than against a save. Two places naming the same
constant agreed with each other and not with the document.

The reveal now takes the characters from the serializer, and the test
serializes a document with each mark and compares. The selection colour went
the same way: it was set inside the editor only, so every field outside it
selected in the platform's blue on a warm page.

## 41. Bold and italic had keys and no menu. Closed.

The same reading of Typora's menu turned up a plainer gap than the missing
hyperlink. Typora keeps Paragraph for the block a thing is and Format for how
its words are drawn. Noto had no Format menu at all: Strong, Emphasis, Code
and Strike existed only as key bindings, so the only way to learn them was to
already know them, and Underline, Highlight and Inline Math sat at the foot of
Paragraph where they are not.

There is a Format menu now, with all seven, the hyperlink, and Clear Format,
which takes every inline mark off the selection and leaves the words. Block
type is not touched by it: a heading that stopped being a heading would be a
different command.

## 42. Not one of the vault's 14,417 links could be followed. Closed.

Counting what the vault actually holds put the earlier guesswork right.
Inline links come to 14,417, tables to 1,123 files, callouts to 105 and
footnotes to 53. Links are the thing this vault is made of, and clicking one
did nothing at all: the window refuses navigation, which is the right refusal
and the wrong end state.

Command or Control and a click follows one now, the same modifier a wiki link
already took, because the text under a link is editable text and a plain click
has to go on placing the caret. A page on the web goes to the browser; any
other address is treated as a note in this folder and resolved the way a wiki
link is, by relative path and then by name.

Reaching the browser means `shell.openExternal`, which hands the string to the
operating system and will launch a handler for any scheme the machine knows,
and the string came out of somebody's Markdown file. The scheme is checked
against http, https and mailto in the renderer, in the preload, and again in
main immediately before the call.

The check that mattered was not the third one. Validating a parsed URL and then
opening the raw string is a bug wherever the two parsers disagree, and they do:
`https:/\/\evil.com` parses here as `https://evil.com/`, a tab inside a host
is dropped, a newline inside a scheme is dropped. Only the normalised form is
opened, so what was checked is what is launched.

## 43. A note never said how long it was. Closed, with a difference.

Typora keeps a word count and puts it behind a popover. Noto's status line
had the folder path and a promise about fidelity and nothing about the note
itself. The count now sits at the end of that line, where nothing competes
with it.

It is counted from what the document draws, never from the file. One of the
author's notes is 910 bytes of which most is image addresses; counting the
file says 144 words and counting the document says 84. Typora agrees with the
principle here: it reports far less than the file holds too.

It is counted after typing stops, not during. A megabyte of prose takes about
37 milliseconds, which is nothing to wait for after a pause and far too much
to pay for a letter. Typora does the same, on a deferred timer of its own.

The rule is a run of letters or digits for one word, and a Han character, a
kana or a Hangul syllable for one word each, because Chinese and Japanese put
no spaces between words and counting runs would report one word per sentence.

This does not match Typora and is not meant to. On that same note Typora says
112 where this says 84. The note holds 81 Han characters, three hyphenated
Latin words and fifteen pieces of Chinese punctuation, and Typora appears to
be counting the punctuation. A full stop is not a word. Parity is the goal
everywhere it describes something a reader wanted; here it would mean copying
a number that is wrong.

## 44. A callout could be read but not made. Closed.

The editor has drawn GitHub alerts since entry 7, with a title chip standing
in for the marker, and 105 of the vault's notes use one. There was no way to
make one except by typing `> [!NOTE]` and a line break by hand.

Five menu items now do it. A callout is not a node type of its own: it is a
quote whose first paragraph opens with the marker, which is exactly what the
file holds, so the command wraps in a quote and writes the marker as text, in
one transaction so one undo takes both back. A quote that already carries a
marker has it replaced rather than gaining a second, which makes the five
items behave as one setting rather than five additions.

The break after the marker is the soft one the file has, a bare newline. The
first attempt used a hard break, which since entry 35 is written as two
trailing spaces, and `> [!NOTE]  ` is not what the marker looks like in
anybody's note.

## 45. A link with a bold word in it was split in two on save. Closed.

Found while testing the link panel, and older than it. ProseMirror keeps a
mark on each text node, so `[**bold** and plain](url)` is two text nodes, both
carrying the link. The serializer merged adjacent emphasis, strong and strike
siblings and did not merge links, so the pair came back as
`[**bold**](url)[ and plain](url)`: two links where the file had one. The vault
holds 1,491 links with a mark inside their text, and every one of them would
have been split the first time its block was edited.

Adjacent links now join when their address and title match, and reference
links when their identifier and label match. The parser cannot tell one link
from two adjacent identical ones either, so joining them is exactly what
reading the file back does.

The panel had the same fault in a different place: it found the first run of a
link rather than the whole of it, so changing an address would have rewritten
half a link. Both are covered by tests, and one of them writes the file and
reads it back.

## 46. What the fidelity number is now, and why the rest of it stays.

Measured over 900 notes rather than 400: 39,774 blocks, 4,158 of which come
back different, 10.5%. The wider sample is the more honest figure and the two
things that dominate it are both deliberate.

A rule written as six dashes comes back as three, 388 times, which is more
than a third of all the change. The vault writes three dashes 8,123 times and
six 2,799, so three is the form the file usually has and the one the
serializer picks. The rest is unreachable in practice: a horizontal rule is a
leaf node, and the only ways to touch it are to delete it or to edit a block
beside it, neither of which re-serializes the rule. A test covers exactly
that, a neighbouring edit leaving a six-dash rule alone.

Second is trailing whitespace at the end of a heading, a paragraph or an empty
quote line, stripped on the way out. Two spaces at the end of a heading cannot
be a hard break and two at the end of a paragraph have nothing to break
before, so nothing is lost but the bytes.

What remains after those is small and scattered. The corpus measurement has
paid for itself four times over and this is where it stops being the best
place to look.

A later pass on the same 900-note sample, after the wins below, reads 45,524
blocks with 3,105 different, 6.8%. The drop is three concrete escapes the
serializer no longer makes, and the list marker the source used:

- a star glued to a word (`*nix`) stays unescaped, because real emphasis is
  already a node by the time the text handler runs;
- a metric at-sign (`NDCG@10`) stays unescaped; a real address is already a
  link node, so the text handler only ever sees the metric form;
- an image alt that is a snake_case identifier keeps its underscores, which
  the text handler never saw because an alt is a plain string;
- a list written with `*` or `1)` keeps that marker when the list itself is
  edited, matching how a fence already remembers whether it was fenced.

What still dominates is intentional: the long rule, trailing whitespace, and
the nested-list indent near-tie recorded in §58. Defensive escapes of bare
`[` in isolated blocks stay, because a block save cannot see definitions
elsewhere in the file.

## 47. A band of rail colour across a window with no rail. Closed.

Found by opening the window at 1440, 900 and 640 and looking at each. Below
900 the rail is hidden and the document takes the window, which is deliberate,
but the title bar goes on painting the rail's ground above where the rail
would be. Toggling the sidebar from the View menu at that width left a grey
band across the top left of the window with nothing underneath it.

The width comes from an inline style, which no stylesheet rule can outrank, so
the title bar now reads it through a property of its own and the narrow window
sets that to zero. An `!important` would have worked and would have hidden the
reason.

## 48. Typing a letter joined every line of the paragraph. Closed.

The worst fault found so far, and it was invisible until the product was
driven against real notes rather than written ones.

A paragraph the author wrapped by hand is one paragraph holding newlines, and
the editor draws those newlines as breaks through `white-space: pre-wrap`
rather than any node of its own. That much worked. But the view reads its own
DOM back after a keystroke, and it only preserves newlines where the node type
says its whitespace is `pre`. The paragraph said nothing, so one letter typed
into a paragraph the author had wrapped over three lines joined all three into
one, separated by spaces, and the save wrote that.

5,339 of the vault's 7,047 notes hold at least one paragraph broken across
lines, 341,174 paragraphs in all. Every one of them would have been flattened
on the first keystroke.

Setting `preserveWhitespace` on the parse rule changed nothing, which is worth
recording: the flag the view consults is `whitespace` on the node spec, not
the option on the rule.

A heading has the same exposure and needed the same flag. A line of dashes
straight after a paragraph, with no blank line between, is a setext heading
and takes every line above it with it; 2,963 of the vault's notes have one,
and almost all of them turn out to be frontmatter missing its opening
delimiter, written that way by whatever scraped them. Whatever the author
meant, that is what the file says and what every parser reads, and typing into
one was flattening six lines into one.

Typora reads those files differently, and the difference is worth recording
rather than chasing. With single line breaks preserved, which is how the
author has it set, Typora makes only the last line the heading and leaves the
rest a paragraph. CommonMark makes the whole paragraph the heading, and so
does this. The files are malformed either way; following the spec the rest of
the pipeline is built on beats matching one editor's reading of a broken file.

Found by a sweep that copies real notes, opens each, types one letter into a
block and reads the file back, checking that every line the reader did not
touch survives. Over 127 notes it now reports nothing. Three packaged tests
hold the line, one on a file written with carriage returns and one on a
heading that swallowed its lines.

## 49. The promise, checked against six kinds of block. Holds.

The sweep that found the paragraph fault now edits a heading, a list item, a
table cell, a line inside a fence and a line inside a quote as well, and it
lives in `scripts/edit-sweep.mjs` rather than in a scratch directory.

Across those kinds, nothing outside the edited block moves. What does move is
accounted for: a table, a list and a quote are each one block, so editing any
part of one re-serializes all of it, and the gap beside an edited block is
made canonical on purpose, which is one line.

Two reports turned out to be the probe rather than the product. Typing inside
a bare URL makes its text differ from its address, and a link whose text is
not its address has to be written out in full. And counting differing lines
positionally reports two hundred where one blank line was inserted, so the
count is a multiset now.

## 50. What happens when somebody else edits the note. Tested, and reload closed.

A vault under version control gets written from outside all the time: a pull,
a script, another editor. The protection was already there and had no test, so
it has one now, and it is the highest-stakes path in the product: the save is
refused, the other change stays on disk untouched, and the reader's work stays
in the window.

The banner said "review the disk version or save a copy". Saving a copy is one
of those two; reviewing used to mean leaving for another program. Reload from
Disk is on the banner and the File menu now. A clean buffer takes the disk
version at once (and can follow quietly when that setting is on). A dirty
buffer never replaces silently: the confirm names that unsaved edits will be
discarded, offers Reload as the danger action, Save a Copy first when that
path already exists, and Cancel. Half of a confirm without a way to keep the
work would still be worse than none; both halves are there.

## 51. What three independent reviews found. Four real, two already fixed, one wrong.

Two of the four headline findings had already been fixed by the testing that
found them first: the link panel taking only the first run of a link, and the
external link opening a different string from the one it validated. Both are
above.

Real and now closed. A click on a table rail did not check that every row has
the same cells, which the reordering did check; a table with a merged cell,
which only arrives by pasting HTML, threw out of the pointer handler before
the drag was ended, and the only place that takes the window listeners off is
that ending. The rail froze for good. Ending the drag is in a `finally` now,
and the shape check is shared.

Real and now closed. Command and K was given to both the command palette and
the hyperlink, by me, today. Only one of them could ever fire.

Real and now closed. The page width had Command and a bracket while the editor
gave the same pair to list indentation. A native accelerator is handled before
the document sees the key, so a list could not be indented from the keyboard
at all. Width has no accelerator now, for the same reason Focus and Typewriter
have none: it is settled once for a session. Two tests guard the class rather
than the instance, one that no two menu items claim a chord and one that the
menu leaves the brackets alone.

Real and now closed, though nothing showed it yet: a drag held while the
document changed under it kept an index measured from the old shape, and the
count of words was bound to a tab at construction where every other such
handler goes through a ref.

Wrong, on reading the code: opening several files at once was said to race on
adopting a folder. It cannot. The claim is the first statement of
`adoptFolder`, before any await, so the check and the claim are one tick and
nothing can interleave.

## 52. There was no way to make a note. Closed.

The File menu had Open, Open Folder, Quick Open, Close, Recent, Reveal, Save
and Save a Copy, and no New. An editor for a vault of seven thousand notes
could open any of them and could not add one.

Command and N makes one now. Where it goes is decided in main rather than
asked for: the folder that is open, or failing that the folder the note in
front came from. The renderer names no path at all, because a request that
could name its own would be a request to write anywhere this process can
reach.

The name is the first free `Untitled`, and the file is created with the flag
that fails if something is already there, so a note is never written over even
if one appears between the check and the write. A test puts a note called
`Untitled.md` in the way and checks that it still holds its own words
afterwards.

## 53. Copying gave the words without the markdown. Closed.

The editor draws a document but the document is a text file, and a reader who
copies a bold sentence out of it means the bold to come too. ProseMirror hands
over its own plain text unless told otherwise, so every asterisk, backtick and
bracket was dropped on the way out: `Some **bold** words` arrived somewhere
else as `Some bold words`.

Typora copies markdown by default and the author has it set that way, which
settles what the default should be here.

The awkward part is the shape of a partial selection, so it is tested on its
own: a selection inside one paragraph is a fragment of inline nodes with no
block around it, and it is wrapped in a single paragraph rather than one each,
because a mark running across two text nodes is one run of markdown and
splitting it would close and reopen the delimiters in the middle.

## 54. Two things that looked like faults and were not.

The rail was opened on the author's own vault, three folders deep, and two
things looked wrong in the picture.

Long names are cut at the rail's edge with no ellipsis. That is deliberate:
the tree is as wide as its widest row, so the rail scrolls sideways and shows
the whole name rather than the first half of it. Typora clips too, and its
node titles are set to `clip` rather than `ellipsis`, so it cannot show the
rest at all. The ellipsis was added, found to do nothing, and taken out again;
the reason it is absent is now written where the next person will look.

The folders above the one being read were not pinned to the top. Also
deliberate, and the rule says so: only folders on the path to the note in
front are sticky, so the rail reads as where the file you are in lives rather
than as a stack of everything ever opened. Nothing was open in that picture.

Two more from the same pass looked absent. Structural selection and deletion,
which Typora puts on Edit, is already there from the platform: Option and
Backspace takes a word, Command and Backspace takes the line, Option and Shift
and an arrow selects a word. Building those would be reimplementing macOS.
Export looked like the largest gap and is closed below.

## 55. The type scale, measured against Typora one more time. One face short.

The same note in both windows, every heading and paragraph measured. Every
ratio matches: the headings are the same multiples of the body, the leading is
the same multiple of the size, the margins are the same multiples again. The
whole difference is the body size, 16 in Typora and 15 here.

That 15 was chosen by eye by an earlier pass, and it holds up to a
measurement. Set the same string in both and Typora's is 391.9 pixels wide at
16 and this is 382.1 at 15, within two and a half per cent. At 16 this would
be four per cent wider than Typora, because the Latin glyphs resolve to
different faces at the same nominal size. The eye was right and now there is a
number for it.

A code fence was the one construct the comparison had never covered, and the
one thing in it that was not proportional was the padding. Typora pads a fence
one em at the top, 1.11 at the right and 0.94 at the bottom, in the code's own
size; this padded 0.9, 1 and 0.85, a tenth tighter all round. On the commonest
block in this vault that reads as a different theme rather than a different
number. The gutter's vertical padding moved with it, or the line numbers drift
off their lines. Everything else about a fence already matched to the byte:
the fill, the border, the radius, the face, the leading and both margins.

What did not match was the fallback chain. Typora lists PingFang SC and
Hiragino Sans GB after the three serif faces; this stopped at the third and
then at whatever the system calls serif. On a machine with Songti SC, which
this one has, it makes no difference at all, which is why it went unnoticed.
On a machine without it, Typora would still be setting Chinese in PingFang
while this dropped to Times. The stack is now Typora's, face for face.

## 56. A checkbox that did not grow with the text. Closed.

The task list was the next construct never measured. Everything about it lines
up with Typora, the list's indent to the pixel once the base size is taken
out, and the box did not: 13 pixels where the proportion wanted 11.25.

The reason was worse than the number. The box was written in pixels, so it
stayed 13 while the words around it grew, and the reader who sets the text to
22 got a checkbox for a different document. Everything in this document that
has a size is in `em`, which the theming guide says in as many words; this one
rule was not.

It is 0.8em now, with its border, its corner and its tick in em to match.
Typora's is a native checkbox fixed at 12 pixels, which is 0.8em at its own
16, so the same 0.8em lands on exactly 12 at the default here and keeps
following the setting afterwards, which Typora's does not. Checked at 15 and
at 22.

## 57. The callout, measured. It already matched.

Typora turns out to render GitHub alerts natively, as a `div.md-alert` rather
than a quote, so there was something to measure against after all. Every value
lines up: the left border is three pixels of the same blue, the tint is the
same colour at seven per cent, the padding, the radius and both margins are
the same once the base size is taken out, and the label is the same weight in
the same colour with the same letter spacing and an icon the same size.

One difference, kept on purpose. Typora writes the label in lower case, "note",
because it prints the marker's own text. This capitalises it. The label's job
is to name the kind, GitHub capitalises it where the syntax comes from, and a
capitalised word reads as a label where a lower case one reads as a stray word.

A sweep for other sizes fixed in pixels where the document's own rule wants
`em` came back clean: everything else in pixels is a label the editor speaks
rather than part of the note, the alert's own title chip among them, and those
are meant to hold their size.

## 58. The list, checked against the vault rather than argued about.

Editing one item of a list rewrites the whole list, because a list is one
block, and the sweep reports that honestly: fifty-five lines for a fifty-five
line list. What matters is whether the rewrite is in the vault's own dialect.

Counted: the vault writes one space after a bullet 89,535 times and three
11,716 times, and one space after a number 19,832 times against two 3,857.
The serializer writes one. It is already the vault's own form for seven notes
in eight, and the churn belongs to the eighth.

The nested indent is the one place the vault has no majority: four spaces
7,908 times under a bullet and two 7,805, near enough a tie. Whatever the
serializer picks, half the lists it touches will move. It picks the minimum,
which is at least consistent.

## 59. Right clicking a row of the tree did nothing. Closed.

Every other file tree answers a right click and this one did not, though the
editor's context menu already carried a comment saying the rail had its own
answer. It did not.

The renderer names the row it was pressed on and main does the rest. The path
is resolved through any symlink and checked against the open folder before
anything is drawn, so a renderer naming a path outside it gets nothing: a
sibling of the folder, a path that climbs out with `..` and an absolute path
elsewhere are all turned away, and that is driven in a packaged test.

A file offers Open, Reveal and Copy Path. A folder offers New Note Here in
place of Open, because a click already opens a folder and because the File
menu's own New Note lands in the vault's root, which is rarely the folder the
reader is looking at. The directory it makes the note in is the one already
resolved and checked above, so the note goes where the press was and nowhere
else. Every action takes the path the menu was
built with and none of them reads it again.

What a row offers is read from the template rather than the screen, in a unit
test, for the reason the editor's own context menu is tested the same way: a
native menu holds the input loop until somebody dismisses it, and no automated
pointer here can reach one, so a test that opens one hangs the run.

## 60. Every construct measured. Three differences, all closed.

The comparison against the running Typora now covers every construct the
document is made of: the six headings, the paragraph, bold, italic, links,
inline code, both lists, the quote, the table with its header and body rules,
the rule, the fence, the callout, the task list and both kinds of maths.

All of them match, once the deliberate difference in base size is taken out,
and that difference is itself justified by measurement rather than taste.
Three did not, and all three are fixed: the prose stack's fallback chain, the
fence's padding, and a checkbox written in pixels where the document's own
rule wants `em`.

The image was the last of them and matches too: the same cap at the measure,
no border, no radius, no shadow, the same alignment, and the block rhythm
coming from the paragraph around it. One difference is deliberate. Typora sets
the image itself to `block`, which loses the few pixels of descender space
under it; this leaves it `inline-block` so an image can sit inside a sentence,
which markdown allows and Typora's rule would break.

The obvious fix does not work, and it is worth writing down why so nobody
spends the afternoon on it. `p > .noto-image-frame:only-child` looks like it
names a picture alone on its line, and it does the opposite: `:only-child`
counts element children and ignores text, so it matched the image inside a
sentence, which has no element siblings, and missed the one on its own line,
which has a widget beside it. Tried, measured, reverted. Naming "a paragraph
holding nothing but this image" needs the editor's own knowledge of the block,
not a selector.

Two more looked wrong and were not. Typora's maths block is `text-align:
start`, which reads as left aligned until you measure the rendered SVG and
find it spans the full width and centres the equation inside itself, exactly
as centring it does here. And Typora's file tree clips a long name without an
ellipsis, as this does, except that this can scroll sideways to the rest and
Typora cannot.

## 61. Launching from the dock gave an empty window. Closed.

The recent folders were already on disk and nothing read them at startup, so
somebody who opens the same vault every day got an empty window and an
invitation to open a folder. The most recent one now comes back when nothing
is named on the command line.

The folder only. Which note was in front is not restored, because reopening a
document is a change to it as far as the recovery journal is concerned, and
starting a session by touching a file nobody asked for is not worth the
convenience. It is not marked as chosen either, so the rail obeys its own
setting rather than springing open.

Most of the time this took went into a fault that was mine. The test fired a
click at whatever was in the document at that instant instead of waiting for
the button, so the rail never opened and the assertion failed for a reason
that had nothing to do with folders. Reading main's log I then talked myself
into a delivery problem that did not exist, and removed the one `await` the
restore actually needed: the window can finish loading before the read of the
recent folders that startup began has come back, and then the list is empty.
Asking main directly from the restored window, rather than inferring from a
log, is what settled it in one run.

## 62. Export. Closed, for the formats a reader reaches for.

Typora's File menu offers twelve ways out of a note. Noto had none, and a note
nobody can get out of the editor is a note held hostage by it.

Two jobs behind one menu, and the split is the whole design. PDF and HTML are
the document as Noto draws it: the editor serializes what is on screen, main
wraps it in a stylesheet written for a page rather than a window, pictures are
inlined so the file stands alone, and a PDF is that page printed in a window
nobody sees. Word, OpenDocument, RTF, EPUB, LaTeX, MediaWiki, reStructuredText,
Textile and OPML are conversions of the markdown, and Pandoc does those from
the file on disk when it is present, the same way import already works. A
Pandoc format is refused while the note has unsaved changes rather than
quietly exporting the last saved version.

The command palette carries the same list, so export is reachable the way a
hand that has learned Shift-Command-P reaches anything else. Callouts keep
their tint in the exported stylesheet, and a mermaid diagram travels as the
SVG the sandboxed frame had already drawn: `cloneNode` does not carry an
iframe's document, so without lifting the drawing out every diagram would
have arrived as an empty box.

What is still not here, and is named rather than chased: export as an image,
which Typora offers and which is a screenshot of a page rather than a
document; carrying a custom theme's stylesheet into the export rather than
the reading-column defaults; and anything that would ship Pandoc inside the
app. Pandoc stays optional, with an honest failure when it is missing.

## 63. A tab in a fence was an empty gap. Closed.

`fence-enhance`'s visible tabs put a quiet arrow on every `\t` inside a code
block, the same mark CodeMirror's own demo uses. Indent guides already ruled
the steps of a line's indentation; without the markers a tab still read as a
hole, which is wrong for a Makefile, for Go that still uses tabs, and for any
fence the author pasted from somewhere that did.

Each tab is now a span carrying that arrow at the right of its own advance,
painted by the highlighter that already rebuilds only the block that changed,
so a document of space-indented Python pays nothing and a document of tabs
pays one decoration per tab. The character stays in the file and in the
selection; only the paint is added. A switch turns them off, on by default as
the rest of the fence-enhance port is.

With this, `fence-enhance` is complete: gutter, language, copy, indent guides,
tab markers.

## 64. A sidenote was just a span of source. Closed.

The author's `sidenote` plugin turns `<span class="sidenote">…</span>` (and the
older `marginnote` class) into a numbered Tufte margin note: a superscript in
the prose, the note itself in a right gutter on a wide window, and an inline
chip when the window is too narrow to spare one. Noto showed the tags as
ordinary inline HTML source, because a tag with attributes is left alone by the
paired-tag drawing that handles `<kbd>` and friends.

A sidenote is now a decoration, the same way those tags are. The file keeps
every character; the editor hides the tags while the caret is elsewhere, paints
a superscript number and the note, and brings the tags back, muted, while the
block is being edited. Wide enough windows float the note into a reserved
gutter; narrower ones keep it as a chip. `Format > Sidenote` and `Mod+Alt+S`
wrap the selection the way the Typora plugin does. A switch turns the drawing
off, on by default as the author's Typora is set.

Not in this slice: the Typora plugin's portal layer for sidenotes inside a
scrolling table, and the floating "Add sidenote" chip beside a selection. The
command and the chord cover the same act.

## 65. A checked task forgot when it was done. Closed.

The author's `todo-manager` brief was to sort tasks and to write the check time
into the note, and to stay friendly with no plugin at all. Noto already drew
task boxes and flipped them; the date never landed in the file, and a list of
mixed open and done items stayed in whatever order it was typed.

Checking a task now appends ` ✅ YYYY-MM-DD` to the line — ordinary characters,
so a note opened elsewhere still reads. Unchecking takes the stamp off again.
`Paragraph > Task Status > Sort Tasks` floats open items above done ones, and
orders the done ones by that date. A Preferences switch turns the stamp off for
anyone who wants a bare `[x]`; it is on by default.

Not in this slice: a kanban board across notes, and vault-wide gathering of
every open task. The author's "最好可以支持看板" stays for a later pass; the
hard requirement that the file stay friendly without a plugin is what this one
does.

## 66. A note's tags were only YAML. Closed.

The author's `file-tags` brief was "文件支持 tag，多文件 tag 链接": tags on a
file, and a way from one note to the others that share a tag, without needing
a plugin to read the file. The vault already carries `tags:` in frontmatter on
nearly a hundred notes; Noto drew the YAML and left it at that.

A note's tags now draw as chips above the page. Clicking one opens the other
notes that carry it; `Go > Browse Tags…` (`Cmd+Shift+T`) lists every tag in
the open folder. The source of truth stays the frontmatter — ordinary YAML —
so a note opened elsewhere still reads. A Preferences switch turns the chips
off for anyone who wants the page plain; it is on by default.

Not in this slice: writing tags from a palette into the frontmatter, a
`.typora` on-disk index, or a graph view of the tag net. The hard requirement
that the file stay friendly without a plugin is what this one does.

## 67. A timeline fence was only source. Closed.

The author's `timeline` brief is the Typora plugin's: a fenced code block
whose language is `timeline`, drawn as a vertical chronology. The file keeps
ordinary markdown — a `#` title, `##` times, then paragraphs, lists, tasks,
quotes and rules — so a note opened elsewhere still reads.

Noto now draws that fence the way mermaid is drawn: the chronology beside the
source while the caret is elsewhere, the source back when it enters.
`Paragraph > Timeline` inserts a small template. A Preferences switch turns
the drawing off; it is on by default.

## 68. A source file could not be opened at all. Closed.

The author's `code-viewer` brief is the typora-plugin-lite plugin's: open a
non-Markdown text or code file read-only, with line numbers and syntax colour,
and never write it. Typora would otherwise parse `# comment` as a heading;
Noto used to refuse the open outright.

The tree now lists those files when Preferences **Code viewer** is on (the
default). Opening one paints a read-only pane over the editor — Prism tokens,
a CSS gutter so a copy never carries line numbers — and leaves the bytes on
disk untouched. Markdown notes still open as documents. Binary and oversized
files show a notice instead of a pane.

Not in this slice: rendering HTML/SVG as a framed page, language overrides
remembered per extension, or indexing code files into quick open. The hard
requirement that the original file is never rewritten is what this one does.

## 69. The whole note could not be edited as text. Closed.

Typora's Command-slash shows the note as the markdown it is saved as. Noto had
only the per-block toggle on that chord, which is useful and is not that: fixing
a table's pipes, pasting a slab of raw text, or reading what the file really
holds wants the whole file in one place.

`Cmd+/` now opens Source Code Mode. The rendered page stays mounted and hidden
underneath, so its history and scroll survive, and a plain column of markdown
takes its place — a textarea over a coloured copy drawn with the same Prism
markdown grammar the fences already use. The caret arrives at the block the
reader was in and returns to the block they were reading when they leave.
`Cmd+Alt+/` keeps the per-block toggle. The chrome quiets (status and outline
current mark step back) without hiding the rail, which is Typora's choice too.

What is typed settles into the document a third of a second after each pause.
Block markdown changes go through the same block-wise `replaceMarkdown` a
transform plugin uses, so the outline, the word count, the dirty mark and
autosave keep working and untouched blocks keep provenance. When only the gaps
(or other whole-buffer shape) changed, settle falls through to a pending
`mode: 'source'` save instead of silently no-opping. A save asked for before
the text has settled flushes first. A clean note opens on the accepted file
text (LF-normalised), so blank lines between blocks are what the file holds
rather than a re-join; a dirty note reconstructs from the editor, or shows the
pending full-source buffer when that escape is live. The trailing newline
tracks the buffer into the envelope so the last byte matches what is on screen.

### Tradeoffs, honestly

- **Untouched blocks stay byte-exact.** `replaceMarkdown` keeps prefix and
  suffix blocks that still match, so their provenance survives and the
  ordinary blocks save still copies their original bytes. That is the point of
  not swapping the whole document for a fresh parse on every keystroke.
- **Gap-only edits take an explicit full-source escape.** Changing only the
  blank lines between two blocks (or leading / extra trailing whitespace the
  envelope does not carry) is invisible to block-wise `replaceMarkdown`. When
  settle sees that structure differ from the accepted file, it keeps the LF
  buffer and the next save uses `mode: 'source'`, which rewrites the whole
  file and drops per-block provenance for that save — the cost of making the
  gap stick. Ordinary block edits still prefer `replaceMarkdown`, so untouched
  neighbours keep their original bytes. Final-newline-only toggles stay on the
  envelope and never take the escape. Identical buffers are a no-op.
- **The buffer is LF.** CRLF files are shown and edited as LF; the envelope
  restores the file's endings on save, the same way the rest of the editor
  does. Mixed endings stay mixed for untouched blocks and follow the envelope
  target when the reader has asked to convert.
- **A re-join is not the file.** Once the note is dirty without a pending
  full-source buffer, the buffer is `getMarkdown()` plus the final-newline
  bit, which joins blocks with `\n\n`. Odd gaps the file had are no longer in
  that reconstructed buffer, though they still ride along on a blocks save for
  every pair of still-pristine neighbours. A live full-source escape shows the
  pending buffer instead, so a gap edit is not lost on re-entry.
- **Opening a non-Markdown code view leaves the mode.** The read-only code
  pane and Source Code Mode are different surfaces; stacking them was noise.

# Where things stand

## Plugins: thirteen of sixteen, in some form

Real ports: Title Shift, Markdown Padding. Native equivalents: `wider` is the
width modes, `tree-guides` is the connector lines and the sticky folders,
`fuzzy-search` is quick open with content search, `note-assistant` is quick
open's link mode with wiki-link rendering, `fence-enhance` is the fence gutter
with its language, its copy button, its indent guides and its tab markers,
`sidenote` is the numbered margin note for `<span class="sidenote">`,
`todo-manager` is the check date and the sort, `file-tags` is the frontmatter
chips and Browse Tags, `timeline` is the chronology fence, `code-viewer` is
the read-only source pane, and `trail` is back and forward in the title bar
and the Go menu, three notes each way. `recent-files` is folded into Quick
Open's empty-query frecency list and the File menu / empty-state recent list,
with confirmed-open recording (success only, once per transition) matching the
plugin's `ConfirmedOpenRecorder` spirit rather than a separate fuzzy-recent
palette. `drawio` is partially closed: `.drawio` opens read-only as XML in the code viewer, and `.drawio.svg` shows a rendered SVG preview with a source toggle (no in-app diagrams.net editor). `remote-control` is infrastructure rather
than a feature.

## Where Noto is ahead

Saves are byte exact for every block the reader did not touch; Typora rewrites
the file through its serializer. Noto opens the 2 MB and 8 MB corpus documents;
Typora reports an empty document after three minutes on either. The rail is
resizable and remembered. Quick open ranks by frecency and searches bodies from
the same box. Plugins declare capabilities and main brokers every one, which is
a plugin model Typora does not have.

## Order of work

Images first, because the gap was functional and a third of the vault was
behind it; done, including `<img>` inside HTML. Then the prose scale, tables
and inline code together, since they are one stylesheet and one pass with the
theme open beside it; done. Then line numbers and tree icons; both done. The
remaining plugins after that, in the order the author names them;
`fence-enhance` itself is now complete, and `sidenote`, `todo-manager`,
`file-tags`, `timeline` and `code-viewer` are closed; `drawio` has the code-viewer open/preview slice above, not a live editor.

## 70. Wiki-link brackets lit up a whole list. Closed.

A note that is mostly `[[path|title]]` rows (DailyNews indexes, MOC hubs) showed
every pair of brackets and every muted path at once. The brackets are real
characters, so they used to stay dimmed rather than hidden; the top-level
`.noto-active-block` then kept them lit for every sibling in the list while the
caret was in one item. That is reading the source of the page, not of the block
being edited.

The caret's own textblock now carries `.noto-source-editing`. Wiki brackets
(and labelled `target|`) `display: none` until that textblock is focused and the
editor has the caret — the same focus gate heading markers already used. Inline
mark widgets and Typora-mark delimiters take the same blur gate so leaving the
editor hides source rather than freezing it mid-reveal. Span-scoped emphasis /
code / link widgets are unchanged.

Residual, named rather than queued: heading level still uses the margin `hN`
badge rather than revealing `#` hashes in the line (intentional, matching the
author's Typora theme); wiki brackets still appear for every wiki link inside
one paragraph when that paragraph is focused (block scope, not span scope).

The Typora-habit queue is soft-empty as of 2026-09-11 aside from the residuals
named on gap 70. What remains named rather
than queued: a live diagrams.net editor inside `drawio` (large product work, not
a habit slice), and the open-path distance to Typora after the dual-parse removal
(`docs/performance/measurements.md`) — main `parseDocument` dominates, but
PROFILE shows no clear first cut yet. RooB MOC hub graph data is closed on both
sides: Noto's rail (#14 + MOC graph-rail) and note-assistant lightweight hub
rows (recorded in `roob-vault-stress.md` / #34); rebuild local `graph.json` to
pick up.

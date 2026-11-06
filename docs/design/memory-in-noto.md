# Memory in Noto: the vault's tools without a terminal

`@roobli/vault` gives a folder of notes a memory: which notes link and are
read together, which links are missing or stale, what an agent may see, and
changes an agent proposes for a person to review. Today all of it is reached
through `noto-vault` on the command line. This is the design for reaching it
inside Noto, for someone who will never open a terminal, without making the
editor into a dashboard.

## The one idea

The note in front is the cue. Memory shows up around what is being written
(the notes related to this one, the names in it that could be links, the
changes waiting on it) rather than as a separate place to visit. The few
things that are about the whole folder (a queue of suggestions, proposals
from agents, who may read what) live where folder-wide things already live:
a page in the rail, the folder's menu, and Settings.

Everything the command line does stays possible there. The panels call the
same library, so a person and a script always see the same answers.

## Who, and what they come to do

A writer with a folder of a few thousand Markdown notes, usually under git,
sometimes with an agent (Claude Code, Codex) working beside them. They come
to:

1. Find what they already wrote about the thing in front of them.
2. Keep links whole: link a note they mention by name, and fix links that
   still point where a note used to be.
3. See what an agent wants to change, and say yes or no to it.
4. Decide which notes an agent may read, and stop an agent that should not.

What must never happen: a note changed without the person seeing what
changed and being able to take it back; a note marked private shown to an
agent; typing slowed by any of this.

## Where each command goes

| command line | in Noto |
| --- | --- |
| `init` | **Keep memory for this folder…** in the folder's menu (the ellipsis on the tree's first row) |
| `index`, `status` | runs by itself; Settings → Memory says what the index holds and offers Rebuild |
| `visit` | automatic, as now |
| `git log`, `git show`, `git diff` on one note | **History** in Note Info, the pane beside the note |
| `read --meta` | **Properties** in Note Info |
| `read`, `backlinks`, `where` | **Related** in Note Info |
| the read record, heat | the timeline at the head of Note Info, and **Activity** |
| `recall`, `search` | **Ask the vault** at the top of the Related tab, and in the command palette |
| `suggest` for one note | unlinked mentions marked in the note in front, linked with one press |
| `suggest --review` | the **Review** page in the rail: one suggestion at a time |
| `proposals`, `show`, `accept`, `reject` | the Review page's proposals, opened in the diff view Noto already has for unsaved changes |
| `suggest --dismiss` | **Not this** wherever a suggestion is shown |
| `link`, `supersede` | **Add relation…** and **Superseded by…** in the right-click menu and the palette |
| `key add`, `access.yaml` | Settings → Memory → Agents, and **Privacy** in a folder's right-click menu |
| `graph` | **Get Info** on a folder: its warmest notes, what is read most, what nothing links to; a heat map later (phase 3) |
| `eval` | stays a developer's tool |

## The pieces

### Turning it on

A folder without `.noto/` shows nothing of any of this, except one line at
the foot of the Related tab: "This folder does not keep memory. Keep memory
for this folder…". Choosing it opens a sheet that says, before anything is
written, what will be: a `.noto/` folder with the settings and an index
(listed by name), a line for each note opened, nothing sent anywhere, and
that removing `.noto/` turns it all off. The sheet is main's own, a native
one attached to the window, so a plugin that asks to keep memory cannot say
yes for the person. If the folder has a `vault.yaml` deny list or other
obvious private folders, the sheet offers them as private, ticked (later).
The index then builds in the background, with its progress in the status
line ("Reading 7,976 notes, 9 s"), and every panel works on what it has so far.

A folder can bring its own memory: a clone or a download with a `.noto/`
already in it. Its `.noto/scripts/*.mjs` are code the vault imports when it
opens, and an import can do anything a program can, so such a folder's
memory is not opened until the person has allowed its scripts. Related says
so and offers Review Scripts…, which opens main's sheet naming each script;
the answer is kept per folder in Noto's own data, never in the folder, where
a folder could grant itself trust. A folder Noto made memory for is trusted,
and one whose memory runs no scripts needs no answer. History and Properties
work either way.

### Note Info, the pane beside the note

Everything about the note in front in one place, which is the question a
person brings to the pane: where it came from, what changed in it and when,
how often it is read, what it is linked to, and who may see it. The shell
draws the frame ([the slots plan](../architecture/plugin-slots.md), Note
Info): the note's name, folder and git state at the head; a timeline under
it, one row per track on one axis, reads as bars and commits as dots, with a
ring at the right for what is not committed yet; and a row of tabs that
plugins fill. It opens from View → Note Info, the palette, and Get Info in
the tree's menu, follows the note in front once switching pauses, and
remembers whether it was open, its tab and its width. Its key is chosen with
the others in the Shortcuts board.

The tabs, in order: **Related** and **Activity** from the vault's memory, and
**History** and **Properties** from git and the note itself, which therefore
work in any folder, memory or not.

- **History** lists every commit that touched the note, through renames,
  newest first, with lines added and taken away. A script's commit (only
  text between tool markers) and a sweep across the folder are drawn
  quieter, as the vault sets them aside. A press opens the commit in the
  diff view; its bar steps to the commit before or after, compares the
  version with the note as it stands, copies it, or takes it back as an edit
  Undo reverses, saved only when the note is. Shift with a press compares
  any two. A right click on a paragraph offers History of This Passage:
  History then lists only the commits that changed those lines, followed
  where they moved (`git log -L` on the passage as the last commit has it),
  each row keeping its place in the whole history, and Show All has the
  rest back. A passage written since the last commit has no history yet,
  and History says so. The right click rather than the git mark, because a
  passage git has not marked has a history too.
- **Properties** groups each value by where it comes from: the note's own
  frontmatter, its text (words, Chinese a character each; tables; code;
  links), git, and the file. The vault adds the values a folder's policy, a
  script or `access.yaml` gives a note, under their own headings, which is
  where a person learns why an agent cannot read a note that says nothing
  about it.
- **Activity** says who read the note and how often (the person and each
  agent apart), which agents cannot and why, what most often leads to it
  (notes, searches, questions), and its heat in a sentence.

### Related, in Note Info

The first tab, replacing the Links tab's `graph.json` list.

```
 ┌──────────────── note ──────────────────┬──── Related ───────────────┐
 │ # 看完 GFW 之后的改造方案                │ Ask the vault…             │
 │                                        │                            │
 │ … M22 的拨测结果说明 …                   │ LINKS HERE              3  │
 │                                        │ 多内核横向演进对照          │
 │                                        │   links here · read 5×  ▮▮▮│
 │                                        │ NAMED HERE, NOT LINKED  2  │
 │                                        │ M22 拨测报告        Link   │
 │                                        │   "…M22 的拨测结果…"       │
 │                                        │ READ TOGETHER           4  │
 │                                        │ 积至与 MESA 泄露文件        │
 │                                        │   opened after this 6×  ▮▮ │
 │                                        │ ABOUT THE SAME          5  │
 │                                        │ …                          │
 └────────────────────────────────────────┴────────────────────────────┘
```

Four groups, each a short list with the reason on a muted second line, so the
reader knows why a note is there and can judge it: what links here, notes
this one names without linking, notes read or changed together with it, and
notes about the same things (recall with this note as the cue). A thin strip
at the right of a row is the note's heat, how much it has been read and
written lately, which is the one place colour carries meaning; it is the seed
of the heat map. A press opens the note and records that it was reached from
here. Dragging a row into the text writes a link to it the way the vault
writes links. A superseded note shows its successor beside it, and a sealed
note never appears. The groups fold, and each is capped at eight rows with
"6 more" to show the rest.

**Ask the vault** at the top takes a question in words, and answers with the
recall pack: the notes most likely to matter, each with why and an excerpt,
within a budget. **Copy as context** puts the pack on the clipboard as
Markdown, for pasting into a chat; that is the person's way to give an agent
the same memory the agent would get through MCP.

### Names that could be links, in the note

In the note in front, a mention of another note by its title or alias that is
strong enough to show gets a faint dotted underline, like a spelling mark but
quieter. The score is Review's own, for the whole folder: each note's scan is
kept against its hash, so asking about one note reads only what changed
since, and counts how many notes use each name across all of them (11 ms for
one note of the author's eight thousand, once warm). Only the likeliest are
marked: above 0.6, which three in four of a folder's mentions fall under, and
no more than eight in a note. Resting the pointer on one, or Option-Return
with the caret in it, opens a card with the note it would link to and its
folder; **Link** writes the link in place, as one edit the person can undo,
and **Not This** dismisses it for good, in Review too. View → Show
Suggestions in Notes turns the marks off. Nothing is marked in a note's code,
links, headings, or in a copied reference (`heard`) note.

The marks are a slot of their own (`marks:<id>`, see [the slots
plan](../architecture/plugin-slots.md)), and link suggestions are the Memory
plugin's use of it, so a later plugin can underline words for its own
reasons the same way.

### A folder's info

Get Info in a folder's right-click menu turns the same pane to the folder,
until a note is chosen, another folder is opened or the pane is closed;
**Back to** the note in front does it at once. The head is the folder's name
and where it sits; there is no timeline and there are no tabs, only a column
of sections with a rule between each:

```
 ┌─ Ideas ───────────────────── × ┐
 │ Projects · Folder               │
 │ ‹ Back to plan                  │
 │ 42 notes · 3 broken links       │
 │ Warmest                         │
 │ Plan                     ━━━━━━ │
 │ Argus Index              ━━━──  │
 ├─────────────────────────────────┤
 │ Recent commits                  │
 │ longer plan                     │
 │ Today 00:19 · Noto              │
 │ plan                            │
 ├─────────────────────────────────┤
 │ Read most                       │
 │ Linked to nothing             5 │
 └─────────────────────────────────┘
```

The memory gives the first and last: how many notes and broken links, the
warmest notes each with a short meter against the warmest of them, the notes
read most with how often and when last, and the notes nothing links to and
that link nowhere. It reads the index by the folder's prefix in a few
queries and never opens a note, so a folder of thousands answers at once.
Git gives the middle in any folder it tracks, memory or not: the twenty
newest commits that changed anything under the folder and only there, each
naming the notes it changed, which open on a press. A section with nothing
to say is not shown at all.

The sections are a slot (`folder:<id>`, see [the slots
plan](../architecture/plugin-slots.md)): History adds the commits, Memory the
other two, each asking for itself. The meters are where the heat map starts;
a treemap comes only if a list with meters turns out not to be enough.

### The Review page

A page in the rail, like Changes, with a count on its toggle of what waits
on the person: the proposals from agents and the links to moved notes, the
two kinds that are always worth acting on. It is the folder-wide queue: what
agents proposed, and what the tools found.

```
 ┌ Files  Outline         ⌕  Δ3  ✓12 ┐
 │ FROM AGENTS                    1  │
 │ Point links at where their…       │
 │   claude-code · 6 notes           │
 │ LINKS TO ADD                      │
 │ Links to moved notes  10 [Fix All]│
 │ Named, not linked  2,880 [Review] │
 │ Read together         12 [Review] │
 │ ▸ NOT THIS                    42  │
 └───────────────────────────────────┘
```

A proposal opens in the diff view Noto already draws for unsaved changes
(side by side, stacked or inline, the changed words marked), one file after
another with [ and ], with **Accept** and **Reject…** in its bar. Accepting
merges each file three ways, as `proposals accept` does; a file that changed
since in a way that does not merge is named, and the proposal stays for it.
Reject asks once more in the same bar, since it is final.

**Review** on a group of suggestions goes through them one at a time in the
rail page itself, strongest first, the way `suggest --review` does. It was
drawn for the main area; in the rail it leaves the note in view and needs no
new slot, and its name opens the note when the context is wanted.

```
 ┌───────────────────────────────────┐
 │ ‹ Review                          │
 │ NAMED, NOT LINKED          3 of 40│
 │ ┌───────────────────────────────┐ │
 │ │ AAA_深度对比xray与sing-box · 152│ │
 │ │ …见 多内核横向演进对照 的总结…   │ │
 │ │ → 多内核横向演进对照 in A402…   │ │
 │ │ [Link It Y] [Not This N] [Skip S]│
 │ └───────────────────────────────┘ │
 └───────────────────────────────────┘
```

Keys and buttons both, and the line shown as it will read linked: the name
drawn with the link's underline, the one place the page uses its accent.
Links to moved notes, which are always right (the note moved and git says
where), offer **Fix All**. Whatever is linked or taken in is written to the
notes at once and shows up in Changes, to be committed as usual; **Undo**
takes back the last write, file by file, wherever a file is still as Review
left it. A note with unsaved edits in the window is left alone and named,
since a write under it would lose one side. A suggestion made against an
older version of its note (the words are no longer where it says) is not
applied and is suggested afresh. **Not this** keeps a list that can be
opened, and brought back one at a time or all at once.

Review's lists come from a second worker that opens the same index without
refreshing it: every mention in a folder of eight thousand notes takes
about four seconds to find, which on the first worker would hold up Note
Info's answer about the note in front.

### Agents and privacy

Settings → Memory lists the agents the folder knows, each with what it may
read and do and when it last read anything (from the read record), and
**Any agent without a key** too: what any MCP client on the computer gets
by not bringing one, open notes by default, which **Turn Off** makes
nothing. **Add an Agent…** asks three plain questions: its name; which notes
it may read (open notes only, or private ones too; sealed notes are never
offered); and what it may do (read and search, also propose changes, also
write in one folder such as a daily log). Main then asks once more in a
sheet of its own, saying what the agent will be able to do, so no plugin
can add one; the key is shown once, with **Copy Setup for Claude Code** (a
`claude mcp add` line) and **Copy Setup for Codex** (a `config.toml`
block). **Take Key Back…** empties the agent's keys and records when; a
running server reads the policy again before its next answer, so the agent
is refused from then on.

The MCP server those setups start is the vault's command line, which Noto
ships unpacked beside itself, run by the computer's own Node (22.13 or
later, for its SQLite). Noto cannot be that Node: its fuses keep it from
running as one, which is what keeps a page in it from becoming a program.
Publishing the vault as a package would let the setup say `npx` instead.

`.noto/access.yaml` is the person's, often with comments, so these change
only the lines they are about, in the file's own indent, and each change is
read back with the server's parser before it is saved: if the file would
mean anything besides that change, it is left alone and the person is told
which part to change by hand. Which notes are private is set where the
notes are: a folder's right-click menu has **Privacy ▸ Open, Private,
Sealed**, the level it has now ticked, and writes the folder's own pattern
only when the default or a folder around it would not give that level
already.

The tree draws a small lock after the name of a folder the policy makes
private or sealed by a pattern of its own: outlined for private, solid for
sealed, in the muted tier. The lock is on the folder that was locked, not
repeated on every folder inside it; when the whole folder is private by
default, the vault's own row wears it. While a note whose own frontmatter
(`sensitivity:`) makes it stricter than its folder is in front, the status
line says Private or Sealed beside the same lock; a note that is private
only because its folder is has the folder's lock and nothing more. Both are
read from `access.yaml` and the note alone, without opening the index, so a
window that never shows Note Info still starts no worker.

Below the agents, Settings → Memory has the memory itself: what the index
holds (notes, links, size, how fresh), **Rebuild Index**, which empties it
in place (safe for an agent's server that has it open) and builds it again
from the notes and the read record while every answer says it is reading;
a switch for the read record on this computer; and **Stop Keeping
Memory…**, whose sheet lists what `.noto` holds before moving it to the
Trash, and moves nothing if the folder changed while it was open. Putting
`.noto` back turns everything on again. A server an agent still runs for
the folder stops serving it at its next call, and one started afterwards
refuses a folder without `.noto`: opening the vault there would make
`.noto` anew under no policy and give an agent without a key every open
note. A server answers for memory that exists and never begins it.

## States

| state | what is shown |
| --- | --- |
| no `.noto/` | one line in the Related tab offering to keep memory; nothing else |
| scripts not allowed | Related and Activity say the memory runs scripts, with Review Scripts…; nothing runs until then |
| indexing | progress in the status line; panels fill in as it goes |
| index unreadable | "could not be read", tried again after 30 s, then a minute, up to ten; Rebuild in Settings; the notes are untouched |
| nothing related | "Nothing else in the folder is linked to or about this note yet" |
| note is sealed | the Related tab works for the person; agents never see the note |
| proposal conflicts | the conflicted file shown with both versions; Accept again once fixed |
| read-only window | everything that reads works; Link, Accept and Fix all are disabled with the reason |
| agent revoked | its row says Revoked, with when |
| a folder's info, no `.noto/` | one line saying how its notes are read is not known, with Keep Memory for the Open Folder… |
| a folder's info, not in git | Recent commits says the folder is not in git; the memory's sections answer as usual |

## Boundaries

The vault opens on a worker thread of the main process (Node's SQLite runs
there, and its calls are synchronous, so main's own thread would freeze
while the index builds), never in the editor's page, and the panels ask for
what they show over the workspace channels. Before the worker is stopped it
is let close the index, so its last write lands whole. The index follows the folder the way the tree already does, so a
saved note is re-read in about 80 ms and a note switch asks for related notes
once, after a short pause. Nothing here runs per keystroke. A suggestion
linked from a panel is an edit of the note through the editor when the note
is open, so it has the editor's undo; otherwise it is a proposal accepted at
once, so it has the three-way merge.

Memory is a bundled plugin built on the slots, on by default for a folder
that keeps memory and switchable off like Changes, with `vault.read` for the
Related tab and `vault.review` for the Review page. That keeps the rule that
the app's own features use the seams anyone else's would.

## Rejected

- A separate memory window or dashboard. The point is that memory meets the
  writing; a place to go to is a place nobody goes.
- A chat pane in the editor. The roadmap says no, and Ask the vault with Copy
  as context gives a chat the same memory without one.
- Applying suggestions on their own, even confident ones. Of the strongest 40
  on a real vault, a third were wrong before the ranking was fixed; a person
  says yes.
- A dialog per suggestion. The queue with keys is faster and can be left at
  any point.

## Order of work

1. Note Info with its slots, History and Properties, from git alone. Done.
2. The vault on a worker thread of main behind three workspace channels;
   Related, Activity and the read track; Keep Memory for This Folder; a
   folder's scripts run only once allowed. Done, with `about` and
   `initVault` added to the vault.
3. The Review page: proposals in the diff view, the suggestion queue, Fix all
   for stale links, Undo. Done, with `proposalFile`, `dismissals`,
   `undismiss` and `prepare` added to the vault.
4. Settings → Memory, Privacy in the folder menu, Agents with keys and setup,
   the locks in the tree and the status line, the read record's switch,
   Rebuild and Stop Keeping Memory. Done; the vault gained the policy
   editors, `readers`, `privacyMarks` and `noteSensitivity`, and its command
   line ships with Noto.
5. Link suggestions in the note in front, on a note marks slot any plugin
   can use. Done; the vault's mention scan is kept per note.
6. Ask the vault and Copy as context; the folder's info; one passage's
   history. Done, on a `folder:<id>` slot for a folder's sections; the
   vault gained `folderAbout` and `formatRecall`, and one passage's history
   is offered by a right click rather than the git mark.

Progress is kept in the author's notes; the changelog says what shipped.

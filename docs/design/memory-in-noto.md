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
| `graph` | later: a heat map of the folder (phase 3) |
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
  any two. The history of one passage, from a git mark, comes later.
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
strong enough to show (the same score `suggest` uses, above a threshold, and
never more than a handful per screen) gets a faint dotted underline, like a
spelling mark but quieter. Pointing at it shows the note it would link to,
with its folder; **Link** writes the link in place, as an ordinary edit the
person can undo, and **Not this** dismisses it for good. View → Show Link
Suggestions turns the marks off. Nothing is marked in a note's code, links,
headings, or in a copied reference (`heard`) note.

### The Review page

A page in the rail, like Changes, with a count on its toggle of what is
waiting. It is the folder-wide queue: what agents proposed, and what the tools
found.

```
 ┌ Files  Outline         ⌕  Δ3  ✓12 ┐
 │ REVIEW                            │
 │ ▾ From agents                  1  │
 │   claude-code · 2 h ago           │
 │   Point links at where their…  10 │
 │ ▾ Links to add                    │
 │   Stale links          10  Fix all│
 │   Names not linked  2,880  Review │
 │   Read together        12  Review │
 │ ▸ Not this (42)                   │
 └───────────────────────────────────┘
```

A proposal opens in the main area in the diff view Noto already draws for
unsaved changes (side by side, stacked or inline, the changed words marked),
one file after another, with **Accept** and **Reject** in its bar. Accepting
merges each file three ways, as `proposals accept` does; a file that changed
since is shown as a conflict with both versions, and the proposal stays.

**Review** on a group of suggestions opens them one at a time in the main
area, strongest first, the way `suggest --review` does:

```
 ┌ Link suggestion 3 of 40 ─────────────────────────────────────┐
 │ AAA_深度对比xray与sing-box · line 152                          │
 │ "…在 QUIC 系上 … 见 «多内核横向演进对照» 的总结…"                │
 │ → [[多内核横向演进对照]]   in A402_007_core-history             │
 │                                                               │
 │  Link it  Y     Not this  N     Skip  S          Done  Esc     │
 └───────────────────────────────────────────────────────────────┘
```

Keys and buttons both, and the line shown as it would read after the link.
Stale links, which are always right (the note moved and git says where),
offer **Fix all**. Whatever is linked from the queue is written to the notes
at once and shows up in Changes, to be committed as usual; **Undo** in the
queue's bar takes back the last batch. **Not this** keeps a list that can be
opened and emptied.

### Agents and privacy

Settings → Memory → Agents lists the agents the folder knows, each with what
it may see and do and when it last read anything (from the read record).
**Add an agent** asks three plain questions: its name; which notes it may read
(open notes only, or private ones too; sealed notes are never offered); and
what it may do (read and search, also propose changes, also write in one
folder such as a daily log). It then shows the key once, with **Copy setup
for Claude Code** and **Copy setup for Codex** that fill in the MCP lines.
**Revoke** takes the key out; a running agent loses access within a second,
since the server rereads the policy when it changes.

Which notes are private is set where the notes are: a folder's right-click
menu has **Privacy ▸ Open, Private, Sealed**, written to `.noto/access.yaml`,
and a private or sealed folder carries a small lock in the tree. A note can be
made stricter than its folder with `sensitivity:` in its own frontmatter, and
the status line shows a lock while such a note is in front. Settings → Memory
also has the switch for the read record, the index's state and size with
Rebuild, and Turn Off, which says what it will remove.

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
   for stale links.
4. Settings → Memory, Privacy in the folder menu, Agents with keys and setup.
5. Link suggestions in the note in front.
6. Ask the vault and Copy as context; the folder's info; one passage's
   history from its git mark.

Progress is kept in the author's notes; the changelog says what shipped.

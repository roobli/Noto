# Slots: where a plugin puts its interface

A plugin today can read the open document, decorate it and replace its text,
and add editor extensions (ProseMirror plugins, commands, context-menu items).
It cannot add a page to the sidebar, a pane beside the note, or anything that
knows about the folder rather than the one document. Those are not missing
permissions: the app's own sidebar pages, panes and services are written
straight into the shell, so there is no seam for a plugin to use.

The fix is one rule: the app is the first plugin. Every area of the interface
is a slot, every service the app's own features use is a named capability, and
the app's own features register through the same slots as anyone else's. A
seam the app uses every day does not rot, and a feature someone wants is a
matter of which slot and which services, not of a new hook.

## Slots

| slot | what a plugin gives it | first user |
| --- | --- | --- |
| rail page | a title, an icon, and a mount function for a page in the sidebar | Changes |
| info tab | a title, an order, and a mount function for a tab of Note Info, the pane beside the note | History, Properties |
| info track | a title and a loader for a row on Note Info's timeline: marks in time or amounts per day | commits |
| status item | a short text and an action | (next) |
| fenced block | a renderer for code blocks with a given info string | (next) diagrams |
| command, menu item, context item | as today | sidenotes |

A slot hands the plugin a DOM element and a host object; it never hands over
React or the shell's state. A bundled plugin may render into the element with
React like any other library. Each mount returns a function that unmounts it.

## Services

A service is a capability the manifest declares and the person grants. The
host object a slot passes in carries only the services the plugin holds.

| capability | gives |
| --- | --- |
| `editor.read`, `editor.decorate`, `editor.transform` | as before |
| `git.read` | what changed in the open folder since the last commit; a note's commits, following renames, and its text at any of them (trusted plugins) |
| `vault.read` | what the open folder's memory (`@roobli/vault`) knows about a note: what links to it, what it names, what is read with it, who reads it and who may; and asking to keep memory or to allow a folder's scripts, which main puts to the person in a sheet of its own (trusted plugins) |
| `vault.review` | the open folder's Review queue (proposals, suggestions, what was said no to) and the writes that settle it: accept, link, take back; main leaves alone any note with unsaved edits (trusted plugins) |

Navigation (open a note by path), the file tree's own menu for a note or
folder, and where the window is (the folder, the note in front, and when
either changes) come with every slot: they show nothing the person cannot
already see, and every item of the menu runs in main against a path main
checks, as it does for the tree. A rename or a new folder chosen from it is
typed on the row in the file tree, so the rail turns to the files for the
name and back to the page after.

## How a plugin uses it

A trusted bundled plugin gains a second entry point beside `activate`:

```ts
shell?(context: ShellContext): () => void
```

It is called while the plugin is switched on, whether or not a note is open,
and undone when it is switched off; `activate` still runs only inside an
editor's lease. The context registers rail pages and carries the host and the
services the manifest declares. A rail page must be named in the manifest's
`uiExtensions` as `rail:<id>`, so the Plugin Center can say what a plugin adds.

A rail page is a toggle in the rail's head, drawn as search is, with an
optional count; the words in the tabs stay the shell's own three views,
because a 190 px rail has room for icons and not for more words. The page is
mounted into an element the rail owns. `src/renderer/plugins/ui-kit.ts` holds
the pieces of the shell's tree a page may draw with (row glyphs, git marks,
connector sizing), and the class names they use are part of this contract.

The code is in `src/renderer/plugins/slots.ts`; Changes
(`src/renderer/plugins/bundled/changes/`) is the worked example.

### Note Info

The pane beside the note is not a free area but a frame about the note in
front, and the shell owns the frame: where it is, its width, whether it is
open and which tab is in front (all remembered), the note's name, folder and
git state at its head, and a timeline across its top. Plugins fill it in two
ways.

A tab (`registerInfoTab`, named `info:<id>`) is a page of the pane. It is
mounted the first time it is shown and kept while the pane is open, so it
keeps its scroll, and it may answer `reveal(key)` to show one thing in it.
Its host adds to the slot's: `note()` and `onNote`, the note the pane is
about once switching has paused for 250 ms, so walking through tabs runs no
queries; `noteText()` with `editor.read`; `replaceNoteText(text)` with
`editor.transform`, one edit that Undo reverses, refused for a read-only
note, under Source Code Mode, or for any note but the one in front;
`showTab(id, key)`; and `copy(text)`. `showDiff(request)`, the diff view
over the page with the plugin's buttons and keys in its bar, is on every
slot's host, a rail page's too: Review opens proposals in it.

A track (`registerInfoTrack`, named `track:<id>`) is a row on the timeline:
marks at moments, drawn as dots, or amounts per day, drawn as bars, all on
the one axis, so what was written when and what was read when line up. A
track names the tab a press on its marks brings forward, and the mark's key
is handed to that tab's `reveal`. A track may say when to load it again.

History (`src/renderer/plugins/bundled/history/`) is the worked example: a
History tab, a Properties tab and a track of commits, from the slot alone.
The vault's memory adds Related and Activity, and a track of reads, the same
way.

## Order of work

1. Done: the rail page slot, the `git.read` service, and Changes, a bundled
   plugin that lists only the changed notes as a tree, built from the slot
   alone.
2. Done: Note Info, the pane beside the note, with tabs and timeline tracks
   as its slots, and History and Properties as its first users. Next on it:
   Related and Activity from the vault index (`@roobli/vault`), replacing the
   panel that reads `.note-assistant/graph.json`.
3. Status items and fenced blocks, each moved out of the shell as its first
   user.
4. The same slots for sandboxed plugins, through the message protocol the
   sandbox already speaks: a sandboxed page renders into an iframe the slot
   owns.

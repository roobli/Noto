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
| side pane | a mount function for a pane beside the note | (next) related notes |
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
| `git.read` | what changed in the open folder since the last commit (trusted plugins) |
| `vault.read` | (next) the folder's notes and the vault index |

Navigation (open a note by path) and where the window is (the folder, the
note in front, and when either changes) come with every slot: they show
nothing the person cannot already see.

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

## Order of work

1. Done: the rail page slot, the `git.read` service, and Changes, a bundled
   plugin that lists only the changed notes as a tree, built from the slot
   alone.
2. The side pane slot, with related notes from the vault index (`@roobli/vault`)
   as its first user, replacing the panel that reads `.note-assistant/graph.json`.
3. Status items and fenced blocks, each moved out of the shell as its first
   user.
4. The same slots for sandboxed plugins, through the message protocol the
   sandbox already speaks: a sandboxed page renders into an iframe the slot
   owns.

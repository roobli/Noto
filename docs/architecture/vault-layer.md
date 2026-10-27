# The vault layer

Noto opens a folder of notes, and in a vault that is used every day the notes do not stay where they are. In the author's vault of about 7,600 notes, 81% have moved at least once and 49% twice or more; one month saw more than a thousand renames. They are moved in Finder, in another editor, by a script, by git. Everything Noto shows about the folder rather than about one note (the tree, quick open, where a wiki link goes, tags, backlinks) has to keep up with that, without being felt while typing.

This document says how, in three tempos, and what is built so far.

## Three tempos

The first tempo is the keystroke, and it touches only the open document. Nothing that walks the folder runs between a key and the next frame. Typing never waits on the vault.

The second is the file event, handled by one recursive watch on the folder root (`src/main/workspace/vault-watcher.ts`). On macOS this is a single FSEvents stream and on Windows a single ReadDirectoryChangesW handle, so it costs the same however large the folder is. An event only marks a name as touched. Once the folder has been quiet for 250 ms, or 2 s have passed under a steady stream, the touched names are read together, one `lstat` each, and compared with what the tree and the file index have already been told:

- a path nobody was told about, already gone again, was a temporary file;
- a path that was known and is still a file only had its text saved;
- anything new, gone, or turned into a folder is structural.

Only a structural change re-lists the tree's open folders and re-walks the file index. A saved note drops the tag scan, which is lazy, and nothing else. The kind of an event decides nothing, because an atomic save (write a temporary file, rename it over the note) arrives as three `rename` events for a note that only changed its text.

The third is the commit. A vault that lives in git can be reconciled after the fact from git's rename detection, by tooling that does not need Noto running: the author's vault does this with a `tidy` command and an advisory pre-commit hook. This is the safety net for everything the file tempo does not repair, and it stays outside Noto: Noto never writes to `.git`.

## The numbers behind it

Measured on the author's vault (7,627 openable files in 1,122 folders) on the author's MacBook Air:

| What | Cost |
| --- | --- |
| Breadth-first walk of the whole folder, warm cache, like the file index | 12 to 17 ms |
| Moving a folder of 500 notes in Finder | 5 file events |
| One atomic save | 3 `rename` events |
| Parsing every note for links, in one Node process | about 2.3 s |
| Rebuilding the related-notes graph | about 17 s |

So the events are never the problem and the walk is cheap. What has to stay off every interactive path is per-note parsing of the whole vault: anything that needs links or text from every note must be built once and then kept up incrementally, from the touched names, in the background.

## What follows the disk today

The tree, quick open, wiki-link targets and outbound-link seeding all read the file index, and the index is re-walked after any structural change, whoever made it. Tags are rescanned lazily after a note is saved. Git marks already followed git's own bookkeeping.

## What does not, yet

- Links. Renaming or moving a note inside Noto does not rewrite the links that point at it. Links written as a bare `[[name]]` keep resolving after a move because resolution falls back to a unique file name; path links and relative Markdown links break until something rewrites them.
- Backlinks and related notes come from the note-assistant `graph.json`, read as it was last built.
- Search over text reads files on demand and keeps nothing.

## Next

1. One resolver. Link resolution is written four times today (Noto's `wiki-target.ts`, the vault CLI, the note-assistant library, the Typora plugin), with the same rules kept in step by hand. It becomes one package with the rule set, the parser for links, and their tests, used by all four.
2. A persistent index. Notes, links (as a target to source table, so "who points here" is one lookup), headings, tags and frontmatter, in SQLite through `node:sqlite` with an FTS5 trigram table for text. Trigram cannot match a one- or two-character Chinese query, so short queries fall back to a bigram table or `LIKE`. Built in a utility process, kept up from the watcher's settled batches, rebuildable from the files at any time. Targets: a cold build of a 10,000-note vault under 10 s, a settled batch under 100 ms.
3. Moves that keep links. A rename or move made in Noto rewrites every inbound link in one transaction that undo reverses. A move made elsewhere is paired from the watcher's batch (a gone path and a new one with the same content) and offered as one action rather than applied silently, since a branch checkout looks like a thousand moves.
4. Identity. A folder's index note (`00_索引.md`, `index.md` or `README.md`) can carry a card in its frontmatter: `id`, `aliases` (old names), `status`, `started`, `ended`, `repo`, `tags`. The card is how a project stays the same project across renames and moves, how an old name still opens it, and how projects can be listed by status wherever they live. Plain notes get an `id` only when something first needs to refer to them by one.
5. Agents. The same index behind a command line and an MCP server, so that agents read and move notes through the rules above instead of around them.

The files stay the only source of truth throughout. Every index is a cache that can be deleted and rebuilt, and nothing in a note depends on Noto to be read.

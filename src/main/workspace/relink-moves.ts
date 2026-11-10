/**
 * Links that follow a move, and links a trash would leave leading nowhere.
 *
 * When a note or folder is renamed or moved inside the open folder, the
 * notes that linked to it, and its own relative links to the neighbours it
 * left, are written again so each link reaches the same note
 * (`@roobli/vault`'s `relink`, which keeps each link's own style). Only the
 * notes that can hold such a link are read: in a folder that keeps memory its
 * index names them in a query; elsewhere each note is read once and kept only
 * if it names what moved, which is half a second for eight thousand notes, once
 * per move. A note with unsaved edits in the window is never written under,
 * and is counted instead; a note that changed between being read and being
 * written is left as it is. What was written can be taken back while nothing
 * has changed it since.
 */

import { randomBytes } from 'node:crypto';
import { chmod, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildResolveIndex, extractLinks, linkReaches, relink, relinkTokens, type Move } from '@roobli/vault';

const NOTE = /\.(md|markdown)$/i;
/** Notes read at once while looking through a folder. */
const READERS = 16;

export interface RelinkNote {
  /** Vault-relative, forward slashes: where the note is now. */
  readonly path: string;
  readonly before: string;
  readonly after: string;
  readonly links: number;
}

export interface RelinkPlan {
  readonly notes: readonly RelinkNote[];
  /** Notes with links to write that have unsaved edits in the window, left alone. */
  readonly busy: readonly string[];
}

export interface RelinkSources {
  /**
   * The notes whose links name any of these words, vault-relative, from the
   * folder's index; null when there is no index to ask, and the folder is read.
   */
  (words: readonly string[]): Promise<readonly string[] | null>;
}

/** Every file under `root`, vault-relative with forward slashes; hidden folders and `node_modules` are not the vault's. */
export async function vaultFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') return;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else if (entry.isFile()) files.push(rel);
    }));
  };
  await walk(root, '');
  return files;
}

/** The words, and the same as a link escapes them, so `my%20note` is found for `my note`. */
function searchWords(words: readonly string[]): string[] {
  return [...new Set(words.flatMap((word) => [word, encodeURI(word)]))];
}

/** One pattern for all the words, in any case: a bare-name wiki link finds its note whatever case it is written in. */
function anyWord(words: readonly string[]): RegExp {
  return new RegExp(words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
}

async function eachAtOnce<T>(items: readonly T[], width: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  }));
}

/**
 * A note's text, or null when it cannot be had exactly: a file in another
 * encoding decodes with replacement characters, and writing that back would
 * lose every byte that was not UTF-8. Such a note is never written.
 */
async function readText(file: string): Promise<string | null> {
  const bytes = await readFile(file).catch(() => null);
  if (bytes === null) return null;
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null;
}

/**
 * The notes to look in for `words`, with their text: those the index names, or
 * every note that mentions one of the words, read once. `always` are looked in
 * whatever they say.
 */
async function notesNaming(root: string, files: readonly string[], words: readonly string[], always: ReadonlySet<string>, sources?: RelinkSources): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  const known = new Set(files);
  const named = sources ? await sources(searchWords(words)).catch(() => null) : null;
  if (named !== null) {
    const wanted = [...new Set([...named, ...always])].filter((file) => known.has(file) && NOTE.test(file));
    await eachAtOnce(wanted, READERS, async (file) => {
      const text = await readText(path.join(root, file));
      if (text !== null) texts.set(file, text);
    });
    return texts;
  }
  const mentions = anyWord(searchWords(words));
  await eachAtOnce(files.filter((file) => NOTE.test(file)), READERS, async (file) => {
    const text = await readText(path.join(root, file));
    if (text !== null && (always.has(file) || mentions.test(text))) texts.set(file, text);
  });
  return texts;
}

/**
 * What a move asks to be written: `moves` are real paths under `root`, a
 * folder once rather than each file in it, already moved on disk. `busy` are
 * real paths of notes with unsaved edits.
 */
export async function planRelink(root: string, moves: readonly { from: string; to: string }[], busy: ReadonlySet<string>, sources?: RelinkSources): Promise<RelinkPlan> {
  const rel = (file: string) => path.relative(root, file).split(path.sep).join('/');
  const asked: Move[] = moves.map((move) => ({ from: rel(move.from), to: rel(move.to) }))
    .filter((move) => move.from && move.to && !move.from.startsWith('..') && !move.to.startsWith('..'));
  if (asked.length === 0) return { notes: [], busy: [] };
  const files = await vaultFiles(root);
  const present = new Set(files);
  // A folder's files each moved, found under where it is now; a file moved on its own after it is its own move.
  const named = new Set(asked.map((move) => move.to));
  const expanded: Move[] = [];
  for (const move of asked) {
    if (present.has(move.to)) { expanded.push(move); continue; }
    const prefix = `${move.to}/`;
    for (const file of files) {
      if (file.startsWith(prefix) && !named.has(file)) expanded.push({ from: `${move.from}/${file.slice(prefix.length)}`, to: file });
    }
  }
  if (expanded.length === 0) return { notes: [], busy: [] };
  const movedNotes = new Set(expanded.filter((move) => NOTE.test(move.to)).map((move) => move.to));
  // The index may not have seen the move yet: a note it names by its old place is the same note.
  const movedTo = new Map(expanded.map((move) => [move.from, move.to]));
  const lookup: RelinkSources | undefined = sources
    ? async (words) => {
      const named = await sources(words);
      return named === null ? null : named.map((file) => movedTo.get(file) ?? file);
    }
    : undefined;
  const texts = await notesNaming(root, files, relinkTokens(asked), movedNotes, lookup);
  const rootName = path.basename(root);
  const changed = relink({ files, moves: expanded, notes: texts, rootName });
  const notes: RelinkNote[] = [];
  const held: string[] = [];
  for (const note of changed) {
    if (busy.has(path.join(root, ...note.path.split('/')))) { held.push(note.path); continue; }
    notes.push({ path: note.path, before: texts.get(note.path)!, after: note.text, links: note.links });
  }
  return { notes, busy: held };
}

/** Write a note's new text in its place, keeping its permissions, and only over the text it was read with. */
async function replaceIf(root: string, rel: string, expected: string, text: string): Promise<boolean> {
  const file = path.join(root, ...rel.split('/'));
  const current = await readText(file);
  if (current !== expected) return false;
  const info = await stat(file);
  // Beside it, so the rename is one step on one volume, and hidden from the tree; a name of its own every time.
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString('hex')}.relink`);
  let placed = false;
  try {
    await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
    // Set after writing, since the mode a file is made with goes through the umask.
    await chmod(temporary, info.mode & 0o7777);
    await rename(temporary, file);
    placed = true;
  } finally {
    if (!placed) await unlink(temporary).catch(() => {});
  }
  return true;
}

export interface RelinkOutcome {
  /** Written, for Undo. */
  readonly written: readonly RelinkNote[];
  /** Changed since they were read, and left. */
  readonly changed: readonly string[];
}

export async function applyRelink(root: string, plan: RelinkPlan): Promise<RelinkOutcome> {
  const written: RelinkNote[] = [];
  const changed: string[] = [];
  for (const note of plan.notes) {
    try {
      if (await replaceIf(root, note.path, note.before, note.after)) written.push(note);
      else changed.push(note.path);
    } catch {
      changed.push(note.path);
    }
  }
  return { written, changed };
}

/** Take back what `applyRelink` wrote, note by note, wherever nothing has changed it since. */
export async function undoRelink(root: string, written: readonly RelinkNote[]): Promise<{ restored: number; kept: number }> {
  let restored = 0;
  let kept = 0;
  for (const note of written) {
    try {
      if (await replaceIf(root, note.path, note.after, note.before)) restored += 1;
      else kept += 1;
    } catch {
      kept += 1;
    }
  }
  return { restored, kept };
}

/**
 * How many notes, and links in them, reach `targets` (real paths under
 * `root`, notes or folders): what moving them to the trash would leave
 * leading nowhere. By the same rule as following a move: a bare-name wiki link
 * by its name, anything else by its path.
 */
export async function linksInto(root: string, targets: string | readonly string[], sources?: RelinkSources): Promise<{ notes: number; links: number }> {
  const rels = (typeof targets === 'string' ? [targets] : targets).map((target) => path.relative(root, target).split(path.sep).join('/'))
    .filter((rel) => rel && !rel.startsWith('..'));
  if (rels.length === 0) return { notes: 0, links: 0 };
  const files = await vaultFiles(root);
  // Anything in any of them goes with them, and is not left with a broken link.
  const inside = (file: string) => rels.some((rel) => file === rel || file.startsWith(`${rel}/`));
  if (!files.some(inside)) return { notes: 0, links: 0 };
  const texts = await notesNaming(root, files, relinkTokens(rels.map((rel) => ({ from: rel, to: rel }))), new Set(), sources);
  const index = buildResolveIndex(files, undefined, path.basename(root));
  let notes = 0;
  let links = 0;
  for (const [file, text] of texts) {
    // A note going with it is not left with a broken link.
    if (inside(file)) continue;
    const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
    let here = 0;
    for (const link of extractLinks(text)) {
      const target = link.kind === 'wiki' ? link.target : link.target.replace(/:\d+$/, '');
      const reached = linkReaches(index, dir, target, link.kind);
      if (reached !== null && inside(reached)) here += 1;
    }
    if (here > 0) { notes += 1; links += here; }
  }
  return { notes, links };
}

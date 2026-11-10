/**
 * What Quick Open offers beyond what it found: open a note by its path, or
 * make the note or folder that was typed.
 *
 * Pure, so the rules are tested without a window. The palette draws these
 * after its matches, and when nothing matched they are all there is, so
 * Enter takes the first: the row it takes is always on screen and says what
 * it will do.
 */

import { EDITABLE_EXTENSIONS, isEntryName } from '../shared/workspace/v1/entry-names';

export type QuickAction =
  | { readonly kind: 'open-path'; readonly path: string }
  | { readonly kind: 'new-note'; readonly name: string; readonly file: string }
  | { readonly kind: 'new-folder'; readonly name: string };

/** From the root of the disk, a drive, or the home folder. */
const ABSOLUTE = /^(?:~(?:[\\/]|$)|\/|[A-Za-z]:[\\/])/;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/** Whether Noto opens a file of this name as a note. */
export function opensAsNote(name: string): boolean {
  return EDITABLE_EXTENSIONS.has(extensionOf(name));
}

/**
 * A path typed or pasted whole, or null for anything else.
 *
 * A path copied out of a shell or a file manager may come in quotes, which
 * are not part of it.
 */
export function typedPath(terms: string): string | null {
  let text = terms.trim();
  if (text.length > 1 && /^(['"]).*\1$/.test(text)) text = text.slice(1, -1).trim();
  return ABSOLUTE.test(text) ? text : null;
}

/** The file a new note named `name` is written to: the name, with `.md` unless it already ends in a note's extension. */
export function noteFileName(name: string): string {
  return opensAsNote(name) ? name : `${name}.md`;
}

export interface QuickActionInput {
  /** What was typed, after Quick Open's own `type:` and `scope:` are taken out. */
  readonly terms: string;
  readonly mode: 'files' | 'folders';
  /** The folder searched, relative to the open one; empty for all of it. */
  readonly scope: string;
  /** Every note in the open folder, by path relative to it. */
  readonly notes: readonly { readonly relativePath: string }[];
  readonly folders: readonly { readonly relativePath: string }[];
  /** False with no folder open, and while the palette is writing a link. */
  readonly canMake: boolean;
}

export function quickActions(input: QuickActionInput): QuickAction[] {
  const name = input.terms.trim();
  if (name.length === 0) return [];
  const pathTyped = typedPath(name);
  if (pathTyped !== null) {
    // Only a note: anything else would be opened only to be refused.
    return input.mode === 'files' && opensAsNote(pathTyped) ? [{ kind: 'open-path', path: pathTyped }] : [];
  }
  // One name, never a path: a folder deeper down is reached by narrowing to it first.
  if (!input.canMake || !isEntryName(name) || name.startsWith('.')) return [];
  const within = (relative: string) => (input.scope.length > 0 ? `${input.scope}/${relative}` : relative).toLowerCase();
  const folderTaken = input.folders.some((folder) => folder.relativePath.toLowerCase() === within(name));
  const newFolder: QuickAction[] = folderTaken ? [] : [{ kind: 'new-folder', name }];
  if (input.mode === 'folders') return newFolder;
  const file = noteFileName(name);
  // A note already there is among the matches; making it again would only be refused.
  const noteTaken = input.notes.some((note) => note.relativePath.toLowerCase() === within(file));
  return [...(noteTaken ? [] : [{ kind: 'new-note', name, file } as const]), ...newFolder];
}

/**
 * Listing a folder for the sidebar.
 *
 * The renderer names a directory and main reads it, which makes this a place
 * where a compromised renderer could try to walk the whole disk. Every listing
 * is therefore confined to the folder the user actually chose: the target is
 * resolved through symlinks and must still be inside the root, and entries that
 * point outside are dropped rather than followed.
 *
 * Listing is one level deep. A recursive walk of a large folder would block the
 * main process and produce a tree nobody reads, so children arrive when a
 * directory is expanded.
 */

import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isViewableCodeFile } from '../../shared/code-viewer/languages';
import { EDITABLE_EXTENSIONS } from '../../shared/workspace/v1/entry-names';

export interface FileTreeEntryV1 {
  readonly name: string;
  readonly path: string;
  readonly kind: 'file' | 'directory';
  /** When the file was last written, in milliseconds, for sorting by it. */
  readonly modifiedMs: number;
}

/** How a folder's rows are ordered. Typora offers the same three. */
export const TREE_SORTS = ['name', 'name-desc', 'modified', 'modified-old'] as const;

export type TreeSortV1 = (typeof TREE_SORTS)[number];

/**
 * Folders first, then files, in the order asked for.
 *
 * Folders stay at the top whatever the order, which is what every file
 * browser does and what keeps a deep tree navigable: a folder that sank
 * below the notes because it had not been written to lately would be a
 * folder nobody finds.
 */
export function sortEntries(entries: FileTreeEntryV1[], order: TreeSortV1 = 'name'): FileTreeEntryV1[] {
  const byName = (left: FileTreeEntryV1, right: FileTreeEntryV1) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
  return entries.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
    if (order === 'name') return byName(left, right);
    if (order === 'name-desc') return byName(right, left);
    const newest = right.modifiedMs - left.modifiedMs;
    const difference = order === 'modified' ? newest : -newest;
    // Two files written in the same millisecond are ordered by name, so the
    // list does not shuffle between one listing and the next.
    return difference !== 0 ? difference : byName(left, right);
  });
}

/** Extensions the editor can actually open, kept in `entry-names`. Anything else is noise in a tree. */
export { EDITABLE_EXTENSIONS };

/** Whether this editor will open the file at `filePath`. */
export function isEditableFile(filePath: string): boolean {
  return EDITABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

const MARKDOWN = EDITABLE_EXTENSIONS;

/**
 * Directories never worth showing.
 *
 * Not a security measure, since the root check already provides that. These are
 * excluded because a repository's `node_modules` would bury the user's own
 * files under thousands of entries.
 */
const SKIPPED_DIRECTORIES = new Set([
  'node_modules', '.git', '.svn', '.hg', '.DS_Store', '__pycache__', '.venv',
]);

const MAX_ENTRIES = 2_000;

/**
 * True when `target` is the root or sits inside it.
 *
 * `pathApi` lets callers (and tests) judge Windows-style or POSIX-style paths
 * without depending on the host OS. Defaults to this process's `path`.
 */
export function isInside(
  root: string,
  target: string,
  pathApi: Pick<path.PlatformPath, 'relative' | 'isAbsolute'> = path,
): boolean {
  if (target === root) return true;
  const relative = pathApi.relative(root, target);
  return relative.length > 0 && !relative.startsWith('..') && !pathApi.isAbsolute(relative);
}

/**
 * The real location of a path, or null when it cannot be resolved.
 *
 * Resolving before the containment check is what stops a symlink inside the
 * folder from being used as a door out of it.
 */
async function resolved(target: string): Promise<string | null> {
  try {
    return await realpath(target);
  } catch {
    return null;
  }
}

/**
 * Entries directly inside `target`, which must be within `root`.
 *
 * Throws when the target escapes the root, because that is a request the
 * renderer should never make and silently returning nothing would hide a bug.
 */
export async function listDirectory(
  root: string,
  target: string,
  order: TreeSortV1 = 'name',
  /**
   * When true, list the non-Markdown text/code files the code viewer can open.
   * Off keeps the tree Markdown-only, which is how it was before the viewer.
   */
  includeCode = false,
): Promise<FileTreeEntryV1[]> {
  const realRoot = await resolved(root);
  const realTarget = await resolved(target);
  if (!realRoot || !realTarget) throw new Error('WORKSPACE_PATH_UNREADABLE');
  if (!isInside(realRoot, realTarget)) throw new Error('WORKSPACE_PATH_OUTSIDE_ROOT');

  // In name order before the cap, so a folder past it always shows the same
  // rows rather than whichever the file system happened to return first.
  const entries = (await readdir(realTarget, { withFileTypes: true }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const results: FileTreeEntryV1[] = [];

  for (const entry of entries) {
    if (results.length >= MAX_ENTRIES) break;
    if (entry.name.startsWith('.')) continue;

    const entryPath = path.join(realTarget, entry.name);
    let kind: 'file' | 'directory';

    if (entry.isSymbolicLink()) {
      // Follow the link only far enough to decide what it is, and only when it
      // still lands inside the root.
      const linked = await resolved(entryPath);
      if (!linked || !isInside(realRoot, linked)) continue;
      try {
        kind = (await stat(linked)).isDirectory() ? 'directory' : 'file';
      } catch {
        continue;
      }
    } else if (entry.isDirectory()) {
      kind = 'directory';
    } else if (entry.isFile()) {
      kind = 'file';
    } else {
      continue;
    }

    if (kind === 'directory') {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      const markdown = MARKDOWN.has(ext);
      // `.txt` is editable Markdown here; do not also offer it as code.
      if (!markdown && !(includeCode && isViewableCodeFile(entry.name))) continue;
    }

    let modifiedMs = 0;
    try {
      modifiedMs = (await stat(entryPath)).mtimeMs;
    } catch {
      // A row whose time cannot be read still belongs in the tree; it sorts
      // as the oldest thing there rather than disappearing.
      modifiedMs = 0;
    }
    results.push({ name: entry.name, path: entryPath, kind, modifiedMs });
  }

  return sortEntries(results, order);
}

/**
 * A flat index of every openable file under the workspace root.
 *
 * The tree lists one directory at a time on purpose, because a recursive walk
 * on expand would stall the window. Search is the opposite case: it cannot rank
 * what it has not seen, so it needs the whole vault at once. Building it once
 * per folder and handing the renderer the finished list keeps the walk off the
 * typing path entirely; the alternative, an IPC round trip per keystroke,
 * is the one thing guaranteed to make a search box feel slow.
 *
 * Confinement is the tree's: resolve through symlinks, then require the result
 * to still be inside the root, so a link inside the folder cannot be used as a
 * door out of it.
 */

import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceIndexEntryV1 } from '../../shared/workspace/v1/contracts';
import { EDITABLE_EXTENSIONS, isInside } from './file-tree';

/** Extensions the editor can open, shared with the tree so the two agree. */
const OPENABLE = EDITABLE_EXTENSIONS;

const SKIPPED_DIRECTORIES = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', '.next', 'dist', 'build',
]);

/**
 * Ceilings, so a folder chosen by accident cannot hang the process.
 *
 * Pointing the app at a home directory or a filesystem root is a mistake
 * someone will make, and the honest response is a partial index and a flag
 * saying so, rather than a window that stops responding while it counts a
 * million files.
 */
export const MAX_INDEXED_FILES = 20_000;
export const MAX_INDEXED_DEPTH = 12;

export interface FileIndexResult {
  readonly entries: readonly WorkspaceIndexEntryV1[];
  /** True when a ceiling stopped the walk before it finished. */
  readonly truncated: boolean;
}

/**
 * Every openable file under `root`, breadth first.
 *
 * Breadth first so that a truncated index still holds the shallow files, which
 * are the ones most likely to be wanted: cutting a depth-first walk off leaves
 * one branch fully explored and the rest of the vault invisible.
 */
export async function buildFileIndex(root: string): Promise<FileIndexResult> {
  const realRoot = await realpath(root).catch(() => null);
  if (!realRoot) throw new Error('WORKSPACE_PATH_UNREADABLE');

  const entries: WorkspaceIndexEntryV1[] = [];
  // Guards against a symlink cycle, which a containment check alone does not:
  // two directories inside the root can point at each other quite legally.
  const seen = new Set<string>([realRoot]);
  let queue: { directory: string; depth: number }[] = [{ directory: realRoot, depth: 0 }];
  let truncated = false;

  while (queue.length > 0 && !truncated) {
    const next: { directory: string; depth: number }[] = [];

    for (const { directory, depth } of queue) {
      let listing;
      try {
        listing = await readdir(directory, { withFileTypes: true });
      } catch {
        // An unreadable directory is skipped rather than fatal: one folder
        // without permission should not cost the user their whole index.
        continue;
      }

      for (const entry of listing) {
        if (entry.name.startsWith('.')) continue;

        const entryPath = path.join(directory, entry.name);
        let isDirectory = entry.isDirectory();
        let resolvedPath = entryPath;

        if (entry.isSymbolicLink()) {
          const linked = await realpath(entryPath).catch(() => null);
          if (!linked || !isInside(realRoot, linked)) continue;
          resolvedPath = linked;
          isDirectory = !OPENABLE.has(path.extname(linked).toLowerCase())
            && !path.extname(linked);
          // Cheaper than a stat: an extension we open is a file, and anything
          // else we would not index regardless of what it is.
          if (!isDirectory && !OPENABLE.has(path.extname(linked).toLowerCase())) continue;
        }

        if (isDirectory) {
          if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
          if (depth + 1 > MAX_INDEXED_DEPTH) { truncated = true; continue; }
          if (seen.has(resolvedPath)) continue;
          seen.add(resolvedPath);
          next.push({ directory: resolvedPath, depth: depth + 1 });
          continue;
        }

        if (!OPENABLE.has(path.extname(entry.name).toLowerCase())) continue;
        if (entries.length >= MAX_INDEXED_FILES) { truncated = true; break; }

        entries.push({
          path: entryPath,
          name: entry.name,
          // Forward slashes whatever the platform, because this is a key the
          // renderer matches against and a query is typed with `/`.
          relativePath: path.relative(realRoot, entryPath).split(path.sep).join('/'),
        });
      }

      if (truncated) break;
    }

    queue = next;
  }

  // When each note last changed, for the age a result shows. Read in small
  // batches after the walk: about 25 ms for eight thousand notes, and one
  // that cannot be read simply has no age.
  const dated: WorkspaceIndexEntryV1[] = new Array(entries.length);
  for (let start = 0; start < entries.length; start += STAT_BATCH) {
    const slice = entries.slice(start, start + STAT_BATCH);
    const times = await Promise.all(slice.map((entry) => stat(entry.path).then((info) => info.mtimeMs, () => null)));
    slice.forEach((entry, at) => {
      const modified = times[at];
      dated[start + at] = typeof modified === 'number' && Number.isFinite(modified) && modified > 0
        ? { ...entry, modified: Math.floor(modified) }
        : entry;
    });
  }
  return { entries: dated, truncated };
}

/** Notes whose times are read at once: enough to keep the disk busy, few enough not to exhaust handles. */
const STAT_BATCH = 64;

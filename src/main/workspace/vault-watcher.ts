/**
 * Following the open folder on disk.
 *
 * Notes move under Noto all the time: renamed in Finder, reorganized in
 * another editor, checked out by git. Without a watcher the tree, quick open
 * and wiki links keep answering from the folder as it was when it opened.
 *
 * One recursive watch on the root costs the same however large the vault is
 * (FSEvents on macOS, ReadDirectoryChangesW on Windows), and a folder of five
 * hundred notes moved in Finder arrives as a handful of events, because the
 * system reports the folder rather than each file in it. So the events are
 * never the cost; the work done per event is. Here none is done per event:
 * an event only marks a name as touched, and once the folder has been quiet
 * for a moment the touched names are looked at together, one `lstat` each.
 *
 * An event is a hint, never a verdict. A save that writes a temporary file and
 * renames it over the note arrives as three `rename` events for a note that
 * only changed its text, so the kind of event decides nothing. What is on disk
 * after the quiet moment does, compared with what the tree and the index have
 * already been told.
 */

import { watch } from 'node:fs';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

/** How long the folder has to be still before the touched names are read. */
export const QUIET_MS = 250;

/** The longest a steady stream of events can hold the answer back. */
export const MAX_WAIT_MS = 2_000;

/**
 * Past this many touched names in one settle the list stops being useful,
 * and the answer becomes "everything", as it would after a checkout.
 */
export const MAX_TOUCHED = 5_000;

/** Folders whose churn never shows in the tree: version control, dependencies, tool state. */
const IGNORED_SEGMENTS = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv']);

/** Watch the root recursively and hand back how to stop. Null when it cannot be watched. */
export type WatchRoot = (
  root: string,
  onChange: (name: string | null) => void,
  onError: (error: unknown) => void,
) => (() => void) | null;

export interface VaultWatcherOptions {
  /**
   * Folder-relative paths, with forward slashes, touched since the last
   * settle. Null when the watcher lost track of what changed (a nameless
   * event, or more than `MAX_TOUCHED` names), which means "assume anything".
   */
  readonly onSettled: (touched: readonly string[] | null) => void;
  readonly watchRoot?: WatchRoot;
  readonly quietMs?: number;
  readonly maxWaitMs?: number;
  readonly maxTouched?: number;
  readonly log?: (event: string, fields?: Record<string, unknown>) => void;
}

const watchWithFs: WatchRoot = (root, onChange, onError) => {
  try {
    const watcher = watch(root, { persistent: false, recursive: true }, (_event, name) => {
      onChange(name === null ? null : String(name));
    });
    watcher.on('error', (error) => { watcher.close(); onError(error); });
    return () => watcher.close();
  } catch (error) {
    onError(error);
    return null;
  }
};

/** A name from the watcher, folder-relative with forward slashes, or null when nothing shown could live there. */
export function touchedPath(name: string): string | null {
  const relative = name.split(path.sep).join('/').replace(/^\.\/+/, '');
  if (relative === '' || relative.startsWith('../')) return null;
  for (const segment of relative.split('/')) {
    if (IGNORED_SEGMENTS.has(segment)) return null;
  }
  return relative;
}

export class VaultWatcher {
  private stop: (() => void) | null = null;
  private touched = new Set<string>();
  private lostTrack = false;
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private waitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: VaultWatcherOptions) {}

  /** Follow a new folder, or none. */
  open(root: string | null): void {
    this.close();
    if (root === null) return;
    const watchRoot = this.options.watchRoot ?? watchWithFs;
    this.stop = watchRoot(root, (name) => this.note(name), (error) => {
      // Absent rather than broken: the folder still works as it did before
      // there was a watcher, it just stops noticing other programs.
      this.options.log?.('vault_watch_failed', { message: error instanceof Error ? error.message : String(error) });
      this.close();
    });
  }

  /** Stop watching and drop anything not yet settled. */
  close(): void {
    this.stop?.();
    this.stop = null;
    this.clearTimers();
    this.touched = new Set();
    this.lostTrack = false;
  }

  private note(name: string | null): void {
    if (name === null) {
      this.lostTrack = true;
    } else {
      const relative = touchedPath(name);
      if (relative === null) return;
      this.touched.add(relative);
      if (this.touched.size > (this.options.maxTouched ?? MAX_TOUCHED)) this.lostTrack = true;
    }
    if (this.quietTimer !== null) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => this.settle(), this.options.quietMs ?? QUIET_MS);
    this.waitTimer ??= setTimeout(() => this.settle(), this.options.maxWaitMs ?? MAX_WAIT_MS);
  }

  private settle(): void {
    this.clearTimers();
    const touched = this.lostTrack ? null : [...this.touched];
    this.touched = new Set();
    this.lostTrack = false;
    this.options.onSettled(touched);
  }

  private clearTimers(): void {
    if (this.quietTimer !== null) clearTimeout(this.quietTimer);
    if (this.waitTimer !== null) clearTimeout(this.waitTimer);
    this.quietTimer = null;
    this.waitTimer = null;
  }
}

export type TouchedKind = 'file' | 'directory' | null;

/** What each touched path is now: a file, a folder, or gone. */
export async function inspectTouched(root: string, touched: readonly string[]): Promise<Array<{ path: string; kind: TouchedKind }>> {
  return Promise.all(touched.map(async (relative) => {
    try {
      const stats = await lstat(path.join(root, relative));
      return { path: relative, kind: stats.isDirectory() ? 'directory' as const : 'file' as const };
    } catch {
      return { path: relative, kind: null };
    }
  }));
}

export interface DiskChange {
  /** Something the tree or the index shows appeared, went, or moved. */
  readonly structural: boolean;
  /** A note the index already knew was written, so its tags may have changed. */
  readonly notes: boolean;
}

/**
 * Decide what a settled batch means.
 *
 * `known` answers whether the tree or the index has already been told about
 * a path; `showable` whether the tree or the index would show it. A path
 * nothing was ever told about and that is gone again was a temporary file.
 * A known path that is still a file only changed its text.
 */
export function classifyTouched(
  touched: ReadonlyArray<{ path: string; kind: TouchedKind }>,
  known: (relativePath: string) => boolean,
  showable: (relativePath: string, kind: 'file' | 'directory') => boolean,
): DiskChange {
  let structural = false;
  let notes = false;
  for (const { path: relative, kind } of touched) {
    if (relative.split('/').some((segment) => segment.startsWith('.'))) continue;
    const wasKnown = known(relative);
    if (kind === null) structural ||= wasKnown;
    else if (!wasKnown) structural ||= showable(relative, kind);
    else if (kind === 'file') notes = true;
  }
  return { structural, notes };
}

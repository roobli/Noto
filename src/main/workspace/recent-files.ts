/**
 * The recent files list.
 *
 * Small enough to rewrite whole on every change, so it uses a plain atomic
 * replace rather than the file-truth journal. Losing this list is an
 * inconvenience; losing a user's document is not, which is why only one of them
 * gets the heavy machinery.
 */

import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import type { RecentFileV1 } from '../../shared/workspace/v1/contracts';

const MAX_RECENT = 20;

function isRecentFile(value: unknown): value is RecentFileV1 {
  return typeof value === 'object' && value !== null
    && typeof (value as RecentFileV1).path === 'string'
    && typeof (value as RecentFileV1).name === 'string'
    && Number.isSafeInteger((value as RecentFileV1).openedAt);
}

/**
 * The note to bring back with a folder at launch: the newest recent note
 * inside `folder` that is still a file. A note opened from elsewhere does
 * not count, and one deleted since is passed over rather than reported.
 */
export async function lastNoteInside(entries: readonly RecentFileV1[], folder: string): Promise<string | null> {
  const root = path.resolve(folder);
  for (const entry of [...entries].sort((a, b) => b.openedAt - a.openedAt)) {
    const relative = path.relative(root, path.resolve(entry.path));
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    if (!/\.(md|markdown)$/i.test(entry.path)) continue;
    try {
      if ((await stat(entry.path)).isFile()) return entry.path;
    } catch {
      // Moved or deleted since; the next one may still be there.
    }
  }
  return null;
}

/**
 * Which note was in front when Noto last quit, so a launch reopens that one
 * and not a note the reader had already closed. Written once, at quit, when
 * there is no time for anything asynchronous; read once, at launch.
 */
export class FrontAtQuit {
  constructor(private readonly filePath: string, private readonly clock: () => number = Date.now) {}

  /**
   * The note in front at the last quit (null when none was) and when that
   * quit was; undefined when this was never written or cannot be read.
   */
  async read(): Promise<{ readonly path: string | null; readonly at: number } | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null && 'path' in parsed) {
        const { path: value, at } = parsed as { path: unknown; at?: unknown };
        if (value === null || typeof value === 'string') return { path: value, at: typeof at === 'number' && Number.isFinite(at) ? at : 0 };
      }
    } catch {
      // Never written, or unreadable: the recent list decides instead.
    }
    return undefined;
  }

  save(path: string | null): void {
    try {
      writeFileSync(this.filePath, JSON.stringify({ path, at: this.clock() }));
    } catch {
      // A launch then falls back to the recent list, which is close enough.
    }
  }
}

/**
 * The note a launch reopens in `folder`. The record of the last quit wins
 * while it is the newest thing known: a note closed before quitting stays
 * closed. When the record is older than the newest note opened in the folder
 * (Noto was killed, or the session ended without a quit) or names a note no
 * longer there, the recent list decides, as it does with no record at all.
 */
export async function noteToReopen(
  record: { readonly path: string | null; readonly at: number } | undefined,
  recent: readonly RecentFileV1[],
  folder: string,
): Promise<string | null> {
  const newest = await lastNoteInside(recent, folder);
  const newestAt = newest === null ? -Infinity : Math.max(...recent.filter((entry) => entry.path === newest).map((entry) => entry.openedAt));
  if (record === undefined || newestAt > record.at) return newest;
  if (record.path === null) return null;
  return (await lastNoteInside([{ path: record.path, name: path.basename(record.path), openedAt: record.at }], folder)) ?? newest;
}

export class RecentFiles {
  private entries: RecentFileV1[] = [];
  /**
   * The one read of the file, shared, so a remember that arrives while it is
   * in flight builds on the stored list instead of an empty one.
   */
  private loading: Promise<void> | undefined;

  constructor(private readonly filePath: string) {}

  load(): Promise<void> {
    this.loading ??= this.read();
    return this.loading;
  }

  private async read(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (Array.isArray(parsed)) this.entries = parsed.filter(isRecentFile).slice(0, MAX_RECENT);
    } catch {
      // A missing or unreadable list is not worth surfacing. Start empty.
      this.entries = [];
    }
  }

  list(): readonly RecentFileV1[] {
    return this.entries;
  }

  async remember(filePath: string): Promise<void> {
    await this.load();
    const entry: RecentFileV1 = {
      path: filePath,
      name: path.basename(filePath),
      openedAt: Date.now(),
    };
    this.entries = [entry, ...this.entries.filter((item) => item.path !== filePath)].slice(0, MAX_RECENT);
    await this.persist();
  }

  async forget(filePath: string): Promise<void> {
    await this.load();
    const next = this.entries.filter((item) => item.path !== filePath);
    if (next.length === this.entries.length) return;
    this.entries = next;
    await this.persist();
  }

  private async persist(): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `.recent-${process.pid}-${Date.now()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(this.entries, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}

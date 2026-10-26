/**
 * The recent files list.
 *
 * Small enough to rewrite whole on every change, so it uses a plain atomic
 * replace rather than the file-truth journal. Losing this list is an
 * inconvenience; losing a user's document is not, which is why only one of them
 * gets the heavy machinery.
 */

import path from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import type { RecentFileV1 } from '../../shared/workspace/v1/contracts';

const MAX_RECENT = 20;

function isRecentFile(value: unknown): value is RecentFileV1 {
  return typeof value === 'object' && value !== null
    && typeof (value as RecentFileV1).path === 'string'
    && typeof (value as RecentFileV1).name === 'string'
    && Number.isSafeInteger((value as RecentFileV1).openedAt);
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

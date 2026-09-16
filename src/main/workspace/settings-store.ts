/**
 * Reading and writing user settings.
 *
 * Same reasoning as the recent files list: small enough to rewrite whole, and
 * losing it costs a preference rather than a document, so it uses an atomic
 * replace instead of the file-truth journal.
 */

import path from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import {
  DEFAULT_SETTINGS,
  type NotoSettingsV1,
} from '../../shared/settings/v1/contracts';
import { coerceSettings } from '../../shared/settings/v1/validate';

export class SettingsStore {
  private settings: NotoSettingsV1 = DEFAULT_SETTINGS;
  private loaded = false;
  /** Serializes disk writes so overlapping patches do not race the tmp rename. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<NotoSettingsV1> {
    if (this.loaded) return this.settings;
    this.loaded = true;
    try {
      this.settings = coerceSettings(JSON.parse(await readFile(this.filePath, 'utf8')));
    } catch {
      // Missing on first run, and unreadable if it was hand edited badly.
      // Neither is worth interrupting the user for.
      this.settings = DEFAULT_SETTINGS;
    }
    return this.settings;
  }

  current(): NotoSettingsV1 {
    return this.settings;
  }

  /**
   * Wait for every in-flight `update` persist to finish. Used on quit so a
   * preference changed a moment before close (quick-open width, rail width, …)
   * is not lost when the window tears down mid-IPC.
   */
  async drain(): Promise<void> {
    await this.writeChain;
  }

  /**
   * Apply a partial change.
   *
   * A patch rather than a whole object, so a renderer that knows about fewer
   * settings than the running build cannot erase the ones it does not know.
   */
  async update(patch: Partial<NotoSettingsV1>): Promise<NotoSettingsV1> {
    await this.load();
    this.settings = coerceSettings({ ...this.settings, ...patch });
    const snapshot = this.settings;
    const persist = this.persistSnapshot(snapshot);
    this.writeChain = this.writeChain.then(() => persist, () => persist);
    await persist;
    return snapshot;
  }

  private async persistSnapshot(snapshot: NotoSettingsV1): Promise<void> {
    const temporary = `${this.filePath}.tmp`;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    await rename(temporary, this.filePath);
  }
}

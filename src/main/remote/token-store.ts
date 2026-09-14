/**
 * The remote control's token, kept where only this account can read it.
 *
 * Written to a file of its own rather than into the settings, which are
 * ordinary configuration a person may copy about or paste into a bug report.
 * The file is made readable by its owner alone, and a file that arrives with
 * looser permissions than that is replaced rather than trusted.
 */

import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { newToken } from './server';

/** Owner read and write, and nothing for anybody else. */
const PRIVATE = 0o600;

export class TokenStore {
  /**
   * The token this run is using.
   *
   * Held here as well as on disk, and this copy is the answer once there is
   * one. Without it, anything that made `current()` disagree with the file
   * would hand out a token the listening socket does not have: on Windows
   * the permission check below is meaningless, every read looked like a file
   * anyone could read, and the token was replaced on each call. The socket
   * kept the first one and refused every request made with the ones after it.
   *
   * Concurrent first calls are coalesced on `loading` for the same reason:
   * turning the control on asks for the token from both the socket start and
   * the preferences pane at once. Two regenerates in flight would leave the
   * socket holding A while the pane showed B, and every request would 401
   * until the control was restarted — which is exactly the packaged e2e flake
   * that a longer poll could not cure.
   */
  private held: string | null = null;
  private loading: Promise<string> | null = null;

  constructor(private readonly filePath: string) {}

  /** Sync view of the token this run is using; null until one has been loaded. */
  peek(): string | null {
    return this.held;
  }

  /** The token this run is using, from the file or newly written. */
  async current(): Promise<string> {
    if (this.held !== null) return this.held;
    if (this.loading !== null) return this.loading;
    this.loading = this.loadOrCreate().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async loadOrCreate(): Promise<string> {
    // Another caller may have finished (or regenerate() may have run) while
    // we were waiting to start; prefer that answer over minting a second one.
    if (this.held !== null) return this.held;
    try {
      const info = await stat(this.filePath);
      // A token any other account can read is not a secret any more. Windows
      // does not carry its access rules in the mode, where every file looks
      // world readable, so the question is not asked there.
      if (process.platform === 'win32' || (info.mode & 0o077) === 0) {
        const written = (await readFile(this.filePath, 'utf8')).trim();
        if (written.length >= 20) {
          // regenerate() may have won the race while we read; keep its token.
          if (this.held !== null) return this.held;
          this.held = written;
          return written;
        }
      }
    } catch {
      // Not there yet, which is the ordinary first run.
    }
    if (this.held !== null) return this.held;
    return this.regenerate();
  }

  /** A new token, replacing whatever was there. */
  async regenerate(): Promise<string> {
    const token = newToken();
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${token}\n`, { encoding: 'utf8', mode: PRIVATE });
    // Written again, since an existing file keeps the mode it had.
    await chmod(this.filePath, PRIVATE).catch(() => {});
    this.held = token;
    return token;
  }
}

/**
 * Where "Save a copy" may write, remembered in main.
 *
 * The renderer used to name the destination path itself, and main wrote the
 * document there. A renderer that had been compromised, by a note exploiting
 * the editor say, could then write anywhere the user can write. Now main runs
 * the save dialog, keeps the answer here behind an unguessable token, and the
 * save-copy request can only hand that token back. A token is taken once,
 * lapses after a few minutes, and only the newest few are kept, so a stale or
 * replayed one names nothing.
 */

import { randomBytes } from 'node:crypto';

const LIFETIME_MS = 10 * 60 * 1000;
const MAX_OUTSTANDING = 16;

export class CopyDestinations {
  private readonly chosen = new Map<string, { readonly path: string; readonly at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Remember a path the user chose in main's own dialog. */
  issue(destination: string): string {
    const token = randomBytes(16).toString('hex');
    this.chosen.set(token, { path: destination, at: this.now() });
    while (this.chosen.size > MAX_OUTSTANDING) {
      const oldest = this.chosen.keys().next().value as string;
      this.chosen.delete(oldest);
    }
    return token;
  }

  /** The path behind a token, once; null when it was never issued, was used, or lapsed. */
  take(token: string): string | null {
    const entry = this.chosen.get(token);
    this.chosen.delete(token);
    if (!entry || this.now() - entry.at > LIFETIME_MS) return null;
    return entry.path;
  }
}

import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

export interface StructuredLogger {
  filePath: string;
  log(event: string, details?: Record<string, unknown>): void;
}

/** The app's own log, which can also be read back. */
export interface ReadableLogger extends StructuredLogger {
  /**
   * The last `lines` events, newest last, optionally only those whose event
   * name starts with `event`. For the remote control's debug route: what a
   * person debugging would otherwise copy out of the file by hand.
   */
  tail(lines: number, event?: string | null): Record<string, unknown>[];
}

/** The log is rotated past this, keeping one previous file. */
const ROTATE_BYTES = 4 * 1024 * 1024;
/** Writes between size checks, so a busy log does not stat on every line. */
const ROTATE_CHECK_EVERY = 200;
/** The most of the file's end read for a tail. */
const TAIL_BYTES = 1024 * 1024;

export function summarizeUntrustedText(value: unknown): { bytes: number; sha256: string } {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return {
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/**
 * One newline-delimited JSON log for main, owner-readable only.
 *
 * It grew without end: a year of daily use is a file nobody can open. Past
 * `ROTATE_BYTES` it is moved to `main.1.ndjson`, replacing the one before, so
 * the newest events and the stretch before them are always there to read.
 */
export function createLogger(directory: string, options: { readonly rotateBytes?: number } = {}): ReadableLogger {
  mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, 'main.ndjson');
  const previousPath = path.join(directory, 'main.1.ndjson');
  let writes = 0;
  const rotateIfLarge = () => {
    writes += 1;
    if (writes % ROTATE_CHECK_EVERY !== 1) return;
    try {
      if (existsSync(filePath) && statSync(filePath).size > (options.rotateBytes ?? ROTATE_BYTES)) renameSync(filePath, previousPath);
    } catch {
      // A log that cannot rotate keeps appending; losing the rotation is
      // better than losing the line.
    }
  };
  return {
    filePath,
    log(event, details = {}) {
      rotateIfLarge();
      appendFileSync(filePath, `${JSON.stringify({
        timestamp: new Date().toISOString(),
        process: 'main',
        event,
        ...details,
      })}\n`, { encoding: 'utf8', mode: 0o600 });
    },
    tail(lines, event = null) {
      let text = '';
      try {
        const handle = openSync(filePath, 'r');
        try {
          const size = fstatSync(handle).size;
          const length = Math.min(size, TAIL_BYTES);
          const buffer = Buffer.alloc(length);
          readSync(handle, buffer, 0, length, size - length);
          text = buffer.toString('utf8');
        } finally {
          closeSync(handle);
        }
      } catch {
        return [];
      }
      const entries: Record<string, unknown>[] = [];
      // The first line of a partial read may be cut; it fails to parse and is skipped.
      for (const line of text.split('\n')) {
        if (line.length === 0) continue;
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          if (event && !String(entry.event ?? '').startsWith(event)) continue;
          entries.push(entry);
        } catch {
          continue;
        }
      }
      return entries.slice(-Math.max(0, lines));
    },
  };
}

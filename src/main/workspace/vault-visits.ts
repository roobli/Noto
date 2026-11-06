/**
 * Which notes were opened, and from where, for the vault's memory.
 *
 * Git already records every write. What it cannot see is reading: which note
 * was opened, when, and which note it was reached from. In a vault that keeps
 * memory (it has a `.noto/` folder) each open is one line in
 * `.noto/events/<host>/<yyyy-mm>.jsonl`, the format `@roobli/vault` reads to
 * work out how warm a note is and which notes are thought of together. A
 * folder without `.noto/` is left exactly as it is.
 *
 * yagni: a copy of `@roobli/vault`'s event writer (its docs/design.md is the
 * contract), kept here until that package is published; then import
 * `@roobli/vault/events` instead.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const isNote = (file: string): boolean => /\.(md|markdown)$/i.test(file);

function hostName(): string {
  return os.hostname().replace(/\.local$/, '').replace(/[^A-Za-z0-9._-]+/g, '-').toLowerCase() || 'host';
}

/** A vault-relative path, or null when the file is not inside the folder. */
function inside(root: string, file: string): string | null {
  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

/** Make a folder that may be there already; false when its parent is not. */
async function folderIn(dir: string): Promise<boolean> {
  try {
    await mkdir(dir);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return true;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

export class VaultVisits {
  /** One sitting per launch, so notes opened one after another can be paired. */
  private readonly session = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  private readonly host = hostName();
  private last: { path: string; time: number } | null = null;

  constructor(
    private readonly log: (event: string, data: Record<string, unknown>) => void = () => {},
    /** Whether the person keeps a read record for the folder at `root`, on this computer; on unless they said not. */
    private readonly recording: (root: string) => boolean = () => true,
  ) {}

  /**
   * Record that a note was brought to the front. The same note again within
   * a second is one visit (an open that also activates its tab).
   */
  async opened(root: string | null, file: string, from?: string | null): Promise<void> {
    if (root === null || !isNote(file) || !this.recording(root)) return;
    const rel = inside(root, path.resolve(file));
    if (rel === null) return;
    const now = Date.now();
    if (this.last && this.last.path === rel && now - this.last.time < 1000) return;
    this.last = { path: rel, time: now };
    const fromRel = from ? inside(root, path.resolve(from)) : null;
    const time = new Date(now);
    const line: Record<string, string> = { time: time.toISOString(), actor: 'owner', verb: 'open', path: rel, session: this.session };
    if (fromRel && fromRel !== rel) line.from = fromRel;
    const month = `${time.getUTCFullYear()}-${String(time.getUTCMonth() + 1).padStart(2, '0')}`;
    // Whether the folder keeps memory is asked on every open, so one that
    // began keeping it a moment ago is recorded and one whose .noto was just
    // deleted is not: its events folder is made only inside a .noto that is
    // there, never with the .noto around it.
    const events = path.join(root, '.noto', 'events');
    const target = path.join(events, this.host, `${month}.jsonl`);
    try {
      if (!(await folderIn(events)) || !(await folderIn(path.dirname(target)))) return;
      await appendFile(target, `${JSON.stringify(line)}\n`, 'utf8');
    } catch (error) {
      // Memory is a convenience: a read-only vault still opens its notes.
      this.log('vault_visit_not_recorded', { reason: (error as Error).message });
    }
  }
}

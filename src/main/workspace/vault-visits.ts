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

import { appendFile, mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const isNote = (file: string): boolean => /\.(md|markdown)$/i.test(file);

function hostName(): string {
  return os.hostname().replace(/\.local$/, '').replace(/[^A-Za-z0-9._-]+/g, '-').toLowerCase() || 'host';
}

/** A vault-relative path, or null when the file is not inside the folder. */
function inside(root: string, file: string): string | null {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

export class VaultVisits {
  /** One sitting per launch, so notes opened one after another can be paired. */
  private readonly session = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  private readonly host = hostName();
  private readonly keeps = new Map<string, boolean>();
  private last: { path: string; time: number } | null = null;

  constructor(private readonly log: (event: string, data: Record<string, unknown>) => void = () => {}) {}

  /** Whether a folder keeps memory: it has `.noto/`. Asked once per folder. */
  private async keepsMemory(root: string): Promise<boolean> {
    const known = this.keeps.get(root);
    if (known !== undefined) return known;
    let keeps = false;
    try { keeps = (await stat(path.join(root, '.noto'))).isDirectory(); } catch { keeps = false; }
    this.keeps.set(root, keeps);
    return keeps;
  }

  /**
   * Record that a note was brought to the front. The same note again within
   * a second is one visit (an open that also activates its tab).
   */
  async opened(root: string | null, file: string, from?: string | null): Promise<void> {
    if (root === null || !isNote(file)) return;
    const rel = inside(root, path.resolve(file));
    if (rel === null || !(await this.keepsMemory(root))) return;
    const now = Date.now();
    if (this.last && this.last.path === rel && now - this.last.time < 1000) return;
    this.last = { path: rel, time: now };
    const fromRel = from ? inside(root, path.resolve(from)) : null;
    const time = new Date(now);
    const line: Record<string, string> = { time: time.toISOString(), actor: 'owner', verb: 'open', path: rel, session: this.session };
    if (fromRel && fromRel !== rel) line.from = fromRel;
    const month = `${time.getUTCFullYear()}-${String(time.getUTCMonth() + 1).padStart(2, '0')}`;
    const target = path.join(root, '.noto', 'events', this.host, `${month}.jsonl`);
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await appendFile(target, `${JSON.stringify(line)}\n`, 'utf8');
    } catch (error) {
      // Memory is a convenience: a read-only vault still opens its notes.
      this.log('vault_visit_not_recorded', { reason: (error as Error).message });
    }
  }
}

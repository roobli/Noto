/**
 * Which notes were opened, and from where, for the vault's memory.
 *
 * Git already records every write. What it cannot see is reading: which note
 * was opened, when, and which note it was reached from. In a vault that keeps
 * memory (it has a `.noto/` folder) each open is one line in
 * `.noto/events/<host>/<yyyy-mm>.jsonl`, written by `@roobli/vault`'s
 * `EventLog`: the first open of a note at once, so the index sees it, and
 * the same note opened again with nothing else opened between, within a
 * minute of the last, counted on one `repeat` line when the run ends. A
 * folder without `.noto/` is left exactly as it is.
 *
 * Only the person's opens in this window are recorded here, as `owner`. An
 * agent that reads or edits notes on disk records itself under its own name
 * (`noto-vault record`), and Noto never guesses who changed a file.
 */

import path from 'node:path';
import { EventLog } from '@roobli/vault';

const isNote = (file: string): boolean => /\.(md|markdown)$/i.test(file);

/** A vault-relative path, or null when the file is not inside the folder. */
function inside(root: string, file: string): string | null {
  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

export class VaultVisits {
  /** One sitting per launch, so notes opened one after another can be paired. */
  private readonly session = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  private readonly logs = new Map<string, EventLog>();
  private last: { path: string; time: number } | null = null;

  constructor(
    private readonly log: (event: string, data: Record<string, unknown>) => void = () => {},
    /** Whether the person keeps a read record for the folder at `root`, on this computer; on unless they said not. */
    private readonly recording: (root: string) => boolean = () => true,
    private readonly clock: () => number = Date.now,
  ) {}

  /**
   * Record that a note was brought to the front. The same note again within
   * a second is one visit reported twice (an open that also activates its
   * tab), and is not counted at all.
   */
  opened(root: string | null, file: string, from?: string | null): void {
    if (root === null || !isNote(file) || !this.recording(root)) return;
    const rel = inside(root, path.resolve(file));
    if (rel === null) return;
    const now = this.clock();
    if (this.last && this.last.path === rel && now - this.last.time < 1000) return;
    this.last = { path: rel, time: now };
    const fromRel = from ? inside(root, path.resolve(from)) : null;
    let log = this.logs.get(root);
    if (!log) this.logs.set(root, log = new EventLog(root, undefined, this.clock));
    // Whether the folder keeps memory is asked on every open, so one that
    // began keeping it a moment ago is recorded and one whose .noto was just
    // deleted is not: the writer makes its events folder only inside a .noto
    // that is there, never the .noto around it.
    try {
      log.record([{ actor: 'owner', verb: 'open', path: rel, session: this.session, ...(fromRel && fromRel !== rel ? { from: fromRel } : {}) }]);
    } catch (error) {
      // Memory is a convenience: a read-only vault still opens its notes.
      this.log('vault_visit_not_recorded', { reason: (error as Error).message });
    }
  }

  /** Write any run still being counted; the writer also does this a minute after its last open, and at exit. */
  flush(): void {
    for (const log of this.logs.values()) log.flush();
  }
}

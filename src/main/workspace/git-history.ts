/**
 * One note's history, as git keeps it.
 *
 * The same read-only system git as the tree's marks (`git-marks.ts`), with
 * the same rules: `execFile` or `spawn`, never a shell; a timeout on every
 * run; no optional locks, no fsmonitor, no external diff or text conversion.
 *
 * A note's commits come from one `git log --follow` walk, newest first, so a
 * note that was renamed or moved keeps its past. The walk costs the same
 * whether it is asked for ten commits or all of them (it is the walk that is
 * dear, not the lines it prints), so it is made once per note and kept until
 * HEAD moves. Each commit says how many lines it added and took away, and,
 * for the newest ones, two things a reader wants dimmed: a commit that only
 * rewrote text between tool markers (`<!-- note-assistant:index:start -->`
 * and its end), which is a script's work, and a commit that changed more than
 * a hundred files at once, which is a sweep across the folder. Both are what
 * the vault's own reading of history sets aside, so the person's own changes
 * stand out the same way in both.
 */

import { spawn } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { GitRunError, gitEnvironment, locate, type GitRunner } from './git-marks';
import type {
  NoteCommitV1,
  NoteFileFactsV1,
  WorkspaceNoteHistoryReplyV1,
} from '../../shared/workspace/v1/contracts';
import { NOTO_WORKSPACE_VERSION } from '../../shared/workspace/v1/contracts';

const LOG_TIMEOUT_MS = 3_000;
const SMALL_TIMEOUT_MS = 2_000;
/**
 * yagni: a note with more commits than this shows the newest and says there
 * are more. No note in a real vault has come near it; `--skip` paging is the
 * upgrade if one does.
 */
export const MAX_HISTORY = 1000;
/**
 * The newest commits whose changes are classed as tool-only or sweeping.
 * yagni: older ones are shown unclassed; classing them on scroll is the
 * upgrade, should a note's distant past turn out to be read.
 */
export const MAX_CLASSIFIED = 200;
/** A commit that changes more files than this is a sweep across the folder. */
export const SWEEP_FILES = 100;
/** A version bigger than this is not shown; the diff view would not be readable either. */
export const MAX_VERSION_BYTES = 4 * 1024 * 1024;
/** The most the blobs read to class a history may come to. */
const MAX_BATCH_BYTES = 32 * 1024 * 1024;
/** Notes whose history is kept, most recently asked for last. */
const CACHE_NOTES = 64;

const FIELD = '\x1f';
const RECORD = '\x1e';
const NO_BLOB = /^0+$/;

/**
 * Arguments every read here starts with. `--literal-pathspecs`, because a note
 * may be called `Notes [draft].md` or `*.md`, and git would otherwise read
 * the name as a pattern and match its neighbours too.
 */
const PLUMBING = ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-c', 'log.showSignature=false'];

/** What a commit's words may run to, as the window's contract takes them. */
const MAX_SUBJECT = 1000;
const MAX_AUTHOR = 200;

/** The `git log` for one note, from the repository's top, by its path there. */
export function logArguments(fromTop: string): string[] {
  return [
    ...PLUMBING, 'log', '--follow', '-M', '--raw', '--numstat', '--no-abbrev', '--no-color',
    '--no-ext-diff', '--no-textconv', `--format=${RECORD}%H${FIELD}%P${FIELD}%an${FIELD}%at${FIELD}%s`,
    '-n', String(MAX_HISTORY + 1), '--', fromTop,
  ];
}

/** A commit as the walk reads it, with the blobs that tell what kind of change it was. */
export interface WalkedCommit {
  readonly hash: string;
  readonly time: number;
  readonly author: string;
  readonly subject: string;
  readonly change: NoteCommitV1['change'];
  readonly path: string;
  readonly from: string | null;
  readonly added: number | null;
  readonly removed: number | null;
  readonly before: string | null;
  readonly after: string | null;
}

/**
 * Undo git's C quoting of a path, which `core.quotePath=false` still applies
 * to names holding a quote, a backslash or a control character. Octal
 * escapes are bytes, so they are gathered and read as UTF-8.
 */
export function unquotePath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) return value;
  const bytes: number[] = [];
  const body = value.slice(1, -1);
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'));
      continue;
    }
    const next = body[index + 1] ?? '';
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(index + 1, index + 4), 8));
      index += 3;
    } else {
      bytes.push(simple[next] ?? next.charCodeAt(0));
      index += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

const CHANGES: Record<string, NoteCommitV1['change']> = { A: 'added', M: 'modified', R: 'renamed', C: 'copied', D: 'deleted', T: 'modified' };

/** Read the walk's output into commits, newest first. */
export function parseFollowLog(output: string): WalkedCommit[] {
  const commits: WalkedCommit[] = [];
  for (const record of output.split(RECORD)) {
    if (!record.trim()) continue;
    const lines = record.split('\n');
    const [hash, , author, seconds, ...subject] = lines[0]!.split(FIELD);
    if (!hash || !/^[0-9a-f]{40,64}$/.test(hash)) continue;
    let change: NoteCommitV1['change'] = 'merge';
    let at: string | null = null;
    let from: string | null = null;
    let before: string | null = null;
    let after: string | null = null;
    let added: number | null = null;
    let removed: number | null = null;
    for (const line of lines.slice(1)) {
      if (line.startsWith(':') && at === null) {
        const [meta, ...paths] = line.split('\t');
        const fields = meta!.split(' ');
        const status = fields[4] ?? '';
        change = CHANGES[status[0] ?? ''] ?? 'modified';
        before = NO_BLOB.test(fields[2] ?? '') ? null : fields[2] ?? null;
        after = NO_BLOB.test(fields[3] ?? '') ? null : fields[3] ?? null;
        if (paths.length >= 2 && (change === 'renamed' || change === 'copied')) {
          from = unquotePath(paths[0]!);
          at = unquotePath(paths[1]!);
        } else {
          at = unquotePath(paths[0] ?? '');
        }
        continue;
      }
      const stats = /^(\d+|-)\t(\d+|-)\t/.exec(line);
      if (stats && added === null) {
        added = stats[1] === '-' ? null : Number(stats[1]);
        removed = stats[2] === '-' ? null : Number(stats[2]);
      }
    }
    commits.push({
      hash,
      time: Number(seconds) * 1000,
      author: (author ?? '').slice(0, MAX_AUTHOR),
      subject: subject.join(FIELD).slice(0, MAX_SUBJECT),
      change,
      path: at ?? '',
      from,
      added,
      removed,
      before,
      after,
    });
  }
  // A merge prints no change of its own; it is where the note was in the commit after it.
  for (let index = 0; index < commits.length; index += 1) {
    const commit = commits[index]!;
    if (commit.path === '') {
      const later = commits.slice(0, index).reverse().find((candidate) => candidate.path !== '');
      const earlier = commits.slice(index + 1).find((candidate) => candidate.path !== '');
      commits[index] = { ...commit, path: earlier?.path ?? later?.path ?? '' };
    }
  }
  return commits;
}

/**
 * A tool's region: an opening marker, what the tool wrote, and the closing
 * marker with the same name. Names look like `note-assistant:index`.
 */
const TOOL_REGION = /<!--\s*([A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*):start\b[^>]*-->[\s\S]*?<!--\s*\1:end\s*-->/g;

/** The text with what tools wrote between their markers taken out, the markers kept. */
export function withoutToolRegions(text: string): string {
  return text.replace(TOOL_REGION, (_whole, name: string) => `<!-- ${name}:start --><!-- ${name}:end -->`);
}

/** True when the two texts differ, and only inside tool regions. */
export function onlyToolRegionsChanged(before: string, after: string): boolean {
  return before !== after && withoutToolRegions(before) === withoutToolRegions(after);
}

/** What the cache holds for a note: its commits, classed, under the HEAD they were read at. */
interface KeptHistory {
  readonly head: string;
  readonly toplevel: string;
  readonly commits: readonly NoteCommitV1[];
  readonly more: boolean;
}

/** Reads blobs and counts, where one process for many answers is what keeps it quick. */
export interface BatchGit {
  /** The blobs' texts by id. A blob that is missing, or too big, is left out. */
  blobs(ids: readonly string[], cwd: string): Promise<Map<string, string>>;
  /** How many files each commit changed, by hash. */
  filesChanged(hashes: readonly string[], cwd: string): Promise<Map<string, number>>;
}

/**
 * Run git with input, reading its output as it comes: never a shell, always a
 * timeout. `onData` answers `'stop'` to end the run early, which is then a
 * `slow` failure. A throw from it is taken as a stop, since a throw there is
 * outside the promise and would take the main process with it.
 */
function streamGit(
  binary: string,
  args: readonly string[],
  cwd: string,
  input: string | null,
  onData: (chunk: Buffer) => void | 'stop',
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], { cwd, env: gitEnvironment(), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let stopped = false;
    const stop = () => {
      stopped = true;
      clearTimeout(timer);
      child.kill();
      reject(new GitRunError('slow'));
    };
    const timer = setTimeout(stop, LOG_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      if (stopped) return;
      let answer: void | 'stop';
      try {
        answer = onData(chunk);
      } catch {
        answer = 'stop';
      }
      if (answer === 'stop') stop();
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new GitRunError(error.code === 'ENOENT' ? 'missing' : 'failed'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (stopped) return;
      if (code === 0) resolve();
      else reject(new GitRunError('failed'));
    });
    child.stdin.on('error', () => { /* A git that exits early closes its input; the exit says why. */ });
    child.stdin.end(input ?? '');
  });
}

/** The system git's batch reads. */
export function systemBatchGit(binary: string): BatchGit {
  return {
    async blobs(ids, cwd) {
      const found = new Map<string, string>();
      if (ids.length === 0) return found;
      const chunks: Buffer[] = [];
      let size = 0;
      await streamGit(binary, [...PLUMBING, 'cat-file', '--batch'], cwd, `${ids.join('\n')}\n`, (chunk) => {
        size += chunk.length;
        // Classing is a nicety: a history this heavy is shown unclassed.
        if (size > MAX_BATCH_BYTES) return 'stop';
        chunks.push(chunk);
        return undefined;
      });
      const all = Buffer.concat(chunks);
      let at = 0;
      while (at < all.length) {
        const end = all.indexOf(10, at);
        if (end < 0) break;
        const [id, type, bytes] = all.subarray(at, end).toString('utf8').split(' ');
        at = end + 1;
        if (type !== 'blob' || bytes === undefined) continue;
        const length = Number(bytes);
        if (length <= MAX_VERSION_BYTES) found.set(id!, all.subarray(at, at + length).toString('utf8'));
        at += length + 1;
      }
      return found;
    },
    async filesChanged(hashes, cwd) {
      const counts = new Map<string, number>();
      if (hashes.length === 0) return counts;
      let current: string | null = null;
      let rest = '';
      // `--raw` lists the changed paths without reading a line of them; counted
      // as they stream, so a commit across ten thousand files costs no memory.
      await streamGit(binary, [
        ...PLUMBING, 'log', '--no-walk=unsorted', '--raw', '--no-abbrev', '--no-renames', `--format=${RECORD}%H`, '--stdin',
      ], cwd, `${hashes.join('\n')}\n`, (chunk) => {
        const lines = (rest + chunk.toString('utf8')).split('\n');
        rest = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith(RECORD)) {
            current = line.slice(1).trim();
            counts.set(current, 0);
          } else if (current !== null && line.startsWith(':')) {
            counts.set(current, (counts.get(current) ?? 0) + 1);
          }
        }
      });
      return counts;
    },
  };
}

/** Where a note sits in its repository. */
interface Placed {
  readonly toplevel: string;
  readonly fromTop: string;
}

async function place(run: GitRunner, real: string): Promise<Placed | null> {
  const location = await locate(run, path.dirname(real));
  if (!location) return null;
  const toplevel = await realpath(location.toplevel).catch(() => location.toplevel);
  const fromTop = path.relative(toplevel, real).split(path.sep).join('/');
  if (fromTop.startsWith('..') || path.isAbsolute(fromTop)) return null;
  return { toplevel, fromTop };
}

async function fileFacts(real: string): Promise<NoteFileFactsV1 | null> {
  try {
    const info = await stat(real);
    return {
      created: info.birthtimeMs > 0 ? info.birthtimeMs : info.ctimeMs,
      modified: info.mtimeMs,
      bytes: info.size,
    };
  } catch {
    return null;
  }
}

/** Lines a text has, as `git diff --numstat` would count them for a new file. */
function lineCount(text: string): number {
  if (text.length === 0) return 0;
  const breaks = text.split('\n').length - 1;
  return text.endsWith('\n') ? breaks : breaks + 1;
}

/** The history of notes, read from git and kept until HEAD moves. */
export class NoteHistoryReader {
  private readonly kept = new Map<string, KeptHistory>();
  /** Reads under way, so the tab and the timeline asking at once walk once. */
  private readonly reading = new Map<string, Promise<KeptHistory | null>>();

  constructor(
    private readonly run: () => Promise<GitRunner | null>,
    private readonly batch: () => Promise<BatchGit | null>,
  ) {}

  /** The history of the note at `real`, a real path the caller has confined to the open folder. */
  async history(real: string): Promise<WorkspaceNoteHistoryReplyV1> {
    const file = await fileFacts(real);
    const reply = (state: WorkspaceNoteHistoryReplyV1['state'], rest: Partial<WorkspaceNoteHistoryReplyV1> = {}): WorkspaceNoteHistoryReplyV1 => ({
      version: NOTO_WORKSPACE_VERSION, state, commits: [], more: false, uncommitted: null, file, ...rest,
    });
    const run = await this.run();
    if (run === null) return reply('unavailable');
    try {
      const kept = await this.read(run, real);
      if (kept === null) return reply('not-git');
      const uncommitted = await this.uncommitted(run, real, kept);
      if (kept.commits.length === 0) return reply('untracked', { uncommitted });
      return reply('ok', { commits: kept.commits, more: kept.more, uncommitted });
    } catch (error) {
      if (error instanceof GitRunError) return reply(error.reason === 'slow' ? 'slow' : 'unavailable');
      throw error;
    }
  }

  /**
   * The note's text as a commit had it, by the path it had there. Only a
   * commit and path from the note's own history are read, so this cannot be
   * turned into a reader of anything else the repository holds.
   */
  async version(real: string, hash: string, at: string): Promise<string | null> {
    if (!/^[0-9a-f]{40,64}$/.test(hash)) return null;
    const run = await this.run();
    if (run === null) return null;
    try {
      const kept = await this.read(run, real);
      const commit = kept?.commits.find((entry) => entry.hash === hash);
      if (!kept || !commit || commit.path !== at || commit.change === 'deleted') return null;
      const text = await run([...PLUMBING, 'cat-file', 'blob', `${hash}:${at}`], kept.toplevel, SMALL_TIMEOUT_MS);
      return text.length > MAX_VERSION_BYTES ? null : text;
    } catch (error) {
      if (error instanceof GitRunError) return null;
      throw error;
    }
  }

  private read(run: GitRunner, real: string): Promise<KeptHistory | null> {
    const under = this.reading.get(real);
    if (under) return under;
    const reading = this.readOnce(run, real).finally(() => this.reading.delete(real));
    this.reading.set(real, reading);
    return reading;
  }

  private async readOnce(run: GitRunner, real: string): Promise<KeptHistory | null> {
    const placed = await place(run, real);
    if (!placed) return null;
    // An empty repository has no HEAD and so no history; every note in it is new.
    const head = (await run([...PLUMBING, 'rev-parse', '--verify', '-q', 'HEAD'], placed.toplevel, SMALL_TIMEOUT_MS)
      .catch(() => '')).trim();
    const key = real;
    const known = this.kept.get(key);
    if (known && known.head === head) {
      this.kept.delete(key);
      this.kept.set(key, known);
      return known;
    }
    if (head === '') return this.keep(key, { head, toplevel: placed.toplevel, commits: [], more: false });
    const walked = parseFollowLog(await run(logArguments(placed.fromTop), placed.toplevel, LOG_TIMEOUT_MS));
    const more = walked.length > MAX_HISTORY;
    const commits = await this.classify(walked.slice(0, MAX_HISTORY), placed.toplevel);
    return this.keep(key, { head, toplevel: placed.toplevel, commits, more });
  }

  private keep(key: string, history: KeptHistory): KeptHistory {
    this.kept.set(key, history);
    while (this.kept.size > CACHE_NOTES) this.kept.delete(this.kept.keys().next().value!);
    return history;
  }

  /** Class the newest commits; one batch for their blobs and one for their sizes. */
  private async classify(walked: readonly WalkedCommit[], toplevel: string): Promise<NoteCommitV1[]> {
    const newest = walked.slice(0, MAX_CLASSIFIED);
    const batch = await this.batch();
    let texts = new Map<string, string>();
    let counts = new Map<string, number>();
    if (batch) {
      const ids = new Set<string>();
      for (const commit of newest) {
        if (commit.change === 'modified' && commit.before && commit.after) { ids.add(commit.before); ids.add(commit.after); }
      }
      // A class is a nicety: when git cannot answer in time the commits are shown unclassed.
      [texts, counts] = await Promise.all([
        batch.blobs([...ids], toplevel).catch(() => new Map<string, string>()),
        batch.filesChanged(newest.map((commit) => commit.hash), toplevel).catch(() => new Map<string, number>()),
      ]);
    }
    return walked.map((commit, index) => {
      const before = commit.before ? texts.get(commit.before) : undefined;
      const after = commit.after ? texts.get(commit.after) : undefined;
      return {
        hash: commit.hash,
        time: commit.time,
        author: commit.author,
        subject: commit.subject,
        change: commit.change,
        path: commit.path,
        from: commit.from,
        added: commit.added,
        removed: commit.removed,
        tooling: index < MAX_CLASSIFIED && commit.change === 'modified' && before !== undefined && after !== undefined
          && onlyToolRegionsChanged(before, after),
        sweeping: (counts.get(commit.hash) ?? 0) > SWEEP_FILES,
      };
    });
  }

  /** Lines added and taken away on disk since the last commit; null when there are none. */
  private async uncommitted(run: GitRunner, real: string, kept: KeptHistory): Promise<{ added: number; removed: number } | null> {
    const fromTop = path.relative(kept.toplevel, real).split(path.sep).join('/');
    if (kept.commits.length === 0) {
      // Never committed: all of it is new, unless git is told to ignore it.
      const ignored = await run([...PLUMBING, 'check-ignore', '-q', '--', fromTop], kept.toplevel, SMALL_TIMEOUT_MS)
        .then(() => true, () => false);
      if (ignored) return null;
      const body = await readFile(real, 'utf8').catch(() => '');
      const added = lineCount(body);
      return added > 0 ? { added, removed: 0 } : null;
    }
    const output = await run([...PLUMBING, 'diff', '--numstat', '--no-ext-diff', '--no-textconv', 'HEAD', '--', fromTop],
      kept.toplevel, SMALL_TIMEOUT_MS);
    const stats = /^(\d+|-)\t(\d+|-)\t/.exec(output);
    if (!stats) return null;
    return { added: stats[1] === '-' ? 0 : Number(stats[1]), removed: stats[2] === '-' ? 0 : Number(stats[2]) };
  }
}

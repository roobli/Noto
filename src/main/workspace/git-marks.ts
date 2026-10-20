/**
 * Which notes in the open folder differ from the last commit.
 *
 * Read with the system `git`, from main, and only ever read. No JavaScript
 * git library: the system binary already understands packfiles, worktrees,
 * submodules and the reader's own configuration, and a second implementation
 * would get one of them subtly wrong. Noto never writes to `.git`.
 *
 * The feature is absent rather than broken whenever it cannot be had cheaply:
 * no git, a folder outside any repository, a status that takes too long or
 * prints too much. Absent means no marks and no message. Nobody opened a
 * folder of notes to be told about their version control.
 *
 * Nothing polls. A status runs when the folder is opened, when git's own
 * bookkeeping changes (the index, HEAD, the refs), after a save or a tree
 * action, and when the window comes back to the front, debounced together.
 */

import { execFile } from 'node:child_process';
import { constants, watch, type FSWatcher } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  marksFrom,
  parsePorcelainV2,
  scopeToVault,
  vaultPathspec,
  type GitChangeV1,
} from './git-status';

/** What the renderer is sent: absolute paths, as the tree's rows carry them. */
export interface GitMarksEventV1 {
  readonly version: 1;
  /** The folder these marks are for, so a late answer for another is dropped. */
  readonly root: string | null;
  readonly files: ReadonlyArray<readonly [string, GitChangeV1]>;
  readonly folders: readonly string[];
}

/** Runs git with arguments, in a directory, and resolves with its stdout. */
export type GitRunner = (args: readonly string[], cwd: string, timeoutMs: number) => Promise<string>;

/** Why a run failed, which decides between "try again later" and "stop". */
export class GitRunError extends Error {
  constructor(readonly reason: 'missing' | 'slow' | 'failed') {
    super(`git ${reason}`);
  }
}

const DISCOVER_TIMEOUT_MS = 2_000;
const STATUS_TIMEOUT_MS = 3_000;
/** Enough for tens of thousands of paths; more than that is a repository too big to mark. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Past this many changed notes the marks stop being information. */
const MAX_MARKED = 20_000;
const DEBOUNCE_MS = 300;

/**
 * The environment git runs in.
 *
 * `GIT_OPTIONAL_LOCKS=0` as well as `--no-optional-locks`, so an old git that
 * ignores one still sees the other: without them `status` refreshes the index
 * and takes its lock, and fights the reader's own git. Variables that would
 * point git at some other repository than the folder's are dropped, so a Noto
 * launched from inside a git hook still reads the folder it shows.
 */
function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']) {
    delete env[name];
  }
  return env;
}

/**
 * Where git is.
 *
 * On macOS a GUI app inherits a PATH without Homebrew, and `/usr/bin/git` is a
 * stub that, without the Command Line Tools, puts up an installer dialog: a
 * prompt, which this feature must never cause. So the places people install
 * git come first, and the stub is only used once `xcode-select -p` says the
 * tools behind it exist. Elsewhere the name is enough.
 */
export async function findGit(
  platform: NodeJS.Platform = process.platform,
  exists: (candidate: string) => Promise<boolean> = isExecutable,
  hasDeveloperTools: () => Promise<boolean> = xcodeToolsPresent,
): Promise<string | null> {
  if (platform !== 'darwin') return 'git';
  for (const candidate of ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/opt/local/bin/git']) {
    if (await exists(candidate)) return candidate;
  }
  return (await hasDeveloperTools()) ? '/usr/bin/git' : null;
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function xcodeToolsPresent(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('/usr/bin/xcode-select', ['-p'], { timeout: DISCOVER_TIMEOUT_MS, windowsHide: true },
      (error) => resolve(error === null));
  });
}

/** A runner for one git binary. `execFile`, never a shell. */
export function systemGit(binary: string): GitRunner {
  return (args, cwd, timeoutMs) => new Promise((resolve, reject) => {
    execFile(binary, [...args], {
      cwd,
      env: gitEnvironment(),
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      encoding: 'utf8',
    }, (error, stdout) => {
      if (error === null) { resolve(stdout); return; }
      const failure = error as NodeJS.ErrnoException & { killed?: boolean };
      if (failure.code === 'ENOENT') reject(new GitRunError('missing'));
      else if (failure.killed || failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reject(new GitRunError('slow'));
      else reject(new GitRunError('failed'));
    });
  });
}

/** Where a folder sits in its repository, from one `rev-parse`. */
export interface GitLocationV1 {
  readonly toplevel: string;
  readonly gitDir: string;
  readonly commonDir: string;
  /** The folder relative to the top level, with a trailing slash, or empty. */
  readonly prefix: string;
}

/**
 * Ask git where the folder is, or null when it is not in a work tree.
 *
 * `--git-common-dir` is what a linked worktree shares with its main checkout,
 * and where the refs live; `--absolute-git-dir` is the worktree's own, where
 * its HEAD and index are. The common dir may come back relative to the
 * folder.
 */
export async function locate(run: GitRunner, folder: string): Promise<GitLocationV1 | null> {
  let output: string;
  try {
    output = await run(
      ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir', '--show-prefix'],
      folder, DISCOVER_TIMEOUT_MS,
    );
  } catch (error) {
    if (error instanceof GitRunError) return null;
    throw error;
  }
  const lines = output.split(/\r?\n/);
  const [toplevel, gitDir, commonDir] = lines;
  if (!toplevel || !gitDir || !commonDir) return null;
  return {
    toplevel,
    gitDir,
    commonDir: path.resolve(folder, commonDir),
    prefix: lines[3] ?? '',
  };
}

/** The status arguments, in one place so the test can hold them to the decision. */
export function statusArguments(prefix: string): string[] {
  return [
    '--no-optional-locks',
    // A repository's own config can name a program for fsmonitor, and status
    // would run it. A folder of notes someone downloaded is not a reason to
    // run their program.
    '-c', 'core.fsmonitor=false',
    'status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=all',
    '--', vaultPathspec(prefix),
  ];
}

const EMPTY: Omit<GitMarksEventV1, 'root'> = { version: 1, files: [], folders: [] };

export interface GitMarksOptions {
  readonly publish: (event: GitMarksEventV1) => void;
  /** Which folder-relative files count. The tree's notes, for the tree. */
  readonly keep: (relativePath: string) => boolean;
  /** Resolves the runner once; null when there is no git. */
  readonly runner?: () => Promise<GitRunner | null>;
  readonly watchDirectory?: (directory: string, recursive: boolean, onChange: (name: string | null) => void) => (() => void) | null;
  readonly log?: (event: string, fields?: Record<string, unknown>) => void;
  readonly debounceMs?: number;
}

/** Watch one directory, and hand back how to stop. Null when it cannot be watched. */
function watchWithFs(directory: string, recursive: boolean, onChange: (name: string | null) => void): (() => void) | null {
  let watcher: FSWatcher;
  try {
    watcher = watch(directory, { persistent: false, recursive }, (_event, name) => onChange(name === null ? null : String(name)));
  } catch {
    return null;
  }
  watcher.on('error', () => watcher.close());
  return () => watcher.close();
}

/** The names in a git directory whose change means the status may have. */
const BOOKKEEPING = new Set(['index', 'HEAD', 'packed-refs']);

export class GitMarks {
  private root: string | null = null;
  private realRoot: string | null = null;
  private location: GitLocationV1 | null = null;
  private run: GitRunner | null = null;
  private runnerPromise: Promise<GitRunner | null> | null = null;
  private stops: Array<() => void> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private again = false;
  /** Bumped on every folder change, so an answer for the last one is dropped. */
  private generation = 0;
  private latest: GitMarksEventV1 = { ...EMPTY, root: null };

  constructor(private readonly options: GitMarksOptions) {}

  /** The marks as they stand, for a renderer that has just loaded. */
  current(): GitMarksEventV1 {
    return this.latest;
  }

  /** Follow a new folder, or none. Resolves once the first status is in. */
  async open(root: string | null): Promise<void> {
    this.close();
    const generation = ++this.generation;
    this.root = root;
    this.latest = { ...EMPTY, root };
    if (root === null) return;
    try {
      const run = await this.resolveRunner();
      if (run === null || generation !== this.generation) return;
      const realRoot = await realpath(root);
      const location = await locate(run, realRoot);
      if (location === null || generation !== this.generation) return;
      this.run = run;
      this.realRoot = realRoot;
      this.location = location;
      this.watchBookkeeping(location);
      await this.update(generation);
    } catch {
      // Absent, quietly. Anything unexpected here is still not worth a message.
      if (generation === this.generation) this.close();
    }
  }

  /** Something may have changed: run a status once things settle. */
  refresh(): void {
    if (this.location === null) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.update(this.generation);
    }, this.options.debounceMs ?? DEBOUNCE_MS);
  }

  /** Stop watching and forget the folder. */
  close(): void {
    for (const stop of this.stops) stop();
    this.stops = [];
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.location = null;
    this.realRoot = null;
    this.again = false;
  }

  private resolveRunner(): Promise<GitRunner | null> {
    this.runnerPromise ??= (this.options.runner ?? (async () => {
      const binary = await findGit();
      return binary === null ? null : systemGit(binary);
    }))();
    return this.runnerPromise;
  }

  /**
   * The index and HEAD live in the worktree's own git directory, the refs in
   * the common one. A commit rewrites a ref and appends to `logs/HEAD`; a
   * checkout rewrites HEAD; staging rewrites the index (by rename, which is
   * why the directory is watched and not the file).
   */
  private watchBookkeeping(location: GitLocationV1): void {
    const watchDirectory = this.options.watchDirectory ?? watchWithFs;
    const add = (directory: string, recursive: boolean, relevant: (name: string | null) => boolean) => {
      const stop = watchDirectory(directory, recursive, (name) => { if (relevant(name)) this.refresh(); });
      if (stop) this.stops.push(stop);
    };
    const bookkeeping = (name: string | null) => name === null || BOOKKEEPING.has(name);
    add(location.gitDir, false, bookkeeping);
    add(path.join(location.gitDir, 'logs'), false, (name) => name === null || name === 'HEAD');
    if (path.resolve(location.commonDir) !== path.resolve(location.gitDir)) add(location.commonDir, false, bookkeeping);
    add(path.join(location.commonDir, 'refs'), true, (name) => name === null || !name.endsWith('.lock'));
  }

  private async update(generation: number): Promise<void> {
    if (this.running) { this.again = true; return; }
    this.running = true;
    try {
      do {
        this.again = false;
        await this.statusOnce(generation);
      } while (this.again && generation === this.generation);
    } finally {
      this.running = false;
    }
  }

  private async statusOnce(generation: number): Promise<void> {
    const { run, location, realRoot, root } = this;
    if (run === null || location === null || realRoot === null) return;
    let output: string;
    try {
      output = await run(statusArguments(location.prefix), location.toplevel, STATUS_TIMEOUT_MS);
    } catch (error) {
      if (generation !== this.generation) return;
      const reason = error instanceof GitRunError ? error.reason : 'failed';
      this.options.log?.('git_status_unavailable', { reason });
      // Slow once is slow every time on this repository: stop, rather than
      // spend the reader's machine on marks it cannot afford. A plain failure
      // may be a moment mid-rebase, so the watch stays and the marks clear.
      if (reason !== 'failed') this.close();
      this.emit({ ...EMPTY, root });
      return;
    }
    if (generation !== this.generation) return;
    const scoped = scopeToVault(parsePorcelainV2(output), location.prefix, this.options.keep);
    if (scoped.length > MAX_MARKED) {
      this.options.log?.('git_status_unavailable', { reason: 'too-many' });
      this.close();
      this.emit({ ...EMPTY, root });
      return;
    }
    const marks = marksFrom(scoped);
    const absolute = (relative: string) => path.join(realRoot, ...relative.split('/'));
    this.emit({
      version: 1,
      root,
      files: [...marks.files].map(([relative, change]) => [absolute(relative), change] as const),
      folders: [...marks.folders].map(absolute),
    });
  }

  private emit(event: GitMarksEventV1): void {
    const before = this.latest;
    this.latest = event;
    // A status that found what the last one found is not news.
    if (before.root === event.root && sameMarks(before, event)) return;
    this.options.publish(event);
  }
}

function sameMarks(left: GitMarksEventV1, right: GitMarksEventV1): boolean {
  if (left.files.length !== right.files.length || left.folders.length !== right.folders.length) return false;
  const files = new Map(left.files.map(([file, change]) => [file, change]));
  if (right.files.some(([file, change]) => files.get(file) !== change)) return false;
  const folders = new Set(left.folders);
  return right.folders.every((folder) => folders.has(folder));
}

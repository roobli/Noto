/**
 * Git changes in the tree: what `git status` output becomes.
 *
 * The parsing and scoping are pure and pinned here record by record. The
 * runner is then driven against real temporary repositories with the system
 * git, because the decision this implements is about how git behaves (a
 * subfolder vault, a linked worktree, a status that must not take the index
 * lock) and a stub would only test the stub.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  changeFromXY, marksFrom, parsePorcelainV2, scopeToVault, vaultPathspec,
} from '../../src/main/workspace/git-status';
import {
  findGit, GitMarks, GitRunError, locate, statusArguments, systemGit, type GitMarksEventV1,
} from '../../src/main/workspace/git-marks';

const HASH = '0123456789abcdef0123456789abcdef01234567';
const ordinary = (xy: string, file: string) => `1 ${xy} N... 100644 100644 100644 ${HASH} ${HASH} ${file}`;

describe('changeFromXY', () => {
  it('reads three states from the index and work tree columns', () => {
    expect(changeFromXY('.M')).toBe('modified');
    expect(changeFromXY('M.')).toBe('modified');
    expect(changeFromXY('MM')).toBe('modified');
    expect(changeFromXY('T.')).toBe('modified');
    expect(changeFromXY('A.')).toBe('new');
    expect(changeFromXY('AM')).toBe('new');
    expect(changeFromXY('.D')).toBe('deleted');
    expect(changeFromXY('D.')).toBe('deleted');
    expect(changeFromXY('MD')).toBe('deleted');
  });

  it('marks nothing for a note added and removed before any commit', () => {
    expect(changeFromXY('AD')).toBeNull();
    expect(changeFromXY('..')).toBeNull();
  });
});

describe('parsePorcelainV2', () => {
  it('reads ordinary, untracked, renamed and unmerged records', () => {
    const output = [
      ordinary('.M', 'notes/a.md'),
      ordinary('.D', 'notes/c.md'),
      `2 R. N... 100644 100644 100644 ${HASH} ${HASH} R100 notes/sub/b2.md`, 'notes/sub/b.md',
      `u UU N... 100644 100644 100644 100644 ${HASH} ${HASH} ${HASH} notes/conflict.md`,
      '? notes/new.md',
      '! notes/ignored.md',
      '',
    ].join('\0');
    expect(parsePorcelainV2(output)).toEqual([
      { path: 'notes/a.md', change: 'modified' },
      { path: 'notes/c.md', change: 'deleted' },
      { path: 'notes/sub/b2.md', change: 'new' },
      { path: 'notes/sub/b.md', change: 'deleted' },
      { path: 'notes/conflict.md', change: 'modified' },
      { path: 'notes/new.md', change: 'new' },
    ]);
  });

  it('keeps spaces, brackets and non-ASCII in paths, unquoted under -z', () => {
    const output = [ordinary('.M', 'my notes/[draft] 日记.md'), '? a b/c d.md', ''].join('\0');
    expect(parsePorcelainV2(output).map((entry) => entry.path)).toEqual(['my notes/[draft] 日记.md', 'a b/c d.md']);
  });

  it('does not read a rename\'s original path as a record of its own', () => {
    // An original path that happens to look like an untracked record.
    const output = [`2 R. N... 100644 100644 100644 ${HASH} ${HASH} R90 new.md`, '? old.md', ''].join('\0');
    expect(parsePorcelainV2(output)).toEqual([
      { path: 'new.md', change: 'new' },
      { path: '? old.md', change: 'deleted' },
    ]);
  });

  it('leaves the original of a copy alone', () => {
    const output = [`2 C. N... 100644 100644 100644 ${HASH} ${HASH} C100 copy.md`, 'source.md', ''].join('\0');
    expect(parsePorcelainV2(output)).toEqual([{ path: 'copy.md', change: 'new' }]);
  });

  it('skips headers, empty output and records it does not understand', () => {
    expect(parsePorcelainV2('')).toEqual([]);
    expect(parsePorcelainV2('# branch.oid abc\0x what\0' + '1 .M short\0')).toEqual([]);
  });
});

describe('vault scoping', () => {
  it('builds a literal top-relative pathspec from the prefix', () => {
    expect(vaultPathspec('')).toBe(':(top)');
    expect(vaultPathspec('notes/')).toBe(':(top,literal)notes');
    expect(vaultPathspec('a/[draft]*/')).toBe(':(top,literal)a/[draft]*');
  });

  it('keeps entries under the prefix, relative to it, that pass the filter', () => {
    const entries = parsePorcelainV2([
      ordinary('.M', 'notes/a.md'),
      ordinary('.M', 'notes/code.ts'),
      ordinary('.M', 'notes-other/b.md'),
      ordinary('.M', 'top.md'),
      '? notes/sub/c.md',
      '',
    ].join('\0'));
    const markdown = (file: string) => file.endsWith('.md');
    expect(scopeToVault(entries, 'notes/', markdown)).toEqual([
      { path: 'a.md', change: 'modified' },
      { path: 'sub/c.md', change: 'new' },
    ]);
    expect(scopeToVault(entries, '', markdown).map((entry) => entry.path))
      .toEqual(['notes/a.md', 'notes-other/b.md', 'top.md', 'notes/sub/c.md']);
  });

  it('marks every folder above a change, and not the vault itself', () => {
    const marks = marksFrom([
      { path: 'a/b/c.md', change: 'modified' },
      { path: 'a/gone.md', change: 'deleted' },
      { path: 'top.md', change: 'new' },
    ]);
    expect([...marks.files]).toEqual([['a/b/c.md', 'modified'], ['a/gone.md', 'deleted'], ['top.md', 'new']]);
    expect([...marks.folders].sort()).toEqual(['a', 'a/b']);
  });

  it('prefers the state on disk when a path is reported twice', () => {
    const marks = marksFrom([{ path: 'x.md', change: 'deleted' }, { path: 'x.md', change: 'new' }]);
    expect(marks.files.get('x.md')).toBe('new');
  });
});

describe('the status command', () => {
  it('never takes the optional lock, never runs fsmonitor, and is scoped', () => {
    const args = statusArguments('notes/');
    expect(args.slice(0, 3)).toEqual(['--no-optional-locks', '-c', 'core.fsmonitor=false']);
    expect(args).toContain('--porcelain=v2');
    expect(args).toContain('-z');
    expect(args.slice(-2)).toEqual(['--', ':(top,literal)notes']);
    // Read-only by construction: the only subcommand is status.
    for (const verb of ['add', 'commit', 'stash', 'checkout', 'reset', 'fetch', 'push', 'blame', 'branch']) {
      expect(args).not.toContain(verb);
    }
  });
});

describe('findGit', () => {
  it('uses the name off macOS', async () => {
    expect(await findGit('linux', async () => false, async () => false)).toBe('git');
    expect(await findGit('win32', async () => false, async () => false)).toBe('git');
  });

  it('prefers an installed git on macOS and never touches the stub without the tools', async () => {
    expect(await findGit('darwin', async (file) => file === '/usr/local/bin/git', async () => true))
      .toBe('/usr/local/bin/git');
    expect(await findGit('darwin', async () => false, async () => true)).toBe('/usr/bin/git');
    expect(await findGit('darwin', async () => false, async () => false)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Against real repositories.

const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=noto@example.invalid', '-c', 'user.name=Noto', '-c', 'commit.gpgsign=false', ...args], {
    cwd, stdio: 'ignore', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A repository with a vault in `notes/`, committed, then changed every way. */
function changedRepository(): { repo: string; vault: string } {
  const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'noto-git-')));
  temporary.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  write(path.join(repo, 'notes', 'kept.md'), 'kept\n');
  write(path.join(repo, 'notes', 'edited.md'), 'before\n');
  write(path.join(repo, 'notes', 'deep', 'gone.md'), 'gone\n');
  write(path.join(repo, 'outside.md'), 'outside\n');
  write(path.join(repo, '.gitignore'), 'notes/ignored.md\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'first');
  write(path.join(repo, 'notes', 'edited.md'), 'after\n');
  rmSync(path.join(repo, 'notes', 'deep', 'gone.md'));
  write(path.join(repo, 'notes', 'fresh', 'new.md'), 'new\n');
  write(path.join(repo, 'notes', 'ignored.md'), 'ignored\n');
  write(path.join(repo, 'notes', 'picture.png'), 'not a note\n');
  write(path.join(repo, 'outside.md'), 'changed outside the vault\n');
  return { repo, vault: path.join(repo, 'notes') };
}

/** Open a folder and collect what is published, with fs watching off. */
async function marksFor(folder: string, runner?: () => Promise<ReturnType<typeof systemGit> | null>) {
  const published: GitMarksEventV1[] = [];
  const marks = new GitMarks({
    publish: (event) => published.push(event),
    keep: (file) => file.endsWith('.md'),
    runner: runner ?? (async () => systemGit('git')),
    watchDirectory: () => null,
    debounceMs: 0,
  });
  await marks.open(folder);
  return { marks, published };
}

describe.skipIf(!hasGit)('GitMarks against a real repository', () => {
  it('marks modified, new and deleted notes in a subfolder vault, and nothing outside it', async () => {
    const { vault } = changedRepository();
    const { marks } = await marksFor(vault);
    const current = marks.current();
    expect(current.root).toBe(vault);
    expect(Object.fromEntries(current.files)).toEqual({
      [path.join(vault, 'edited.md')]: 'modified',
      [path.join(vault, 'fresh', 'new.md')]: 'new',
      [path.join(vault, 'deep', 'gone.md')]: 'deleted',
    });
    expect([...current.folders].sort()).toEqual([path.join(vault, 'deep'), path.join(vault, 'fresh')].sort());
    marks.close();
  });

  it('marks the whole repository when the vault is its top level', async () => {
    const { repo } = changedRepository();
    const { marks } = await marksFor(repo);
    expect(marks.current().files.map(([file]) => path.relative(repo, file)).sort())
      .toEqual([path.join('notes', 'deep', 'gone.md'), path.join('notes', 'edited.md'), path.join('notes', 'fresh', 'new.md'), 'outside.md'].sort());
    marks.close();
  });

  it('does not take the index lock or rewrite the index', async () => {
    const { repo, vault } = changedRepository();
    const index = path.join(repo, '.git', 'index');
    const before = execFileSync('git', ['ls-files', '--debug'], { cwd: repo, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).toString();
    const { statSync } = await import('node:fs');
    const mtime = statSync(index).mtimeMs;
    const { marks } = await marksFor(vault);
    expect(existsSync(`${index}.lock`)).toBe(false);
    expect(statSync(index).mtimeMs).toBe(mtime);
    expect(execFileSync('git', ['ls-files', '--debug'], { cwd: repo, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).toString()).toBe(before);
    marks.close();
  });

  it('follows a refresh after the reader commits', async () => {
    const { repo, vault } = changedRepository();
    const { marks, published } = await marksFor(vault);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'second');
    marks.refresh();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise<void>((resolve) => {
      const wait = () => (marks.current().files.length === 0 ? resolve() : setTimeout(wait, 20));
      wait();
    });
    expect(published.at(-1)?.files).toEqual([]);
    marks.close();
  });

  it('reads a linked worktree, whose git directory is not the common one', async () => {
    const { repo } = changedRepository();
    git(repo, 'stash', '-u', '-q');
    const tree = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'noto-git-wt-')));
    temporary.push(tree);
    rmSync(tree, { recursive: true, force: true });
    git(repo, 'worktree', 'add', '-q', tree);
    write(path.join(tree, 'notes', 'kept.md'), 'changed in the worktree\n');
    const location = await locate(systemGit('git'), path.join(tree, 'notes'));
    expect(location?.prefix).toBe('notes/');
    // Compared through the native realpath, which is what makes a Windows
    // short name and git's forward slashes the same path.
    const real = (file: string) => realpathSync.native(path.resolve(file));
    expect(real(location!.commonDir)).toBe(real(path.join(repo, '.git')));
    expect(real(location!.gitDir)).not.toBe(real(location!.commonDir));
    const { marks } = await marksFor(path.join(tree, 'notes'));
    expect(marks.current().files).toEqual([[path.join(tree, 'notes', 'kept.md'), 'modified']]);
    marks.close();
  });

  it('is absent, with nothing published, outside any repository', async () => {
    const folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'noto-plain-')));
    temporary.push(folder);
    write(path.join(folder, 'a.md'), 'a\n');
    // A ceiling, so a temp directory that happens to sit inside a repository
    // on some machine is still outside one here.
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(folder);
    try {
      const { marks, published } = await marksFor(folder);
      expect(published).toEqual([]);
      expect(marks.current().files).toEqual([]);
      marks.close();
    } finally {
      delete process.env.GIT_CEILING_DIRECTORIES;
    }
  });

  it('is absent when git is missing', async () => {
    const { vault } = changedRepository();
    const missing = systemGit(path.join(os.tmpdir(), 'no-such-git-binary'));
    await expect(missing(['--version'], vault, 1000)).rejects.toEqual(new GitRunError('missing'));
    const absent = await marksFor(vault, async () => missing);
    expect(absent.published).toEqual([]);
    const none = await marksFor(vault, async () => null);
    expect(none.published).toEqual([]);
  });

  it('degrades to no marks and stops when status is too slow', async () => {
    const { vault } = changedRepository();
    const real = systemGit('git');
    let statuses = 0;
    const slow: ReturnType<typeof systemGit> = async (args, cwd, timeout) => {
      if (args.includes('status')) { statuses += 1; throw new GitRunError('slow'); }
      return real(args, cwd, timeout);
    };
    const { marks, published } = await marksFor(vault, async () => slow);
    expect(published).toEqual([]);
    marks.refresh();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(statuses).toBe(1);
  });
});

/**
 * A note's history from git: the walk that follows renames, the commits it
 * dims (a script's work between tool markers, a sweep across the folder),
 * what is on disk since the last commit, and a version read only from the
 * note's own history.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  NoteHistoryReader,
  onlyToolRegionsChanged,
  parseFollowLog,
  SWEEP_FILES,
  systemBatchGit,
  unquotePath,
} from '../../src/main/workspace/git-history';
import { systemGit } from '../../src/main/workspace/git-marks';

const made: string[] = [];
afterAll(() => { for (const directory of made) rmSync(directory, { recursive: true, force: true }); });

function repository(): { root: string; git: (...args: string[]) => void; write: (rel: string, text: string) => void } {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'noto-history-')));
  made.push(root);
  const git = (...args: string[]) => {
    execFileSync('git', ['-c', 'user.email=noto@example.invalid', '-c', 'user.name=Noto', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'ignore' });
  };
  const write = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  git('init', '-q');
  return { root, git, write };
}

const reader = () => new NoteHistoryReader(async () => systemGit('git'), async () => systemBatchGit('git'));

describe('reading the walk', () => {
  it('reads a commit, a rename with its old path and a merge with none', () => {
    const hash = (digit: string) => digit.repeat(40);
    const output = [
      `\x1e${hash('a')}\x1f${hash('b')}\x1fNoto\x1f1793709378\x1fmove it`,
      '',
      `:100644 100644 ${'1'.repeat(40)} ${'2'.repeat(40)} R076\tOld/name.md\tNew/name.md`,
      '3\t1\tOld/name.md => New/name.md',
      `\x1e${hash('c')}\x1f${hash('d')} ${hash('e')}\x1fNoto\x1f1793700000\x1fMerge`,
      `\x1e${hash('f')}\x1f\x1fNoto\x1f1793600000\x1ffirst: with a colon`,
      '',
      `:000000 100644 ${'0'.repeat(40)} ${'3'.repeat(40)} A\tOld/name.md`,
      '12\t0\tOld/name.md',
      '',
    ].join('\n');
    const commits = parseFollowLog(output);
    expect(commits.map((commit) => [commit.change, commit.path, commit.from, commit.added, commit.removed])).toEqual([
      ['renamed', 'New/name.md', 'Old/name.md', 3, 1],
      ['merge', 'Old/name.md', null, null, null],
      ['added', 'Old/name.md', null, 12, 0],
    ]);
    expect(commits[0]!.time).toBe(1793709378_000);
    expect(commits[2]!.before).toBeNull();
    expect(commits[2]!.subject).toBe('first: with a colon');
  });

  it('reads a quoted path back to its name', () => {
    expect(unquotePath('"tab\\there.md"')).toBe('tab\there.md');
    expect(unquotePath('"\\346\\226\\207.md"')).toBe('文.md');
    expect(unquotePath('plain/中文.md')).toBe('plain/中文.md');
  });

  it('calls a change only between tool markers a script\'s work', () => {
    const note = (index: string, body: string) => `# Note\n\n${body}\n\n<!-- note-assistant:index:start -->\n${index}\n<!-- note-assistant:index:end -->\n`;
    expect(onlyToolRegionsChanged(note('- a', 'Text.'), note('- a\n- b', 'Text.'))).toBe(true);
    expect(onlyToolRegionsChanged(note('- a', 'Text.'), note('- a\n- b', 'Text, changed.'))).toBe(false);
    expect(onlyToolRegionsChanged(note('- a', 'Text.'), note('- a', 'Text.'))).toBe(false);
    // A marker with no matching end is not a region.
    expect(onlyToolRegionsChanged('<!-- x:start -->\na', '<!-- x:start -->\nb')).toBe(false);
  });
});

describe('a note\'s history', () => {
  it('follows a rename, dims a script\'s commit and a sweep, and counts what is not committed', async () => {
    const { root, git, write } = repository();
    write('Drafts/plan.md', '# Plan\n\nFirst.\n\n<!-- note-assistant:index:start -->\n- one\n<!-- note-assistant:index:end -->\n');
    git('add', '-A'); git('commit', '-q', '-m', 'start the plan');
    write('Drafts/plan.md', '# Plan\n\nFirst.\n\n<!-- note-assistant:index:start -->\n- one\n- two\n<!-- note-assistant:index:end -->\n');
    git('add', '-A'); git('commit', '-q', '-m', 'refresh indexes');
    mkdirSync(path.join(root, 'Areas'));
    git('mv', 'Drafts/plan.md', 'Areas/plan.md');
    git('commit', '-q', '-m', 'file the plan');
    write('Areas/plan.md', '# Plan\n\nFirst, and more.\n\n<!-- note-assistant:index:start -->\n- one\n- two\n<!-- note-assistant:index:end -->\n');
    for (let index = 0; index <= SWEEP_FILES; index += 1) write(`many/${index}.md`, `${index}\n`);
    git('add', '-A'); git('commit', '-q', '-m', 'say more, and add a hundred notes');
    write('Areas/plan.md', '# Plan\n\nFirst, and more.\n\nUnsaved line.\n\n<!-- note-assistant:index:start -->\n- one\n- two\n<!-- note-assistant:index:end -->\n');

    const history = await reader().history(path.join(root, 'Areas/plan.md'));
    expect(history.state).toBe('ok');
    expect(history.commits.map((commit) => [commit.subject, commit.change, commit.path, commit.from, commit.tooling, commit.sweeping])).toEqual([
      ['say more, and add a hundred notes', 'modified', 'Areas/plan.md', null, false, true],
      ['file the plan', 'renamed', 'Areas/plan.md', 'Drafts/plan.md', false, false],
      ['refresh indexes', 'modified', 'Drafts/plan.md', null, true, false],
      ['start the plan', 'added', 'Drafts/plan.md', null, false, false],
    ]);
    expect(history.uncommitted).toEqual({ added: 2, removed: 0 });
    expect(history.file?.bytes).toBeGreaterThan(0);
  });

  it('reads a version only by a commit and path from the note\'s own history', async () => {
    const { root, git, write } = repository();
    write('a.md', 'one\n');
    write('secret.md', 'not for this note\n');
    git('add', '-A'); git('commit', '-q', '-m', 'first');
    write('a.md', 'two\n');
    git('add', '-A'); git('commit', '-q', '-m', 'second');
    const notes = reader();
    const history = await notes.history(path.join(root, 'a.md'));
    const [second, first] = history.commits;
    expect(await notes.version(path.join(root, 'a.md'), first!.hash, 'a.md')).toBe('one\n');
    expect(await notes.version(path.join(root, 'a.md'), second!.hash, 'a.md')).toBe('two\n');
    // The commit is the note's, the path is not.
    expect(await notes.version(path.join(root, 'a.md'), first!.hash, 'secret.md')).toBeNull();
    expect(await notes.version(path.join(root, 'a.md'), 'f'.repeat(40), 'a.md')).toBeNull();
  });

  it('says a new note is not committed, and a folder outside git has no history', async () => {
    const { root, git, write } = repository();
    write('kept.md', 'kept\n');
    git('add', '-A'); git('commit', '-q', '-m', 'first');
    write('new.md', 'one\ntwo\nthree');
    const notes = reader();
    const fresh = await notes.history(path.join(root, 'new.md'));
    expect(fresh.state).toBe('untracked');
    expect(fresh.uncommitted).toEqual({ added: 3, removed: 0 });

    const plain = realpathSync(mkdtempSync(path.join(tmpdir(), 'noto-history-plain-')));
    made.push(plain);
    writeFileSync(path.join(plain, 'note.md'), 'x\n');
    const outside = await notes.history(path.join(plain, 'note.md'));
    expect(outside.state).toBe('not-git');
    expect(outside.file?.bytes).toBe(2);
  });

  it('reads a note named like a pattern as its own name, not its neighbours', async () => {
    const { root, git, write } = repository();
    write('x.md', 'plain\n');
    git('add', '-A'); git('commit', '-q', '-m', 'the plain one');
    write('[x].md', 'bracketed\n');
    git('add', '-A'); git('commit', '-q', '-m', 'the bracketed one');
    const history = await reader().history(path.join(root, '[x].md'));
    expect(history.commits.map((commit) => commit.subject)).toEqual(['the bracketed one']);
  });

  it('keeps a history until HEAD moves', async () => {
    const { root, git, write } = repository();
    write('a.md', 'one\n');
    git('add', '-A'); git('commit', '-q', '-m', 'first');
    const notes = reader();
    const before = await notes.history(path.join(root, 'a.md'));
    expect(await notes.history(path.join(root, 'a.md'))).toEqual(before);
    write('a.md', 'two\n');
    git('add', '-A'); git('commit', '-q', '-m', 'second');
    expect((await notes.history(path.join(root, 'a.md'))).commits.map((commit) => commit.subject)).toEqual(['second', 'first']);
  });
});

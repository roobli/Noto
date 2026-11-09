/**
 * Links following a move on disk: the notes that named the old place are
 * written again, found through the index when there is one and by reading
 * the folder when not; unsaved notes and notes changed meanwhile are left;
 * Undo puts back only what nothing has changed since; and the trash sheet
 * counts what would lead nowhere.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyRelink, linksInto, planRelink, undoRelink } from '../../src/main/workspace/relink-moves';
import { followedWords, undoneWords } from '../../src/renderer/relink-words';

let root = '';
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

function folder(files: Record<string, string>): string {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'noto-relink-')));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
  return root;
}
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');
const move = (from: string, to: string) => {
  mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
  renameSync(path.join(root, from), path.join(root, to));
  return { from: path.join(root, from), to: path.join(root, to) };
};

describe('following a move', () => {
  it('writes the links that named the old place, and takes them back', async () => {
    folder({
      'Ideas/plan.md': '# Plan\n\nSee [n](notes.md).\n',
      'Ideas/notes.md': '# Notes\n',
      'essay.md': 'By path [[Ideas/plan]], relative [p](Ideas/plan.md), by name [[plan]].\n',
      'unrelated.md': 'Nothing here.\n',
    });
    const moved = move('Ideas/plan.md', 'Work/plan.md');
    const plan = await planRelink(root, [moved], new Set());
    expect(plan.notes.map((note) => note.path).sort()).toEqual(['Work/plan.md', 'essay.md']);
    const outcome = await applyRelink(root, plan);
    expect(read('essay.md')).toBe('By path [[Work/plan]], relative [p](Work/plan.md), by name [[plan]].\n');
    expect(read('Work/plan.md')).toBe('# Plan\n\nSee [n](../Ideas/notes.md).\n');
    expect(outcome.written.reduce((sum, note) => sum + note.links, 0)).toBe(3);

    // Undo puts back what nothing has changed since, and keeps what something has.
    writeFileSync(path.join(root, 'essay.md'), `${read('essay.md')}Edited after.\n`);
    expect(await undoRelink(root, outcome.written)).toEqual({ restored: 1, kept: 1 });
    expect(read('Work/plan.md')).toBe('# Plan\n\nSee [n](notes.md).\n');
    expect(read('essay.md')).toContain('[[Work/plan]]');
  });

  it('asks the index for the notes to read, by the words the move names, and reads only those', async () => {
    folder({ 'Ideas/plan.md': '# Plan\n', 'essay.md': '[p](Ideas/plan.md)\n', 'other.md': '[p](Ideas/plan.md)\n' });
    const moved = move('Ideas/plan.md', 'Work/plan.md');
    const sources = vi.fn(async (words: readonly string[]) => (words.includes('plan') ? ['essay.md'] : []));
    const plan = await planRelink(root, [moved], new Set(), sources);
    // other.md links there too; the index did not name it, so it is not read.
    expect(plan.notes.map((note) => note.path)).toEqual(['essay.md']);
    expect(sources).toHaveBeenCalledWith(expect.arrayContaining(['plan']));
  });

  it('follows a folder, leaves an unsaved note and one changed meanwhile alone', async () => {
    folder({ 'Ideas/plan.md': '# Plan\n', 'essay.md': '[p](Ideas/plan.md)\n', 'open.md': '[p](Ideas/plan.md)\n' });
    const moved = move('Ideas', 'Archive/Ideas');
    const plan = await planRelink(root, [moved], new Set([path.join(root, 'open.md')]));
    expect(plan.busy).toEqual(['open.md']);
    expect(plan.notes.map((note) => note.path)).toEqual(['essay.md']);
    writeFileSync(path.join(root, 'essay.md'), '[p](Ideas/plan.md) and more\n');
    const outcome = await applyRelink(root, plan);
    expect(outcome).toMatchObject({ written: [], changed: ['essay.md'] });
    expect(read('essay.md')).toBe('[p](Ideas/plan.md) and more\n');
  });

  it('never writes a note it cannot read exactly, such as one in another encoding', async () => {
    folder({ 'Ideas/plan.md': '# Plan\n', 'essay.md': 'ok' });
    // GBK bytes for a Chinese word, then a link: decoding as UTF-8 would replace them.
    writeFileSync(path.join(root, 'old.md'), Buffer.concat([Buffer.from([0xc4, 0xe3, 0xba, 0xc3]), Buffer.from(' [p](Ideas/plan.md)\n')]));
    const before = readFileSync(path.join(root, 'old.md'));
    const moved = move('Ideas/plan.md', 'Work/plan.md');
    const plan = await planRelink(root, [moved], new Set());
    expect(plan.notes.map((note) => note.path)).not.toContain('old.md');
    await applyRelink(root, plan);
    expect(readFileSync(path.join(root, 'old.md')).equals(before)).toBe(true);
  });

  it('finds a link written in another case, and a file moved on its own out of a folder that moved', async () => {
    folder({ 'Ideas/Plan.md': '# Plan\n', 'Ideas/b.md': '# B\n', 'essay.md': '[[plan]] and [x](Ideas/b.md)\n' });
    move('Ideas', 'Archive');
    move('Archive/b.md', 'Archive/c.md');
    // As the session gathers them: the second move named from where b was before its folder went.
    const plan = await planRelink(root, [
      { from: path.join(root, 'Ideas'), to: path.join(root, 'Archive') },
      { from: path.join(root, 'Ideas/b.md'), to: path.join(root, 'Archive/c.md') },
    ], new Set());
    await applyRelink(root, plan);
    expect(read('essay.md')).toBe('[[plan]] and [x](Archive/c.md)\n');
  });

  it('counts the notes and links a trash would leave leading nowhere', async () => {
    folder({
      'Ideas/plan.md': '# Plan\n', 'Ideas/notes.md': '[p](plan.md)\n',
      'essay.md': '[[plan]] and [p](Ideas/plan.md)\n', 'other.md': '[n](Ideas/notes.md)\n',
    });
    expect(await linksInto(root, path.join(root, 'Ideas/plan.md'))).toEqual({ notes: 2, links: 3 });
    // A folder: what is inside it does not count, what is outside does.
    expect(await linksInto(root, path.join(root, 'Ideas'))).toEqual({ notes: 2, links: 3 });
  });
});

describe('what the status line says', () => {
  it('counts what was written and what was left, and what Undo did', () => {
    expect(followedWords({ notes: 4, links: 7, held: 0, left: 0 })).toBe('Updated 7 links in 4 notes');
    expect(followedWords({ notes: 1, links: 1, held: 1, left: 0 })).toBe('Updated 1 link in 1 note; 1 note with unsaved edits left as it is');
    expect(followedWords({ notes: 0, links: 0, held: 2, left: 0 })).toBe('2 notes with unsaved edits still link to the old place');
    expect(followedWords({ notes: 2, links: 2, held: 0, left: 1 })).toBe('Updated 2 links in 2 notes; 1 note changed meanwhile, left as it is');
    expect(undoneWords({ restored: 4, kept: 0 })).toBe('Put back the links in 4 notes');
    expect(undoneWords({ restored: 1, kept: 1 })).toBe('Put back the links in 1 note; 1 note changed since, kept');
    expect(undoneWords({ restored: 0, kept: 2 })).toBe('Nothing put back: those notes changed since');
  });
});

describe('which listings a change on disk touches', () => {
  it('names each changed path and its folder, as the window spells them, and gives up past five hundred', async () => {
    const { changedListings } = await import('../../src/main/workspace/session');
    expect(changedListings('/v', ['Ideas/plan.md', 'top.md'])!.sort()).toEqual(['/v', '/v/Ideas', '/v/Ideas/plan.md', '/v/top.md']);
    // Hidden paths change nothing shown.
    expect(changedListings('/v', ['.git/index', 'Ideas/.plan.md.tmp'])).toEqual([]);
    expect(changedListings('/v', Array.from({ length: 600 }, (_, index) => `f${index}/n.md`))).toBeNull();
  });
});

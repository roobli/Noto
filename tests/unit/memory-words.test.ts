/**
 * The words the memory tabs use: when something happened, and how warm a
 * note is, said as what the heat is made of rather than as its number.
 */

import { describe, expect, it } from 'vitest';
import { ago, agentName, folderSummary, heatWords, readWhy, warmthShare } from '../../src/renderer/plugins/bundled/memory/model';
import { moreFiles } from '../../src/renderer/plugins/bundled/history/FolderCommits';
import { MEMORY } from './memory-fixture';

const NOW = new Date(2026, 10, 5, 15, 0).getTime();
const at = (year: number, month: number, day: number, hour = 9) => new Date(year, month - 1, day, hour).toISOString();

describe('when', () => {
  it('says today, yesterday, a few days ago, then the date, with the year only when it is another', () => {
    expect(ago(at(2026, 11, 5, 1), NOW)).toBe('today');
    expect(ago(at(2026, 11, 4, 23), NOW)).toBe('yesterday');
    expect(ago(at(2026, 11, 1), NOW)).toBe('4 days ago');
    expect(ago(at(2026, 10, 12), NOW)).toBe('on Oct 12');
    expect(ago(at(2025, 10, 12), NOW)).toBe('on Oct 12, 2025');
  });
});

describe('how warm a note is', () => {
  it('names the reads and the writes and when, never the bare score', () => {
    const words = heatWords({ ...MEMORY, heat: { heat: 9.08, reads: 6, writes: 2, lastRead: at(2026, 11, 5), lastWrite: at(2026, 11, 3) } }, NOW);
    expect(words).toBe('Read 6 times, last today; written twice, last 2 days ago.');
    expect(words).not.toContain('9.08');
    expect(heatWords({ ...MEMORY, heat: { heat: 0.4, reads: 0, writes: 1, lastRead: null, lastWrite: at(2026, 11, 4) } }, NOW))
      .toBe('Written once, last yesterday.');
    expect(heatWords({ ...MEMORY, heat: { heat: 0, reads: 0, writes: 0, lastRead: null, lastWrite: null } }, NOW))
      .toBe('Not read or written since the folder began keeping memory.');
  });

  it('calls the policy for an agent with no key what it is', () => {
    expect(agentName('default')).toBe('Without a key');
    expect(agentName('claude-code')).toBe('claude-code');
  });
});

describe('a folder in words', () => {
  const now = new Date('2026-11-05T12:00:00Z').getTime();
  it('says what it holds, and broken links only when there are some', () => {
    expect(folderSummary({ notes: 42, broken: 0 })).toBe('42 notes');
    expect(folderSummary({ notes: 1, broken: 1 })).toBe('1 note · 1 broken link');
    expect(folderSummary({ notes: 1200, broken: 3 })).toBe('1,200 notes · 3 broken links');
    expect(folderSummary({ notes: 0, broken: 0 })).toBe('The memory holds no note here yet.');
  });
  it('says how often a note was read and when last', () => {
    expect(readWhy({ reads: 12, lastRead: '2026-11-04T09:00:00Z' }, now)).toBe('read 12 times, last yesterday');
    expect(readWhy({ reads: 1, lastRead: null }, now)).toBe('read once');
  });
  it('draws each bar against the warmest, never quite empty', () => {
    expect(warmthShare(4, 4)).toBe(1);
    expect(warmthShare(1, 4)).toBe(0.25);
    expect(warmthShare(0.001, 4)).toBe(0.04);
    expect(warmthShare(0, 4)).toBe(0);
    expect(warmthShare(1, 0)).toBe(0);
  });
  it('counts what a commit changed beyond the notes it names', () => {
    expect(moreFiles(2, 2)).toBe('');
    expect(moreFiles(1, 4)).toBe('and 3 more files');
    expect(moreFiles(1, 2)).toBe('and 1 more file');
    expect(moreFiles(0, 2)).toBe('2 files');
  });
});

describe('why a note is offered, in plain words', () => {
  it('says the vault\'s reasons in the words of where they are shown, the telling ones first, two at most', async () => {
    const { plainWhy, heatLevel } = await import('../../src/renderer/plugins/bundled/memory/model');
    expect(plainWhy(['matches the cue', 'often opened with "记忆界面与笔记档案：设计与进度"'], 'title'))
      .toBe('read with "记忆界面与笔记档案：设计与进度" · shares words with this title');
    // A title too long for the line is cut inside its quotes.
    expect(plainWhy(['often opened with "Noto 项目交接文档（供新同事全量审阅代码）"'], 'title')).toBe('read with "Noto 项目交接文档（供新同事全…"');
    expect(plainWhy(['the title answers the cue'], 'title')).toBe('a title like this one');
    expect(plainWhy(['the title answers the cue', 'matches every word of the cue'], 'question')).toBe('its title answers it · has every word you asked');
    expect(plainWhy(['matches the cue', 'linked from "Noto 索引"', 'often changed with "Noto 系列修复记录"'], 'title'))
      .toBe('linked from "Noto 索引" · changed with "Noto 系列修复记录"');
    expect([heatLevel(undefined), heatLevel(0), heatLevel(0.1), heatLevel(0.5), heatLevel(2)]).toEqual([0, 0, 1, 2, 3]);
  });
});

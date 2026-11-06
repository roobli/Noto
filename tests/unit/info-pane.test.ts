/**
 * The info pane's slot and what its first tabs work out: who may add a tab,
 * a track or a folder's section, the order they come in, how long the pane waits on a switch of
 * note, how marks gather on the timeline, and the words History and
 * Properties use.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InfoRegistry, RailPageRegistry, ShellState, shellContext, type InfoTabHost } from '../../src/renderer/plugins/slots';
import { clampInfoWidth, columnsOf, gitStateOf, INFO_MIN } from '../../src/renderer/InfoPane';
import { commitDetail, commitsSummary, frontmatterFields, textCounts, when } from '../../src/renderer/plugins/bundled/history/model';
import type { NoteCommitV1 } from '../../src/shared/workspace/v1/contracts';

const manifest = (uiExtensions: string[], capabilities: string[] = []) => ({ id: 'example.plugin', capabilities, uiExtensions });
const tab = (id: string, order?: number) => ({ id, title: id, order, mount: () => ({ dispose() {} }) });

describe('the info slot', () => {
  it('takes only the tabs and tracks a manifest names, and orders them', () => {
    const registry = new InfoRegistry();
    const { context, dispose } = shellContext(manifest(['info:history', 'info:related', 'track:commits']), new ShellState(), new RailPageRegistry(), registry);
    context.registerInfoTab(tab('history', 20));
    context.registerInfoTab(tab('related', 10));
    expect(() => context.registerInfoTab(tab('undeclared'))).toThrow(/info:undeclared/);
    context.registerInfoTrack({ id: 'commits', title: 'Commits', tab: 'history', load: async () => null });
    expect(() => context.registerInfoTrack({ id: 'reads', title: 'Reads', load: async () => null })).toThrow(/track:reads/);
    expect(registry.tabs().map((entry) => entry.key)).toEqual(['example.plugin:related', 'example.plugin:history']);
    expect(registry.tracks()[0]!.tabKey).toBe('example.plugin:history');
    dispose();
    expect(registry.tabs()).toEqual([]);
    expect(registry.tracks()).toEqual([]);
  });

  it('takes only the folder sections a manifest names, and orders them', () => {
    const registry = new InfoRegistry();
    const { context, dispose } = shellContext(manifest(['folder:commits', 'folder:warmth']), new ShellState(), new RailPageRegistry(), registry);
    context.registerFolderSection({ id: 'commits', title: 'Recent commits', order: 20, mount: () => () => {} });
    context.registerFolderSection({ id: 'warmth', title: 'Warmest notes', order: 10, mount: () => () => {} });
    expect(() => context.registerFolderSection({ id: 'reach', title: 'Reach', mount: () => () => {} })).toThrow(/folder:reach/);
    expect(registry.sections().map((entry) => entry.key)).toEqual(['example.plugin:warmth', 'example.plugin:commits']);
    dispose();
    expect(registry.sections()).toEqual([]);
  });

  it('gives a tab the note\'s text and the right to replace it only by the manifest', () => {
    const state = new ShellState();
    const replace = vi.fn(() => true);
    state.setEditorAccess({ text: () => 'the note', replace });
    const hostFor = (capabilities: string[]) => {
      const registry = new InfoRegistry();
      const { context } = shellContext(manifest(['info:t'], capabilities), state, new RailPageRegistry(), registry);
      context.registerInfoTab(tab('t'));
      return registry.tabs()[0]!.host as InfoTabHost;
    };
    const bare = hostFor([]);
    expect(bare.noteText()).toBeNull();
    expect(bare.replaceNoteText('x')).toBe(false);
    expect(bare.git).toBeNull();
    const full = hostFor(['editor.read', 'editor.transform', 'git.read']);
    expect(full.noteText()).toBe('the note');
    expect(full.replaceNoteText('x')).toBe(true);
    expect(replace).toHaveBeenCalledWith('x');
    expect(full.git).not.toBeNull();
  });

  describe('following the note in front', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('follows the first note at once and a switch once it has paused', () => {
      const state = new ShellState();
      const heard = vi.fn();
      state.onSettledNote(heard);
      state.update({ active: '/v/a.md' });
      expect(state.settledNote()).toBe('/v/a.md');
      state.update({ active: '/v/b.md' });
      state.update({ active: '/v/c.md' });
      expect(state.settledNote()).toBe('/v/a.md');
      vi.advanceTimersByTime(ShellState.SETTLE_MS);
      expect(state.settledNote()).toBe('/v/c.md');
      expect(heard).toHaveBeenCalledTimes(2);
      state.update({ active: null });
      expect(state.settledNote()).toBeNull();
    });
  });
});

describe('the pane', () => {
  it('gathers marks closer than a column into one, newest first', () => {
    const day = 86_400_000;
    const marks = [0, 1, 50, 99].map((at, index) => ({ at: at * day, label: String(index), key: String(index) }));
    const columns = columnsOf(marks, 0, 100 * day, 10);
    expect(columns.map((column) => [column.index, column.marks.map((mark) => mark.key)])).toEqual([
      [0, ['1', '0']], [5, ['2']], [9, ['3']],
    ]);
  });

  it('says what git says about the note, through a link to the folder too', () => {
    const snapshot = { root: '/link', realRoot: '/real', repository: true as const, files: [['/real/a.md', 'modified'], ['/real/b.md', 'new']] as const };
    expect(gitStateOf(snapshot, '/link/a.md')).toBe('Uncommitted changes');
    expect(gitStateOf(snapshot, '/link/b.md')).toBe('Not committed yet');
    // No mark is committed only when the history has a commit; an ignored note has neither.
    expect(gitStateOf(snapshot, '/link/ignored.md', false)).toBe('Not committed yet');
    expect(gitStateOf(snapshot, '/link/ignored.md', true)).toBe('Committed');
    expect(gitStateOf(snapshot, '/link/ignored.md', null)).toBe('Committed');
    expect(gitStateOf(snapshot, '/link/c.md')).toBe('Committed');
    expect(gitStateOf({ root: null, files: [] }, '/x.md')).toBe('Not in git');
  });

  it('keeps its width between the floor and two fifths of the window', () => {
    expect(clampInfoWidth(100, 1400)).toBe(INFO_MIN);
    expect(clampInfoWidth(900, 1400)).toBe(560);
    expect(clampInfoWidth(900, 400)).toBe(INFO_MIN);
  });
});

describe('the words of History and Properties', () => {
  const now = new Date(2026, 10, 5, 12, 0).getTime();
  const commit = (over: Partial<NoteCommitV1>): NoteCommitV1 => ({
    hash: 'a'.repeat(40), time: new Date(2026, 10, 4, 23, 40).getTime(), author: 'lr00rl', subject: 's',
    change: 'modified', path: 'a.md', from: null, added: 40, removed: 6, tooling: false, sweeping: false, ...over,
  });

  it('says when as a list of commits does', () => {
    expect(when(new Date(2026, 10, 5, 10, 12).getTime(), now)).toBe('Today 10:12');
    expect(when(new Date(2026, 10, 4, 23, 40).getTime(), now)).toBe('Yesterday 23:40');
    expect(when(new Date(2026, 9, 1, 9, 5).getTime(), now)).toBe('Oct 1, 09:05');
    expect(when(new Date(2025, 9, 1).getTime(), now)).toBe('Oct 1, 2025');
  });

  it('says what a commit did, and which were a script\'s', () => {
    expect(commitDetail(commit({}), now)).toBe('Yesterday 23:40 · lr00rl · +40 -6');
    expect(commitDetail(commit({ change: 'added', added: 118, removed: 0 }), now)).toBe('Yesterday 23:40 · lr00rl · created, +118 -0');
    expect(commitDetail(commit({ tooling: true }), now)).toMatch(/index only$/);
    expect(commitDetail(commit({ sweeping: true }), now)).toMatch(/across the folder$/);
    expect(commitsSummary([commit({}), commit({})], false, now)).toBe('2 commits, last yesterday');
  });

  it('reads a note\'s frontmatter fields in the order written', () => {
    const text = '---\ntitle: "A plan"\ntags: [gfw, probe]\naliases:\n  - M22\n  - 拨测\nempty:\n# a comment\n---\n\n# Body\n';
    expect(frontmatterFields(text)).toEqual([
      { key: 'title', value: 'A plan' },
      { key: 'tags', value: 'gfw, probe' },
      { key: 'aliases', value: 'M22, 拨测' },
      { key: 'empty', value: '' },
    ]);
    expect(frontmatterFields('# No frontmatter\n')).toEqual([]);
  });

  it('counts words as a reader would, Chinese a character each, and leaves code and frontmatter out', () => {
    const text = [
      '---', 'title: not counted', '---', '',
      '# 看完 GFW 之后', '', 'Two words.', '',
      '```', 'not words at all', '```', '',
      '| a | b |', '| --- | --- |', '| 1 | 2 |', '',
      'See [[Other note]] and [the site](https://example.com) and [a note](other.md).',
    ].join('\n');
    const counts = textCounts(text);
    expect(counts.codeBlocks).toBe(1);
    expect(counts.tables).toBe(1);
    expect(counts.headings).toBe(1);
    expect(counts.noteLinks).toBe(2);
    expect(counts.webLinks).toBe(1);
    // 看完 之后 (4) + GFW + Two words. + a b 1 2 + See Other note and the site and a note (link targets are not words).
    expect(counts.words).toBe(4 + 1 + 2 + 4 + 9);
  });
});

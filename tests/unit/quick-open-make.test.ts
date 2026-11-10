import { describe, expect, it } from 'vitest';
import { noteFileName, quickActions, typedPath, type QuickActionInput } from '../../src/renderer/quick-open-make';

const base: QuickActionInput = {
  terms: '',
  mode: 'files',
  scope: '',
  notes: [{ relativePath: 'Ideas/plan.md' }, { relativePath: 'readme.md' }],
  folders: [{ relativePath: 'Ideas' }, { relativePath: 'Ideas/Old' }],
  canMake: true,
};
const kinds = (input: Partial<QuickActionInput>) => quickActions({ ...base, ...input }).map((action) => action.kind);

describe('what Quick Open offers to make', () => {
  it('offers a note and a folder for a name nothing has, in the folder searched', () => {
    expect(quickActions({ ...base, terms: 'budget' })).toEqual([
      { kind: 'new-note', name: 'budget', file: 'budget.md' },
      { kind: 'new-folder', name: 'budget' },
    ]);
    expect(kinds({ terms: '2026 计划', scope: 'Ideas' })).toEqual(['new-note', 'new-folder']);
  });

  it('does not offer what is already there, whatever its case', () => {
    expect(kinds({ terms: 'Plan', scope: 'Ideas' })).toEqual(['new-folder']);
    expect(kinds({ terms: 'plan.md', scope: 'Ideas' })).toEqual(['new-folder']);
    expect(kinds({ terms: 'old', scope: 'Ideas' })).toEqual(['new-note']);
    // The same name one folder up is a different place.
    expect(kinds({ terms: 'plan' })).toEqual(['new-note', 'new-folder']);
  });

  it('keeps an extension Noto opens and adds .md to anything else', () => {
    expect(noteFileName('notes.txt')).toBe('notes.txt');
    expect(noteFileName('Meeting 3.5')).toBe('Meeting 3.5.md');
    expect(noteFileName('draft.MD')).toBe('draft.MD');
  });

  it('offers only a folder on the folders tab, and nothing for a name that cannot be one', () => {
    expect(kinds({ terms: 'archive', mode: 'folders' })).toEqual(['new-folder']);
    for (const terms of ['a/b', 'what?', '.hidden', 'con', 'trailing.', '   ']) expect(kinds({ terms })).toEqual([]);
    expect(kinds({ terms: 'budget', canMake: false })).toEqual([]);
  });
});

describe('opening a note by its path', () => {
  it('reads a path from the root, a drive or the home folder, quotes and all', () => {
    expect(typedPath('/Users/me/notes/a.md')).toBe('/Users/me/notes/a.md');
    expect(typedPath('~/notes/a.md')).toBe('~/notes/a.md');
    expect(typedPath('C:\\Notes\\a.md')).toBe('C:\\Notes\\a.md');
    expect(typedPath('"/Users/me/My Notes/a.md"')).toBe('/Users/me/My Notes/a.md');
    expect(typedPath('Ideas/plan')).toBeNull();
    expect(typedPath('plan')).toBeNull();
  });

  it('offers to open a note at a path, only a note, and with no folder open too', () => {
    expect(quickActions({ ...base, terms: '/tmp/elsewhere/x.md' })).toEqual([{ kind: 'open-path', path: '/tmp/elsewhere/x.md' }]);
    expect(kinds({ terms: '/tmp/elsewhere/x.md', canMake: false })).toEqual(['open-path']);
    expect(kinds({ terms: '/tmp/picture.png' })).toEqual([]);
    expect(kinds({ terms: '/tmp/elsewhere/x.md', mode: 'folders' })).toEqual([]);
  });
});

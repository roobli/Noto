import { describe, expect, it } from 'vitest';
import {
  duplicateName,
  extensionOf,
  isEntryName,
  renamedFileName,
  stemOf,
} from '../../src/shared/workspace/v1/entry-names';

describe('isEntryName', () => {
  it('accepts the names this vault is actually full of', () => {
    expect(isEntryName('note.md')).toBe(true);
    expect(isEntryName('设计笔记.md')).toBe(true);
    expect(isEntryName('B3009_ANALYSIS_thing.md')).toBe(true);
    expect(isEntryName('a name with spaces.md')).toBe(true);
    expect(isEntryName('.hidden')).toBe(true);
  });

  it('refuses anything that is a path rather than a name', () => {
    expect(isEntryName('sub/note.md')).toBe(false);
    expect(isEntryName('sub\\note.md')).toBe(false);
    expect(isEntryName('..')).toBe(false);
    expect(isEntryName('.')).toBe(false);
  });

  it('refuses what one of the three platforms would mangle or reject', () => {
    // Windows drops a trailing dot or space silently, so the file comes back
    // under a name nobody typed.
    expect(isEntryName('note.')).toBe(false);
    expect(isEntryName('note ')).toBe(false);
    expect(isEntryName('a:b.md')).toBe(false);
    expect(isEntryName('a?b.md')).toBe(false);
    expect(isEntryName('a*b.md')).toBe(false);
    expect(isEntryName('a"b.md')).toBe(false);
    expect(isEntryName('con.md')).toBe(false);
    expect(isEntryName('LPT1.txt')).toBe(false);
  });

  it('refuses an empty name, a padded one, and one past the bound', () => {
    expect(isEntryName('')).toBe(false);
    expect(isEntryName('  note.md  ')).toBe(false);
    expect(isEntryName(`${'a'.repeat(201)}.md`)).toBe(false);
    expect(isEntryName(`${'a'.repeat(190)}.md`)).toBe(true);
  });

  it('counts characters rather than bytes, so a Chinese name is not cut short', () => {
    // 100 Han characters is 300 bytes and well within what any of the three
    // filesystems accept, and names like this are the normal case here.
    expect(isEntryName(`${'设'.repeat(100)}.md`)).toBe(true);
  });

  it('refuses anything that is not a string', () => {
    expect(isEntryName(null)).toBe(false);
    expect(isEntryName(42)).toBe(false);
    expect(isEntryName(undefined)).toBe(false);
  });
});

describe('extensionOf and stemOf', () => {
  it('splits a name at its last dot, and treats a dotfile as all stem', () => {
    expect(extensionOf('note.md')).toBe('.md');
    expect(extensionOf('notes.v2.md')).toBe('.md');
    expect(extensionOf('README')).toBe('');
    expect(extensionOf('.gitignore')).toBe('');
    expect(stemOf('notes.v2.md')).toBe('notes.v2');
    expect(stemOf('.gitignore')).toBe('.gitignore');
  });
});

describe('duplicateName', () => {
  it('names the first copy after the original, keeping its extension', () => {
    expect(duplicateName('note.md', new Set())).toBe('note (copy).md');
  });

  it('numbers later copies rather than stacking the word', () => {
    // Typora writes `note (copy) (copy).md`, which is unreadable by the third.
    const taken = new Set(['note.md', 'note (copy).md']);
    expect(duplicateName('note.md', taken)).toBe('note (copy) 2.md');
    expect(duplicateName('note.md', new Set([...taken, 'note (copy) 2.md'])))
      .toBe('note (copy) 3.md');
  });

  it('copies a folder, which has no extension to keep', () => {
    expect(duplicateName('Research', new Set())).toBe('Research (copy)');
  });
});

describe('renamedFileName', () => {
  const opens = (extension: string) => ['.md', '.markdown', '.txt'].includes(extension);

  it('keeps the extension when the reader typed none', () => {
    // Otherwise the note leaves the tree, which lists only what it can open,
    // and cannot be opened again: lost without being deleted.
    expect(renamedFileName('Ideas', 'note.md', opens)).toBe('Ideas.md');
  });

  it('takes the extension the reader typed, when Noto opens it', () => {
    expect(renamedFileName('Ideas.markdown', 'note.md', opens)).toBe('Ideas.markdown');
    expect(renamedFileName('Ideas.md', 'note.md', opens)).toBe('Ideas.md');
    expect(renamedFileName('Ideas.MD', 'note.md', opens)).toBe('Ideas.MD');
  });

  it('keeps the note\u2019s extension when the dot in the name is part of the name', () => {
    expect(renamedFileName('Meeting 3.5', 'note.md', opens)).toBe('Meeting 3.5.md');
    expect(renamedFileName('v2.0 plan', 'note.md', opens)).toBe('v2.0 plan.md');
  });

  it('leaves a name alone when the old one had no extension either', () => {
    expect(renamedFileName('LICENCE', 'README', opens)).toBe('LICENCE');
  });
});

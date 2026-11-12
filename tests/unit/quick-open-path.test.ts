import { describe, expect, it } from 'vitest';
import { pathTail } from '../../src/renderer/quick-open-path';

describe('the path shown beside a quick open result', () => {
  it('is the folder the note is in, not the note again', () => {
    expect(pathTail('notes/daily/today.md')).toBe('notes / daily');
  });

  it('keeps the last folders whole, which is what tells two results apart', () => {
    expect(pathTail('E_works/acme/数据组/需求管理/archived/one.md')).toBe('… / 需求管理 / archived');
  });

  it('shows a short path whole, and says where a note at the top is', () => {
    expect(pathTail('notes/one.md')).toBe('notes');
    expect(pathTail('one.md')).toBe('At the top of the folder');
  });

  it('keeps the last part of a folder, which is the folder itself', () => {
    expect(pathTail('works/jobs/hiring', true)).toBe('… / jobs / hiring');
    expect(pathTail('works', true)).toBe('works');
  });

  it('reads a Windows path', () => {
    expect(pathTail('a\\b\\c\\d.md')).toBe('… / b / c');
  });

  it('takes as many segments as it is asked for', () => {
    expect(pathTail('a/b/c/d/e.md', false, 3)).toBe('… / b / c / d');
  });
});

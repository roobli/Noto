import { describe, expect, it } from 'vitest';
import { pathContext } from '../../src/renderer/quick-open-path';

describe('the path shown beside a quick open result', () => {
  it('is the folder the note is in, not the note again', () => {
    expect(pathContext('notes/daily/today.md')).toBe('notes/daily');
  });

  it('keeps the end, which is what tells two results apart', () => {
    expect(pathContext('E_works/acme/数据组/需求管理/archived/one.md'))
      .toBe('…/需求管理/archived');
  });

  it('shows a short path whole', () => {
    expect(pathContext('notes/one.md')).toBe('notes');
    expect(pathContext('one.md')).toBe('');
  });

  it('reads a Windows path', () => {
    expect(pathContext('a\\b\\c\\d.md')).toBe('…/b/c');
  });

  it('takes as many segments as it is asked for', () => {
    expect(pathContext('a/b/c/d/e.md', 3)).toBe('…/b/c/d');
  });
});

import { describe, expect, it } from 'vitest';
import { dollarOpensMath } from '../../src/renderer/editor/noto/math-pair';

describe('when a typed dollar opens a formula', () => {
  it('opens one where a formula could start', () => {
    expect(dollarOpensMath('', '')).toBe(true);
    expect(dollarOpensMath(' ', '')).toBe(true);
    expect(dollarOpensMath('（', '）')).toBe(true);
    expect(dollarOpensMath(' ', ' ')).toBe(true);
  });

  it('stays a dollar after a word or a digit, before a word, and after a backslash or a dollar', () => {
    expect(dollarOpensMath('S', '')).toBe(false); // US$
    expect(dollarOpensMath('5', '')).toBe(false); // 5$
    expect(dollarOpensMath('美', '')).toBe(false);
    expect(dollarOpensMath(' ', 'x')).toBe(false); // typed in front of a word
    expect(dollarOpensMath(' ', '8')).toBe(false); // typed in front of a number
    expect(dollarOpensMath('\\', '')).toBe(false); // an escaped dollar
    expect(dollarOpensMath('$', '')).toBe(false);
  });
});

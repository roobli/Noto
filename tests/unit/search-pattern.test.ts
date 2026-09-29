import { describe, expect, it } from 'vitest';
import { PLAIN_FLAGS, patternFor } from '../../src/shared/search/pattern';

describe('the search pattern', () => {
  it('takes a query as the text it is, brackets and all', () => {
    const pattern = patternFor('Data_Archive (旧)', PLAIN_FLAGS)!;
    expect('see Data_Archive (旧) here'.match(pattern)).toEqual(['Data_Archive (旧)']);
  });

  it('ignores case until asked not to', () => {
    expect(patternFor('noto', PLAIN_FLAGS)!.test('Noto')).toBe(true);
    expect(patternFor('noto', { ...PLAIN_FLAGS, caseSensitive: true })!.test('Noto')).toBe(false);
  });

  it('bounds a whole word', () => {
    const whole = patternFor('cat', { ...PLAIN_FLAGS, wholeWord: true })!;
    expect(whole.test('a cat sat')).toBe(true);
    whole.lastIndex = 0;
    expect(whole.test('concatenate')).toBe(false);
  });

  it('reads an expression when asked, and declines one that does not parse', () => {
    expect('image-20260902.png'.match(patternFor('image-\\d+', { ...PLAIN_FLAGS, regex: true })!)).toEqual(['image-20260902']);
    expect(patternFor('(', { ...PLAIN_FLAGS, regex: true })).toBeNull();
    expect(patternFor('', PLAIN_FLAGS)).toBeNull();
  });
});

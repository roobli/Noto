import { describe, expect, it } from 'vitest';
import { typoraMarkRanges } from '../../src/renderer/editor/noto/typora-marks';

const kinds = (text: string) => typoraMarkRanges(text).map((range) => [range.kind, text.slice(range.innerFrom, range.innerTo)]);

describe('Typora inline marks', () => {
  it('finds a highlight, with the delimiters outside the inner text', () => {
    const text = 'the ==key point== here';
    const [range] = typoraMarkRanges(text);
    expect(range.kind).toBe('highlight');
    expect(text.slice(range.from, range.to)).toBe('==key point==');
    expect(text.slice(range.innerFrom, range.innerTo)).toBe('key point');
  });

  it('finds superscript and subscript, which take no spaces', () => {
    expect(kinds('x^2^ and H~2~O')).toEqual([['superscript', '2'], ['subscript', '2']]);
    expect(kinds('a ^ b ^ c')).toEqual([]);
    expect(kinds('a ~ b ~ c')).toEqual([]);
  });

  it('leaves strikethrough to the parser', () => {
    expect(kinds('~~struck~~ text')).toEqual([]);
    expect(kinds('~~struck~~ and H~2~O')).toEqual([['subscript', '2']]);
  });

  it('does not nest, and does not cross a line', () => {
    expect(kinds('==one ^two^ three==')).toEqual([['highlight', 'one ^two^ three']]);
    expect(kinds('==open\nclose==')).toEqual([]);
    expect(kinds('a == b == c')).toEqual([['highlight', ' b ']]);
  });

  it('returns nothing for a run with no marks', () => {
    expect(typoraMarkRanges('plain text, 3 = 3, a~b')).toEqual([]);
  });
});

describe('the three switches', () => {
  it('leave the characters alone for a mark that is turned off', () => {
    const text = 'a ==hit== and x^2^ and H~2~O';
    expect(typoraMarkRanges(text).map((range) => range.kind)).toEqual(['highlight', 'superscript', 'subscript']);
    expect(typoraMarkRanges(text, { highlight: false, superscript: true, subscript: true })
      .map((range) => range.kind)).toEqual(['superscript', 'subscript']);
    expect(typoraMarkRanges(text, { highlight: true, superscript: false, subscript: false })
      .map((range) => range.kind)).toEqual(['highlight']);
    expect(typoraMarkRanges(text, { highlight: false, superscript: false, subscript: false })).toEqual([]);
  });

  it('lets a sub- or superscript hold a space written as an escape, and hides the backslash', () => {
    const text = 'X~long\\ text~ and Y^a\\ b^ but not ~a b~';
    expect(kinds(text)).toEqual([['subscript', 'long\\ text'], ['superscript', 'a\\ b']]);
    const [sub] = typoraMarkRanges(text);
    expect(sub!.escapes.map((at) => text[at])).toEqual(['\\']);
  });
});

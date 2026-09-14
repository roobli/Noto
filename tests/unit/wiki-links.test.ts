/**
 * Finding `[[wiki links]]` in text.
 *
 * The links are decorations rather than schema nodes, so this is the only place
 * that decides what counts as one. Getting it wrong costs a false highlight,
 * never a rewritten file, which is exactly why it is a decoration.
 */

import { describe, expect, it } from 'vitest';
import { findWikiLinks } from '../../src/renderer/editor/noto/wiki-link-plugin';

const targets = (text: string) => findWikiLinks(text, 0).map((match) => match.target);

describe('finding wiki links', () => {
  it('finds one, and reports where it sits', () => {
    const [link] = findWikiLinks('see [[Index]] for more', 10);
    expect(link).toMatchObject({ from: 14, to: 23, target: 'Index', label: 'Index' });
  });

  it('finds several in one run of text', () => {
    expect(targets('[[a]] and [[b]] and [[c]]')).toEqual(['a', 'b', 'c']);
  });

  it('reads a label after a pipe, and falls back to the target without one', () => {
    const [labelled] = findWikiLinks('[[notes/index|the index]]', 0);
    expect(labelled).toMatchObject({
      target: 'notes/index',
      label: 'the index',
      // `notes/index|` is muted; only the label is the clickable face.
      muteFrom: 2,
      muteTo: 14,
      linkFrom: 14,
      linkTo: 23,
    });
    const [bare] = findWikiLinks('[[notes/index]]', 0);
    expect(bare).toMatchObject({
      label: 'notes/index',
      muteFrom: null,
      linkFrom: 2,
      linkTo: 13,
    });
  });

  it('handles CJK targets and paths', () => {
    expect(targets('[[E000_Works/数据部门/00_索引]]')).toEqual(['E000_Works/数据部门/00_索引']);
  });

  it('ignores an empty target', () => {
    expect(targets('[[]] and [[   ]]')).toEqual([]);
  });

  it('does not run across a line break', () => {
    expect(targets('[[start\nend]]')).toEqual([]);
  });

  it('does not swallow a nested bracket into one long false positive', () => {
    expect(targets('[[a] [b]]')).toEqual([]);
  });

  it('leaves an ordinary markdown link alone', () => {
    expect(targets('[text](https://example.com)')).toEqual([]);
  });

  it('trims the target so a stray space does not become part of the name', () => {
    expect(targets('[[  Index  ]]')).toEqual(['Index']);
  });

  it('is reusable, so a shared regex cannot carry state between calls', () => {
    expect(targets('[[a]]')).toEqual(['a']);
    expect(targets('[[a]]')).toEqual(['a']);
  });

  it('ignores comma-separated integer lists (RTFS array text, not note paths)', () => {
    expect(targets('[[100, 101]]')).toEqual([]);
    expect(targets('[[100,101,102]]')).toEqual([]);
    expect(targets('see [[100 , 101 , 102]] nearby')).toEqual([]);
  });

  it('still decorates a bare number, and a list that is not only integers', () => {
    expect(targets('[[100]]')).toEqual(['100']);
    expect(targets('[[100, note]]')).toEqual(['100, note']);
    expect(targets('[[note, 100]]')).toEqual(['note, 100']);
  });

  it('ignores an integer list even when a label is written after the pipe', () => {
    expect(targets('[[100, 101|pages]]')).toEqual([]);
  });

  it('still decorates real note paths and labelled links', () => {
    expect(targets('[[note]] and [[path/note|title]]')).toEqual(['note', 'path/note']);
  });
});

/**
 * Wiki links survive being re-serialized.
 *
 * The serializer escapes `[` in text because a bare one can open a link
 * reference. That turned `[[note]]` into `\[\[note]]`, so editing any paragraph
 * containing a wiki link rewrote it and the link stopped being one. These pin
 * both halves: the exemption works, and it stays narrow enough that ordinary
 * bracket text is still escaped.
 */

import { describe, expect, it } from 'vitest';
import { parseMarkdown, renderMarkdown } from '../../src/shared/markdown/v3/syntax';

/** Parse one paragraph and write it back, as an edited block would be. */
const roundTrip = (markdown: string): string => {
  const tree = parseMarkdown(markdown);
  return renderMarkdown(tree.children[0]).trim();
};

describe('wiki links through the serializer', () => {
  it('writes a wiki link back unescaped', () => {
    expect(roundTrip('See [[deep-dive]] for detail.')).toBe('See [[deep-dive]] for detail.');
  });

  it('handles several in one paragraph', () => {
    expect(roundTrip('[[a]] then [[b]] then [[c]]')).toBe('[[a]] then [[b]] then [[c]]');
  });

  it('keeps a label after the pipe', () => {
    expect(roundTrip('[[notes/index|the index]]')).toBe('[[notes/index|the index]]');
  });

  it('keeps CJK targets and paths intact', () => {
    const source = '[[E_works/数据组/00_索引]] 的说明';
    expect(roundTrip(source)).toBe(source);
  });

  it('is stable, so editing the same block twice does not drift', () => {
    const once = roundTrip('See [[deep-dive]].');
    expect(roundTrip(once)).toBe(once);
  });

  it('still escapes a bracket that is not a complete wiki link', () => {
    // A lone bracket can open a link reference, so it keeps its escape.
    expect(roundTrip('a [ bracket')).toContain('\\[');
    expect(roundTrip('[[unclosed')).toContain('\\[');
  });

  it('leaves a real markdown link alone', () => {
    expect(roundTrip('[text](https://example.com)')).toBe('[text](https://example.com)');
  });

  it('does not exempt a bracket run that spans a line break', () => {
    const rendered = roundTrip('[[start\nend]]');
    expect(rendered).toContain('\\[');
  });
});

/**
 * A note's unsaved changes, block by block and word by word.
 */

import { describe, expect, it } from 'vitest';
import { unsavedDiff, wordDiff } from '../../src/renderer/unsaved-diff';

const kinds = (saved: string, current: string) => unsavedDiff(saved, current).rows.map((row) => `${row.kind}:${row.change}`);

describe('the blocks of an unsaved note', () => {
  it('pairs every block in reading order, with nothing to show when nothing changed', () => {
    const note = '# Title\n\nOne.\n\nTwo.\n';
    const diff = unsavedDiff(note, note);
    expect(diff.changes).toBe(0);
    expect(diff.rows.every((row) => row.kind === 'same' && row.saved === row.current)).toBe(true);
  });

  it('marks an edited block with the saved text and the current one', () => {
    const diff = unsavedDiff('# Title\n\nOne.\n\nTwo.\n', '# Title\n\nOne, edited.\n\nTwo.\n');
    expect(diff.rows[1]).toEqual({ kind: 'modified', saved: 'One.', current: 'One, edited.', change: 0 });
    expect(diff.modified).toBe(1);
  });

  it('puts a removed block where it stood and an added one where it is', () => {
    expect(kinds('A.\n\nB.\n\nC.\n', 'A.\n\nC.\n\nD.\n')).toEqual(['same:-1', 'removed:0', 'same:-1', 'added:1']);
  });

  it('counts neighbouring changed rows as one change', () => {
    const diff = unsavedDiff('A.\n\nB.\n\nC.\n\nD.\n', 'A.\n\nB, edited.\n\nNew.\n\nD.\n');
    expect(diff.rows.map((row) => row.change)).toEqual([-1, 0, 0, -1]);
    expect(diff.changes).toBe(1);
  });

  it('does not count line endings or a byte order mark as a change', () => {
    const diff = unsavedDiff('\uFEFF# T\r\n\r\nOne.\r\n', '# T\n\nOne.\n');
    expect(diff.changes).toBe(0);
    expect(diff.spacingOnly).toBe(false);
  });

  it('says when only the spacing between blocks or the end of the file differs', () => {
    expect(unsavedDiff('a\n\nb\n', 'a\n\n\nb\n')).toMatchObject({ changes: 0, spacingOnly: true });
    expect(unsavedDiff('a\n\nb\n', 'a\n\nb')).toMatchObject({ changes: 0, spacingOnly: true });
  });
});

describe('the words of an edited block', () => {
  const join = (pieces: ReturnType<typeof wordDiff>, keep: 'saved' | 'current') => pieces
    .filter((piece) => piece.op === 'same' || piece.op === (keep === 'saved' ? 'removed' : 'added'))
    .map((piece) => piece.text).join('');

  it('marks only the words that changed, and gives back both texts whole', () => {
    const pieces = wordDiff('The quick brown fox.', 'The slow brown fox jumps.');
    expect(pieces).toEqual([
      { op: 'same', text: 'The ' },
      { op: 'removed', text: 'quick' },
      { op: 'added', text: 'slow' },
      { op: 'same', text: ' brown fox' },
      { op: 'added', text: ' jumps' },
      { op: 'same', text: '.' },
    ]);
    expect(join(pieces, 'saved')).toBe('The quick brown fox.');
    expect(join(pieces, 'current')).toBe('The slow brown fox jumps.');
  });

  it('compares Chinese a character at a time', () => {
    const pieces = wordDiff('今天天气很好', '今天天气不错');
    expect(pieces[0]).toEqual({ op: 'same', text: '今天天气' });
    expect(join(pieces, 'saved')).toBe('今天天气很好');
    expect(join(pieces, 'current')).toBe('今天天气不错');
  });

  it('compares a long block edited at both ends line by line rather than marking it all', () => {
    const lines = Array.from({ length: 80 }, (_, index) => `line ${index} with a few words to make it long enough`);
    const saved = lines.join('\n');
    const current = ['changed first line', ...lines.slice(1, -1), 'changed last line'].join('\n');
    const pieces = wordDiff(saved, current);
    const kept = pieces.filter((piece) => piece.op === 'same').map((piece) => piece.text).join('');
    expect(kept).toContain(lines[40]);
    expect(pieces.filter((piece) => piece.op === 'removed').map((piece) => piece.text).join('')).toContain('line 0');
  });

  it('marks a block too large to compare word by word as changed whole', () => {
    const saved = Array.from({ length: 600 }, (_, index) => `a${index}`).join(' ');
    const current = Array.from({ length: 600 }, (_, index) => `b${index}`).join(' ');
    const pieces = wordDiff(saved, current);
    expect(pieces.map((piece) => piece.op)).toEqual(['removed', 'added']);
  });
});

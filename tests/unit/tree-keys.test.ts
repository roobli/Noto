import { describe, expect, it } from 'vitest';
import { treeMove, type TreeRowView } from '../../src/renderer/tree-keys';

// Daily-use audit finding 17: the arrows, Enter and F2 did nothing in the tree.
const rows: TreeRowView[] = [
  { path: '/v/a', kind: 'directory', depth: 1, open: true, label: 'a' },
  { path: '/v/a/one.md', kind: 'file', depth: 2, label: 'one' },
  { path: '/v/a/b', kind: 'directory', depth: 2, open: false, label: 'b' },
  { path: '/v/two.md', kind: 'file', depth: 1, label: 'two' },
  { path: '/v/three.md', kind: 'file', depth: 1, label: 'three' },
];

describe('walking the tree from the keyboard', () => {
  it('goes up and down the rows, and to the first and the last', () => {
    expect(treeMove(rows, 1, 'ArrowDown')).toEqual({ kind: 'focus', index: 2 });
    expect(treeMove(rows, 1, 'ArrowUp')).toEqual({ kind: 'focus', index: 0 });
    expect(treeMove(rows, 0, 'ArrowUp')).toEqual({ kind: 'none' });
    expect(treeMove(rows, 4, 'ArrowDown')).toEqual({ kind: 'none' });
    expect(treeMove(rows, 2, 'Home')).toEqual({ kind: 'focus', index: 0 });
    expect(treeMove(rows, 2, 'End')).toEqual({ kind: 'focus', index: 4 });
  });

  it('opens a folder with Right, then steps into it', () => {
    expect(treeMove(rows, 2, 'ArrowRight')).toEqual({ kind: 'expand', path: '/v/a/b' });
    expect(treeMove(rows, 0, 'ArrowRight')).toEqual({ kind: 'focus', index: 1 });
    expect(treeMove(rows, 1, 'ArrowRight')).toEqual({ kind: 'none' });
  });

  it('closes an open folder with Left, and otherwise steps out to its folder', () => {
    expect(treeMove(rows, 0, 'ArrowLeft')).toEqual({ kind: 'collapse', path: '/v/a' });
    expect(treeMove(rows, 1, 'ArrowLeft')).toEqual({ kind: 'focus', index: 0 });
    expect(treeMove(rows, 2, 'ArrowLeft')).toEqual({ kind: 'focus', index: 0 });
    expect(treeMove(rows, 3, 'ArrowLeft')).toEqual({ kind: 'none' });
  });

  it('renames with F2', () => {
    expect(treeMove(rows, 3, 'F2')).toEqual({ kind: 'rename', path: '/v/two.md' });
  });

  it('finds the next row a typed name starts with, and cycles on a repeated letter', () => {
    expect(treeMove(rows, 0, 't', 't')).toEqual({ kind: 'focus', index: 3 });
    expect(treeMove(rows, 3, 't', 't')).toEqual({ kind: 'focus', index: 4 });
    expect(treeMove(rows, 4, 't', 't')).toEqual({ kind: 'focus', index: 3 });
    expect(treeMove(rows, 3, 'h', 'th')).toEqual({ kind: 'focus', index: 4 });
    expect(treeMove(rows, 0, 'z', 'z')).toEqual({ kind: 'none' });
  });
});

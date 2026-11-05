import { describe, expect, it } from 'vitest';
import { changeCounts, changeTree, type ChangeNode } from '../../src/renderer/plugins/bundled/changes/tree';

const shape = (nodes: readonly ChangeNode[]): unknown[] => nodes.map((node) => (node.kind === 'file'
  ? `${node.name} (${node.change})`
  : { [node.name]: shape(node.children) }));

describe('the tree of changed notes', () => {
  it('holds only what changed, folders first, and folds chains of single folders into one row', () => {
    const tree = changeTree('/v', [
      ['/v/Work/Acme/研发组/TODO/a.md', 'modified'],
      ['/v/Work/Acme/研发组/TODO/b.md', 'new'],
      ['/v/A000/note 10.md', 'modified'],
      ['/v/A000/note 9.md', 'deleted'],
      ['/v/top.md', 'new'],
      ['/elsewhere/x.md', 'modified'],
    ]);
    expect(shape(tree)).toEqual([
      { A000: ['note 9.md (deleted)', 'note 10.md (modified)'] },
      { 'Work / Acme / 研发组 / TODO': ['a.md (modified)', 'b.md (new)'] },
      'top.md (new)',
    ]);
    const folder = tree[1]!;
    expect(folder.kind === 'folder' && folder.key).toBe('Work/Acme/研发组/TODO');
  });

  it('counts each kind of change', () => {
    expect(changeCounts([['/v/a.md', 'modified'], ['/v/b.md', 'modified'], ['/v/c.md', 'deleted']])).toEqual({ modified: 2, new: 0, deleted: 1 });
  });
});

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

  it('gives each folder row its own path, written as the files are, for its menu', () => {
    const tree = changeTree('/v', [['/v/Work/Acme/TODO/a.md', 'modified'], ['/v/Work/b.md', 'new']]);
    const work = tree[0]!;
    expect(work.kind === 'folder' && work.path).toBe('/v/Work');
    const chain = work.kind === 'folder' ? work.children[0]! : null;
    // A chain drawn as one row is the last folder of it.
    expect(chain?.kind === 'folder' && [chain.name, chain.path]).toEqual(['Acme / TODO', '/v/Work/Acme/TODO']);
    // Windows paths keep their separators.
    const windows = changeTree('C:\\Users\\runneradmin\\v', [['C:\\Users\\runneradmin\\v\\Work\\a.md', 'new']]);
    expect(windows[0]!.kind === 'folder' && windows[0]!.path).toBe('C:\\Users\\runneradmin\\v\\Work');
  });

  it('counts each kind of change', () => {
    expect(changeCounts([['/v/a.md', 'modified'], ['/v/b.md', 'modified'], ['/v/c.md', 'deleted']])).toEqual({ modified: 2, new: 0, deleted: 1 });
  });
});

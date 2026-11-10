import { describe, expect, it } from 'vitest';
import { folderIndexNote, recentInside } from '../../src/renderer/FolderEmptyState';

const entry = (relativePath: string) => ({ path: `/v/${relativePath}`, name: relativePath.split('/').pop()!, relativePath });
const recent = (path: string, openedAt: number) => ({ path, name: path.split('/').pop()!, openedAt });

describe("an open folder's empty page", () => {
  it("offers the folder's own index note, by the names it goes by", () => {
    expect(folderIndexNote([entry('a.md'), entry('README.md')])?.relativePath).toBe('README.md');
    expect(folderIndexNote([entry('README.md'), entry('00_索引.md')])?.relativePath).toBe('00_索引.md');
    expect(folderIndexNote([entry('sub/README.md')])).toBeNull();
  });

  it('lists notes opened lately inside the folder only, newest first, with where each sits', () => {
    const lately = recentInside([
      recent('/v/a/one.md', 1), recent('/elsewhere/two.md', 5), recent('/v/three.md', 3), recent('/v/pic.png', 9), recent('/vault2/x.md', 8),
    ], '/v');
    expect(lately).toEqual([
      { path: '/v/three.md', name: 'three', where: '' },
      { path: '/v/a/one.md', name: 'one', where: 'a' },
    ]);
  });

  it('finds a Windows folder\'s notes whatever the slashes and the case', () => {
    const lately = recentInside([recent('C:/Notes/Sub/one.md', 2), { path: 'c:\\notes\\two.md', name: 'two.md', openedAt: 1 }], 'C:\\Notes');
    expect(lately.map((file) => [file.name, file.where])).toEqual([['one', 'Sub'], ['two', '']]);
  });
});

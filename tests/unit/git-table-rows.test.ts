import { describe, expect, it } from 'vitest';
import { tableRowChanges } from '../../src/renderer/editor/noto/git-table-rows';

const table = (...rows: string[]) => ['| name | size |', '| --- | ---: |', ...rows].join('\n');

describe('which rows of a table changed since the commit', () => {
  const committed = table('| a | 1 |', '| b | 2 |', '| c | 3 |');

  it('marks the one row whose cells changed, and none of the others', () => {
    expect(tableRowChanges(committed, table('| a | 1 |', '| b | 20 |', '| c | 3 |')))
      .toEqual({ rows: ['same', 'same', 'modified', 'same'], deletedBefore: [] });
  });

  it('tells a new row from a changed one, and says where rows were deleted', () => {
    expect(tableRowChanges(committed, table('| a | 1 |', '| b | 2 |', '| c | 3 |', '| d | 4 |')))
      .toEqual({ rows: ['same', 'same', 'same', 'same', 'added'], deletedBefore: [] });
    expect(tableRowChanges(committed, table('| a | 1 |', '| c | 3 |')))
      .toEqual({ rows: ['same', 'same', 'same'], deletedBefore: [2] });
    expect(tableRowChanges(committed, table('| a | 1 |', '| b | 2 |')))
      .toEqual({ rows: ['same', 'same', 'same'], deletedBefore: [3] });
    // Two rows where one was: the first stands in for it, the second is new.
    expect(tableRowChanges(committed, table('| a | 1 |', '| x | 9 |', '| y | 8 |', '| c | 3 |')))
      .toEqual({ rows: ['same', 'same', 'modified', 'added', 'same'], deletedBefore: [] });
  });

  it('marks the header row like any other', () => {
    const now = ['| name | bytes |', '| --- | ---: |', '| a | 1 |', '| b | 2 |', '| c | 3 |'].join('\n');
    expect(tableRowChanges(committed, now)?.rows).toEqual(['modified', 'same', 'same', 'same']);
  });

  it('ignores the padding between pipes, which no row shows', () => {
    const padded = table('|  a  |  1 |', '| b | 20 |', '| c |   3 |');
    expect(tableRowChanges(committed, padded)?.rows).toEqual(['same', 'same', 'modified', 'same']);
    expect(tableRowChanges(committed, table('|  a  |  1 |', '| b | 2 |', '| c | 3 |'))).toBeNull();
  });

  it('keeps an escaped pipe inside its cell', () => {
    const before = table('| a \\| b | 1 |');
    expect(tableRowChanges(before, table('| a \\| b | 2 |'))?.rows).toEqual(['same', 'modified']);
  });

  it('gives up, so the whole table is marked, when the columns or their alignment changed', () => {
    expect(tableRowChanges(committed, ['| name | size | kind |', '| --- | ---: | --- |', '| a | 1 | x |'].join('\n'))).toBeNull();
    expect(tableRowChanges(committed, committed.replace('---: |', ':---: |'))).toBeNull();
    expect(tableRowChanges('not a table', committed)).toBeNull();
  });
});

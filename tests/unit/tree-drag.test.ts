/**
 * A drag in the file tree, worked out without a window: the speed an edge
 * scrolls at, whether a drop would move anything, and the words at the foot
 * of the rail.
 */

import { describe, expect, it } from 'vitest';
import { EDGE_BAND, EDGE_MAX, carried, dropVerdict, dropWords, edgeSpeed, edgeStrength, folderWords, rangeOf } from '../../src/renderer/tree-drag';

describe('scrolling at an edge', () => {
  const top = 100;
  const bottom = 900;
  it('is still in the middle, slow where a band begins and fastest at and past the edge', () => {
    expect(edgeSpeed(500, top, bottom)).toBe(0);
    expect(edgeSpeed(top + EDGE_BAND + 1, top, bottom)).toBe(0);
    const entering = edgeSpeed(bottom - EDGE_BAND + 4, top, bottom);
    const deep = edgeSpeed(bottom - 6, top, bottom);
    expect(entering).toBeGreaterThan(0);
    expect(entering).toBeLessThan(3);
    expect(deep).toBeGreaterThan(entering);
    expect(edgeSpeed(bottom + 200, top, bottom)).toBe(EDGE_MAX);
    // Up is the same, the other way.
    expect(edgeSpeed(top + 6, top, bottom)).toBeCloseTo(-deep, 5);
    expect(edgeSpeed(top - 50, top, bottom)).toBe(-EDGE_MAX);
  });

  it('narrows the bands in a short rail, so its middle still holds still', () => {
    expect(edgeSpeed(150, 100, 200)).toBe(0);
    expect(edgeSpeed(195, 100, 200)).toBeGreaterThan(0);
    expect(edgeSpeed(150, 100, 100)).toBe(0);
  });

  it('shows as strong as it scrolls', () => {
    expect(edgeStrength(EDGE_MAX)).toBe(1);
    expect(edgeStrength(-EDGE_MAX / 2)).toBe(0.5);
  });
});

describe('a drop', () => {
  it('moves into another folder, leaves a row in its own, and never puts a folder inside itself', () => {
    expect(dropVerdict('/v/Ideas/plan.md', '/v/Work')).toBe('move');
    expect(dropVerdict('/v/Ideas/plan.md', '/v/Ideas')).toBe('here');
    expect(dropVerdict('/v/Ideas', '/v/Ideas')).toBe('into-itself');
    expect(dropVerdict('/v/Ideas', '/v/Ideas/Drafts')).toBe('into-itself');
    // A neighbour whose name starts the same is somewhere else.
    expect(dropVerdict('/v/Ideas', '/v/Ideas-old')).toBe('move');
    expect(dropVerdict('C:\\v\\Ideas\\plan.md', 'C:\\v\\Ideas')).toBe('here');
  });

  it("says where it would go, by the folder's place in the open one", () => {
    expect(folderWords('/v', '/v', 'RooB')).toBe('RooB');
    expect(folderWords('/v/Ideas/Drafts', '/v', 'RooB')).toBe('Ideas / Drafts');
    expect(dropWords('/v/Ideas/plan.md', '/v/Work/2026', '/v', 'RooB')).toBe('Move "plan" to Work / 2026');
    expect(dropWords('/v/Ideas/plan.md', '/v/Ideas', '/v', 'RooB')).toBe('"plan" is already in Ideas');
    expect(dropWords('/v/Ideas', '/v/Ideas/Drafts', '/v', 'RooB')).toBe('A folder cannot go inside itself');
    expect(dropWords('/v/Ideas/plan.md', null, '/v', 'RooB')).toBe('Drop on a folder · hold at an edge to scroll');
    // While the tree scrolls, rows pass under the pointer and none is offered.
    expect(dropWords('/v/Ideas/plan.md', '/v/Work', '/v', 'RooB', 1)).toBe('Scrolling down…');
  });
});

describe('several rows', () => {
  it('carries every chosen row when one of them is picked up, and not what a chosen folder holds', () => {
    const chosen = new Set(['/v/Ideas', '/v/Ideas/plan.md', '/v/essay.md']);
    expect(carried('/v/essay.md', chosen).sort()).toEqual(['/v/Ideas', '/v/essay.md']);
    expect(carried('/v/other.md', chosen)).toEqual(['/v/other.md']);
    expect(carried('/v/essay.md', new Set(['/v/essay.md']))).toEqual(['/v/essay.md']);
  });

  it('moves if any would, never into one of them, and says how many', () => {
    expect(dropVerdict(['/v/a.md', '/v/Work/b.md'], '/v/Work')).toBe('move');
    expect(dropVerdict(['/v/Work/a.md', '/v/Work/b.md'], '/v/Work')).toBe('here');
    expect(dropVerdict(['/v/a.md', '/v/Ideas'], '/v/Ideas/Drafts')).toBe('into-itself');
    expect(dropWords(['/v/a.md', '/v/b.md', '/v/c.md'], '/v/Work', '/v', 'RooB')).toBe('Move 3 items to Work');
    expect(dropWords(['/v/Work/a.md', '/v/Work/b.md'], '/v/Work', '/v', 'RooB')).toBe('They are already in Work');
  });

  it('takes a Shift-click range in the order the rows are drawn, either way round', () => {
    const order = ['/v/a', '/v/a/x.md', '/v/b.md', '/v/c.md'];
    expect(rangeOf(order, '/v/a/x.md', '/v/c.md')).toEqual(['/v/a/x.md', '/v/b.md', '/v/c.md']);
    expect(rangeOf(order, '/v/c.md', '/v/a')).toEqual(order);
    expect(rangeOf(order, '/v/gone.md', '/v/b.md')).toEqual(['/v/b.md']);
  });
});

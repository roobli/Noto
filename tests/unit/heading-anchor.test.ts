import { describe, expect, it } from 'vitest';
import { blockForFragment } from '../../src/renderer/heading-anchor';

const outline = [
  { blockIndex: 2, depth: 3, text: 'B12 脚注' },
  { blockIndex: 5, depth: 2, text: '九、HTML' },
  { blockIndex: 7, depth: 3, text: 'Setup' },
  { blockIndex: 9, depth: 3, text: 'Setup' },
];
const blocks = ['# T', 'x', '### B12 脚注', 'y', 'z', '## 九、HTML', 'w', '### Setup', '<span id="jump">here</span>', '### Setup'];

describe('a link to a place in its own note', () => {
  it('finds a heading by slug, by text, encoded or not, and the second of two by its suffix', () => {
    expect(blockForFragment('b12-脚注', outline, blocks)).toBe(2);
    expect(blockForFragment(encodeURIComponent('b12-脚注'), outline, blocks)).toBe(2);
    expect(blockForFragment('九、HTML', outline, blocks)).toBe(5);
    expect(blockForFragment('setup', outline, blocks)).toBe(7);
    expect(blockForFragment('setup-1', outline, blocks)).toBe(9);
  });

  it('finds an anchor the note placed, and nothing for a name nothing has', () => {
    expect(blockForFragment('jump', outline, blocks)).toBe(8);
    expect(blockForFragment('nowhere', outline, blocks)).toBeNull();
  });
});

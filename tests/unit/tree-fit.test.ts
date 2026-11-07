/**
 * A deep tree in a narrow rail, worked out without a window: how far each
 * level steps in, what a note is called on its row, and where a long name is
 * cut.
 */
import { describe, expect, it } from 'vitest';
import { TREE_STEP_MAX, TREE_STEP_MIN, fitLabel, fitName, nameRoom, sharedStarts, treeLabel, treeStep } from '../../src/renderer/tree-fit';

// Close to the tree's face at 14px: a CJK character a full em, anything else about half.
const measure = (text: string) => Array.from(text).reduce((sum, char) => sum + (/[　-鿿＀-￯]/.test(char) ? 14 : 7), 0);

describe('treeStep', () => {
  it('keeps the step of today in a shallow tree or a wide rail', () => {
    expect(treeStep(248, 2)).toBe(TREE_STEP_MAX);
    expect(treeStep(420, 4)).toBe(TREE_STEP_MAX);
  });

  it('gives up width per level when the deepest name would have less than half the rail', () => {
    const step = treeStep(248, 6);
    expect(step).toBeLessThan(TREE_STEP_MAX);
    expect(nameRoom(248, 6, step)).toBeGreaterThanOrEqual(110);
  });

  it('never steps in less than the floor, however deep', () => {
    expect(treeStep(248, 30)).toBe(TREE_STEP_MIN);
  });

  it('falls back to the step of today before the rail has a width', () => {
    expect(treeStep(0, 6)).toBe(TREE_STEP_MAX);
  });
});

describe('treeLabel', () => {
  it('leaves a note its extension unless asked not to', () => {
    expect(treeLabel('plan.md', 'file', true)).toBe('plan.md');
    expect(treeLabel('plan.md', 'file', false)).toBe('plan');
    expect(treeLabel('Plan.Markdown', 'file', false)).toBe('Plan');
  });

  it('keeps every other extension, a folder named like a note, and a name that is only an extension', () => {
    expect(treeLabel('diagram.png', 'file', false)).toBe('diagram.png');
    expect(treeLabel('notes.md', 'directory', false)).toBe('notes.md');
    expect(treeLabel('.md', 'file', false)).toBe('.md');
  });
});

describe('sharedStarts', () => {
  it('finds the start a name shares with a sibling, up to a separator', () => {
    const names = ['duckdb_ext_httpfs与远程读取', 'duckdb_ext_icu时区', '执行器_向量化', '存储_行组'];
    expect(sharedStarts(names)).toEqual(['duckdb_ext_', 'duckdb_ext_', '', '']);
  });

  it('shares only what ends at a separator, and never a whole name', () => {
    expect(sharedStarts(['report', 'reports'])).toEqual(['', '']);
    // Two dotfiles share only their dot, which says nothing and must not be dropped.
    expect(sharedStarts(['.hidden', '.hid2'])).toEqual(['', '']);
    expect(sharedStarts(['2026_11_03_a', '2026_11_05_b', '2026_10_28_c'])).toEqual(['2026_11_', '2026_11_', '2026_']);
  });
});

describe('fitName', () => {
  it('leaves a name that fits as it is', () => {
    expect(fitName('计划.md', 200, '', measure)).toEqual({ text: '计划.md', cut: false });
  });

  it('lets the start shared with siblings go first, so neighbouring rows still differ', () => {
    const shared = 'duckdb_ext_';
    const fitted = fitName('duckdb_ext_httpfs与远程读取', 120, shared, measure);
    expect(fitted.cut).toBe(true);
    expect(fitted.text.endsWith('httpfs与远程读取')).toBe(true);
    expect(measure(fitted.text)).toBeLessThanOrEqual(120);
  });

  it('keeps a short head and the end of a name with nothing shared', () => {
    const fitted = fitName('执行器_向量化与管道模型', 110, '', measure);
    expect(fitted.cut).toBe(true);
    expect(fitted.text.startsWith('执行')).toBe(true);
    expect(fitted.text.endsWith('模型')).toBe(true);
    expect(fitted.text).toContain('…');
    expect(measure(fitted.text)).toBeLessThanOrEqual(110);
  });

  it('cuts at the end only when the room is too small for a head and an end', () => {
    const fitted = fitName('一二三四五六七八', 40, '', measure);
    expect(fitted.cut).toBe(true);
    expect(measure(fitted.text)).toBeLessThanOrEqual(40);
  });

  it('keeps what follows the shared start when even that is too wide, and lets the end go', () => {
    const fitted = fitName('duckdb_ext_httpfs与远程读取', 84, 'duckdb_ext_', measure);
    expect(fitted.text.startsWith('…httpfs')).toBe(true);
    expect(measure(fitted.text)).toBeLessThanOrEqual(84);
  });
});

describe('fitLabel', () => {
  it('leaves a name that fits with its extension', () => {
    expect(fitLabel('计划.md', 'file', 200, '', measure)).toEqual({ text: '计划.md', cut: false });
  });

  it('lets a note give up its extension before anything else', () => {
    expect(fitLabel('执行器_向量化.md', 'file', 100, '', measure)).toEqual({ text: '执行器_向量化', cut: true });
  });

  it('keeps the extension of anything that is not a note, and of a folder', () => {
    const picture = fitLabel('架构图_第三版_最终.png', 'file', 90, '', measure);
    expect(picture.text.endsWith('.png')).toBe(true);
  });
});

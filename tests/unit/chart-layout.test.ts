import { describe, expect, it } from 'vitest';
import { isXyChart, labelWidth, readXyShape, xyLayout } from '../../src/renderer/diagram/chart-layout';

// The daily digest's ParseBench chart, as written: twelve model names under twelve bars.
const DIGEST = [
  'xychart-beta',
  '    title "ParseBench-2 总分（六维平均，0 到 100）"',
  '    x-axis ["LP Agentic Plus", "LP Agentic", "Claude Opus 5.5", "LP Cost Eff.", "Gemini 4 argon", "Reducto agentic", "Extend Parse 2", "Pulse Ultra 2", "Datalab", "GPT-5.6 terra", "Infinity-Parser2 Pro", "Databricks"]',
  '    y-axis "分数" 70 --> 92',
  '    bar [89.8, 86.0, 85.7, 84.6, 84.2, 83.9, 83.2, 82.7, 81.3, 77.1, 77.1, 76.9]',
].join('\n');

describe('how an xychart is laid out', () => {
  it('knows an xychart, behind a comment or front matter too', () => {
    expect(isXyChart(DIGEST)).toBe(true);
    expect(isXyChart('%% made by the digest\nxychart\n  bar [1]')).toBe(true);
    expect(isXyChart('---\nconfig:\n  theme: base\n---\nxychart-beta\n  bar [1]')).toBe(true);
    expect(isXyChart('flowchart LR\n  A --> B')).toBe(false);
  });

  it('reads the categories, quoted or not, and the series', () => {
    const shape = readXyShape(DIGEST);
    expect(shape.categories).toHaveLength(12);
    expect(shape.categories[0]).toBe('LP Agentic Plus');
    expect(shape).toMatchObject({ bars: 1, lines: 0, orientation: null, hasTitle: true });
    expect(readXyShape('xychart-beta\n  x-axis [Jan, Feb, "Mar, late"]\n  bar [1,2,3]\n  line [3,2,1]').categories).toEqual(['Jan', 'Feb', 'Mar, late']);
    expect(readXyShape('xychart-beta\n  x-axis 0 --> 10\n  line [1,2]').categories).toEqual([]);
  });

  it('turns the digest chart on its side, a row per model, as wide as the column', () => {
    const layout = xyLayout(readXyShape(DIGEST), 986);
    expect(layout.chartOrientation).toBe('horizontal');
    expect(layout.width).toBe(960);
    expect(layout.height).toBe(12 * 30 + 110);
    // One series of close scores: read by its values, set beside the bars.
    expect(layout).toMatchObject({ showDataLabel: true, showDataLabelOutsideBar: true });
  });

  it('keeps short labels upright, and draws a chart of a few bars narrower, not as slabs', () => {
    const layout = xyLayout(readXyShape('xychart-beta\n  x-axis [高基数, 中基数, 低基数]\n  bar [1.18, 2.11, 2.07]\n  line [1.22, 3.35, 1.96]'), 900);
    expect(layout.chartOrientation).toBe('vertical');
    expect(layout.width).toBe(220 + 3 * 130);
    // Many upright categories take the column.
    const many = readXyShape(`xychart-beta\n  x-axis [${Array.from({ length: 8 }, (_, at) => `Q${at}`).join(', ')}]\n  bar [1,2,3,4,5,6,7,8]`);
    expect(xyLayout(many, 900).width).toBe(900);
    // A bar and a line: no values printed over each other.
    expect(layout.showDataLabel).toBe(false);
  });

  it('turns a chart on its side when the column narrows under its labels', () => {
    const shape = readXyShape('xychart-beta\n  x-axis [Nezha, ServerStatus, NodeStatus, NodeLite, Komari, Beszel]\n  bar [1,2,3,4,5,6]');
    expect(xyLayout(shape, 960).chartOrientation).toBe('vertical');
    expect(xyLayout(shape, 420).chartOrientation).toBe('horizontal');
  });

  it('leaves an orientation the note wrote alone', () => {
    const upright = xyLayout(readXyShape(DIGEST.replace('xychart-beta', 'xychart-beta vertical')), 986);
    expect(upright.chartOrientation).toBe('vertical');
  });

  it('measures a CJK label as wider than a Latin one of the same length', () => {
    expect(labelWidth('数据湖仓')).toBeGreaterThan(labelWidth('data'));
  });
});

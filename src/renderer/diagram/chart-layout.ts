/**
 * How an xychart is laid out, from what it holds and the room it has.
 *
 * Mermaid draws every xychart at 700 by 500 whatever the column, and never
 * looks at its labels: twelve model names under twelve bars overlap one
 * another into a smear, and a chart of four short labels sits small in a
 * column of a thousand pixels. The author's vault holds fifty-one xycharts,
 * most of them written by the daily digest, so the fix belongs here rather
 * than in each note.
 *
 * The chart takes the column's width. When its category labels would not fit
 * under their bars at that width, it is turned on its side: bars run across,
 * one row per category, each label in full on the left, and the chart is as
 * tall as its rows. A single series of bars carries its values at the bar
 * ends, since a chart of close scores is read by its numbers. Type is a step
 * under mermaid's, nearer the page's own.
 *
 * Whatever the note says wins: an orientation written after `xychart` is
 * mermaid's own and overrides this, and so does an `%%{init}` directive or a
 * front-matter config, which mermaid merges over the configuration given here.
 *
 * Pure, so the decision can be checked without a frame.
 */

/** What the decision is made from. */
export interface XyShape {
  /** The category labels on the x axis, or empty for a numeric axis. */
  readonly categories: readonly string[];
  readonly bars: number;
  readonly lines: number;
  /** Whether the source names an orientation itself (`xychart-beta horizontal`). */
  readonly orientation: 'horizontal' | 'vertical' | null;
  readonly hasTitle: boolean;
  /** The title's text, for fitting it to the width. */
  readonly title: string;
}

/** The parts of mermaid's `xyChart` configuration this sets. */
export interface XyLayout {
  readonly width: number;
  readonly height: number;
  readonly chartOrientation: 'horizontal' | 'vertical';
  readonly showDataLabel: boolean;
  readonly showDataLabelOutsideBar: boolean;
  readonly titleFontSize: number;
  readonly titlePadding: number;
  readonly xAxis: { readonly labelFontSize: number; readonly titleFontSize: number };
  readonly yAxis: { readonly labelFontSize: number; readonly titleFontSize: number };
}

const LABEL = 13;
const AXIS_TITLE = 14;
const TITLE = 16;
/** A row per category on its side: a bar and the air around it. */
const ROW = 30;
/** What a chart on its side spends besides its rows: title, value axis, padding. */
const FRAME = 110;
/** Narrower than this and the y axis and its labels leave no room to plot. */
const MIN_WIDTH = 360;
/** Wider than this and a chart is a banner: the column is capped for it. */
const MAX_WIDTH = 960;

/** Whether the source is an xychart, and so laid out here. */
export function isXyChart(source: string): boolean {
  return /^\s*(?:%%.*\n\s*)*xychart(?:-beta)?\b/.test(stripFrontMatter(source));
}

function stripFrontMatter(source: string): string {
  return source.replace(/^\s*---\n[\s\S]*?\n---\n/, '');
}

/** Read what the layout depends on out of the chart's source, leniently. */
export function readXyShape(source: string): XyShape {
  const body = stripFrontMatter(source);
  const head = /^\s*(?:%%.*\n\s*)*xychart(?:-beta)?[ \t]+(horizontal|vertical)\b/m.exec(body);
  const axis = /^\s*x-axis\b[^\n[]*\[([^\]\n]*)\]/m.exec(body);
  const categories = axis ? splitList(axis[1]!) : [];
  return {
    categories,
    bars: (body.match(/^\s*bar\b/gm) ?? []).length,
    lines: (body.match(/^\s*line\b/gm) ?? []).length,
    orientation: head ? (head[1] as 'horizontal' | 'vertical') : null,
    hasTitle: /^\s*title\b/m.test(body),
    title: (/^\s*title\s+"?([^"\n]*)"?/m.exec(body)?.[1] ?? '').trim(),
  };
}

/** `"a, b", c, "d"` as its items, quotes taken off, commas inside quotes kept. */
function splitList(list: string): string[] {
  const items: string[] = [];
  const pattern = /\s*(?:"([^"]*)"|([^,]+))\s*(?:,|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(list)) !== null && match[0].length > 0) {
    const item = (match[1] ?? match[2] ?? '').trim();
    if (item.length > 0) items.push(item);
  }
  return items;
}

/** A label's width in pixels at `size`, near enough: a CJK character is an em, anything else about 0.58 of one. */
export function labelWidth(label: string, size = LABEL): number {
  let ems = 0;
  for (const character of label) ems += /[\u2e80-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(character) ? 1 : 0.58;
  return ems * size;
}

/** The layout for a chart of `shape` in a column `available` pixels wide. */
export function xyLayout(shape: XyShape, available: number): XyLayout {
  const column = Math.round(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, available)));
  const count = shape.categories.length;
  const widest = Math.max(0, ...shape.categories.map((label) => labelWidth(label)));
  // The plot is what is left beside the value axis, shared out among the bars.
  const slot = count > 0 ? (column - 90) / count : Infinity;
  // A label fits under its bar with a little air either side.
  const fits = widest + 10 <= slot;
  const orientation = shape.orientation ?? (count > 0 && !fits ? 'horizontal' : 'vertical');
  // Upright with a handful of categories, a bar across a third of the column
  // is a slab: the chart is drawn narrower, and centred, the way a person
  // would size a small chart, while a long title still has the column.
  const titleWidth = labelWidth(shape.title, TITLE) + 40;
  // Every label still needs its slot, the outer two half of theirs again past the bars.
  const labelsWidth = 90 + count * (widest + 24) + widest;
  const width = orientation === 'vertical' && count > 0 && count <= 6
    ? Math.round(Math.min(column, Math.max(MIN_WIDTH, 220 + count * 130, titleWidth, labelsWidth)))
    : column;
  const height = orientation === 'horizontal' && count > 0
    ? Math.round(Math.min(1400, Math.max(240, count * ROW + FRAME - (shape.hasTitle ? 0 : 30))))
    // Upright, the value axis needs a line of label per tick: never shorter
    // than about ten of them with the title and the category labels.
    : Math.round(Math.max(420, Math.min(520, width * 0.5)));
  // One series of bars is read by its values; with lines over them, or several
  // series, the numbers would sit on top of one another.
  const labelled = shape.bars === 1 && shape.lines === 0 && count > 0 && count <= 30;
  return {
    width,
    height,
    chartOrientation: orientation,
    showDataLabel: labelled,
    showDataLabelOutsideBar: labelled,
    // A title is one line and mermaid does not wrap it: a long one is set smaller rather than cut off.
    titleFontSize: Math.max(12, Math.min(TITLE, Math.floor((width - 24) / Math.max(1, labelWidth(shape.title, 1))))),
    // Upright, the tallest bar's value sits above it, and a bar that reaches
    // the top of the axis would put it on the title: room for one line of it.
    titlePadding: labelled && orientation === 'vertical' ? 10 + Math.round(LABEL * 1.4) : 10,
    xAxis: { labelFontSize: LABEL, titleFontSize: AXIS_TITLE },
    yAxis: { labelFontSize: LABEL, titleFontSize: AXIS_TITLE },
  };
}

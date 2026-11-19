/**
 * The colours a diagram is drawn in, from the app's palette.
 *
 * Mermaid's `base` theme takes a handful of colours and derives the rest, and
 * for the charts it does not derive them at all: an xychart's series come from
 * a fixed list that opens with a cream and runs through peach, salmon and a
 * bright yellow (#FFF4DD, #FFD8B1, #FFA07A, #FFD74D, #FFFFF0), a pie's second
 * and later slices come out as the paper itself, and a journey's sections are
 * cornsilk. On the light theme the first are near white against the page and
 * the second glare, so a bar chart of the author's (the vault holds fifty-one
 * xycharts) read as pale smears with a yellow line through them.
 *
 * So every colour a chart uses is given here, from one series of eight the
 * theme defines (`--chart-1` to `--chart-8`): muted earth and ink hues that sit
 * with the paper and the terracotta accent. Each is at least 4.5:1 against the
 * paper in both themes, so a line or a bar reads on the page and a label set
 * on a slice in the paper's colour reads on the slice. Where a diagram fills a
 * large area behind text (a timeline's sections, a gantt's tasks, a journey's
 * stages) it gets a tint of the same hue mixed into the paper, with the ink on
 * it, which keeps the text above 5:1.
 *
 * Pure, so the colours can be checked without a frame.
 */

import type { DiagramPalette } from './protocol';

/** How much of a series colour goes into its tint, by theme: dark paper needs more to show. */
const TINT = { light: 0.22, dark: 0.38 };

/** A colour as `#rrggbb`, from the forms a token is written in, or null. */
export function toHex(colour: string): string | null {
  const value = colour.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(value);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  if (/^#[0-9a-f]{6}$/.test(value)) return value;
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(value);
  if (rgb) return `#${rgb.slice(1, 4).map((part) => Math.min(255, Number(part)).toString(16).padStart(2, '0')).join('')}`;
  return null;
}

/** `share` of `colour` over `ground`, or `colour` itself when either cannot be read. */
export function mix(colour: string, ground: string, share: number): string {
  const [a, b] = [toHex(colour), toHex(ground)];
  if (!a || !b) return colour;
  const channel = (at: number) => Math.round(parseInt(a.slice(at, at + 2), 16) * share + parseInt(b.slice(at, at + 2), 16) * (1 - share));
  return `#${[1, 3, 5].map((at) => channel(at).toString(16).padStart(2, '0')).join('')}`;
}

/** Relative luminance of a colour, 0 to 1, or null when it cannot be read. */
export function luminance(colour: string): number | null {
  const hex = toHex(colour);
  if (!hex) return null;
  const linear = (at: number) => {
    const value = parseInt(hex.slice(at, at + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(1) + 0.7152 * linear(3) + 0.0722 * linear(5);
}

/** The contrast ratio of two colours, 1 to 21, or null when either cannot be read. */
export function contrast(a: string, b: string): number | null {
  const [x, y] = [luminance(a), luminance(b)];
  if (x === null || y === null) return null;
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * The text colour for a label on `fill`: `current` when it already reads at
 * 4.5:1, otherwise whichever of the two inks reads better. A note that fills
 * a node with a pale pastel of its own (`classDef ... fill:#fff3e0`, the
 * vault's commonest) and leaves the text to the theme would otherwise get the
 * dark theme's light ink on near white.
 */
export function labelColourOn(fill: string, current: string, inks: readonly [string, string]): string {
  const now = contrast(current, fill);
  if (now === null || now >= 4.5) return current;
  const [a, b] = inks.map((ink) => contrast(ink, fill) ?? 0);
  return a! >= b! ? inks[0] : inks[1];
}

/** The series, cycled to `length`. */
const cycle = (series: readonly string[], length: number) => Array.from({ length }, (_, at) => series[at % series.length]!);

/**
 * Mermaid theme variables for every chart and diagram kind, from the palette.
 * Merged over the structural ones (nodes, edges, actors) the frame sets.
 */
export function chartVariables(palette: DiagramPalette, dark: boolean): Record<string, unknown> {
  // `lineColorN` is lightened or darkened by 20% where mermaid uses it (the
  // timeline's rules); written here it is the series colour itself.
  const series = palette.series.length > 0 ? palette.series : [palette.accent];
  const strong = cycle(series, 12);
  const tint = strong.map((colour) => mix(colour, palette.paper, dark ? TINT.dark : TINT.light));
  const numbered = (prefix: string, values: readonly string[], count: number) =>
    Object.fromEntries(Array.from({ length: count }, (_, at) => [`${prefix}${at}`, values[at]!]));
  return {
    // Bars and lines: the full series, on the page's own ground.
    xyChart: {
      backgroundColor: palette.paper,
      titleColor: palette.inkStrong,
      dataLabelColor: palette.ink,
      legendTextColor: palette.ink,
      xAxisTitleColor: palette.ink,
      xAxisLabelColor: palette.ink,
      xAxisTickColor: palette.muted,
      xAxisLineColor: palette.lineStrong,
      yAxisTitleColor: palette.ink,
      yAxisLabelColor: palette.ink,
      yAxisTickColor: palette.muted,
      yAxisLineColor: palette.lineStrong,
      plotColorPalette: series.join(','),
    },
    // Slices: the full series, parted by the paper, labelled in the paper's colour.
    ...Object.fromEntries(strong.map((colour, at) => [`pie${at + 1}`, colour])),
    pieStrokeColor: palette.paper,
    pieStrokeWidth: '2px',
    pieOuterStrokeColor: palette.hairline,
    pieOuterStrokeWidth: '1px',
    pieOpacity: '1',
    pieSectionTextColor: palette.paper,
    pieTitleTextColor: palette.inkStrong,
    pieLegendTextColor: palette.ink,
    // Sections behind text (timeline, mindmap, journey): tints, with the ink on them.
    ...numbered('cScale', tint, 12),
    // A section's rule and edge in its own hue, never mermaid's inverted
    // complement, which put a slate rule on a terracotta box.
    ...numbered('cScaleInv', strong, 12),
    ...Object.fromEntries(strong.map((colour, at) => [`lineColor${at}`, colour])),
    ...numbered('cScalePeer', strong, 12),
    ...numbered('cScaleLabel', Array<string>(12).fill(palette.ink), 12),
    ...numbered('fillType', tint, 8),
    // Gantt: quiet bands, tasks in the blue tint, the critical ones in the accent's.
    sectionBkgColor: palette.raised,
    sectionBkgColor2: palette.raised,
    altSectionBkgColor: palette.paper,
    gridColor: palette.hairline,
    todayLineColor: palette.accent,
    excludeBkgColor: palette.raised,
    taskBkgColor: tint[1],
    taskBorderColor: strong[1],
    activeTaskBkgColor: tint[3],
    activeTaskBorderColor: strong[3],
    doneTaskBkgColor: palette.raised,
    doneTaskBorderColor: palette.lineStrong,
    critBkgColor: tint[0],
    critBorderColor: strong[0],
    taskTextColor: palette.ink,
    taskTextLightColor: palette.ink,
    taskTextDarkColor: palette.ink,
    taskTextOutsideColor: palette.ink,
    taskTextClickableColor: palette.accent,
    // Git graph: a branch per series colour, labelled in the paper's colour.
    ...numbered('git', strong, 8),
    ...numbered('gitBranchLabel', Array<string>(8).fill(palette.paper), 8),
    commitLabelColor: palette.ink,
    commitLabelBackground: palette.raised,
    tagLabelColor: palette.ink,
    tagLabelBackground: palette.raised,
    tagLabelBorder: palette.lineStrong,
    // Quadrant chart: four tints, points in the accent's hue.
    quadrant1Fill: tint[1],
    quadrant2Fill: tint[2],
    quadrant3Fill: tint[3],
    quadrant4Fill: tint[0],
    quadrant1TextFill: palette.ink,
    quadrant2TextFill: palette.ink,
    quadrant3TextFill: palette.ink,
    quadrant4TextFill: palette.ink,
    quadrantPointFill: strong[0],
    quadrantPointTextFill: palette.ink,
    quadrantXAxisTextFill: palette.ink,
    quadrantYAxisTextFill: palette.ink,
    quadrantInternalBorderStrokeFill: palette.hairline,
    quadrantExternalBorderStrokeFill: palette.lineStrong,
    quadrantTitleFill: palette.inkStrong,
    radar: { axisColor: palette.muted, graticuleColor: palette.hairline },
    // A journey's faces, which mermaid fills cornsilk whatever the theme.
    faceColor: tint[3],
    // Entity rows, state groups and notes: the paper's own two tones, a note in the ochre tint.
    attributeBackgroundColorOdd: palette.paper,
    attributeBackgroundColorEven: palette.raised,
    labelBackgroundColor: palette.paper,
    altBackground: palette.raised,
    compositeBackground: palette.paper,
    compositeTitleBackground: palette.raised,
    specialStateColor: palette.muted,
    innerEndBackground: palette.ink,
    noteBkgColor: tint[3],
    noteBorderColor: mix(strong[3]!, palette.paper, 0.45),
    noteTextColor: palette.ink,
  };
}

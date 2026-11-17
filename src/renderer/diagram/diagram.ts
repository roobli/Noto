/**
 * The diagram frame.
 *
 * Mermaid draws a diagram by writing an SVG full of inline styles, which the
 * editor's content security policy refuses, and it does so from text the
 * reader wrote, which the editor does not run. So it runs here, in a frame
 * sandboxed to nothing: no origin, no bridge, no way to reach the page that
 * holds it. The page posts a source and a palette in; the frame posts a
 * height or an error out. Nothing else crosses.
 */

import mermaid from 'mermaid';
import { isXyChart, readXyShape, xyLayout } from './chart-layout';
import { bundleFanOuts } from './flow-bundle';
import { chartVariables, labelColourOn, mix } from './chart-theme';
import type { DiagramReply, DiagramRequest } from './protocol';

const container = document.getElementById('diagram') as HTMLDivElement;

let latest = 0;
/** The last request drawn, and the width it was laid out for, so a chart that lays out by width can be drawn again when the column changes. */
let lastRequest: DiagramRequest | null = null;
let laidOutFor = 0;
/** Whether the last request is waiting for the frame to be given a width. */
let awaitingRoom = false;
/** Under this the frame has not been laid out: an xychart is not drawn for it. */
const MIN_ROOM = 120;

/** The room the drawing has: the frame's own width, which the page sets to the column's. */
const room = () => document.documentElement.clientWidth || window.innerWidth;

function reply(message: DiagramReply): void {
  window.parent.postMessage(message, '*');
}

function isRequest(data: unknown): data is DiagramRequest {
  if (typeof data !== 'object' || data === null) return false;
  const record = data as Record<string, unknown>;
  return record.type === 'noto-diagram-render'
    && typeof record.serial === 'number'
    && typeof record.source === 'string'
    && typeof record.font === 'string'
    && typeof record.dark === 'boolean'
    && typeof record.palette === 'object' && record.palette !== null
    && Array.isArray((record.palette as { series?: unknown }).series);
}

function measure(): { width: number; height: number } {
  const svg = container.querySelector('svg');
  if (!svg) return { width: 0, height: 0 };
  const rect = svg.getBoundingClientRect();
  return { width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
}

async function draw(request: DiagramRequest): Promise<void> {
  const { serial, source, palette, dark, font } = request;
  latest = serial;
  lastRequest = request;
  // A chart laid out by width waits until the frame has one: off screen, the
  // editor has not laid the frame out yet, and a chart drawn for no width
  // would be drawn at the narrowest and then again.
  if (isXyChart(source) && room() < MIN_ROOM) { awaitingRoom = true; return; }
  awaitingRoom = false;
  laidOutFor = room();
  // An xychart is laid out for the column and its labels (chart-layout.ts);
  // what the note says in its own source or directive still wins.
  const xyChart = isXyChart(source) ? xyLayout(readXyShape(source), laidOutFor) : undefined;
  mermaid.initialize({
    startOnLoad: false,
    // Strict: no click handlers, no scripts in labels, HTML in labels sanitised.
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: 'base',
    darkMode: dark,
    ...(xyChart ? { xyChart } : {}),
    // A journey's people and sections are configuration, not theme: lawn
    // green, cyan and pale yellow by default, whatever the theme says.
    journey: {
      actorColours: palette.series.length > 0 ? [...palette.series] : [palette.accent],
      sectionFills: palette.series.length > 0 ? [...palette.series] : [palette.accent],
      sectionColours: [palette.paper],
    },
    fontFamily: font,
    themeVariables: {
      darkMode: dark,
      background: palette.paper,
      fontFamily: font,
      fontSize: '14px',
      primaryColor: palette.raised,
      primaryTextColor: palette.ink,
      primaryBorderColor: palette.lineStrong,
      secondaryColor: palette.raised,
      secondaryTextColor: palette.ink,
      secondaryBorderColor: palette.hairline,
      tertiaryColor: palette.paper,
      tertiaryTextColor: palette.ink,
      tertiaryBorderColor: palette.hairline,
      lineColor: palette.muted,
      textColor: palette.ink,
      mainBkg: palette.raised,
      nodeBorder: palette.lineStrong,
      nodeTextColor: palette.ink,
      clusterBkg: palette.paper,
      clusterBorder: palette.hairline,
      titleColor: palette.inkStrong,
      edgeLabelBackground: palette.paper,
      actorBkg: palette.raised,
      actorBorder: palette.lineStrong,
      actorTextColor: palette.ink,
      actorLineColor: palette.hairline,
      signalColor: palette.ink,
      signalTextColor: palette.ink,
      labelBoxBkgColor: palette.raised,
      labelBoxBorderColor: palette.lineStrong,
      labelTextColor: palette.ink,
      loopTextColor: palette.ink,
      activationBkgColor: mix(palette.raised, palette.ink, 0.9),
      activationBorderColor: palette.lineStrong,
      sequenceNumberColor: palette.paper,
      // Every chart's colours, from the theme's series: see chart-theme.ts.
      ...chartVariables(palette, dark),
    },
  });
  try {
    // A many-to-many statement is drawn as one bundle through a junction (flow-bundle.ts).
    const { svg } = await mermaid.render(`noto-diagram-${serial}`, bundleFanOuts(source));
    if (serial !== latest) return;
    container.innerHTML = svg;
    settleJunctions(palette);
    if (xyChart) {
      settleBars(xyChart.chartOrientation);
      capValueLabels(xyChart.xAxis.labelFontSize);
    }
    settleColours(palette);
    reply({ type: 'noto-diagram-rendered', serial, ...measure() });
  } catch (error) {
    if (serial !== latest) return;
    container.replaceChildren();
    const text = error instanceof Error ? error.message : String(error);
    reply({ type: 'noto-diagram-failed', serial, message: text.split('\n', 1)[0].slice(0, 200) });
  }
}

/**
 * The junctions a fan-out is drawn through (flow-bundle.ts), as small dots
 * in the colour of the lines they join. Mermaid draws its small circle as an
 * empty ring in the node colours, which on the paper all but disappears and
 * reads, where it shows, as a node with nothing in it.
 */
function settleJunctions(palette: DiagramRequest['palette']): void {
  for (const dot of container.querySelectorAll<SVGCircleElement>('svg g.node[id*="noto_junction_"] circle')) {
    dot.setAttribute('r', '3.5');
    dot.style.setProperty('fill', palette.muted, 'important');
    dot.style.setProperty('stroke', palette.muted, 'important');
    dot.style.setProperty('stroke-width', '1px', 'important');
  }
}

/**
 * An xychart's bars, mended where mermaid draws them wrong.
 *
 * On its side, mermaid starts every bar at the left edge of the plot box
 * rather than at the value axis's zero, which sits some pixels in: every bar
 * is drawn that much too long, so 41, 358 and 565 on an axis to 80,000 come
 * out the same length. Each bar is started where its baseline value is on the
 * axis, read off the axis's own ticks. And a line drawn over bars is moved
 * above them, so its points are not hidden under the bar tops.
 */
function settleBars(orientation: 'horizontal' | 'vertical'): void {
  const svg = container.querySelector('svg');
  if (!svg) return;
  const plot = svg.querySelector('g.plot');
  if (plot) for (const line of [...plot.querySelectorAll(':scope > g[class^="line-plot"]')]) plot.append(line);
  if (orientation !== 'horizontal') return;
  // On its side the value axis runs along the top (or the bottom), each label
  // a number placed at its value by a translate.
  const placed = (label: SVGTextElement) => {
    const shift = /translate\(\s*([-\d.]+)/.exec(label.getAttribute('transform') ?? '');
    return shift ? Number(shift[1]) : Number(label.getAttribute('x'));
  };
  const ticks = [...svg.querySelectorAll<SVGTextElement>('g.top-axis g.label text, g.bottom-axis g.label text')]
    .map((label) => ({ value: Number((label.textContent ?? '').replace(/,/g, '')), x: placed(label) }))
    .filter((tick) => Number.isFinite(tick.value) && Number.isFinite(tick.x));
  if (ticks.length < 2) return;
  const [first, last] = [ticks[0]!, ticks[ticks.length - 1]!];
  if (last.value === first.value) return;
  const at = (value: number) => first.x + (value - first.value) * (last.x - first.x) / (last.value - first.value);
  // A bar grows from zero, or from the axis's own start when zero is off it.
  const base = at(Math.max(first.value, Math.min(last.value, 0)));
  for (const bar of svg.querySelectorAll<SVGRectElement>('g.plot g[class^="bar-plot"] rect')) {
    const x = Number(bar.getAttribute('x'));
    const end = x + Number(bar.getAttribute('width'));
    if (!Number.isFinite(x) || !Number.isFinite(end) || Math.abs(x - base) < 0.5) continue;
    bar.setAttribute('x', String(Math.min(base, end)));
    bar.setAttribute('width', String(Math.abs(end - base)));
  }
}

/**
 * An xychart's values, at one size, the size of its other labels.
 *
 * Mermaid fits the numbers beside its bars to the bars, each bar's to its own
 * then all to the smallest: two wide bars with four digits come out at 85
 * pixels, larger than the title they run into, and a short bar among tall ones
 * takes every value down to three. They are set at the axis labels' size, and
 * one that would not fit inside its bar sits just past its end instead, which
 * is where `showDataLabelOutsideBar` puts them anyway.
 */
function capValueLabels(size: number): void {
  const svg = container.querySelector('svg');
  const box = svg?.viewBox.baseVal;
  for (const label of container.querySelectorAll<SVGTextElement>('svg [class*="bar-plot"] text')) {
    label.setAttribute('font-size', `${size}px`);
    if (!box || box.width === 0) continue;
    // A value past the end of the longest bar would run off the drawing: it
    // goes inside the bar's end instead, where the label colours read on it.
    const ink = label.getBBox();
    const gap = 10;
    if (ink.x + ink.width > box.width - 2) {
      label.setAttribute('x', String(Number(label.getAttribute('x')) - 2 * gap));
      label.setAttribute('text-anchor', 'end');
    } else if (ink.x < 2) {
      label.setAttribute('x', String(Number(label.getAttribute('x')) + 2 * gap));
      label.setAttribute('text-anchor', 'start');
    } else if (ink.y < 2) {
      label.setAttribute('y', String(Number(label.getAttribute('y')) + 2 * gap));
      label.setAttribute('dominant-baseline', 'hanging');
    }
  }
}

/**
 * What the theme cannot reach, mended after drawing.
 *
 * A label sits on whatever its node is filled with, and a note may fill a
 * node itself (`style`, `classDef`) while leaving the text to the theme; on
 * the dark theme that is light ink on a pale pastel. Each label is set in an
 * ink that reads on the fill behind it. And a few strokes mermaid draws in
 * plain black whatever the theme (a sequence diagram's arrowheads, a gantt's
 * ticks) are drawn in the theme's line colour, so they show on dark paper.
 */
function settleColours(palette: DiagramRequest['palette']): void {
  const svg = container.querySelector('svg');
  if (!svg) return;
  const inks: [string, string] = [palette.inkStrong, palette.paper];
  const filled = (element: Element): string | null => {
    const fill = getComputedStyle(element).fill;
    if (!fill || fill === 'none' || fill === 'rgb(0, 0, 0)' || /rgba\([^)]*,\s*0\)/.test(fill)) return null;
    return fill;
  };
  // The fill a label is drawn on: the nearest enclosing group's shape that
  // the label's centre is inside. A legend's swatch or a chart's point sits
  // beside its label, not under it, and does not count.
  const groundOf = (label: Element): string | null => {
    const box = label.getBoundingClientRect();
    const [x, y] = [box.left + box.width / 2, box.top + box.height / 2];
    for (let at: Element | null = label.parentElement; at && at !== svg; at = at.parentElement) {
      if (at.localName !== 'g') continue;
      for (const child of at.children) {
        if (!/^(rect|polygon|circle|ellipse|path)$/.test(child.localName)) continue;
        const rect = child.getBoundingClientRect();
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
        const fill = filled(child);
        if (fill) return fill;
      }
    }
    return null;
  };
  // An HTML label is a few nested elements; the colour that shows is the innermost one's.
  const labels: Element[] = [...svg.querySelectorAll('text'), ...svg.querySelectorAll('foreignObject')];
  for (const label of labels) {
    if ((label.textContent ?? '').trim().length === 0) continue;
    const ground = groundOf(label);
    if (ground === null) continue;
    const isText = label.localName === 'text';
    const leaf = isText ? label : [...label.querySelectorAll('*')].reverse().find((node) => node.childElementCount === 0 && (node.textContent ?? '').trim()) ?? label;
    const current = isText ? getComputedStyle(label).fill : getComputedStyle(leaf).color;
    const wanted = labelColourOn(ground, current, inks);
    if (wanted === current) continue;
    if (isText) (label as SVGElement).style.setProperty('fill', wanted, 'important');
    else for (const node of label.querySelectorAll<HTMLElement>('*')) node.style.setProperty('color', wanted, 'important');
  }
  // A tinted box with nothing round it reads as a patch of colour, not a box:
  // a timeline's periods and events get a rule in their own hue, at the
  // strength a hairline has against the paper.
  for (const node of svg.querySelectorAll<SVGElement>('g.timeline-node')) {
    const shape = node.querySelector<SVGElement>(':scope > g > path, :scope > g > rect');
    const rule = node.querySelector('line');
    if (!shape || !rule) continue;
    const hue = getComputedStyle(rule).stroke;
    if (hue && hue !== 'none') {
      shape.style.setProperty('stroke', mix(hue, palette.paper, 0.4));
      shape.style.setProperty('stroke-width', '1px');
    }
  }
  for (const element of svg.querySelectorAll<SVGElement>('path, line, polyline, polygon')) {
    const style = getComputedStyle(element);
    if (style.stroke === 'rgb(0, 0, 0)') element.style.setProperty('stroke', palette.muted);
    if (style.fill === 'rgb(0, 0, 0)' && element.closest('marker')) element.style.setProperty('fill', palette.muted);
  }
}

window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  if (!isRequest(event.data)) return;
  void draw(event.data);
});

// A diagram may name a link, and mermaid draws it as a real anchor even at
// its strictest. The page holding this frame lets no pointer event reach it
// and the sandbox opens no window, but neither is this frame's to rely on:
// nothing here is ever followed.
document.addEventListener('click', (event) => event.preventDefault(), true);
document.addEventListener('auxclick', (event) => event.preventDefault(), true);

// The page that holds the frame sizes it by what is reported; when the frame
// is made narrower the drawing scales and its height changes with it.
new ResizeObserver(() => {
  if (!container.querySelector('svg')) return;
  reply({ type: 'noto-diagram-rendered', serial: latest, ...measure() });
}).observe(container);

// An xychart laid out for one column width is laid out again when the column
// changes enough to matter: a window made narrower can put its labels back on
// top of one another, or a wider one leave the chart small in the middle.
let relayout = 0;
new ResizeObserver(() => {
  if (!lastRequest || !isXyChart(lastRequest.source) || room() < MIN_ROOM) return;
  window.clearTimeout(relayout);
  // The first width it is given is drawn at once; a change after that waits for the resize to settle.
  if (awaitingRoom) { void draw(lastRequest); return; }
  if (Math.abs(room() - laidOutFor) < 40) return;
  relayout = window.setTimeout(() => {
    if (lastRequest) void draw(lastRequest);
  }, 150);
}).observe(document.documentElement);

reply({ type: 'noto-diagram-ready' });

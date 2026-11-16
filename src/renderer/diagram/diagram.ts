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
import { chartVariables, labelColourOn, mix } from './chart-theme';
import type { DiagramReply, DiagramRequest } from './protocol';

const container = document.getElementById('diagram') as HTMLDivElement;

let latest = 0;

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
  mermaid.initialize({
    startOnLoad: false,
    // Strict: no click handlers, no scripts in labels, HTML in labels sanitised.
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: 'base',
    darkMode: dark,
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
    const { svg } = await mermaid.render(`noto-diagram-${serial}`, source);
    if (serial !== latest) return;
    container.innerHTML = svg;
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

reply({ type: 'noto-diagram-ready' });

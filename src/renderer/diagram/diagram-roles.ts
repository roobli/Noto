/**
 * Semantic role classes and layout defaults for Mermaid 12 diagrams.
 *
 * A note names what a box is (`:::core`, `:::store`, `:::gate`, `class ds core`)
 * rather than writing hex codes in every diagram. Each role resolves to a
 * light fill, a darker same-hue stroke, and an ink that clears 4.5:1 on that
 * fill in both the light and dark themes. A `classDef` the note writes under
 * the same name comes after these or overrides them; this only supplies the
 * defaults when the note has not defined that role itself.
 *
 * Layout choice is likewise inferred only for flowcharts when the note has not
 * chosen one: a flowchart with `subgraph` containers gets Mermaid 12's bundled
 * ELK engine (orthogonal ports, line hops, parallel items inside a layer laid
 * out in a row), while a flat flowchart without subgraphs keeps `dagre`, whose
 * fan-in/fan-out trees stay compact and symmetric. Every other diagram kind
 * (mindmap's `cose-bilkent`, sequence, xychart, erDiagram) keeps Mermaid's own
 * per-diagram default, and any `layout` in the note's YAML front matter or
 * `%%{init}%%` directive wins untouched.
 *
 * Pure text and colour math, so every rule is unit-tested without a frame.
 */

import { labelColourOn, mix, toHex } from './chart-theme';
import type { DiagramPalette } from './protocol';

export interface RoleStyle {
  readonly fill: string;
  readonly stroke: string;
  readonly text: string;
  readonly strokeWidth: number;
  readonly dash?: string;
}

export type RoleName = 'core' | 'ours' | 'store' | 'gate' | 'async' | 'other' | 'client' | 'risk';

const ROLE_ORDER: readonly RoleName[] = ['core', 'ours', 'store', 'gate', 'async', 'other', 'client', 'risk'];

/**
 * The eight semantic roles derived from the active `DiagramPalette`, normalized
 * to `#rrggbb` so commas in `rgb(...)` tokens can never split a Mermaid `classDef`.
 */
export function semanticRoles(palette: DiagramPalette, dark: boolean): Readonly<Record<RoleName, RoleStyle>> {
  const series = palette.series;
  const hex = (value: string, fallback: string) => toHex(value) ?? fallback;
  const pick = (index: number, fallback: string) => hex(series[index] ?? '', fallback);

  const paper = hex(palette.paper, dark ? '#1f1e1c' : '#faf9f6');
  const raised = hex(palette.raised, dark ? '#292826' : '#f2f1ee');
  const ink = hex(palette.ink, dark ? '#d7d4cf' : '#34312e');
  const inkStrong = hex(palette.inkStrong, dark ? '#f1eee8' : '#201e1c');
  const muted = hex(palette.muted, dark ? '#97928b' : '#6f6b66');
  const lineStrong = hex(palette.lineStrong, dark ? '#5c584f' : '#c9c3bb');

  const coreHue = hex(palette.accent, dark ? '#e0a07a' : '#a85d3b');
  const oursHue = pick(1, dark ? '#7f98bc' : '#3e6187');
  const gateHue = pick(2, dark ? '#8da874' : '#4f7543');
  const storeHue = pick(3, dark ? '#be9b52' : '#8c6514');
  const asyncHue = pick(4, dark ? '#b489a8' : '#7e4c6e');
  const riskHue = dark ? '#d88780' : '#a64440';

  const tintShare = dark ? 0.28 : 0.14;
  const coreShare = dark ? 0.32 : 0.16;
  const inks: readonly [string, string] = [inkStrong, paper];

  const make = (hue: string, share: number, strokeWidth: number, dash?: string): RoleStyle => {
    const fill = mix(hue, paper, share);
    const stroke = dark ? mix(hue, inkStrong, 0.85) : hue;
    const preferred = dark ? inkStrong : mix(hue, inkStrong, 0.35);
    const text = hex(labelColourOn(fill, preferred, inks), inkStrong);
    return dash ? { fill, stroke, text, strokeWidth, dash } : { fill, stroke, text, strokeWidth };
  };

  const otherFill = dark ? mix(raised, ink, 0.08) : raised;

  return {
    core: make(coreHue, coreShare, 1.8),
    ours: make(oursHue, tintShare, 1.3),
    store: make(storeHue, tintShare, 1.3),
    gate: make(gateHue, tintShare, 1.3),
    async: make(asyncHue, tintShare, 1.3),
    other: {
      fill: otherFill,
      stroke: lineStrong,
      text: hex(labelColourOn(otherFill, ink, inks), inkStrong),
      strokeWidth: 1.2,
    },
    client: {
      fill: paper,
      stroke: mix(muted, paper, dark ? 0.72 : 0.62),
      text: hex(labelColourOn(paper, ink, inks), inkStrong),
      strokeWidth: 1.2,
      dash: '4 3',
    },
    risk: make(riskHue, tintShare, 1.3),
  };
}

/** Strip leading comments and YAML front matter to inspect the diagram keyword. */
export function stripDiagramHeader(source: string): string {
  return source
    .replace(/^\s*(?:%%[^\n]*\n\s*)*/, '')
    .replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '')
    .replace(/^\s*(?:%%[^\n]*\n\s*)*/, '');
}

/** Whether the source is a flowchart or block diagram that accepts `classDef`. */
export function acceptsRoleClasses(source: string): boolean {
  const body = stripDiagramHeader(source);
  return /^(?:flowchart(?:-elk)?|graph|block(?:-beta)?)\b/.test(body);
}

/** Names the note already gave its own `classDef`, which must not be overwritten. */
function authorDefinedClasses(source: string): Set<string> {
  const defined = new Set<string>();
  const re = /^\s*classDef\s+([A-Za-z0-9_,-]+)\b/gm;
  for (let hit = re.exec(source); hit !== null; hit = re.exec(source)) {
    for (const name of hit[1]!.split(',')) {
      const trimmed = name.trim();
      if (trimmed) defined.add(trimmed);
    }
  }
  return defined;
}

/**
 * Append Noto's semantic `classDef` lines to flowcharts and block diagrams,
 * skipping any role name the note defined itself so author styles always win.
 */
export function injectSemanticRoles(source: string, palette: DiagramPalette, dark: boolean): string {
  if (!acceptsRoleClasses(source)) return source;
  const own = authorDefinedClasses(source);
  const roles = semanticRoles(palette, dark);
  const needed = ROLE_ORDER.filter((name) => {
    if (own.has(name)) return false;
    const usedInline = new RegExp(`:::${name}\\b`).test(source);
    const usedStmt = new RegExp(`^\\s*class\\s+[^;\\n]+\\s+${name}\\b`, 'm').test(source);
    return usedInline || usedStmt;
  });
  if (needed.length === 0) return source;
  const lines = needed.map((name) => {
    const r = roles[name];
    const dash = r.dash ? `,stroke-dasharray:${r.dash}` : '';
    return `  classDef ${name} fill:${r.fill},stroke:${r.stroke},stroke-width:${r.strokeWidth}px,color:${r.text}${dash}`;
  });
  return `${source}\n${lines.join('\n')}`;
}

/**
 * Whether the diagram explicitly names a `layout` inside YAML front matter, an
 * `%%{init:...}%%` directive block, or via the `flowchart-elk` keyword.
 */
export function hasExplicitLayout(source: string): boolean {
  const fmMatch = /^\s*---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (fmMatch && /^\s*layout\s*:/m.test(fmMatch[1]!)) return true;
  const initRe = /%%\{\s*init\s*:([\s\S]*?)\}%%/gi;
  for (let hit = initRe.exec(source); hit !== null; hit = initRe.exec(source)) {
    if (/["']?layout["']?\s*:/.test(hit[1]!)) return true;
  }
  const body = stripDiagramHeader(source);
  return /^flowchart-elk\b/.test(body);
}

/**
 * Layout override to pass to `mermaid.initialize`, or `undefined` when Mermaid's
 * own per-diagram default should stand:
 * - If the note explicitly specified a layout, return `undefined` so Mermaid
 *   honours the note's directive without interference.
 * - For flowcharts (`flowchart` / `graph`): `elk` when `subgraph` containers are
 *   present, `dagre` when flat.
 * - For every other diagram type (`mindmap` uses `cose-bilkent`, `erDiagram` and
 *   `stateDiagram` already default to `elk` in Mermaid 12): return `undefined`.
 */
export function preferredLayout(source: string): 'elk' | 'dagre' | undefined {
  if (hasExplicitLayout(source)) return undefined;
  const body = stripDiagramHeader(source);
  if (/^(?:flowchart|graph)\b/.test(body)) {
    return /^\s*subgraph\b/m.test(body) ? 'elk' : 'dagre';
  }
  return undefined;
}

import { describe, expect, it } from 'vitest';
import { contrast } from '../../src/renderer/diagram/chart-theme';
import {
  acceptsRoleClasses,
  hasExplicitLayout,
  injectSemanticRoles,
  preferredLayout,
  semanticRoles,
  type RoleName,
} from '../../src/renderer/diagram/diagram-roles';
import type { DiagramPalette } from '../../src/renderer/diagram/protocol';
import { detectLanguage } from '../../src/renderer/editor/noto/detect-language';

const LIGHT: DiagramPalette = {
  paper: '#FAF9F6', raised: '#F2F1EE', ink: '#34312E', inkStrong: '#201E1C', muted: '#6F6B66',
  hairline: '#DDD9D2', lineStrong: '#C9C3BB', accent: '#A85D3B',
  series: ['#A5562F', '#3E6187', '#4F7543', '#8C6514', '#7E4C6E', '#2E6E69', '#6E655B', '#5C5B9A'],
};
const DARK: DiagramPalette = {
  paper: '#1F1E1C', raised: '#292826', ink: '#D7D4CF', inkStrong: '#F1EEE8', muted: '#97928B',
  hairline: '#3B3935', lineStrong: '#5C584F', accent: '#E0A07A',
  series: ['#C98A63', '#7F98BC', '#8DA874', '#BE9B52', '#B489A8', '#6CA59E', '#A39A8D', '#9594C8'],
};

const ALL_ROLES: readonly RoleName[] = ['core', 'ours', 'store', 'gate', 'async', 'other', 'client', 'risk'];

describe('semantic diagram roles and layout selection', () => {
  it('keeps every role readable at >= 4.5:1 on its fill in both light and dark themes', () => {
    for (const [palette, dark] of [[LIGHT, false], [DARK, true]] as const) {
      const roles = semanticRoles(palette, dark);
      for (const name of ALL_ROLES) {
        const role = roles[name];
        expect(contrast(role.text, role.fill), `${name} (${dark ? 'dark' : 'light'})`).toBeGreaterThanOrEqual(4.5);
      }
      expect(roles.client.dash).toBe('4 3');
    }
  });

  it('injects classDef only for roles referenced in flowcharts or block diagrams', () => {
    const plain = 'flowchart TB\n  A --> B';
    expect(injectSemanticRoles(plain, LIGHT, false)).toBe(plain);

    const used = [
      'flowchart TB',
      '  svc["search-service"]:::core --> db[("Postgres")]',
      '  class db store',
      '  ext["caller"]:::client --> svc',
    ].join('\n');
    const injected = injectSemanticRoles(used, LIGHT, false);
    expect(injected).toContain('classDef core ');
    expect(injected).toContain('classDef store ');
    expect(injected).toContain('classDef client ');
    expect(injected).toContain('stroke-dasharray:4 3');
    expect(injected).not.toContain('classDef async ');

    const blockSrc = 'block-beta\n  columns 2\n  a["exit"]:1 b["budget"]:1\n  class a core';
    expect(injectSemanticRoles(blockSrc, DARK, true)).toContain('classDef core ');
    expect(acceptsRoleClasses('erDiagram\n  person ||--o{ link : id')).toBe(false);
  });

  it('never overrides a classDef the note defined itself', () => {
    const custom = [
      'flowchart LR',
      '  A:::core --> B:::ours',
      '  classDef core fill:#ffeedd,stroke:#993300',
    ].join('\n');
    const out = injectSemanticRoles(custom, LIGHT, false);
    expect(out.match(/classDef core\b/g)).toHaveLength(1);
    expect(out).toContain('classDef ours ');
  });

  it('normalizes rgb() tokens to hex so commas never break Mermaid classDef', () => {
    const rgbPalette: DiagramPalette = {
      ...LIGHT,
      accent: 'rgb(168, 93, 59)',
      paper: 'rgb(250, 249, 246)',
      series: ['rgb(165, 86, 47)', 'rgb(62, 97, 135)'],
    };
    const injected = injectSemanticRoles('flowchart LR\n  A:::core --> B:::ours', rgbPalette, false);
    expect(injected).not.toContain('rgb(');
    expect(injected).toMatch(/classDef core fill:#[0-9a-f]{6},stroke:#[0-9a-f]{6}/);
  });

  it('picks ELK for nested subgraph architectures, dagre for flat flowcharts, and undefined for non-flowcharts or explicit overrides', () => {
    expect(preferredLayout('flowchart TB\n  A --> B')).toBe('dagre');
    expect(preferredLayout('graph LR\n  A --> B')).toBe('dagre');
    expect(preferredLayout('flowchart TB\n  subgraph G["core"]\n    A --> B\n  end')).toBe('elk');
    // Mindmaps keep cose-bilkent; ER diagrams keep Mermaid's own ELK default
    expect(preferredLayout('mindmap\n  root((Noto))\n    A\n    B')).toBeUndefined();
    expect(preferredLayout('erDiagram\n  person ||--o{ link : id')).toBeUndefined();
    expect(preferredLayout('---\nconfig:\n  layout: dagre\n---\nflowchart TB\n  subgraph G\n    A\n  end')).toBeUndefined();

    expect(hasExplicitLayout('flowchart TB\n  A --> B')).toBe(false);
    // A label containing "layout:" after an init directive without layout must NOT count as explicit layout
    expect(hasExplicitLayout('%%{init: {"theme": "base"}}%%\nflowchart LR\n  A["layout: grid"] --> B')).toBe(false);
    expect(hasExplicitLayout('---\nconfig:\n  layout: dagre\n---\nflowchart TB\n  subgraph G\n    A\n  end')).toBe(true);
    expect(hasExplicitLayout('%%{init: {"layout": "elk"}}%%\nflowchart LR\n  A --> B')).toBe(true);
    expect(hasExplicitLayout('flowchart-elk TB\n  A --> B')).toBe(true);
  });

  it('detects new Mermaid 12 headers without misclassifying YAML or Python', () => {
    expect(detectLanguage('treeView-beta\n├── src/\n└── README.md')).toBe('mermaid');
    expect(detectLanguage('block-beta\n  columns 3\n  a b c')).toBe('mermaid');
    expect(detectLanguage('xychart-beta horizontal\n  bar [1, 2, 3]')).toBe('mermaid');
    expect(detectLanguage('name: ci\narchitecture: x86_64\nblock:\n  key: value')).toBe('yaml');
    expect(detectLanguage('import os\ndef run():\n    block = [1, 2, 3]\n    return block\n')).toBe('python');
  });
});

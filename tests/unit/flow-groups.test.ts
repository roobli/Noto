import { describe, expect, it } from 'vitest';
import { drawWholeGroups, subgraphMembers } from '../../src/renderer/diagram/flow-groups';

// A billing diagram shaped like the one that tangled: five writers, three tables, a service that writes two.
const BILLING = [
  'flowchart LR',
  '    subgraph P["billing：发"]',
  '        P1["付款回调<br/>订阅、充值"]',
  '        P2["注册"]',
  '        P3["邀请奖励 worker"]',
  '        P4["兑换码"]',
  '        P5["运维命令行"]',
  '    end',
  '    subgraph DB["账库"]',
  '        B["buckets<br/>每笔一行"]',
  '        Q["quotas<br/>账号总额"]',
  '        L["ledger<br/>发放流水"]',
  '    end',
  '    subgraph M["api：扣"]',
  '        CP["purpose.py<br/>每种来源的用途"]',
  '        M1["搜索、详情、探测"]',
  '        M2["解锁联系方式"]',
  '    end',
  '    P1 & P2 & P3 & P4 & P5 --> B & Q & L',
  '    CP -.-> M1 & M2',
  '    M1 & M2 --> B & Q',
].join('\n');

describe('a statement naming a whole group, drawn as the group', () => {
  it('reads each group\'s nodes, labels and line breaks aside', () => {
    const groups = subgraphMembers(BILLING);
    expect([...groups.get('P')!].sort()).toEqual(['P1', 'P2', 'P3', 'P4', 'P5']);
    expect([...groups.get('DB')!].sort()).toEqual(['B', 'L', 'Q']);
    expect([...groups.get('M')!].sort()).toEqual(['CP', 'M1', 'M2']);
  });

  it('draws the platform writing every table as one arrow from the platform box to each table', () => {
    // The sources are drawn as their group; the tables keep their names.
    expect(drawWholeGroups(BILLING)).toContain('\n    P --> B & Q & L\n');
    // The other way round, the sources are the tables, and it is they that become their group.
    const flipped = BILLING.replace('P1 & P2 & P3 & P4 & P5 --> B & Q & L', 'B & Q & L --> P1 & P2 & P3 & P4 & P5');
    expect(drawWholeGroups(flipped)).toContain('    DB --> P1 & P2 & P3 & P4 & P5\n');
  });

  it('keeps a group drawn as an arrow\'s end laid out the way the chart runs', () => {
    const drawn = drawWholeGroups(BILLING);
    // Mermaid would turn it top-to-bottom, a row of five boxes; the chart runs left to right.
    expect(drawn).toContain('    subgraph P["billing：发"]\n        direction LR\n');
    // The tables are not drawn as a group here, so their group is left as written.
    expect(drawn).toContain('    subgraph DB["账库"]\n        B[');
    // A group not drawn as an end is left as written.
    expect(drawn).toContain('    subgraph M["api：扣"]\n        CP[');
    // A direction the note gave a group is kept.
    const stated = drawWholeGroups(BILLING.replace('subgraph P["billing：发"]', 'subgraph P["billing：发"]\n        direction TB'));
    expect(stated).not.toContain('direction TB\n        direction LR');
    expect(stated.match(/direction/g)).toHaveLength(1);
  });

  it('keeps a statement that names only some of a group, so which ones stays visible', () => {
    const drawn = drawWholeGroups(BILLING);
    // The api writes two of the three tables, from two of its three nodes.
    expect(drawn).toContain('    M1 & M2 --> B & Q');
    expect(drawn).toContain('    CP -.-> M1 & M2');
  });

  it('never ends an arrow on a group, and leaves one-to-many and many-to-one as written', () => {
    expect(drawWholeGroups(BILLING.replace('P1 & P2 & P3 & P4 & P5 --> B & Q & L', 'P1 & P2 & P3 & P4 & P5 --> B & Q'))).toContain('    P --> B & Q');
    // The targets are the whole database, but an arrow stays on its named tables.
    const partial = BILLING.replace('P1 & P2 & P3 & P4 & P5 --> B & Q & L', 'P1 & P2 --> B & Q & L');
    expect(drawWholeGroups(partial)).toBe(partial);
    // A node to a whole group, or a whole group to a node, is three lines and stays three named lines.
    const fan = BILLING.replace('P1 & P2 & P3 & P4 & P5 --> B & Q & L', 'CP --> B & Q & L\n    P1 & P2 & P3 & P4 & P5 --> CP');
    expect(drawWholeGroups(fan)).toBe(fan);
  });

  it('counts a nested group\'s nodes as the outer group\'s too', () => {
    const nested = 'flowchart TD\n  subgraph O\n    A\n    subgraph I\n      B\n      C\n    end\n  end\n  A & B & C --> X & Y\n  B & C --> X & Y';
    const drawn = drawWholeGroups(nested);
    expect(drawn).toContain('O --> X & Y');
    expect(drawn).toContain('I --> X & Y');
  });

  it('leaves a chart with no groups, a labelled arrow, and other diagram kinds as written', () => {
    const plain = 'flowchart LR\n  A & B --> C & D';
    expect(drawWholeGroups(plain)).toBe(plain);
    const labelled = BILLING.replace('P1 & P2 & P3 & P4 & P5 --> B & Q & L', 'P1 & P2 & P3 & P4 & P5 -- 写入 --> B & Q & L');
    expect(drawWholeGroups(labelled)).toBe(labelled);
    const sequence = 'sequenceDiagram\n  A->>B: hi';
    expect(drawWholeGroups(sequence)).toBe(sequence);
  });

  it('does not use a group whose members it cannot be sure of', () => {
    // B is in both groups: mermaid places it in one, and which is not for this to guess.
    const shared = 'flowchart LR\n  subgraph G1\n    A\n    B\n  end\n  subgraph G2\n    B\n    C\n  end\n  A & B --> X & Y';
    expect(drawWholeGroups(shared)).toBe(shared);
  });
});

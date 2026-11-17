import { describe, expect, it } from 'vitest';
import { bundleFanOuts, isFlowchart } from '../../src/renderer/diagram/flow-bundle';

describe('a flowchart\'s many-to-many lines, drawn through a junction', () => {
  it('draws five to three as five lines in and three out, not fifteen', () => {
    const out = bundleFanOuts('flowchart LR\n    P1 & P2 & P3 & P4 & P5 --> B & Q & L');
    expect(out).toContain('P1 & P2 & P3 & P4 & P5 --- noto_junction_1 --> B & Q & L');
    expect(out).toContain('noto_junction_1@{ shape: sm-circ }');
  });

  it('keeps the kind of line: dotted stays dotted, thick stays thick', () => {
    expect(bundleFanOuts('graph TD\n  A & B -.-> C & D')).toContain('A & B -.- noto_junction_1 -.-> C & D');
    expect(bundleFanOuts('graph TD\n  A & B ==> C & D')).toContain('A & B === noto_junction_1 ==> C & D');
  });

  it('leaves one-to-many, many-to-one, labelled and shaped statements as written', () => {
    const kept = [
      'flowchart LR\n  CP -.-> M1 & M2',
      'flowchart LR\n  M1 & M2 --> B',
      'flowchart LR\n  F & G & H -- 成功 --> I & J',
      'flowchart LR\n  U2 & S2 --> T["依次扣"] & X',
    ];
    for (const source of kept) expect(bundleFanOuts(source)).toBe(source);
  });

  it('touches only flowcharts', () => {
    expect(isFlowchart('%% note\nflowchart LR\n A-->B')).toBe(true);
    const sequence = 'sequenceDiagram\n  A & B --> C & D';
    expect(bundleFanOuts(sequence)).toBe(sequence);
  });

  it('numbers each junction, so two fan-outs in one chart stay apart', () => {
    const out = bundleFanOuts('flowchart LR\n  A & B --> C & D\n  E & F --> G & H');
    expect(out).toContain('noto_junction_1 -->');
    expect(out).toContain('noto_junction_2 -->');
  });
});

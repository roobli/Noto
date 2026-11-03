/**
 * Typora's `flow` and `sequence` fences, read as mermaid.
 *
 * The fences here are the ones in the author's own Typora notes, so what is
 * pinned is that those notes draw, and what each line becomes.
 */

import { describe, expect, it } from 'vitest';
import { diagramDialect, flowToMermaid, sequenceToMermaid, toMermaid } from '../../src/renderer/diagram/legacy-diagrams';

const lines = (result: ReturnType<typeof toMermaid>): string[] => {
  if ('error' in result) throw new Error(result.error);
  return result.source.split('\n');
};

describe('which fences are diagrams', () => {
  it('reads mermaid, flow and sequence in any case, and nothing else', () => {
    expect(diagramDialect('mermaid')).toBe('mermaid');
    expect(diagramDialect(' Mermaid ')).toBe('mermaid');
    expect(diagramDialect('FLOW')).toBe('flow');
    expect(diagramDialect('sequence')).toBe('sequence');
    expect(diagramDialect('flowchart')).toBeNull();
    expect(diagramDialect('js')).toBeNull();
    expect(diagramDialect('')).toBeNull();
  });

  it('passes mermaid through untouched', () => {
    expect(toMermaid('mermaid', 'graph LR\nA-->B')).toEqual({ source: 'graph LR\nA-->B' });
  });
});

describe('a sequence fence', () => {
  it('draws the note: actors in the order they appear, notes and both kinds of line', () => {
    const result = lines(sequenceToMermaid([
      'Title: 标题：复杂使用',
      '对象A->对象B: 对象B你好吗?（请求）',
      'Note right of 对象B: 对象B的描述',
      'Note left of 对象A: 对象A的描述(提示)',
      '对象B-->对象A: 我很好(响应)',
      '对象B->小三: 你好吗',
      '小三-->>对象A: 对象B找我了',
      'Note over 小三,对象B: 我们是朋友',
      'participant C',
      'Note right of C: 没人陪我玩',
    ].join('\n')));
    expect(result).toEqual([
      'sequenceDiagram',
      '  title 标题：复杂使用',
      '  participant a0 as 对象A',
      '  participant a1 as 对象B',
      '  participant a2 as 小三',
      '  participant a3 as C',
      '  a0->>a1: 对象B你好吗?（请求）',
      '  Note right of a1: 对象B的描述',
      '  Note left of a0: 对象A的描述(提示)',
      '  a1-->>a0: 我很好(响应)',
      '  a1->>a2: 你好吗',
      '  a2--)a0: 对象B找我了',
      '  Note over a2,a1: 我们是朋友',
      '  Note right of a3: 没人陪我玩',
    ]);
  });

  it('keeps an open head open, and a name with spaces or a dash whole', () => {
    const result = lines(sequenceToMermaid('web server->>job queue: enqueue\njob queue-->>web server: done'));
    expect(result).toContain('  participant a0 as web server');
    expect(result).toContain('  a0-)a1: enqueue');
    expect(result).toContain('  a1--)a0: done');
  });

  it('uses the alias in signals and shows the name', () => {
    const result = lines(sequenceToMermaid('participant Alice Smith as A\nA->B: hi'));
    expect(result).toContain('  participant a0 as Alice Smith');
    expect(result).toContain('  a0->>a1: hi');
  });

  it('writes the characters mermaid reads as syntax as entities', () => {
    const result = lines(sequenceToMermaid('A->B: one; two #3'));
    expect(result).toContain('  a0->>a1: one#59; two #35;3');
  });

  it('breaks a message or note at \\n, as js-sequence-diagrams does', () => {
    const result = lines(sequenceToMermaid('A->B: first\\nsecond\nNote right of B: one\\ntwo'));
    expect(result).toContain('  a0->>a1: first<br/>second');
    expect(result).toContain('  Note right of a1: one<br/>two');
  });

  it('reads a second arrow on one line as an error, not as part of a name', () => {
    expect(sequenceToMermaid('A->B->C: x')).toEqual({ error: 'line 1 is not sequence syntax: A->B->C: x' });
  });

  it('says which line it cannot read', () => {
    expect(sequenceToMermaid('A->B: fine\nthis is not a signal')).toEqual({
      error: 'line 2 is not sequence syntax: this is not a signal',
    });
  });
});

describe('a flow fence', () => {
  it('draws the note: every symbol in its shape, and yes and no on the edges they leave by', () => {
    const result = lines(flowToMermaid([
      'st=>start: 开始框',
      'op=>operation: 处理框',
      'cond=>condition: 判断框(是或否?)',
      'sub1=>subroutine: 子流程',
      'io=>inputoutput: 输入输出框',
      'e=>end: 结束框',
      'st->op->cond',
      'cond(yes)->io->e',
      'cond(no)->sub1(right)->op',
    ].join('\n')));
    expect(result).toEqual([
      'flowchart TD',
      '  n0(["开始框"])',
      '  n1["处理框"]',
      '  n2{"判断框(是或否?)"}',
      '  n3[["子流程"]]',
      '  n4[/"输入输出框"/]',
      '  n5(["结束框"])',
      '  n0 --> n1',
      '  n1 --> n2',
      '  n2 -->|yes| n4',
      '  n4 --> n5',
      '  n2 -->|no| n3',
      '  n3 --> n1',
    ]);
  });

  it('drops side hints, links and states, and never uses a name mermaid reserves', () => {
    const result = lines(flowToMermaid([
      'end=>end: Done:>https://example.com[blank]',
      'op=>operation: Work|past',
      'op(right)->end',
      'cond=>condition: Ok?',
      'cond(yes, bottom)->op',
    ].join('\n')));
    expect(result).toContain('  n0(["Done"])');
    expect(result).toContain('  n1["Work"]');
    expect(result).toContain('  n1 --> n0');
    expect(result).toContain('  n2 -->|yes| n1');
    expect(result.some((line) => /\bend\b/.test(line))).toBe(false);
  });

  it('keeps a bar in a label that is not a flowchart.js state', () => {
    expect(lines(flowToMermaid('op=>operation: a|b'))).toContain('  n0["a|b"]');
  });

  it('draws a name that is connected but never defined as a plain box', () => {
    expect(lines(flowToMermaid('a=>start: A\na->b'))).toContain('  n1["b"]');
  });

  it('says which line it cannot read', () => {
    expect(flowToMermaid('st=>start: A\nnonsense here')).toEqual({ error: 'line 2 is not flow syntax: nonsense here' });
  });
});

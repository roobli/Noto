import { describe, expect, it } from 'vitest';
import katex from 'katex';
import { mathContextOf, prepared } from '../../src/renderer/editor/noto/math-context';

const typesets = (source: string, display: boolean, context: ReturnType<typeof mathContextOf>) => {
  const ready = prepared(source, display, context);
  return katex.renderToString(ready.source, { displayMode: display, macros: ready.macros, throwOnError: true, strict: false });
};

describe('a formula read with the rest of its note', () => {
  it('numbers labelled blocks and resolves references to them', () => {
    const context = mathContextOf([
      { text: 'a^2 + b^2 = c^2 \\tag{1}', display: true },
      { text: 'e^{i\\pi} + 1 = 0 \\label{euler}', display: true },
      { text: 'x \\label{p} \\tag{P}', display: true },
    ]);
    expect(context.labels.get('euler')).toBe('1');
    expect(context.labels.get('p')).toBe('P');
    expect(prepared('e^{i\\pi} + 1 = 0 \\label{euler}', true, context).source).toBe('e^{i\\pi} + 1 = 0 \\tag{1}');
    expect(prepared('\\eqref{euler} and \\ref{p} and \\eqref{nope}', false, context).source)
      .toBe('\\text{(1)} and \\text{P} and \\text{(??)}');
    expect(() => typesets('\\eqref{euler}', false, context)).not.toThrow();
  });

  it('shares a macro the note defines with every formula, the defining one included', () => {
    const definer = '\\newcommand{\\vect}[1]{\\boldsymbol{#1}}\n\\vect{F} = m\\vect{a}';
    const context = mathContextOf([{ text: definer, display: true }, { text: '\\vect{v}', display: false }]);
    expect(() => typesets('\\vect{v} = \\vect{v}_0 + \\vect{a}t', false, context)).not.toThrow();
    expect(() => typesets(definer, true, context)).not.toThrow();
  });

  it('typesets chemistry', async () => {
    await import('katex/contrib/mhchem');
    expect(() => katex.renderToString('\\ce{2H2 + O2 -> 2H2O}', { throwOnError: true })).not.toThrow();
  });
});

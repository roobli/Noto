import { describe, expect, it } from 'vitest';
import { notoSchema } from '../../src/shared/markdown/v3/pm/schema';
import { canHighlight, guessedLanguage, rangesFor } from '../../src/renderer/editor/noto/highlight';
import { LANGUAGES, PLAIN_TEXT } from '../../src/renderer/editor/noto/languages';

function codeBlock(lang: string, code: string) {
  return notoSchema.nodes.code_block.create({ lang, fenced: true }, notoSchema.text(code));
}

/** The class list a decoration would carry for the text at `offset`. */
function classAt(node: ReturnType<typeof codeBlock>, offset: number): string | null {
  const range = rangesFor(node).find((candidate) => offset >= candidate.from && offset < candidate.to);
  return range?.className ?? null;
}

describe('code fence highlighting', () => {
  it('colours every language the fence list offers, by every name it lists', () => {
    const drawn = new Set(['mermaid', 'flow', 'sequence', 'timeline', PLAIN_TEXT]);
    for (const entry of LANGUAGES) {
      if (drawn.has(entry.id)) continue;
      for (const name of [entry.id, ...entry.aliases]) expect(canHighlight(name), name).toBe(true);
    }
  });

  it('tokenises a fence into ranges that line up with the source offsets', () => {
    const code = 'const answer = 42;';
    const node = codeBlock('ts', code);
    const ranges = rangesFor(node);
    expect(ranges.length).toBeGreaterThan(0);

    // `const` is a keyword, and the range must cover exactly those characters.
    const keyword = ranges.find((range) => range.from === 0);
    expect(keyword?.to).toBe(5);
    expect(keyword?.className).toContain('keyword');

    // Every range stays inside the text it came from.
    for (const range of ranges) {
      expect(range.from).toBeGreaterThanOrEqual(0);
      expect(range.to).toBeLessThanOrEqual(code.length);
      expect(range.from).toBeLessThan(range.to);
    }
  });

  it('resolves the short language names people type', () => {
    expect(rangesFor(codeBlock('ts', 'const a = 1;')).length).toBeGreaterThan(0);
    expect(rangesFor(codeBlock('py', 'def f(): pass')).length).toBeGreaterThan(0);
    expect(rangesFor(codeBlock('sh', 'echo hi')).length).toBeGreaterThan(0);
    expect(rangesFor(codeBlock('yml', 'a: 1')).length).toBeGreaterThan(0);
  });

  it('leaves an unknown language, and code it cannot place, as plain text', () => {
    expect(rangesFor(codeBlock('', 'const a = 1;'))).toEqual([]);
    expect(rangesFor(codeBlock('not-a-language', 'const a = 1;'))).toEqual([]);
    expect(rangesFor(codeBlock(PLAIN_TEXT, 'kubectl get pods -A'))).toEqual([]);
  });

  it('colours a fence that names no language as what its code clearly is', () => {
    const node = codeBlock('', 'def greet(name):\n    return name\n');
    expect(guessedLanguage(node)).toBe('python');
    expect(rangesFor(node).some((range) => range.className.includes('keyword'))).toBe(true);
    expect(guessedLanguage(codeBlock('python', 'x'))).toBeNull();
  });

  it('never emits overlapping ranges, so decorations cannot stack', () => {
    const node = codeBlock('ts', 'export function f(a: string): number { return 1; }');
    const ranges = [...rangesFor(node)].sort((left, right) => left.from - right.from);
    for (let index = 1; index < ranges.length; index += 1) {
      expect(ranges[index].from).toBeGreaterThanOrEqual(ranges[index - 1].to);
    }
  });

  it('classifies a string and a comment distinctly from code', () => {
    const node = codeBlock('ts', '// note\nconst s = "text";');
    expect(classAt(node, 0)).toContain('comment');
    expect(classAt(node, '// note\nconst s = '.length)).toContain('string');
  });

  it('reuses tokens for an unchanged node instead of re-tokenising', () => {
    const node = codeBlock('ts', 'const answer = 42;');
    const first = rangesFor(node);
    const second = rangesFor(node);
    // Identity, not equality: an untouched fence must cost nothing on re-render.
    expect(second).toBe(first);
  });

  it('tokenises a different node separately', () => {
    const first = rangesFor(codeBlock('ts', 'const a = 1;'));
    const second = rangesFor(codeBlock('ts', 'const b = 2;'));
    expect(second).not.toBe(first);
    expect(second.length).toBeGreaterThan(0);
  });

  it('handles a large fence without pathological output', () => {
    const code = Array.from({ length: 500 }, (_, index) => `const value${index} = ${index};`).join('\n');
    const ranges = rangesFor(codeBlock('ts', code));
    expect(ranges.length).toBeGreaterThan(1000);
    expect(ranges.at(-1)!.to).toBeLessThanOrEqual(code.length);
  });
});

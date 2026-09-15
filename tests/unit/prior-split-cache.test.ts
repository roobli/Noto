/**
 * Host prior-split cache for flagged `replaceMarkdown` → `reparseFromText`.
 *
 * Micromark path is out of scope: the cache is only consulted when the
 * `@roobli/md` engine is selected.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { joinSplit } from '../../src/shared/markdown/v3/roobli-md-adapter';
import {
  PriorSplitCache,
  parseStructuralForTests,
  structuralSplitFromSpans,
} from '../../src/shared/markdown/v3/prior-split-cache';
import { setMarkdownEngineForTests } from '../../src/shared/markdown/v3/engine-flag';
import { splitBlocks } from '../../src/shared/markdown/v3/blocks';

afterEach(() => {
  setMarkdownEngineForTests(null);
});

describe('structuralSplitFromSpans', () => {
  it('rebuilds leading / gaps / trailing without reparsing', () => {
    const text = '# One\n\nTwo\n\nThree\n';
    const structural = parseStructuralForTests(text);
    const rebuilt = structuralSplitFromSpans(
      text,
      structural.spans.map((span) => ({
        kind: span.kind as 'heading' | 'paragraph',
        start: span.start,
        end: span.end,
        markdown: span.markdown,
      })),
    );
    expect(joinSplit(rebuilt)).toBe(text);
    expect(rebuilt.leading).toBe(structural.leading);
    expect([...rebuilt.gaps]).toEqual([...structural.gaps]);
    expect(rebuilt.trailing).toBe(structural.trailing);
    expect(rebuilt.spans.map((s) => s.markdown)).toEqual(structural.spans.map((s) => s.markdown));
  });
});

describe('PriorSplitCache', () => {
  it('full-splits when empty, then reparses a middle edit', () => {
    const cache = new PriorSplitCache();
    expect(cache.hasPrior).toBe(false);

    const first = cache.spansForReplace('# One\n\nTwo\n\nThree\n');
    expect(first.source).toBe('full');
    expect(cache.hasPrior).toBe(true);
    expect(first.spans.map((s) => s.markdown)).toEqual(['# One', 'Two', 'Three']);
    expect(first.spans.every((s) => s.node != null)).toBe(true);

    const second = cache.spansForReplace('# One\n\nDeux\n\nThree\n');
    expect(second.source).toBe('reparse');
    expect(second.spans.map((s) => s.markdown)).toEqual(['# One', 'Deux', 'Three']);
    expect(second.spans[1]!.node.type).toBe('paragraph');
    // Middle block should be inside the dirty window (slack may widen it).
    expect(second.dirtyFrom).toBeLessThanOrEqual(1);
    expect(second.dirtyTo).toBeGreaterThanOrEqual(1);
  });

  it('returns an empty dirty window when text is unchanged after seed', () => {
    const cache = new PriorSplitCache();
    const text = '# A\n\nB\n';
    cache.seedFromSplit(parseStructuralForTests(text));
    const result = cache.spansForReplace(text);
    expect(result.source).toBe('reparse');
    expect(result.dirtyTo).toBeLessThan(result.dirtyFrom);
    expect(result.spans.map((s) => s.markdown)).toEqual(['# A', 'B']);
  });

  it('falls back to a full split after invalidate (typing)', () => {
    const cache = new PriorSplitCache();
    cache.spansForReplace('# One\n\nTwo\n\nThree\n');
    expect(cache.hasPrior).toBe(true);

    cache.invalidate();
    expect(cache.hasPrior).toBe(false);

    const again = cache.spansForReplace('# One\n\nDeux\n\nThree\n');
    expect(again.source).toBe('full');
    expect(again.spans.map((s) => s.markdown)).toEqual(['# One', 'Deux', 'Three']);

    const third = cache.spansForReplace('# One\n\nDeux\n\nTrois\n');
    expect(third.source).toBe('reparse');
    expect(third.spans.map((s) => s.markdown)).toEqual(['# One', 'Deux', 'Trois']);
  });

  it('seedFromSpans matches open-path offsets used by the editor', () => {
    setMarkdownEngineForTests('roobli-md');
    const text = '```js\ncode\n```\n\nAfter\n';
    const opened = splitBlocks(text);
    const cache = new PriorSplitCache();
    cache.seedFromSpans(text, opened.spans);

    const next = '```js\ncode\n```\n\nChanged\n';
    const result = cache.spansForReplace(next);
    expect(result.source).toBe('reparse');
    expect(result.spans.map((s) => s.markdown)).toEqual(['```js\ncode\n```', 'Changed']);
    expect(result.spans.map((s) => next.slice(s.start, s.end))).toEqual(
      result.spans.map((s) => s.markdown),
    );
  });

  it('inserts a new block between neighbours', () => {
    const cache = new PriorSplitCache();
    cache.seedFromSplit(parseStructuralForTests('# One\n\nThree\n'));
    const result = cache.spansForReplace('# One\n\nTwo\n\nThree\n');
    expect(result.source).toBe('reparse');
    expect(result.spans.map((s) => s.markdown)).toEqual(['# One', 'Two', 'Three']);
  });
});

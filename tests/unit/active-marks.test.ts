/**
 * Which span reveals its markdown.
 *
 * The rule this pins is the one the block-scoped version got wrong: putting the
 * caret in a sentence must reveal the delimiters of the one span it is in, not
 * of every span in the paragraph. A list item naming eleven directories showed
 * eleven pairs of backticks at once, which is reading the source rather than
 * reading the document.
 */

import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { notoSchema } from '../../src/shared/markdown/v3/pm/schema';
import {
  containingMarkRanges, DELIMITERS, innermostRange,
} from '../../src/renderer/editor/noto/active-node-plugin';

const { emphasis, strong, inline_code: inlineCode, link } = notoSchema.marks;

/** A one-paragraph document, from a list of [text, marks] runs. */
function paragraph(runs: readonly (readonly [string, ReturnType<typeof emphasis.create>[]])[]) {
  const doc = notoSchema.node('doc', null, [
    notoSchema.node('paragraph', null, runs.map(([text, marks]) => notoSchema.text(text, marks))),
  ]);
  return EditorState.create({ doc });
}

/** The delimiters that would be drawn with the caret at `position`. */
function revealedAt(state: EditorState, position: number): string[] {
  const ranges = containingMarkRanges(state, position)
    .filter((range) => DELIMITERS[range.mark.type.name] !== undefined);
  const innermost = innermostRange(ranges);
  if (!innermost) return [];
  const spec = DELIMITERS[innermost.mark.type.name];
  return [spec.open, spec.close(innermost.mark)];
}

describe('revealing inline markdown', () => {
  it('reveals only the code span the caret is in, not its neighbours', () => {
    const state = paragraph([
      ['use ', []],
      ['X400', [inlineCode.create()]],
      [' or ', []],
      ['X405', [inlineCode.create()]],
      [' today', []],
    ]);
    // Positions: 1 starts the paragraph's content.
    const inFirst = 1 + 'use '.length + 1;
    const inSecond = 1 + 'use X400 or '.length + 1;
    expect(revealedAt(state, inFirst)).toEqual(['`', '`']);
    expect(revealedAt(state, inSecond)).toEqual(['`', '`']);
    // One span at a time, never both, which is the whole point.
    expect(containingMarkRanges(state, inFirst)).toHaveLength(1);
  });

  it('reveals nothing in plain prose', () => {
    const state = paragraph([['just words here', []]]);
    expect(revealedAt(state, 4)).toEqual([]);
  });

  it('reveals the innermost mark when marks nest', () => {
    const state = paragraph([
      ['bold ', [strong.create()]],
      ['and italic', [strong.create(), emphasis.create()]],
      [' end', [strong.create()]],
    ]);
    const inNested = 1 + 'bold '.length + 2;
    expect(revealedAt(state, inNested)).toEqual(['*', '*']);
  });

  it('falls back to the outer mark once the caret leaves the inner one', () => {
    const state = paragraph([
      ['bold ', [strong.create()]],
      ['and italic', [strong.create(), emphasis.create()]],
      [' end', [strong.create()]],
    ]);
    const inOuterOnly = 1 + 'bold and italic '.length;
    expect(revealedAt(state, inOuterOnly)).toEqual(['**', '**']);
  });

  it('shows a link destination, which is the part a reader cannot otherwise see', () => {
    const state = paragraph([
      ['see ', []],
      ['the docs', [link.create({ href: 'https://example.com/a' })]],
    ]);
    expect(revealedAt(state, 1 + 'see '.length + 2))
      .toEqual(['[', '](https://example.com/a)']);
  });

  it('reveals nothing while a range is selected', () => {
    const state = paragraph([['a ', []], ['word', [emphasis.create()]], [' b', []]]);
    const selected = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 1, 6)),
    );
    expect(selected.selection.empty).toBe(false);
  });

  // Whether the delimiters match what a save writes is checked in
  // `reveal-matches-save.test.ts`, against the serializer's real output. This
  // file used to assert the characters directly and passed for months while
  // showing an underscore the file no longer contained: two places naming the
  // same constant agreed with each other and not with the document.
});

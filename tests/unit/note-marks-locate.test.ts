/**
 * Finding a mark's words in the note as it stands: in running text and not
 * in code, headings, links or wiki links; the place whose neighbours agree
 * with what the plugin saw, when the words occur more than once; and nowhere
 * once they are gone.
 */

import { describe, expect, it } from 'vitest';
import { docFromSpans } from '../../src/shared/markdown/v3/pm/from-mdast';
import { splitBlocks } from '../../src/shared/markdown/v3/blocks';
import { locateMarks } from '../../src/renderer/editor/noto/note-marks-locate';

const doc = (markdown: string) => docFromSpans(splitBlocks(markdown).spans);
const textAt = (markdown: string, mark: { text: string; before: string; after: string }) => {
  const built = doc(markdown);
  return locateMarks(built, [{ key: 'k', ...mark }]).map((found) => built.textBetween(found.from, found.to));
};

describe('where a mark falls', () => {
  it('finds the words in running text, across emphasis', () => {
    expect(textAt('# Notes\n\nRead the **Argus** design first.\n', { text: 'Argus design', before: 'Read the ', after: ' first.' }))
      .toEqual(['Argus design']);
  });

  it('takes the place whose neighbours agree, when the words occur twice', () => {
    const markdown = 'Argus is old.\n\nWe moved to Argus last week.\n';
    const built = doc(markdown);
    const [found] = locateMarks(built, [{ key: 'k', text: 'Argus', before: 'We moved to ', after: ' last week.' }]);
    const second = built.child(1);
    let start = 0;
    built.forEach((node, offset, index) => { if (index === 1) start = offset; });
    expect(found!.from).toBeGreaterThan(start);
    expect(found!.from).toBeLessThan(start + second.nodeSize);
  });

  it('never marks code, a heading, a link or a wiki link, nor words no longer there', () => {
    const markdown = '# Argus\n\n`Argus` and [Argus](a.md) and [[Argus]].\n\n```\nArgus\n```\n';
    expect(textAt(markdown, { text: 'Argus', before: '', after: '' })).toEqual([]);
    expect(textAt('Nothing here.\n', { text: 'Argus', before: '', after: '' })).toEqual([]);
  });

  it('keeps two marks from overlapping', () => {
    const built = doc('The Argus Index is here.\n');
    const found = locateMarks(built, [
      { key: 'a', text: 'Argus Index', before: 'The ', after: ' is' },
      { key: 'b', text: 'Index', before: 'The Argus ', after: ' is' },
    ]);
    expect(found.map((item) => item.key)).toEqual(['a']);
  });

  it('finds whole words only, where words are spaced, and any run of Chinese', () => {
    expect(textAt('We flew from the AIRPORT.\n', { text: 'AI', before: '', after: '' })).toEqual([]);
    expect(textAt('We asked the AI first.\n', { text: 'AI', before: 'We asked the ', after: ' first.' })).toEqual(['AI']);
    expect(textAt('先读目标设计说明再动手。\n', { text: '目标设计说明', before: '先读', after: '再动手。' })).toEqual(['目标设计说明']);
  });

  it('guesses at no place when the words occur more than once and no neighbours agree', () => {
    const markdown = 'Argus was first.\n\nThen Argus again.\n';
    expect(textAt(markdown, { text: 'Argus', before: 'We moved to ', after: ' last week.' })).toEqual([]);
  });

  it('never marks frontmatter, math or raw HTML', () => {
    const markdown = '---\ntitle: Argus\n---\n\n$$\nArgus\n$$\n\n<div>Argus</div>\n';
    expect(textAt(markdown, { text: 'Argus', before: '', after: '' })).toEqual([]);
  });
});

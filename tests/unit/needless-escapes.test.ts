import { describe, expect, it } from 'vitest';
import { notoSchema } from '../../src/shared/markdown/v3/pm/schema';
import { blockToMarkdown } from '../../src/shared/markdown/v3/pm/to-mdast';

const { nodes } = notoSchema;
const paragraph = (text: string) => nodes.paragraph.create(null, notoSchema.text(text));
const md = (text: string) => blockToMarkdown(paragraph(text));

/*
 * Text the reader typed is written back as it was typed wherever the plain
 * characters read the same, as Typora writes it; a backslash goes in only
 * where the characters would otherwise mean markup.
 */
describe('a paragraph of plain text is written with no escape it does not need', () => {
  it('keeps underscores used as blanks to fill in', () => {
    expect(md('签字：____文元少')).toBe('签字：____文元少');
    expect(md('日期：__2026__ 年')).not.toContain('\\_\\_\\_');
  });

  it('keeps a colon and an angle bracket that open nothing', () => {
    // A bare address typed as text keeps the escape in its colon: without it
    // the address would open as a link, which the text was not.
    expect(md('see https://img.roobli.org/a.png here')).toBe('see https\\://img.roobli.org/a.png here');
    expect(md('a < b and c > d')).toBe('a < b and c > d');
    expect(md('ratio 3:4, #tag in the middle')).toBe('ratio 3:4, #tag in the middle');
  });

  it('still escapes what would become markup, and the text reads back the same', () => {
    // These would be emphasis, a tag or a heading without their backslashes.
    for (const text of ['__bold__ no', '*star* no', '<img src=x>', '# not a heading', '[a](b) literal']) {
      const written = md(text);
      expect(written).not.toBe(text);
    }
  });
});

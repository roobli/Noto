import { describe, expect, it } from 'vitest';
import { parseDocument } from '../../src/shared/markdown/v3/document';

/*
 * A note with a tab, a no-break space or an ideographic space before `>`
 * froze the parse: the engine's quote test and quote strip disagreed and its
 * paragraph loop never advanced. Fixed in @roobli/md 0.1.24. Full-width
 * spaces are routine in Chinese notes, so this is checked here too, through
 * the same entry Noto opens a file with.
 */
describe('a line led by other whitespace before >', () => {
  it('opens and keeps its bytes', () => {
    for (const text of ['　> 引用', '段落\n　> 引用\n', '\t> q', '- a\n\t> q\n', ' > q']) {
      const parsed = parseDocument(new TextEncoder().encode(text));
      expect(parsed.status).toBe('parsed');
      if (parsed.status === 'parsed') expect(parsed.document.text).toBe(text);
    }
  });
});

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/*
 * A shadow darkens what it falls on, in both themes.
 *
 * The floating surfaces were shadowed with the ink, which is near black by
 * day and near white at night, so in the dark theme each of them glowed. They
 * draw in `--shadow` now, which is the ink by day and black at night.
 */
describe('Shadows', () => {
  const sheets = ['app.scss', 'noto-editor.scss'];

  it('are never mixed from the ink', async () => {
    for (const sheet of sheets) {
      const css = await readFile(new URL(`../../src/renderer/styles/${sheet}`, import.meta.url), 'utf8');
      const offending = css.split('\n').filter((line) => /box-shadow:.*var\(--ink/.test(line));
      expect(offending, sheet).toEqual([]);
    }
  });

  it('are dark in the dark theme', async () => {
    const tokens = await readFile(new URL('../../src/renderer/styles/_tokens.scss', import.meta.url), 'utf8');
    const dark = tokens.slice(tokens.indexOf(":root[data-theme='dark']"));
    expect(dark).toMatch(/--shadow:\s*#000;/);
  });
});

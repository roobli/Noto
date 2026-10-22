import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/*
 * Readable text clears 4.5:1 against every surface it is set on, in both
 * themes, and the code's muted ink (comments, punctuation) clears it on the
 * code fill. Decided by the maintainer on 2026-10-20: the dark muted and both code
 * mutes were lifted to these values; see resources/provenance/DESIGN_TOKENS.md.
 */
const hex = (value: string): [number, number, number] => {
  const h = value.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
};
const luminance = (rgb: [number, number, number]) => {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(hex(a)), luminance(hex(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

async function theme(name: 'light' | 'dark') {
  const css = await readFile(new URL('../../src/renderer/styles/_tokens.scss', import.meta.url), 'utf8');
  const start = css.indexOf(`:root[data-theme='${name}']`);
  const block = css.slice(start, css.indexOf('\n  }', start));
  const tokens: Record<string, string> = {};
  for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{6});/g)) tokens[m[1]] = m[2];
  return tokens;
}

describe.each(['light', 'dark'] as const)('The %s theme', (name) => {
  it('holds the muted ink at 4.5:1 on every surface', async () => {
    const t = await theme(name);
    for (const surface of ['paper', 'panel', 'raised', 'overlay']) {
      expect(contrast(t.muted, t[surface]), `muted on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('holds the code mute at 4.5:1 on the code fill and the paper', async () => {
    const t = await theme(name);
    expect(contrast(t['code-muted'], t['code-fill'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['code-muted'], t.paper)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('Readable text', () => {
  it('is never dimmed with opacity on the crumbs, the buried preferences or the line numbers', async () => {
    const app = await readFile(new URL('../../src/renderer/styles/app.scss', import.meta.url), 'utf8');
    const editor = await readFile(new URL('../../src/renderer/styles/noto-editor.scss', import.meta.url), 'utf8');
    const ruleOf = (css: string, selector: string) => {
      const at = css.indexOf(selector);
      expect(at, selector).toBeGreaterThan(-1);
      // The rule's own declarations, up to its first nested block or its end;
      // the crumb's '›' separator is decoration and may stay faded.
      const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
      return body.split('{')[0];
    };
    expect(ruleOf(app, '.document-identity .crumb {')).not.toMatch(/^\s*opacity:/m);
    expect(ruleOf(app, '.pref-section.is-buried')).not.toMatch(/^\s*opacity:/m);
    expect(ruleOf(editor, '.ProseMirror .noto-fence-gutter {')).not.toMatch(/^\s*opacity:/m);
  });
});

describe.each(['light', 'dark'] as const)('The git marks in the %s theme', (name) => {
  it('clear 3:1 on the panel and the active row, as a mark that carries meaning must', async () => {
    const t = await theme(name);
    for (const mark of ['git-changed', 'success', 'muted']) {
      for (const surface of ['panel', 'surface-active']) {
        expect(contrast(t[mark], t[surface]), `${mark} on ${surface}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('clear 3:1 on the page for the gutter beside the open note', async () => {
    const t = await theme(name);
    for (const mark of ['git-changed', 'success', 'danger']) {
      expect(contrast(t[mark], t.paper), `${mark} on paper`).toBeGreaterThanOrEqual(3);
    }
  });
});

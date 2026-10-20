import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/*
 * Every duration and curve is a token.
 *
 * `docs/design/motion.md` says there are no literal milliseconds outside the
 * tokens on the root of `app.scss`, and three had crept in, each on the weak
 * built-in `ease`. This keeps the claim true: a transition or animation names
 * its time with `var(--motion-*)` and its curve with `var(--ease-*)`, or says
 * `none`.
 */
const SHEETS = ['app.scss', 'noto-editor.scss', 'editor.scss'];

/*
 * The one literal allowed: how long the status line holds a message before
 * letting it go. That is a reading time, not a motion, and its fade inside
 * the keyframes runs on the ease-out token.
 */
const ALLOWED = [/animation:\s*noto-status-say 5s var\(--ease-out\) forwards;/];

const MOTION = /^\s*(transition|transition-duration|transition-timing-function|transition-delay|animation|animation-duration|animation-timing-function|animation-delay)\s*:/;
const LITERAL_TIME = /(^|[\s,(:])\d*\.?\d+m?s\b/;
const BARE_CURVE = /(^|[\s,:])(ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end)(?=[\s,;]|$)|cubic-bezier\(|steps\(/;

/** Declarations, one per entry, with the comments taken out. */
function declarations(css: string): string[] {
  return css.replace(/\/\*[\s\S]*?\*\//g, '').split(/[;{}]/).map((part) => `${part.trim()};`);
}

describe('Motion tokens', () => {
  it('leave no literal duration or built-in curve in a transition or animation', async () => {
    const offending: string[] = [];
    for (const sheet of SHEETS) {
      const css = await readFile(new URL(`../../src/renderer/styles/${sheet}`, import.meta.url), 'utf8');
      // The root block that declares the tokens is the one place values live.
      const body = sheet === 'app.scss' ? css.replace(/:root\s*\{[^}]*--motion-micro[^}]*\}/, '') : css;
      for (const declaration of declarations(body)) {
        if (!MOTION.test(declaration)) continue;
        if (ALLOWED.some((allowed) => allowed.test(declaration))) continue;
        const value = declaration.slice(declaration.indexOf(':') + 1);
        if (LITERAL_TIME.test(value) || BARE_CURVE.test(value)) offending.push(`${sheet}: ${declaration}`);
      }
    }
    expect(offending).toEqual([]);
  });

  it('catches the literals it is there to catch', () => {
    const probe = (declaration: string) => {
      const value = declaration.slice(declaration.indexOf(':') + 1);
      return MOTION.test(declaration) && (LITERAL_TIME.test(value) || BARE_CURVE.test(value));
    };
    expect(probe('transition: opacity 110ms ease;')).toBe(true);
    expect(probe('transition-duration: .2s;')).toBe(true);
    expect(probe('transition: color var(--motion-micro) ease;')).toBe(true);
    expect(probe('animation: fade var(--motion-default) cubic-bezier(0, 0, 1, 1);')).toBe(true);
    expect(probe('transition: opacity var(--motion-micro) var(--ease-out);')).toBe(false);
    expect(probe('transition-property: background-color, scale;')).toBe(false);
    expect(probe('transition: none !important;')).toBe(false);
  });
});

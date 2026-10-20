// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackInputModality } from '../../src/renderer/input-modality';

/*
 * docs/design/motion.md, amendment of 2026-10-20: an overlay summoned from the
 * keyboard appears at once; reduced motion keeps the fades and drops the
 * movement; and no layout property is animated.
 */
// A path rather than a URL from import.meta: under happy-dom, URL is the DOM's.
const sheet = (name: string) => readFile(path.join(process.cwd(), 'src/renderer/styles', name), 'utf8');

describe('The hand last used', () => {
  it('is kept on the root, keyboard on a key and pointer on a press', () => {
    const root = document.documentElement;
    delete root.dataset.input;
    const stop = trackInputModality(window, root);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta' }));
    expect(root.dataset.input).toBe('keyboard');
    window.dispatchEvent(new Event('pointerdown'));
    expect(root.dataset.input).toBe('pointer');
    stop();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(root.dataset.input).toBe('pointer');
  });
});

describe('Overlays', () => {
  it('lose their arrival when the keyboard summoned them, every one that has one', async () => {
    const app = await sheet('app.scss');
    const at = app.indexOf(":root[data-input='keyboard'] :is(");
    expect(at).toBeGreaterThan(-1);
    const list = app.slice(at, app.indexOf('{', at));
    // Every rule that arrives (or fades a scrim in) is on the keyboard list.
    const arriving = [...app.matchAll(/^(\.[\w-]+) \{\n  animation: noto-(?:arrive|fade) /gm)].map((m) => m[1]);
    expect(arriving.length).toBeGreaterThan(5);
    for (const selector of arriving) expect(list, selector).toContain(selector);
    expect(app.slice(at, app.indexOf('}', at))).toMatch(/animation: none;/);
  });
});

describe('Reduced motion', () => {
  it('keeps the fades and drops the movement', async () => {
    const app = await sheet('app.scss');
    const at = app.indexOf('@media (prefers-reduced-motion: reduce)');
    const block = app.slice(at, app.indexOf('\n}\n', at));
    expect(block).not.toMatch(/transition: none|animation: none/);
    for (const name of ['noto-arrive', 'noto-rail-in', 'noto-rise']) {
      expect(block).toMatch(new RegExp(`@keyframes ${name} \\{ from \\{ opacity: 0; \\} \\}`));
    }
    const property = /transition-property: ([^!]+)!important/.exec(block)?.[1] ?? '';
    expect(property).toMatch(/opacity/);
    expect(property).toMatch(/color/);
    expect(property).not.toMatch(/transform|scale|translate|rotate|width|height|left|top/);
  });
});

describe('Layout', () => {
  it('is never animated: no transition on width, height, left or top', async () => {
    for (const name of ['app.scss', 'noto-editor.scss', 'editor.scss']) {
      const css = await sheet(name);
      const offending = css.split('\n').filter((line) =>
        /^\s*transition(-property)?:/.test(line) && /\b(width|height|left|top|right|bottom)\b/.test(line));
      expect(offending, name).toEqual([]);
    }
  });
});

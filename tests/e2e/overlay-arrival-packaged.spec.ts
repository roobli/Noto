import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

/*
 * docs/design/motion.md, amendment of 2026-10-20. An overlay summoned from the
 * keyboard is in place at once; the same overlay summoned by a press keeps its
 * arrival. Under reduced motion the arrival is a fade and nothing moves.
 */
async function invokeMenu(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ Menu }, wanted) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | null => {
      for (const item of items) {
        if (item.id === wanted) return item;
        const nested = item.submenu ? find(item.submenu.items) : null;
        if (nested) return nested;
      }
      return null;
    };
    const target = find(Menu.getApplicationMenu()!.items);
    if (!target) throw new Error(`no menu item ${wanted}`);
    target.click();
  }, id);
}

/** The animation on an element, if any, read on the frame it appears. */
async function arrival(page: Page, selector: string) {
  await page.waitForSelector(selector, { state: 'attached' });
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)!;
    const style = getComputedStyle(el);
    return { name: style.animationName, running: el.getAnimations().length };
  }, selector);
}

test('an overlay from the keyboard is there at once, from a press it arrives, and reduced motion only fades', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'overlay-arrival');
  await rm(workspace, { recursive: true, force: true });
  const userData = path.join(workspace, 'user-data');
  await mkdir(userData, { recursive: true });
  const vault = path.join(workspace, 'vault');
  await mkdir(vault, { recursive: true });
  const file = path.join(vault, 'note.md');
  await writeFile(file, '# Arrival\n\nWords.\n', 'utf8');
  const app = await electron.launch({ executablePath: packagedExecutable(), args: [`--user-data-dir=${userData}`, vault, file] });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 900 });
    const editor = page.locator('.canvas-slot:not([hidden]) .ProseMirror');
    await editor.waitFor({ state: 'visible', timeout: 30_000 });
    await editor.click();

    // The shortcut's modifier goes down first; the menu then sends the command.
    await page.keyboard.down('Control');
    await invokeMenu(app, 'quick-open');
    await page.keyboard.up('Control');
    expect(await arrival(page, '.quick-open')).toEqual({ name: 'none', running: 0 });
    await page.keyboard.press('Escape');
    await expect(page.locator('.quick-open')).toHaveCount(0);

    // A press on the gear: Settings arrives.
    await page.getByTestId('settings-toggle').click();
    const pressed = await arrival(page, '.settings-shell');
    expect(pressed.name).toBe('noto-arrive');
    await page.keyboard.press('Escape');
    await expect(page.locator('.settings-shell')).toHaveCount(0);

    // Reduced motion: the arrival keeps its fade and loses its scale.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByTestId('settings-toggle').click();
    await page.waitForSelector('.settings-shell');
    const reduced = await page.evaluate(() => {
      const el = document.querySelector('.settings-shell')!;
      const frames = el.getAnimations().flatMap((a) => (a.effect as KeyframeEffect).getKeyframes());
      return {
        fades: frames.some((f) => 'opacity' in f),
        moves: frames.some((f) => 'scale' in f || 'translate' in f || 'transform' in f),
        iconTransition: getComputedStyle(document.querySelector('.icon-button')!).transitionProperty,
      };
    });
    expect(reduced.fades).toBe(true);
    expect(reduced.moves).toBe(false);
    expect(reduced.iconTransition).not.toMatch(/scale/);
    expect(reduced.iconTransition).toMatch(/background-color/);
  } finally {
    await app.close();
  }
});

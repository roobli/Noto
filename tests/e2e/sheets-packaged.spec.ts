/**
 * The sheets in the packaged app: What Noto Can Do, the command palette and
 * Quick Open open at one top, at one of four widths of the window that ⌘[
 * and ⌘] step in any of them, and the step is shared. They were four sizes
 * at three tops, and only Quick Open answered the bracket keys.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Locator } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

async function invokeMenu(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ Menu }, itemId) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | null => {
      for (const item of items) {
        if (item.id === itemId) return item;
        const nested = item.submenu ? find(item.submenu.items) : null;
        if (nested) return nested;
      }
      return null;
    };
    find(Menu.getApplicationMenu()!.items)!.click();
  }, id);
}

const box = (sheet: Locator) => sheet.evaluate((node) => {
  // Settled: on its arrival frame a sheet is drawn a little smaller.
  for (const animation of node.getAnimations()) animation.finish();
  const rect = node.getBoundingClientRect();
  return { top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
});

test('the sheets share a top and a width that the bracket keys step in any of them', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'sheets');
  await rm(workspace, { recursive: true, force: true });
  const vault = path.join(workspace, 'vault');
  const userData = path.join(workspace, 'user-data');
  await mkdir(vault, { recursive: true });
  await mkdir(userData, { recursive: true });
  await writeFile(path.join(vault, 'note.md'), '# Sheets\n\nBody text.\n', 'utf8');

  const app = await electron.launch({ executablePath: packagedExecutable(), args: [`--user-data-dir=${userData}`, vault] });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
    const narrower = process.platform === 'darwin' ? 'Meta+[' : 'Control+[';
    const wider = process.platform === 'darwin' ? 'Meta+]' : 'Control+]';

    await invokeMenu(app, 'shortcuts');
    const guide = page.getByTestId('shortcuts-panel');
    await expect(guide).toHaveAttribute('data-sheet-width', '3');
    const guideAt3 = await box(guide);
    // 68% of 1400, under the 1080 cap.
    expect(guideAt3.width).toBe(952);
    await expect(guide.getByTestId('sheet-width-hint')).toBeVisible();
    await page.keyboard.press(narrower);
    await expect(guide).toHaveAttribute('data-sheet-width', '2');
    expect((await box(guide)).width).toBe(896);
    await page.keyboard.press('Escape');

    // The palette took the step the guide was left at, from the same top.
    await invokeMenu(app, 'command-palette');
    const palette = page.getByTestId('command-palette');
    await expect(palette).toHaveAttribute('data-sheet-width', '2');
    const paletteAt2 = await box(palette);
    expect(paletteAt2.width).toBe(640);
    expect(paletteAt2.top).toBe(guideAt3.top);
    await page.keyboard.press(wider);
    await page.keyboard.press(wider);
    await expect(palette).toHaveAttribute('data-sheet-width', '4');
    expect((await box(palette)).width).toBe(740);
    // Past the widest it stays the widest.
    await page.keyboard.press(wider);
    await expect(palette).toHaveAttribute('data-sheet-width', '4');
    await page.keyboard.press('Escape');

    // Quick Open is sized for finding, not reading: 80% of the window's
    // height (560..860), and at each step a ceiling well under the page
    // (step 4: 80% of 1400, under 1280; step 3: 70%, under 1120). It sits a
    // little lower than the other sheets, with air above and below.
    await invokeMenu(app, 'quick-open');
    const quick = page.getByTestId('quick-open');
    await expect(quick).toHaveAttribute('data-sheet-width', '4');
    const quickAt4 = await box(quick);
    expect(quickAt4.width).toBe(1120);
    expect(quickAt4.height).toBe(720);
    expect(quickAt4.top).toBe(117);
    await page.keyboard.press(narrower);
    await expect(quick).toHaveAttribute('data-sheet-width', '3');
    expect((await box(quick)).width).toBe(980);
    await page.keyboard.press('Escape');
  } finally {
    await app.close();
  }
});

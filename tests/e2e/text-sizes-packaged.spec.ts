import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

/* Three sizes, each set on its own: the note's text (also Command with plus
   and minus, as a browser zooms), the interface's, and the sidebar's. */
const menu = (app: ElectronApplication, id: string) => app.evaluate(({ Menu }, itemId) => {
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

test('the note, the interface and the sidebar each keep the size set for them', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'text-sizes');
  await rm(workspace, { recursive: true, force: true });
  const vault = path.join(workspace, 'vault');
  await mkdir(vault, { recursive: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  await writeFile(path.join(vault, 'note.md'), '# Title\n\nA paragraph of text.\n', 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--folder=${vault}`, `--open=${path.join(vault, 'note.md')}`],
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
    const paragraph = page.locator('.ProseMirror > p').first();
    // Drawn sizes, in screen pixels: the CSS size times the window's zoom.
    const drawn = (selector: string) => page.evaluate((query) => {
      const element = document.querySelector(query)!;
      return Number.parseFloat(getComputedStyle(element).fontSize);
    }, selector);
    const zoom = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor());
    const onScreen = async (selector: string) => (await drawn(selector)) * (await zoom());
    await expect(paragraph).toBeVisible();
    expect(await onScreen('.ProseMirror > p')).toBeCloseTo(15, 1);

    // Command with plus and minus walk the note's size, and Shift-0 sets it back.
    // Two presses at once land as two steps: a reply for the first does not undo the second.
    await menu(app, 'text-larger');
    await menu(app, 'text-larger');
    await expect.poll(() => onScreen('.ProseMirror > p')).toBeCloseTo(17, 1);
    await page.waitForTimeout(400);
    expect(await onScreen('.ProseMirror > p')).toBeCloseTo(17, 1);
    await menu(app, 'text-smaller');
    await expect.poll(() => onScreen('.ProseMirror > p')).toBeCloseTo(16, 1);
    await expect.poll(async () => JSON.parse(await readFile(path.join(workspace, 'user-data', 'settings.json'), 'utf8')).fontSize).toBe(16);
    await menu(app, 'text-default');
    await expect.poll(() => onScreen('.ProseMirror > p')).toBeCloseTo(15, 1);

    // The interface grows; the note and the sidebar's names do not.
    const treeRow = '[data-testid="tree-file"] .tree-name, [data-testid="tree-file"]';
    const rowBefore = await onScreen(treeRow);
    await page.evaluate(() => window.notoSettings.write({ version: 1, requestId: 'ui-125', patch: { uiScale: 1.25 } }));
    await expect.poll(zoom).toBeCloseTo(1.25, 2);
    await expect.poll(() => onScreen('.ProseMirror > p')).toBeCloseTo(15, 1);
    await expect.poll(() => onScreen(treeRow)).toBeCloseTo(rowBefore, 1);
    expect(await onScreen('.operational-status')).toBeGreaterThan(12);

    // The sidebar on its own: names and rows grow, the note stays.
    await page.evaluate(() => window.notoSettings.write({ version: 1, requestId: 'rail-17', patch: { railFontSize: 17 } }));
    await expect.poll(() => onScreen(treeRow)).toBeCloseTo(17, 1);
    const rowHeight = await page.locator('[data-testid="tree-file"]').first().evaluate((row) => row.getBoundingClientRect().height);
    expect(rowHeight * (await zoom())).toBeGreaterThan(36);
    expect(await onScreen('.ProseMirror > p')).toBeCloseTo(15, 1);
  } finally {
    await app.close();
  }
});

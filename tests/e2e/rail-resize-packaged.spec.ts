import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

/*
 * Dragging the rail's edge moves the page with it, while the pointer is
 * still down. Only the rail used to grow until release, so mid-drag it
 * spilled over a page that had not moved and the page's marks showed through.
 */
const edges = (page: Page) => page.evaluate(() => {
  const rail = document.querySelector('.workspace-rail')!.getBoundingClientRect();
  const layout = document.querySelector('.workspace-layout')!.getBoundingClientRect();
  return { rail: Math.round(rail.right), page: Math.round(layout.left) };
});

test('the page follows the rail edge during the drag, and the width holds after it', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'rail-resize');
  await rm(workspace, { recursive: true, force: true });
  const vault = path.join(workspace, 'vault');
  await mkdir(vault, { recursive: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  await writeFile(path.join(vault, 'note.md'), '# Rail\n\nA paragraph beside the rail.\n', 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, vault],
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1400, height: 860 });
    await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
    await page.getByTestId('tree-file').first().click();
    // The rail opens when the folder arrives and its column slides out; the
    // drag is measured from where that slide ends.
    await expect.poll(async () => { const at = await edges(page); return Math.abs(at.page - at.rail); }).toBeLessThanOrEqual(1);
    const before = await edges(page);

    const handle = (await page.getByTestId('rail-resize').boundingBox())!;
    const x = handle.x + handle.width / 2;
    const y = handle.y + handle.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 60, y, { steps: 4 });
    await page.mouse.move(x + 120, y, { steps: 4 });
    // Still held: the page starts where the rail ends, at the new width.
    await expect.poll(async () => {
      const now = await edges(page);
      return now.rail > before.rail + 100 && Math.abs(now.page - now.rail) <= 1;
    }).toBe(true);
    await page.mouse.up();

    const after = await edges(page);
    expect(after.rail).toBeGreaterThan(before.rail + 100);
    expect(Math.abs(after.page - after.rail)).toBeLessThanOrEqual(1);
    await expect(page.locator('.app-shell')).not.toHaveClass(/is-resizing-rail/);
  } finally {
    await app.close();
  }
});

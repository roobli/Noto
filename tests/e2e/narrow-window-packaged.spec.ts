import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';
import { packagedExecutable, placeCaret } from './packaged-app';

/*
 * At the window's narrowest, 720px, the rail is still a press away and the
 * page still holds everything it draws.
 *
 * Below 900px the rail and its toggle both used to vanish. Now the toggle
 * stays, and the rail it opens lies over the document instead of taking a
 * column from it, so the text does not move. A press anywhere else puts the
 * rail away. The heading badge, which hangs in the page's left margin, has the
 * room to stand there whole rather than being cut by the window's edge.
 */
test('a 720px window keeps the rail toggle, lays the rail over the page, and has room for the heading badge', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'narrow-window');
  await rm(workspace, { recursive: true, force: true });
  const userData = path.join(workspace, 'user-data');
  await mkdir(userData, { recursive: true });
  const vault = path.join(workspace, 'vault');
  await mkdir(vault, { recursive: true });
  await writeFile(path.join(vault, 'note.md'), '# Narrow\n\nA paragraph of the narrow note.\n', 'utf8');

  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${userData}`, vault],
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 720, height: 820 });
    const toggle = page.getByTestId('sidebar-toggle');
    const rail = page.locator('.workspace-rail');
    await expect(toggle).toBeVisible();
    if (!(await rail.isVisible())) await toggle.click();
    await expect(rail).toBeVisible();

    // Lying over the page: out of flow, above it, and starting at the edge.
    await page.getByTestId('tree-file').first().click();
    const editor = page.locator('.canvas-slot:not([hidden]) .ProseMirror');
    await editor.waitFor({ state: 'visible' });
    const over = await page.evaluate(() => {
      const r = document.querySelector('.workspace-rail')!;
      const layout = document.querySelector('.workspace-layout')!.getBoundingClientRect();
      return { position: getComputedStyle(r).position, left: Math.round(r.getBoundingClientRect().left), layoutLeft: Math.round(layout.left) };
    });
    expect(over).toEqual({ position: 'absolute', left: 0, layoutLeft: 0 });
    const textLeft = async () => Math.round((await editor.locator('p').first().boundingBox())!.x);
    const withRail = await textLeft();

    // A press on the page puts it away, and the text has not moved.
    await editor.locator('p').first().click();
    await expect(rail).toBeHidden();
    await expect(toggle).toBeVisible();
    expect(await textLeft()).toBe(withRail);

    // And the toggle brings it back.
    await toggle.click();
    await expect(rail).toBeVisible();
    await toggle.click();
    await expect(rail).toBeHidden();

    // The badge beside a heading the caret is in, whole inside the window.
    await placeCaret(page, editor.locator('h1'));
    const badge = await page.evaluate(() => {
      const h = document.querySelector<HTMLElement>('.canvas-slot:not([hidden]) .ProseMirror > h1')!;
      const b = getComputedStyle(h, '::before');
      const outer = parseFloat(b.width) + parseFloat(b.paddingLeft) + parseFloat(b.paddingRight)
        + parseFloat(b.borderLeftWidth) + parseFloat(b.borderRightWidth);
      // `right` resolves to a length from the heading's right edge.
      return { left: h.getBoundingClientRect().right - parseFloat(b.right) - outer, opacity: b.opacity, outer };
    });
    expect(badge.outer).toBeGreaterThan(10);
    expect(badge.left).toBeGreaterThanOrEqual(2);
  } finally {
    await app.close();
  }
});

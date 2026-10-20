import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type Page } from '@playwright/test';
import { packagedExecutable, placeCaret } from './packaged-app';

/*
 * The small controls take a press over at least 24px, WCAG 2.5.8's minimum,
 * while drawing exactly the size they did. The rail's tabs and search, the
 * vault row's ellipsis and the table's tools were as small to the pointer as
 * they look, 20 to 22px. Each is probed at the corners of a 24px square on its
 * centre, which must land on the control, and its drawn box is held to the
 * size it was.
 */
async function reach(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) throw new Error(`no ${sel}`);
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const halfX = Math.max(24, r.width) / 2 - 0.5;
    const halfY = Math.max(24, r.height) / 2 - 0.5;
    const points = [[-halfX, -halfY], [halfX, -halfY], [-halfX, halfY], [halfX, halfY]];
    const hits = points.map(([dx, dy]) => {
      const hit = document.elementFromPoint(cx + dx, cy + dy);
      return hit === el || el.contains(hit);
    });
    return { width: Math.round(r.width), height: Math.round(r.height), hits };
  }, selector);
}

test('small controls take a press over 24px and draw the size they did', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'hit-areas');
  await rm(workspace, { recursive: true, force: true });
  const userData = path.join(workspace, 'user-data');
  await mkdir(userData, { recursive: true });
  const vault = path.join(workspace, 'vault');
  await mkdir(vault, { recursive: true });
  await writeFile(path.join(vault, 'note.md'), '# Hits\n\n| A | B |\n| --- | --- |\n| one | two |\n', 'utf8');

  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${userData}`, vault],
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
    await page.getByTestId('tree-file').first().click();
    const editor = page.locator('.canvas-slot:not([hidden]) .ProseMirror');
    await editor.waitFor({ state: 'visible' });
    await placeCaret(page, editor.locator('td').first());
    await expect(page.locator('.noto-table-tools').first()).toHaveCSS('opacity', '1');
    await page.locator('.tree-vault-row').first().hover();

    const expected: Array<[string, number, number]> = [
      ['.rail-tab', 34, 20],
      ['.rail-search', 22, 22],
      ['.vault-menu-button', 20, 20],
      ['.noto-table-tool', 24, 22],
    ];
    for (const [selector, width, height] of expected) {
      const found = await reach(page, selector);
      expect({ selector, width: found.width, height: found.height }).toEqual({ selector, width, height });
      expect({ selector, hits: found.hits }).toEqual({ selector, hits: [true, true, true, true] });
    }
  } finally {
    await app.close();
  }
});

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

const resultRoot = path.join(process.cwd(), 'test-results', 'rail-search');

async function launch(name: string): Promise<{ app: ElectronApplication; page: Page }> {
  const workspace = path.join(resultRoot, name);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const vault = path.join(workspace, 'vault');
  await mkdir(path.join(vault, 'deep'), { recursive: true });
  await writeFile(path.join(vault, 'alpha.md'), '# Alpha\n\nThe Kestrel flies.\n\nA kestrel again, twice: kestrel.\n', 'utf8');
  await writeFile(path.join(vault, 'deep', 'beta.md'), '# Beta\n\nNo bird here, only a kestrelish word.\n', 'utf8');
  await writeFile(path.join(vault, 'gamma.md'), '# Gamma\n\nimage-20260902.png sits here.\n', 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, vault],
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
  return { app, page };
}

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

test.describe('search in the rail', () => {
  test('finds the lines, opens a note from one, and stays open for the next', async () => {
    const { app, page } = await launch('stays');
    try {
      await page.getByTestId('rail-search').click();
      const input = page.getByTestId('search-input');
      await expect(input).toBeFocused();
      await input.fill('kestrel');

      // Two notes hold the letters; the one that says the word most comes
      // first, with its lines and the word marked in each.
      const hits = page.getByTestId('search-hit');
      await expect(hits).toHaveCount(2);
      await expect(hits.first().locator('.rail-hit-name')).toHaveText('alpha');
      await expect(hits.first().locator('.rail-hit-count')).toHaveText('3');
      await expect(hits.first().locator('.quick-hit').first()).toHaveText('Kestrel');
      await expect(hits.nth(1).locator('.rail-hit-folder')).toHaveText('deep');

      // A line opens its note, and the search is still there afterwards.
      await hits.nth(1).getByTestId('search-line').first().click();
      await expect(page.locator('.canvas-slot:not([hidden]) .ProseMirror')).toContainText('kestrelish');
      await expect(page.getByTestId('search-panel')).toBeVisible();
      await expect(hits.nth(1)).toHaveClass(/is-current/);
      await expect(input).toHaveValue('kestrel');

      // Case narrows it to the one capitalised use; whole word drops the
      // note where it is part of a longer word.
      await page.getByTestId('search-case').click();
      await input.fill('Kestrel');
      await expect(hits).toHaveCount(1);
      await page.getByTestId('search-case').click();
      await page.getByTestId('search-word').click();
      await expect(hits).toHaveCount(1);
      await expect(hits.first().locator('.rail-hit-name')).toHaveText('alpha');

      // An expression, and one that does not parse yet.
      await page.getByTestId('search-word').click();
      await page.getByTestId('search-regex').click();
      await input.fill('image-\\d+');
      await expect(hits).toHaveCount(1);
      await expect(hits.first().locator('.quick-hit')).toHaveText('image-20260902');
      await input.fill('image-(');
      await expect(page.getByTestId('search-status')).toHaveText('That expression does not parse.');

      // Escape goes back to the files.
      await input.press('Escape');
      await expect(page.getByTestId('file-tree')).toBeVisible();
      await expect(page.getByTestId('search-panel')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test("Typora's chord opens it, and the magnifier closes it again", async () => {
    const { app, page } = await launch('chord');
    try {
      await invokeMenu(app, 'search-content');
      await expect(page.getByTestId('search-panel')).toBeVisible();
      await expect(page.getByTestId('search-input')).toBeFocused();
      await expect(page.getByTestId('rail-search')).toHaveAttribute('aria-pressed', 'true');
      // Magnifier closes on mousedown; wait for the panel to go, not only the
      // tree — ubuntu CI was flaking when the assertion raced the unmount.
      await page.getByTestId('rail-search').click();
      await expect(page.getByTestId('search-panel')).toHaveCount(0);
      await expect(page.getByTestId('file-tree')).toBeVisible();
      await expect(page.getByTestId('rail-search')).toHaveAttribute('aria-pressed', 'false');
    } finally {
      await app.close();
    }
  });
});

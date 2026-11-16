import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

const resultRoot = path.join(process.cwd(), 'test-results', 'trail');

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
    const menu = Menu.getApplicationMenu();
    const target = menu ? find(menu.items) : null;
    if (!target) throw new Error(`No menu item with id ${itemId}`);
    target.click();
  }, id);
}

/** A vault with a note two folders deep and two more beside it. */
async function launch(name: string): Promise<{ app: ElectronApplication; page: Page }> {
  const workspace = path.join(resultRoot, name);
  await rm(workspace, { recursive: true, force: true });
  const vault = path.join(workspace, 'vault');
  const deep = path.join(vault, 'projects', 'alpha');
  await mkdir(deep, { recursive: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  await writeFile(path.join(vault, 'one.md'), '# One\n', 'utf8');
  await writeFile(path.join(vault, 'two.md'), '# Two\n', 'utf8');
  await writeFile(path.join(deep, 'three.md'), '# Three\n', 'utf8');

  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, vault, path.join(vault, 'one.md')],
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
  // Sized before the tree is awaited: under a tiling window manager a new
  // window can open at the 720px floor, where the rail is hidden.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
  return { app, page };
}

const title = (page: Page) => page.getByTestId('document-identity');

test.describe('the trail', () => {
  test('steps back and forward through the notes you opened, three each way', async () => {
    const { app, page } = await launch('steps');
    try {
      const back = page.getByTestId('nav-back');
      const forward = page.getByTestId('nav-forward');
      await expect(back).toBeDisabled();
      await expect(forward).toBeDisabled();

      await page.getByTestId('tree-file').filter({ hasText: 'two.md' }).click();
      await expect(title(page)).toContainText('two.md');
      await expect(back).toBeEnabled();

      await page.getByTestId('tree-directory').filter({ hasText: 'projects' }).click();
      await page.getByTestId('tree-directory').filter({ hasText: 'alpha' }).click();
      await page.getByTestId('tree-file').filter({ hasText: 'three.md' }).click();
      await expect(title(page)).toContainText('three.md');
      // Inside the vault the breadcrumb is the path from the vault's own
      // name, and the last two folders are what fits in a title bar.
      await expect(title(page).locator('.crumb')).toHaveText(['alpha']);

      // Back through the menu, which is the chord's route, then the button.
      await invokeMenu(app, 'navigate-back');
      await expect(title(page)).toContainText('two.md');
      await expect(forward).toBeEnabled();
      await back.click();
      await expect(title(page)).toContainText('one.md');
      await expect(back).toBeDisabled();
      await expect(title(page).locator('.crumb')).toHaveText(['vault']);

      await forward.click();
      await expect(title(page)).toContainText('two.md');
      await invokeMenu(app, 'navigate-forward');
      await expect(title(page)).toContainText('three.md');
      await expect(forward).toBeDisabled();

      // Opening something new from the middle clears the way forward.
      await invokeMenu(app, 'navigate-back');
      await expect(title(page)).toContainText('two.md');
      await page.getByTestId('tree-file').filter({ hasText: 'one.md' }).click();
      await expect(title(page)).toContainText('one.md');
      await expect(forward).toBeDisabled();
      await expect(back).toBeEnabled();
    } finally {
      await app.close();
    }
  });

  test('opens the search from the head of the rail, in place of the files', async () => {
    const { app, page } = await launch('search');
    try {
      await page.getByTestId('rail-search').click();
      await expect(page.getByTestId('search-input')).toBeFocused();
      // In place of the files: the tree is out of sight, kept for coming back to.
      await expect(page.getByTestId('file-tree')).toBeHidden();
    } finally {
      await app.close();
    }
  });
});

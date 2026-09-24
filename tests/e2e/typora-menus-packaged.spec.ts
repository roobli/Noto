import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

const NOTE = '# Menus\n\nSome **bold words** here.\n\n- one\n- two\n\nTail.\n';

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

async function launch(name: string): Promise<{ app: ElectronApplication; page: Page; file: string }> {
  const workspace = path.join(process.cwd(), 'test-results', 'typora-menus', name);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const vault = path.join(workspace, 'vault');
  await mkdir(vault, { recursive: true });
  const file = path.join(vault, 'note.md');
  await writeFile(file, NOTE, 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, vault],
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
  await page.getByTestId('tree-file').first().click();
  await page.locator('.canvas-slot:not([hidden]) .ProseMirror').waitFor({ state: 'visible' });
  return { app, page, file };
}

const editor = (page: Page) => page.locator('.canvas-slot:not([hidden]) .ProseMirror');
const host = (page: Page) => page.locator('.canvas-slot:not([hidden]) [data-testid="noto-editor"]');
const selection = (page: Page) => page.evaluate(() => window.getSelection()?.toString() ?? '');

test.describe("Typora's menus", () => {
  test('Insert Table asks for a size first', async () => {
    const { app, page } = await launch('table');
    try {
      await editor(page).locator('p').filter({ hasText: 'Tail.' }).click();
      await expect(editor(page).locator('.noto-active-block')).toHaveText('Tail.');
      await invokeMenu(app, 'table-insert');
      const dialog = page.getByTestId('table-dialog');
      await expect(dialog).toBeVisible();
      await expect(page.getByTestId('table-rows')).toBeFocused();
      await page.getByTestId('table-rows').fill('1');
      await page.getByTestId('table-columns').fill('4');
      await page.keyboard.press('Enter');
      await expect(dialog).toHaveCount(0);
      await expect(editor(page).locator('table')).toHaveCount(1);
      await expect(editor(page).locator('th')).toHaveCount(4);
      await expect(editor(page).locator('tr')).toHaveCount(2);
      // Escape leaves without a table. Focus a field first: on packaged
      // macOS a bare Escape can miss the capture listener while focus is
      // still settling after the menu click (dialog stayed open → flake).
      await invokeMenu(app, 'table-insert');
      await expect(page.getByTestId('table-dialog')).toBeVisible();
      await page.getByTestId('table-rows').focus();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('table-dialog')).toHaveCount(0);
      await expect(editor(page).locator('table')).toHaveCount(1);
    } finally {
      await app.close();
    }
  });

  test('Select Styled Scope takes the styled run, Clear Format clears it at the caret, Comment wraps', async () => {
    const { app, page, file } = await launch('scope');
    try {
      // Into the bold run.
      await editor(page).locator('strong').click();
      await expect(editor(page).locator('.noto-active-block')).toContainText('bold words');
      const before = (await host(page).getAttribute('data-caret')) ?? '';
      void before;
      await invokeMenu(app, 'select-scope');
      await expect.poll(() => selection(page)).toBe('bold words');

      // Comment around the selection, and the note holds it as one.
      await invokeMenu(app, 'insert-comment');
      await invokeMenu(app, 'save');
      await expect.poll(() => readFile(file, 'utf8')).toContain('<!-- **bold words** -->');

      // Clear Format with no selection: the caret's run loses its style.
      await editor(page).locator('strong').click();
      await expect(host(page)).not.toHaveAttribute('data-caret', before);
      await invokeMenu(app, 'clear-format');
      await expect(editor(page).locator('strong')).toHaveCount(0);
      await expect(editor(page)).toContainText('bold words');
    } finally {
      await app.close();
    }
  });

  test('Increase and Decrease Indent nest a list item and lift it', async () => {
    const { app, page } = await launch('indent');
    try {
      await editor(page).locator('li').filter({ hasText: 'two' }).click();
      await expect(editor(page).locator('.noto-active-block')).toContainText('two');
      await invokeMenu(app, 'indent-more');
      await expect(editor(page).locator('li li')).toHaveCount(1);
      await invokeMenu(app, 'indent-less');
      await expect(editor(page).locator('li li')).toHaveCount(0);
      await expect(editor(page).locator('li')).toHaveCount(2);
    } finally {
      await app.close();
    }
  });
});

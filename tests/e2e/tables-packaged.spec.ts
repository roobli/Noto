import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable, placeCaret } from './packaged-app';

const resultRoot = path.join(process.cwd(), 'test-results', 'tables');

const NOTE = [
  '# Tables',
  '',
  '| 字段 | 值 |',
  '| --- | --- |',
  '| a | 1 |',
  '',
  'After.',
  '',
].join('\n');

async function launch(name: string): Promise<{ app: ElectronApplication; page: Page; file: string }> {
  const workspace = path.join(resultRoot, name);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const file = path.join(workspace, 'note.md');
  await writeFile(file, NOTE, 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${file}`],
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
  await page.setViewportSize({ width: 1100, height: 800 });
  return { app, page, file };
}

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

test.describe('editing a table', () => {
  test('grows a row when Tab runs out of cells', async () => {
    const { app, page, file } = await launch('tab');
    try {
      // A header row and one body row. There is no thead: every row is a
      // table_row, and the header's cells are th.
      await expect(page.locator('.ProseMirror table tr')).toHaveCount(2);
      await placeCaret(page, page.locator('.ProseMirror table td').last());
      await page.keyboard.press('Tab');
      await expect(page.locator('.ProseMirror table tr')).toHaveCount(3);

      // The caret went into the row it made, so typing fills it.
      await page.keyboard.type('b');
      await page.getByTestId('save-button').click();
      // The serializer pads a cell out to its column's width, so the row is
      // matched rather than compared to an exact string.
      await expect.poll(async () => readFile(file, 'utf8')).toMatch(/\| b\s+\|/);
    } finally {
      await app.close();
    }
  });

  test('adds and deletes rows and columns from the menu', async () => {
    const { app, page, file } = await launch('menu');
    try {
      await placeCaret(page, page.locator('.ProseMirror table td').first());
      await invokeMenu(app, 'table-column-after');
      await expect(page.locator('.ProseMirror table th')).toHaveCount(3);
      await invokeMenu(app, 'table-row-below');
      await expect(page.locator('.ProseMirror table tr')).toHaveCount(3);
      await invokeMenu(app, 'table-row-delete');
      await expect(page.locator('.ProseMirror table tr')).toHaveCount(2);
      // Into the column added above before it is deleted. Where a row's delete leaves the
      // caret is the table plugin's choice, and on a slow runner it was the first column.
      await placeCaret(page, page.locator('.ProseMirror table th').nth(1));
      await invokeMenu(app, 'table-column-delete');
      await expect(page.locator('.ProseMirror table th')).toHaveCount(2);

      await page.getByTestId('save-button').click();
      const saved = await readFile(file, 'utf8');
      expect(saved).toContain('| 字段 | 值 |');
      expect(saved).toContain('After.');
    } finally {
      await app.close();
    }
  });

  test('makes a table where the caret is', async () => {
    const { app, page } = await launch('insert');
    try {
      await placeCaret(page, page.locator('.ProseMirror > p').last());
      // Typora asks the size first; the dialog's defaults are two by three.
      await invokeMenu(app, 'table-insert');
      await expect(page.getByTestId('table-dialog')).toBeVisible();
      await page.getByTestId('table-insert').click();
      await expect(page.locator('.ProseMirror table')).toHaveCount(2);
      await expect(page.locator('.ProseMirror table').last().locator('th')).toHaveCount(3);
      await expect(page.locator('.ProseMirror table').last().locator('tr')).toHaveCount(3);
    } finally {
      await app.close();
    }
  });
});

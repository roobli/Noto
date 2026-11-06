import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

const resultRoot = path.join(process.cwd(), 'test-results', 'table-rails');

const NOTE = [
  '# Rails',
  '',
  '| head a | head b | head c |',
  '| --- | --- | --- |',
  '| one | two | three |',
  '| four | five | six |',
  '| seven | eight | nine |',
  '',
  '> A quoted table, which the vault does have.',
  '>',
  '> | q1 | q2 |',
  '> | --- | --- |',
  '> | alpha | beta |',
  '> | gamma | delta |',
  '',
].join('\n');

async function launch(name: string): Promise<{ app: ElectronApplication; page: Page }> {
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
  await page.setViewportSize({ width: 1100, height: 700 });
  return { app, page };
}

/** The note has two tables; every helper below works on the first. */
const table = (page: Page) => page.locator('.noto-table-frame').first();

/** Put the pointer over the table so the rails are measured and drawn. */
async function hoverTable(page: Page): Promise<void> {
  await table(page).locator('table').hover();
  await expect(table(page).locator('.noto-table-rail-rows .noto-table-handle').first()).toBeVisible();
}

/** The first cell of every body row, in the order they are drawn. */
async function firstColumn(page: Page): Promise<string[]> {
  return table(page).locator('tr td:first-child').allInnerTexts();
}

async function dragHandle(page: Page, handle: ReturnType<Page['locator']>, dy: number, dx = 0): Promise<void> {
  const box = await handle.boundingBox();
  if (!box) throw new Error('the handle is not on screen');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= 5; step += 1) {
    await page.mouse.move(x + (dx * step) / 5, y + (dy * step) / 5);
  }
  await page.mouse.up();
}

test.describe('taking hold of a table', () => {
  test('shows a handle for every body row and every column, but not the header', async () => {
    const { app, page } = await launch('handles');
    try {
      await hoverTable(page);
      // Three body rows, and the header is not one of them.
      await expect(table(page).locator('.noto-table-rail-rows .noto-table-handle')).toHaveCount(3);
      await expect(table(page).locator('.noto-table-rail-columns .noto-table-handle')).toHaveCount(3);
      await page.screenshot({ path: path.join(resultRoot, 'rails.png') });
    } finally {
      await app.close();
    }
  });

  test('carries a row to where it is dropped', async () => {
    const { app, page } = await launch('drag-row');
    try {
      await hoverTable(page);
      expect(await firstColumn(page)).toEqual(['one', 'four', 'seven']);

      const rows = table(page).locator('tr');
      const height = (await rows.nth(1).boundingBox())!.height;
      await dragHandle(page, table(page).locator('.noto-table-rail-rows .noto-table-handle').first(), height * 2.5);
      expect(await firstColumn(page)).toEqual(['four', 'seven', 'one']);
    } finally {
      await app.close();
    }
  });

  test('carries a column, header and body together', async () => {
    const { app, page } = await launch('drag-column');
    try {
      await hoverTable(page);
      const width = (await table(page).locator('th').first().boundingBox())!.width;
      await dragHandle(page, table(page).locator('.noto-table-rail-columns .noto-table-handle').first(), 0, width * 1.6);

      await expect(table(page).locator('th').first()).toHaveText('head b');
      await expect(table(page).locator('tr').nth(1).locator('td').first()).toHaveText('two');
    } finally {
      await app.close();
    }
  });

  test('carries a column again straight after a move, and after a key typed in a cell', async () => {
    const { app, page } = await launch('drag-again');
    try {
      await hoverTable(page);
      const columns = () => table(page).locator('th').allInnerTexts();
      const width = (await table(page).locator('th').first().boundingBox())!.width;
      const handles = table(page).locator('.noto-table-rail-columns .noto-table-handle');
      // The handles stay while the pointer is still on the table: they used to
      // go with the first move and come back only when it left and returned.
      await dragHandle(page, handles.first(), 0, width * 1.6);
      await expect.poll(columns).toEqual(['head b', 'head a', 'head c']);
      await expect(handles.first()).toBeVisible();
      await dragHandle(page, handles.first(), 0, width * 1.6);
      await expect.poll(columns).toEqual(['head a', 'head b', 'head c']);

      // A caret moved into a cell and a key typed there do not take them away.
      await table(page).locator('td').first().click();
      await page.keyboard.type('!');
      await table(page).locator('table').hover();
      await expect(handles.first()).toBeVisible();
      await dragHandle(page, handles.last(), 0, -width * 1.6);
      await expect.poll(columns).toEqual(['head a', 'head c', 'head b']);
    } finally {
      await app.close();
    }
  });

  test('leaves everything where it was when the drag is called off', async () => {
    const { app, page } = await launch('escape');
    try {
      await hoverTable(page);
      const handle = table(page).locator('.noto-table-rail-rows .noto-table-handle').first();
      const box = (await handle.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + 90);
      await expect(table(page).locator('.noto-table-drop')).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(table(page).locator('.noto-table-drop')).toBeHidden();
      await page.mouse.up();
      expect(await firstColumn(page)).toEqual(['one', 'four', 'seven']);
    } finally {
      await app.close();
    }
  });

  test('works the same for a table nested inside a quote', async () => {
    const { app, page } = await launch('nested');
    try {
      const quoted = page.locator('blockquote .noto-table-frame');
      await quoted.locator('table').hover();
      const handles = quoted.locator('.noto-table-rail-rows .noto-table-handle');
      await expect(handles).toHaveCount(2);

      const rows = quoted.locator('tr');
      const height = (await rows.nth(1).boundingBox())!.height;
      await dragHandle(page, handles.first(), height * 1.5);
      await expect(quoted.locator('tr td:first-child').first()).toHaveText('gamma');
      await page.screenshot({ path: path.join(resultRoot, 'nested.png') });
    } finally {
      await app.close();
    }
  });

  test('survives a table whose rows are not all the same width', async () => {
    const { app, page } = await launch('ragged');
    try {
      // A merged cell only arrives by pasting HTML, and then counting cells off
      // the header runs past the end of a short row. Clicking a handle used to
      // throw out of the pointer handler before the drag was ended, which left
      // the window listeners attached and the rail frozen for good.
      await page.evaluate(() => {
        const row = document.querySelector('.ProseMirror tr:last-child');
        row?.lastElementChild?.remove();
      });
      await table(page).locator('table').hover();
      const handle = table(page).locator('.noto-table-rail-rows .noto-table-handle').first();
      await handle.click();

      // Still alive: the rails redraw on the next pass of the pointer.
      await page.mouse.move(0, 0);
      await table(page).locator('table').hover();
      await expect(handle).toBeVisible();
      await expect(page.locator('.noto-table-rails[data-dragging]')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('selects the whole row when the handle is clicked rather than dragged', async () => {
    const { app, page } = await launch('select');
    try {
      await hoverTable(page);
      await table(page).locator('.noto-table-rail-rows .noto-table-handle').first().click();
      await expect(table(page).locator('tr').nth(1).locator('.selectedCell')).toHaveCount(3);
    } finally {
      await app.close();
    }
  });
});

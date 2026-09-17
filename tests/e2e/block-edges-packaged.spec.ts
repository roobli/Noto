import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable, placeCaretAtStart } from './packaged-app';

const resultRoot = path.join(process.cwd(), 'test-results', 'block-edges');

const NOTE = '# Head\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nTail\n';

async function launch(name: string): Promise<{ app: ElectronApplication; page: Page }> {
  const workspace = path.join(resultRoot, name);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const vault = path.join(workspace, 'vault');
  await mkdir(vault, { recursive: true });
  await writeFile(path.join(vault, 'keys.md'), NOTE, 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, vault],
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
  await page.getByTestId('tree-file').first().click();
  await page.locator('.canvas-slot:not([hidden]) [data-testid="noto-editor"]').waitFor({ state: 'visible' });
  return { app, page };
}

const editor = (page: Page) => page.locator('.canvas-slot:not([hidden]) .ProseMirror');

/**
 * Click into a block and wait until the editor has taken the caret, which it
 * learns of a moment after the browser moves the selection; a key pressed in
 * that moment goes to wherever the caret was before.
 */
async function caretIn(page: Page, target: ReturnType<Page['locator']>, text: string): Promise<void> {
  await target.click();
  await expect(editor(page).locator('.noto-active-block')).toContainText(text);
}

/** The text of the cell the caret is in, read from the live selection. */
const caretCell = (page: Page) => page.evaluate(() => {
  const node = window.getSelection()?.anchorNode;
  const element = node instanceof Element ? node : node?.parentElement;
  return element?.closest('td, th')?.textContent ?? null;
});

test.describe("Typora's keys at the edges of a block", () => {
  test('Backspace at the start of a heading leaves a paragraph with its words', async ({}, info) => {
    const { app, page } = await launch(info.title.slice(0, 12).replace(/\W+/g, '-'));
    try {
      // Home / Meta+ArrowLeft can scroll or miss a packaged macOS window.
      // placeCaretAtStart focuses ProseMirror then sets the Selection — without
      // focus, PM ignores selectionchange and data-caret stayed at the click
      // position (flake: expected "1", got "5" on macos-14).
      const host = page.locator('.canvas-slot:not([hidden]) [data-testid="noto-editor"]');
      const heading = editor(page).locator('h1');
      await expect(async () => {
        await placeCaretAtStart(page, heading);
        await expect(host).toHaveAttribute('data-caret', '1');
      }).toPass({ timeout: 20_000 });
      await expect(editor(page).locator('.noto-active-block')).toHaveText('Head');
      await page.keyboard.press('Backspace');
      await expect(editor(page).locator('h1')).toHaveCount(0);
      await expect(editor(page).locator('p').first()).toHaveText('Head');
      // The words are still there to be typed after.
      await page.keyboard.type('ing');
      await expect(editor(page).locator('p').first()).toHaveText('ingHead');
    } finally {
      await app.close();
    }
  });

  test('Enter in a table goes down the column and makes a row at the bottom', async ({}, info) => {
    const { app, page } = await launch(info.title.slice(0, 12).replace(/\W+/g, '-'));
    try {
      await caretIn(page, editor(page).locator('th').filter({ hasText: 'b' }), 'b');
      await page.keyboard.press('Enter');
      expect(await caretCell(page)).toBe('2');
      await expect(editor(page).locator('tr')).toHaveCount(2);
      await page.keyboard.press('Enter');
      await expect(editor(page).locator('tr')).toHaveCount(3);
      await page.keyboard.type('new');
      await expect(editor(page).locator('tr').last().locator('td').nth(1)).toHaveText('new');
      await expect(editor(page).locator('tr').last().locator('td').nth(0)).toHaveText('');
    } finally {
      await app.close();
    }
  });

  test('a header line and a rule typed by hand become a table on Enter', async ({}, info) => {
    const { app, page } = await launch(info.title.slice(0, 12).replace(/\W+/g, '-'));
    try {
      await caretIn(page, editor(page).locator('p').filter({ hasText: 'Tail' }), 'Tail');
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('| x | y |');
      await page.keyboard.press('Enter');
      await page.keyboard.type('|---|:-:|');
      await expect(editor(page).locator('table')).toHaveCount(1);
      await page.keyboard.press('Enter');
      await expect(editor(page).locator('table')).toHaveCount(2);
      const made = editor(page).locator('table').last();
      await expect(made.locator('th')).toHaveText(['x', 'y']);
      await expect(made.locator('th').nth(1)).toHaveCSS('text-align', 'center');
      await page.keyboard.type('1');
      await expect(made.locator('td').first()).toHaveText('1');
    } finally {
      await app.close();
    }
  });
});

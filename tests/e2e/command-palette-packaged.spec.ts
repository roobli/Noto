import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test';
import { packagedExecutable, placeCaret } from './packaged-app';

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
    const target = find(Menu.getApplicationMenu()!.items);
    if (!target) throw new Error(`No menu item with id ${itemId}`);
    target.click();
  }, id);
}

/*
 * The palette is a modal dialog with a filter field: the keyboard goes into
 * the field, the words typed narrow the list, Up and Down pick a row, Tab
 * stays inside, and Escape, Close or a press outside leave it and give the
 * keyboard back to the note. Running a command with Enter is covered by the
 * plugin center spec, which runs a real plugin's command that way.
 */
test('the command palette filters, moves, traps the focus, and gives it back', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'command-palette');
  await rm(workspace, { recursive: true, force: true });
  const userData = path.join(workspace, 'user-data');
  await mkdir(userData, { recursive: true });
  const file = path.join(workspace, 'note.md');
  const text = '# Palette\n\nBody text.\n';
  await writeFile(file, text, 'utf8');

  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${userData}`, `--open=${file}`],
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 900 });
    const editor = page.locator('.canvas-slot:not([hidden]) .ProseMirror');
    await editor.waitFor({ state: 'visible', timeout: 30_000 });
    await placeCaret(page, editor.locator('p'));

    const focusInPalette = () => page.evaluate(
      () => document.querySelector('[data-testid="command-palette"]')?.contains(document.activeElement) ?? false,
    );
    const focusInEditor = () => page.evaluate(
      () => document.activeElement?.closest('.ProseMirror') !== null,
    );

    await invokeMenu(app, 'command-palette');
    const palette = page.getByTestId('command-palette');
    const field = page.getByTestId('palette-input');
    const options = palette.getByRole('option');
    await expect(palette).toBeVisible();
    await expect(field).toBeFocused();
    const all = await options.count();
    expect(all).toBeGreaterThan(3);

    // The first row is current, and the field says so.
    const activeId = () => field.getAttribute('aria-activedescendant');
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');
    expect(await activeId()).toBe(await options.first().getAttribute('id'));

    // Down and Up walk the rows; Up from the top wraps to the bottom.
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    expect(await activeId()).toBe(await options.nth(1).getAttribute('id'));
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await expect(options.last()).toHaveAttribute('aria-selected', 'true');

    // Words narrow the list, in any order, and the first match is current.
    await page.keyboard.type('pdf export');
    await expect(options).toHaveCount(1);
    await expect(options.first()).toContainText('Export PDF');
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');
    await field.fill('nothing like this');
    await expect(options).toHaveCount(0);
    await expect(palette.getByText('No command matches that.')).toBeVisible();
    await field.fill('');
    await expect(options).toHaveCount(all);

    // None of that reached the note.
    await expect(editor.locator('p')).toHaveText('Body text.');

    // Tab goes round the field and Close, and never out of the dialog.
    for (let step = 0; step < 4; step += 1) {
      await page.keyboard.press(step % 2 === 0 ? 'Tab' : 'Shift+Tab');
      await page.keyboard.press('Tab');
      expect(await focusInPalette()).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);
    await expect.poll(focusInEditor).toBe(true);

    // Close hands the keyboard back the same way.
    await invokeMenu(app, 'command-palette');
    await expect(field).toBeFocused();
    await palette.getByRole('button', { name: 'Close' }).click();
    await expect(palette).toHaveCount(0);
    await expect.poll(focusInEditor).toBe(true);

    // So does a press outside it.
    await invokeMenu(app, 'command-palette');
    await expect(field).toBeFocused();
    await page.mouse.click(30, 860);
    await expect(palette).toHaveCount(0);
    await expect.poll(focusInEditor).toBe(true);

    expect(await readFile(file, 'utf8')).toBe(text);
  } finally {
    await app.close();
  }
});

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
 * The palette is a modal dialog: the keyboard goes into it, Escape leaves it,
 * and leaving gives the keyboard back to the note. It used to open with the
 * focus still in the document, so keys typed into the note behind it and
 * Escape did nothing at all.
 */
test('the command palette takes the keyboard, and Escape gives it back', async () => {
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
    await expect(palette).toBeVisible();
    await expect.poll(focusInPalette).toBe(true);

    // A key pressed now is the palette's, not the note's.
    await page.keyboard.type('x');
    await expect(editor.locator('p')).toHaveText('Body text.');

    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);
    await expect.poll(focusInEditor).toBe(true);

    // The Close button hands the keyboard back the same way.
    await invokeMenu(app, 'command-palette');
    await expect.poll(focusInPalette).toBe(true);
    await palette.getByRole('button', { name: 'Close' }).click();
    await expect(palette).toHaveCount(0);
    await expect.poll(focusInEditor).toBe(true);

    expect(await readFile(file, 'utf8')).toBe(text);
  } finally {
    await app.close();
  }
});

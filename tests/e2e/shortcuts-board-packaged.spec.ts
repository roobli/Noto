import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';
import { packagedExecutable, placeCaretAtEnd } from './packaged-app';

test('the Shortcuts pane lists every key, and a switch turns one off everywhere it is bound', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'shortcuts-board');
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const file = path.join(workspace, 'note.md');
  await writeFile(file, '# Keys\n\nSome plain words here\n', 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${file}`],
  });
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  const menuChord = (id: string) => app.evaluate(({ Menu }, itemId) =>
    Menu.getApplicationMenu()?.getMenuItemById(itemId)?.accelerator ?? null, id);
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
    await page.setViewportSize({ width: 1280, height: 860 });
    const paragraph = page.locator('.canvas-slot:not([hidden]) .ProseMirror > p').first();
    const boldWord = async () => {
      await placeCaretAtEnd(page, paragraph);
      await page.keyboard.press(process.platform === 'darwin' ? 'Alt+Shift+ArrowLeft' : 'Control+Shift+ArrowLeft');
      // The editor reads a selection the keyboard made on the browser's next
      // selection event; pressed at once, the chord finds an empty caret and
      // only arms the mark for the next character typed.
      await page.waitForTimeout(250);
      await page.keyboard.press(`${mod}+b`);
    };

    await page.getByTestId('settings-toggle').click();
    await page.getByTestId('pref-shortcuts').click();
    const rows = page.getByTestId('shortcut-row');
    await expect.poll(() => rows.count()).toBeGreaterThan(60);
    // Every key once: nothing on two rows.
    await expect(page.getByTestId('shortcut-clash')).toHaveCount(0);
    await expect(page.locator('[data-testid="shortcut-row"][data-chord="Mod+Alt+Shift+T"]')).toContainText('Browse Tags');
    await expect(page.locator('[data-testid="shortcut-row"][data-chord="Mod+Shift+ArrowUp"]')).toContainText('Plugin · Title Shift');

    // Found by name.
    await page.getByTestId('shortcut-search').fill('strong');
    await expect(rows).toHaveCount(1);
    const strong = page.locator('[data-testid="shortcut-row"][data-chord="Mod+B"]');
    await expect(strong).toContainText('Menu · Editor');

    // Off: the menu lets go of the key, and the row says so.
    expect(await menuChord('mark-strong')).toBe('CmdOrCtrl+B');
    // The track, as a person turns it off. The input under it is a 1px box,
    // and in a test window that is never shown Settings can still be at its
    // entrance's 0.98 scale here, which leaves Playwright no pixel to press.
    await strong.locator('.pref-track').click();
    await expect(strong.getByTestId('shortcut-switch')).not.toBeChecked();
    await expect(strong.locator('.shortcut-keys')).toHaveAttribute('data-off', 'true');
    await expect(page.getByTestId('shortcut-count')).toContainText('1 off');
    await expect.poll(() => menuChord('mark-strong')).toBeFalsy();

    // And the editor's own binding passes the key on.
    await page.getByTestId('settings-close').click();
    await boldWord();
    // Given time to arrive, since what this rules out is the browser bolding
    // the text on its own a moment later.
    await page.waitForTimeout(400);
    await expect(paragraph.locator('strong, b')).toHaveCount(0);

    // Back on, from the reset, and the key bolds again.
    await page.getByTestId('settings-toggle').click();
    await page.getByTestId('pref-shortcuts').click();
    await page.getByTestId('shortcut-reset').click();
    await expect(page.getByTestId('shortcut-count')).not.toContainText('off');
    await expect.poll(() => menuChord('mark-strong')).toBe('CmdOrCtrl+B');
    await page.getByTestId('settings-close').click();
    await boldWord();
    await expect(paragraph.locator('strong')).toHaveText('here');
  } finally {
    await app.close();
  }
});

/**
 * Every save says what it did: the note's name and the full path it was
 * written to, or that it could not be, and why.
 */
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test';
import { packagedExecutable, placeCaret } from './packaged-app';

const END = process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End';

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
    find(Menu.getApplicationMenu()!.items)!.click();
  }, id);
}

test('a save, by hand or on leaving the note, says the name and the path it wrote; a failed one says so', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'save-toast');
  await chmod(path.join(workspace, 'vault', 'locked'), 0o755).catch(() => {});
  await rm(workspace, { recursive: true, force: true });
  const vault = path.join(workspace, 'vault');
  await mkdir(path.join(vault, 'locked'), { recursive: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const first = path.join(vault, 'first.md');
  const locked = path.join(vault, 'locked', 'kept.md');
  await writeFile(first, 'First.\n', 'utf8');
  await writeFile(path.join(vault, 'second.md'), 'Second.\n', 'utf8');
  await writeFile(locked, 'Kept.\n', 'utf8');
  const app = await electron.launch({ executablePath: packagedExecutable(), args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, vault] });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
    await page.getByTestId('tree-file').filter({ hasText: 'first.md' }).click();
    const editor = page.locator('.canvas-slot:not([hidden]) .ProseMirror');
    const toast = page.getByTestId('save-toast');

    await placeCaret(page, editor.locator('p').first());
    await page.keyboard.press(END);
    await page.keyboard.type(' One');
    await invokeMenu(app, 'save');
    await expect(toast).toHaveAttribute('data-ok', 'true');
    await expect(toast).toContainText('Saved first.md');
    await expect(page.getByTestId('save-toast-path')).toHaveText(`to ${first}`);
    await expect.poll(() => readFile(first, 'utf8')).toBe('First. One\n');

    // Saved on the way to another note: the toast is the one left, not the one opened.
    await placeCaret(page, editor.locator('p').first());
    await page.keyboard.press(END);
    await page.keyboard.type(' Two');
    await page.getByTestId('tree-file').filter({ hasText: 'second.md' }).click();
    await expect(page.getByTestId('save-toast-path')).toHaveText(`to ${first}`);
    await expect.poll(() => readFile(first, 'utf8')).toBe('First. One Two\n');

    // A folder that cannot be written to: the toast says it failed, where, and why.
    await page.getByTestId('tree-directory').filter({ hasText: 'locked' }).click();
    await page.getByTestId('tree-file').filter({ hasText: 'kept.md' }).click();
    await expect(editor.locator('p').first()).toHaveText('Kept.');
    await chmod(path.join(vault, 'locked'), 0o555);
    await placeCaret(page, editor.locator('p').first());
    await page.keyboard.press(END);
    await page.keyboard.type(' Three');
    await invokeMenu(app, 'save');
    await expect(toast).toHaveAttribute('data-ok', 'false');
    await expect(toast).toContainText('Could not save kept.md');
    await expect(page.getByTestId('save-toast-path')).toHaveText(`to ${locked}`);
  } finally {
    await chmod(path.join(vault, 'locked'), 0o755).catch(() => {});
    await app.close();
  }
});

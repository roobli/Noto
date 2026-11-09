/**
 * The file tree from the keyboard, in the packaged app (daily-use audit,
 * finding 17): the rows are a tree with one Tab stop, the arrows walk them,
 * Right and Left open and close a folder, Enter opens a note, F2 names a row
 * again, and typing a name goes to it.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

const made: string[] = [];
test.afterAll(() => {
  for (const directory of made) rmSync(directory, { recursive: true, force: true });
});

function scratch(name: string): string {
  const directory = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), `noto-e2e-${name}-`)));
  made.push(directory);
  return directory;
}

test('the file tree walks, opens and renames from the keyboard', async () => {
  const root = scratch('tree-keys');
  mkdirSync(path.join(root, 'archive'));
  writeFileSync(path.join(root, 'archive', 'old.md'), '# Old\n', 'utf8');
  writeFileSync(path.join(root, 'alpha.md'), '# Alpha\n', 'utf8');
  writeFileSync(path.join(root, 'beta.md'), '# Beta\n', 'utf8');
  writeFileSync(path.join(root, 'gamma.md'), '# Gamma\n', 'utf8');
  const userData = scratch('user-data');
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({}));
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${userData}`, `--folder=${root}`, `--open=${path.join(root, 'alpha.md')}`],
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
    const tree = page.getByRole('tree');
    await expect(tree).toBeVisible();
    // One row on the Tab path: the note in front.
    await expect(tree.locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1);
    const alpha = tree.locator('[role="treeitem"][data-path$="alpha.md"]');
    await expect(alpha).toHaveAttribute('tabindex', '0');
    await expect(alpha).toHaveAttribute('aria-level', '1');

    await alpha.focus();
    const focused = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.path?.split('/').pop() ?? null);
    await page.keyboard.press('ArrowUp');
    await expect.poll(focused).toBe('archive');
    await page.keyboard.press('ArrowRight');
    await expect(tree.locator('[role="treeitem"][data-path$="archive"]')).toHaveAttribute('aria-expanded', 'true');
    await expect(tree.locator('[role="treeitem"][data-path$="old.md"]')).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect.poll(focused).toBe('old.md');
    await page.keyboard.press('ArrowLeft');
    await expect.poll(focused).toBe('archive');
    await page.keyboard.press('ArrowLeft');
    await expect(tree.locator('[role="treeitem"][data-path$="archive"]')).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('End');
    await expect.poll(focused).toBe('gamma.md');
    await page.keyboard.press('Home');
    await expect.poll(focused).toBe('archive');
    // Typing a name goes to it.
    await page.keyboard.type('be');
    await expect.poll(focused).toBe('beta.md');
    await page.keyboard.press('Enter');
    await expect(page.locator('.canvas-slot:not([hidden]) .ProseMirror h1')).toHaveText('Beta');

    // F2 names the row again where it sits.
    await tree.locator('[role="treeitem"][data-path$="gamma.md"]').focus();
    await page.keyboard.press('F2');
    const field = page.getByTestId('tree-name-field');
    await expect(field).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(field).toHaveCount(0);
  } finally {
    await app.close();
  }
});

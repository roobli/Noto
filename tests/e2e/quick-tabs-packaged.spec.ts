import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

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

async function launch(name: string): Promise<{ app: ElectronApplication; page: Page; userData: string }> {
  const workspace = path.join(process.cwd(), 'test-results', 'quick-tabs', name);
  await rm(workspace, { recursive: true, force: true });
  const userData = path.join(workspace, 'user-data');
  await mkdir(userData, { recursive: true });
  const vault = path.join(workspace, 'vault');
  await mkdir(path.join(vault, 'works', 'jobs'), { recursive: true });
  await mkdir(path.join(vault, 'archive'), { recursive: true });
  await writeFile(path.join(vault, 'top.md'), '# Top\n\nA note at the top.\n', 'utf8');
  await writeFile(path.join(vault, 'works', 'plan.md'), '# Plan\n\nThe kestrel plan.\n', 'utf8');
  await writeFile(path.join(vault, 'works', 'jobs', 'hiring.md'), '# Hiring\n\nAbout kestrels again.\n', 'utf8');
  await writeFile(path.join(vault, 'archive', 'old.md'), '# Old\n\nAn old kestrel note.\n', 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${userData}`, vault],
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
  return { app, page, userData };
}

test.describe('quick open, as the author built it', () => {
  test('has three tabs, and a folder narrows the other two', async () => {
    const { app, page } = await launch('tabs');
    try {
      await invokeMenu(app, 'quick-open');
      await expect(page.getByTestId('quick-open')).toBeVisible();
      await expect(page.getByTestId('quick-tab-files')).toHaveAttribute('aria-selected', 'true');

      // Tab cycles files, folders, content and back.
      await page.keyboard.press('Tab');
      await expect(page.getByTestId('quick-tab-folders')).toHaveAttribute('aria-selected', 'true');
      const folders = page.getByTestId('quick-folder');
      await expect(folders.first()).toContainText('works');
      // Counted through the whole subtree, so `works` says two.
      await expect(folders.first()).toContainText('2');

      // Choosing one narrows the search to it and goes back to the notes.
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('quick-tab-files')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('quick-scope')).toHaveText('works');
      await page.getByTestId('quick-input').fill('');
      await expect(page.getByTestId('quick-input')).toHaveAttribute('placeholder', 'Search 2 notes');

      // The content tab is narrowed too: three notes mention kestrels, one is inside.
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await expect(page.getByTestId('quick-tab-content')).toHaveAttribute('aria-selected', 'true');
      await page.getByTestId('quick-input').fill('kestrel');
      await expect(page.getByTestId('quick-match')).toHaveCount(2, { timeout: 15_000 });

      // Backspace on an empty box steps back out of the folder.
      await page.getByTestId('quick-input').fill('');
      await page.keyboard.press('Backspace');
      await expect(page.getByTestId('quick-scope')).toHaveCount(0);
      await page.getByTestId('quick-input').fill('kestrel');
      await expect(page.getByTestId('quick-match')).toHaveCount(3, { timeout: 15_000 });
    } finally {
      await app.close();
    }
  });

  test('opens on the chord the author uses, and remembers how wide it was made', async () => {
    const { app, page, userData } = await launch('width');
    try {
      // Command-period, which is the author's own palette's chord.
      await invokeMenu(app, 'quick-open-period');
      const palette = page.getByTestId('quick-open');
      await expect(palette).toBeVisible();
      await expect(palette).toHaveAttribute('data-width', 'default');
      const narrow = await palette.evaluate((node) => Math.round(node.getBoundingClientRect().width));

      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+]' : 'Control+]');
      await expect(palette).toHaveAttribute('data-width', 'wide');
      await expect.poll(() => palette.evaluate((node) => Math.round(node.getBoundingClientRect().width)))
        .toBeGreaterThan(narrow);

      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+[' : 'Control+[');
      await expect(palette).toHaveAttribute('data-width', 'default');
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+]' : 'Control+]');
      await expect(palette).toHaveAttribute('data-width', 'wide');
      // Wait for main to persist the preference before tearing the window down —
      // otherwise Windows CI can close mid-write and reopen at the default width.
      await expect.poll(async () => {
        try {
          const stored = JSON.parse(await readFile(path.join(userData, 'settings.json'), 'utf8'));
          return stored.quickOpenWidth ?? null;
        } catch {
          return null;
        }
      }, { timeout: 15_000 }).toBe('wide');
      await page.keyboard.press('Escape');
    } finally {
      await app.close();
    }

    // The width is a preference, so the next window opens wearing it.
    const again = await electron.launch({
      executablePath: packagedExecutable(),
      args: [`--user-data-dir=${userData}`, path.join(path.dirname(userData), 'vault')],
    });
    try {
      const page = await again.firstWindow();
      await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
      // Settings load async after mount; poll until the palette reflects disk.
      await invokeMenu(again, 'quick-open');
      await expect(page.getByTestId('quick-open')).toHaveAttribute('data-width', 'wide', { timeout: 15_000 });
    } finally {
      await again.close();
    }
  });
});

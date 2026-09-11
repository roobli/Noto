/**
 * File tags: chips on the note, and Browse Tags across the vault.
 *
 * The author's brief was tags on a file and multi-file linking by tag. The
 * tags stay in frontmatter; this checks that they draw, that a click opens
 * the other notes that share one, and that the Settings switch hides them.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

const resultRoot = path.join(process.cwd(), 'test-results', 'file-tags');

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

interface Workspace { app: ElectronApplication; page: Page; folder: string }

async function launch(name: string): Promise<Workspace> {
  const workspace = path.join(resultRoot, name);
  await rm(workspace, { recursive: true, force: true });
  const folder = path.join(workspace, 'vault');
  await mkdir(folder, { recursive: true });
  await writeFile(
    path.join(folder, 'agent.md'),
    '---\ntags: [agent, cloudflare]\ntype: theory\n---\n\n# Agent\n\nAbout agents.\n',
    'utf8',
  );
  await writeFile(
    path.join(folder, 'linux.md'),
    '---\ntags:\n  - linux\n  - agent\n---\n\n# Linux\n\nAbout linux.\n',
    'utf8',
  );
  await writeFile(path.join(folder, 'plain.md'), '# Plain\n\nNo tags here.\n', 'utf8');

  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${path.join(folder, 'agent.md')}`],
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
  await page.setViewportSize({ width: 1280, height: 900 });

  await app.evaluate(({ dialog }, target) => {
    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog =
      async () => ({ canceled: false, filePaths: [target] });
  }, folder);
  await invokeMenu(app, 'open-folder');
  await expect(page.getByTestId('file-tree')).toBeVisible();
  return { app, page, folder };
}

test.describe('file tags', () => {
  test('draws the note\'s tags and opens the others that share one', async () => {
    const { app, page } = await launch('chips');
    try {
      await expect(page.getByTestId('tag-strip')).toBeVisible();
      await expect(page.getByTestId('tag-chip')).toHaveCount(2);
      await expect(page.getByTestId('tag-chip').nth(0)).toHaveText('agent');
      await expect(page.getByTestId('tag-chip').nth(1)).toHaveText('cloudflare');

      await page.getByTestId('tag-chip').filter({ hasText: 'agent' }).click();
      await expect(page.getByTestId('tag-browser')).toBeVisible();
      await expect(page.getByTestId('tag-browser-note')).toHaveCount(2);
      await expect(page.getByTestId('tag-browser-note').filter({ hasText: 'linux' })).toBeVisible();

      await page.getByTestId('tag-browser-note').filter({ hasText: 'linux' }).click();
      await expect(page.getByTestId('tag-browser')).toBeHidden();
      await expect(page.locator('.canvas-slot:not([hidden]) .ProseMirror h1')).toHaveText('Linux');
      await expect(page.getByTestId('tag-chip').filter({ hasText: 'linux' })).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('Browse Tags lists every tag in the vault', async () => {
    const { app, page } = await launch('browse');
    try {
      await invokeMenu(app, 'browse-tags');
      await expect(page.getByTestId('tag-browser')).toBeVisible();
      await expect(page.getByTestId('tag-browser-tag')).toHaveCount(3);
      await page.getByTestId('tag-browser-tag').filter({ hasText: 'cloudflare' }).click();
      await expect(page.getByTestId('tag-browser-note')).toHaveCount(1);
      await expect(page.getByTestId('tag-browser-note')).toContainText('agent');
    } finally {
      await app.close();
    }
  });

  test('the Settings switch hides the chips', async () => {
    const { app, page } = await launch('toggle');
    try {
      await expect(page.getByTestId('tag-strip')).toBeVisible();
      await page.getByTestId('settings-toggle').click();
      await page.getByTestId('pref-editor').click();
      await page.getByTestId('setting-file-tags').click();
      await page.getByTestId('settings-close').click();
      await expect(page.getByTestId('tag-strip')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});

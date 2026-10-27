/**
 * Quick open, against the packaged app.
 *
 * The unit tests cover the ranking arithmetic. What only the packaged app can
 * show is that the index actually reaches the renderer, that a chosen file
 * opens through the same path a tree click takes, and that Alt+Enter writes a
 * link into the real document.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable, placeCaret } from './packaged-app';

const resultRoot = path.join(process.cwd(), 'test-results', 'quick-open');

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
  await mkdir(path.join(folder, 'chapters'), { recursive: true });
  await writeFile(path.join(folder, 'index.md'), '# Index\n\nThe start.\n', 'utf8');
  await writeFile(path.join(folder, 'release-notes.md'), '# Release notes\n\nWhat changed.\n', 'utf8');
  await writeFile(path.join(folder, 'chapters', 'deep-dive.md'), '# Deep dive\n\nDetail.\n', 'utf8');
  await writeFile(path.join(folder, '发展规划.md'), '# 发展规划\n\n计划。\n', 'utf8');

  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${path.join(folder, 'index.md')}`],
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

test.describe('quick open', () => {
  test('follows a note that another program renamed and moved', async () => {
    const { app, page, folder } = await launch('follow-disk');
    try {
      await invokeMenu(app, 'quick-open');
      await expect(page.getByTestId('quick-input')).toHaveAttribute('placeholder', /4 notes/);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('file-tree')).toContainText('release-notes');

      // Finder, a shell or another editor: anything that is not Noto.
      await rename(path.join(folder, 'release-notes.md'), path.join(folder, 'chapters', 'changelog.md'));
      await expect(page.getByTestId('file-tree')).not.toContainText('release-notes');

      await invokeMenu(app, 'quick-open');
      await page.getByTestId('quick-input').fill('changelog');
      await expect(page.getByTestId('quick-result').first()).toContainText('changelog.md');
      await page.getByTestId('quick-input').fill('release');
      await expect(page.getByTestId('quick-open')).not.toContainText('release-notes.md');
    } finally {
      await app.close();
    }
  });

  test('finds a note by name and opens it', async () => {
    const { app, page } = await launch('open');
    try {
      await invokeMenu(app, 'quick-open');
      await expect(page.getByTestId('quick-open')).toBeVisible();
      // The index reached the renderer, so the box knows how much it searches.
      await expect(page.getByTestId('quick-input')).toHaveAttribute('placeholder', /4 notes/);

      await page.getByTestId('quick-input').fill('release');
      await expect(page.getByTestId('quick-result').first()).toContainText('release-notes.md');
      await page.keyboard.press('Enter');

      await expect(page.getByTestId('quick-open')).toBeHidden();
      await expect(page.locator('.canvas-slot:not([hidden]) .ProseMirror h1')).toHaveText('Release notes');
    } finally {
      await app.close();
    }
  });

  test('finds a CJK name, which is most of this vault', async () => {
    const { app, page } = await launch('cjk');
    try {
      await invokeMenu(app, 'quick-open');
      await page.getByTestId('quick-input').fill('发展');
      await expect(page.getByTestId('quick-result').first()).toContainText('发展规划.md');
    } finally {
      await app.close();
    }
  });

  test('narrows by path when the query names a folder', async () => {
    const { app, page } = await launch('path');
    try {
      await invokeMenu(app, 'quick-open');
      await page.getByTestId('quick-input').fill('chapters/deep');
      await expect(page.getByTestId('quick-result').first()).toContainText('deep-dive.md');
    } finally {
      await app.close();
    }
  });

  test('writes a wiki link into the document with the modifier, and follows it back', async () => {
    const { app, page, folder } = await launch('link');
    try {
      // Put the caret at the end of the body before linking.
      await placeCaret(page, page.locator('.canvas-slot:not([hidden]) .ProseMirror p').first());
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');

      await invokeMenu(app, 'quick-open');
      await page.getByTestId('quick-input').fill('deep');
      await page.keyboard.press('Alt+Enter');

      await expect(page.getByTestId('quick-open')).toBeHidden();
      const link = page.locator('.canvas-slot:not([hidden]) .noto-wiki-link');
      await expect(link).toHaveText('deep-dive');

      // It is ordinary text in the file, which is the point of rendering it as
      // a decoration rather than as a node.
      await page.getByTestId('save-button').click();
      await expect(page.getByTestId('file-state')).toHaveText('Saved', { timeout: 15_000 });
      const saved = await readFile(path.join(folder, 'index.md'), 'utf8');
      expect(saved).toContain('[[chapters/deep-dive|deep-dive]]');

      // Following it opens the note it names.
      await link.click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
      await expect(page.locator('.canvas-slot:not([hidden]) .ProseMirror h1')).toHaveText('Deep dive');
    } finally {
      await app.close();
    }
  });

  test('closes on Escape without opening anything', async () => {
    const { app, page } = await launch('escape');
    try {
      await invokeMenu(app, 'quick-open');
      await page.getByTestId('quick-input').fill('release');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('quick-open')).toBeHidden();
      await expect(page.locator('.canvas-slot:not([hidden]) .ProseMirror h1')).toHaveText('Index');
    } finally {
      await app.close();
    }
  });
});

test.describe('searching inside notes', () => {
  test('finds a note by its contents and opens it at the match', async () => {
    const { app, page } = await launch('content');
    try {
      // The chord for searching notes opens the rail's search now, as Typora's
      // does; quick open still searches inside notes, two tabs along the ring
      // of files, folders and content.
      await invokeMenu(app, 'quick-open');
      await expect(page.getByTestId('quick-open')).toBeVisible();
      await page.getByTestId('quick-input').press('Tab');
      await page.getByTestId('quick-input').press('Tab');
      await expect(page.getByTestId('quick-tab-content')).toHaveAttribute('aria-selected', 'true');

      // A word that appears in one note's body and in no note's name.
      await page.getByTestId('quick-input').fill('Detail');
      await expect(page.getByTestId('quick-match')).toHaveCount(1);
      const match = page.getByTestId('quick-match').first();
      await expect(match).toContainText('deep-dive.md');
      // The line it was found on is shown, which is the reason to search bodies.
      await expect(match.locator('.quick-line-text')).toContainText('Detail.');

      await page.keyboard.press('Enter');
      await expect(page.getByTestId('quick-open')).toBeHidden();
      await expect(page.locator('.canvas-slot:not([hidden]) .ProseMirror h1')).toHaveText('Deep dive');
      // The note opens with the query already found, not at the top of a file
      // the reader then has to scan by eye.
      await expect(page.getByTestId('find-input')).toHaveValue('Detail');
      await expect(page.getByTestId('find-status')).toHaveText('1 of 1');
    } finally {
      await app.close();
    }
  });

  test('switches between searching names and searching bodies with Tab', async () => {
    const { app, page } = await launch('content-tab');
    try {
      await invokeMenu(app, 'quick-open');
      await expect(page.getByTestId('quick-tab-files')).toHaveAttribute('aria-selected', 'true');
      await page.getByTestId('quick-input').fill('Detail');
      // Nothing is named that, so the name search finds nothing.
      await expect(page.getByTestId('quick-result')).toHaveCount(0);

      await page.keyboard.press('Tab');
      await expect(page.getByTestId('quick-tab-folders')).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('Tab');
      await expect(page.getByTestId('quick-tab-content')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('quick-match')).toHaveCount(1);
    } finally {
      await app.close();
    }
  });

  test('says so when nothing contains the query', async () => {
    const { app, page } = await launch('content-empty');
    try {
      await invokeMenu(app, 'quick-open');
      await page.getByTestId('quick-input').press('Tab');
      await page.getByTestId('quick-input').press('Tab');
      await page.getByTestId('quick-input').fill('zzzznothinghere');
      await expect(page.getByTestId('quick-open')).toContainText('No note contains that.');
    } finally {
      await app.close();
    }
  });
});

test.describe('reveal in the file manager', () => {
  /**
   * The real call opens Finder, which would leave windows all over the machine
   * running a suite, so it is replaced in the app process and observed. What
   * this proves is the part worth proving: which path main chose, from a
   * request that named only a kind.
   */
  async function captureReveals(app: ElectronApplication): Promise<void> {
    await app.evaluate(({ shell }) => {
      const seen: string[] = [];
      (globalThis as unknown as { revealed: string[] }).revealed = seen;
      shell.showItemInFolder = (target: string) => { seen.push(target); };
    });
  }
  const revealed = (app: ElectronApplication) =>
    app.evaluate(() => (globalThis as unknown as { revealed: string[] }).revealed);

  test('reveals the folder from the rail, and the document from the menu', async () => {
    const { app, page, folder } = await launch('reveal');
    try {
      await captureReveals(app);

      // The menu lives on the folder's row and shows when the pointer is on it.
      await page.getByTestId('tree-vault').hover();
      await page.getByTestId('rail-folder-menu').click();
      await page.getByTestId('rail-reveal-folder').click();
      await expect.poll(() => revealed(app)).toEqual([folder]);

      await invokeMenu(app, 'reveal-document');
      await expect.poll(() => revealed(app))
        .toEqual([folder, path.join(folder, 'index.md')]);
    } finally {
      await app.close();
    }
  });

  test('does nothing rather than failing when there is no folder', async () => {
    const workspace = path.join(resultRoot, 'reveal-none');
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true });
    const app = await electron.launch({
      executablePath: packagedExecutable(),
      args: [`--user-data-dir=${path.join(workspace, 'user-data')}`],
    });
    try {
      const page = await app.firstWindow();
      await page.waitForSelector('[data-testid="noto-app"]');
      await captureReveals(app);
      const outcome = await page.evaluate(async () => {
        const api = (window as unknown as {
          notoWorkspace: { reveal(request: unknown): Promise<{ ok: boolean; value?: { revealed: boolean } }> };
        }).notoWorkspace;
        return api.reveal({ version: 1, requestId: 'reveal:none', target: 'document' });
      });
      expect(outcome.ok).toBe(true);
      expect(outcome.value?.revealed).toBe(false);
      expect(await revealed(app)).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

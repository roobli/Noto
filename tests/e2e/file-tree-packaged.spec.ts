import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

const resultRoot = path.join(process.cwd(), 'test-results', 'file-tree');


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

/**
 * Choose the folder without the native dialog.
 *
 * The dialog cannot be driven from a test, so the folder is set through the
 * same session call the dialog would make, and everything after it is the real
 * path: the IPC listing, its root confinement, and the tree.
 */
async function chooseFolder(app: ElectronApplication, folder: string): Promise<void> {
  await app.evaluate(({ dialog }, target) => {
    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog =
      async () => ({ canceled: false, filePaths: [target] });
  }, folder);
  await invokeMenu(app, 'open-folder');
}

interface Workspace {
  app: ElectronApplication;
  page: Page;
  folder: string;
}

async function launch(name: string): Promise<Workspace> {
  const workspace = path.join(resultRoot, name);
  await rm(workspace, { recursive: true, force: true });
  const folder = path.join(workspace, 'notes');
  await mkdir(path.join(folder, 'chapters'), { recursive: true });
  await mkdir(path.join(folder, 'node_modules'), { recursive: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });

  await writeFile(path.join(folder, 'index.md'), '# Index\n\nIndex body.\n', 'utf8');
  await writeFile(path.join(folder, 'appendix.md'), '# Appendix\n\nAppendix body.\n', 'utf8');
  await writeFile(path.join(folder, 'picture.png'), 'binary\n', 'utf8');
  await writeFile(path.join(folder, 'chapters', 'one.md'), '# One\n\nChapter one body.\n', 'utf8');
  await writeFile(path.join(folder, 'node_modules', 'noise.md'), '# Noise\n', 'utf8');

  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [
      `--user-data-dir=${path.join(workspace, 'user-data')}`,
      `--open=${path.join(folder, 'index.md')}`,
    ],
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
  await page.setViewportSize({ width: 1400, height: 900 });
  return { app, page, folder };
}

test.describe('workspace file tree', () => {
  test('is hidden until asked for, then shows the folder the note came from', async () => {
    const { app, page, folder } = await launch('show');
    try {
      await expect(page.getByTestId('file-tree')).toBeHidden();

      await invokeMenu(app, 'toggle-sidebar');
      await expect(page.getByTestId('file-tree')).toBeVisible();
      // The note was opened on its own and brought its folder with it, so the
      // tree has something to show without being asked a second time.
      await expect(page.getByTestId('tree-vault')).toContainText('notes');
      await expect(page.getByTestId('tree-file')).toHaveCount(3);

      // Choosing a folder still works, and lands on the same one.
      await chooseFolder(app, folder);
      await expect(page.getByTestId('tree-vault')).toContainText('notes');
    } finally {
      await app.close();
    }
  });

  test('offers to open a folder when there is no note to take one from', async () => {
    const workspace = path.join(resultRoot, 'empty');
    await rm(workspace, { recursive: true, force: true });
    await mkdir(path.join(workspace, 'user-data'), { recursive: true });
    const app = await electron.launch({
      executablePath: packagedExecutable(),
      args: [`--user-data-dir=${path.join(workspace, 'user-data')}`],
    });
    try {
      const page = await app.firstWindow();
      await page.waitForSelector('[data-testid="empty-state"]', { state: 'visible', timeout: 30_000 });
      await page.setViewportSize({ width: 1400, height: 900 });
      await invokeMenu(app, 'toggle-sidebar');
      await expect(page.getByTestId('choose-folder')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('lists notes, pictures and folders, and leaves out the rest', async () => {
    const { app, page, folder } = await launch('filter');
    try {
      await invokeMenu(app, 'toggle-sidebar');
      await chooseFolder(app, folder);

      // Files are alphabetical within their kind.
      // A picture is listed too, and opens in the viewer as itself.
      await expect(page.getByTestId('tree-file')).toHaveText(['appendix.md', 'index.md', 'picture.png']);
      // Directories come first, and dependency folders are not shown at all.
      await expect(page.getByTestId('tree-directory')).toHaveText(['chapters']);
      await expect(page.getByTestId('file-tree')).not.toContainText('node_modules');
    } finally {
      await app.close();
    }
  });

  test('reads a folder only when it is expanded', async () => {
    const { app, page, folder } = await launch('expand');
    try {
      await invokeMenu(app, 'toggle-sidebar');
      await chooseFolder(app, folder);

      // The nested file is absent until the folder is opened.
      await expect(page.getByTestId('file-tree')).not.toContainText('one.md');
      await page.getByTestId('tree-directory').click();
      await expect(page.getByTestId('file-tree')).toContainText('one.md');
    } finally {
      await app.close();
    }
  });

  test('opens a file from the tree into a tab', async () => {
    const { app, page, folder } = await launch('open');
    try {
      await invokeMenu(app, 'toggle-sidebar');
      await chooseFolder(app, folder);

      await page.getByTestId('tree-file').filter({ hasText: 'appendix.md' }).click();
      await expect(page.locator('.ProseMirror:visible')).toContainText('Appendix body.');
      // Opening a second document puts it in the recent strip beside the first.
      await expect(page.getByTestId('recent-chip')).toHaveCount(2);
    } finally {
      await app.close();
    }
  });

  test('marks the document that is in front', async () => {
    const { app, page, folder } = await launch('active');
    try {
      await invokeMenu(app, 'toggle-sidebar');
      await chooseFolder(app, folder);

      const index = page.getByTestId('tree-file').filter({ hasText: 'index.md' });
      await expect(index).toHaveAttribute('aria-current', 'true');

      await page.getByTestId('tree-file').filter({ hasText: 'appendix.md' }).click();
      await expect(page.getByTestId('tree-file').filter({ hasText: 'appendix.md' }))
        .toHaveAttribute('aria-current', 'true');
      await expect(index).not.toHaveAttribute('aria-current', 'true');
    } finally {
      await app.close();
    }
  });

  test('refuses to list a directory outside the chosen folder', async () => {
    const { app, page, folder } = await launch('escape');
    try {
      await invokeMenu(app, 'toggle-sidebar');
      await chooseFolder(app, folder);
      // The folder names itself on the tree's own first row.
      await expect(page.getByTestId('tree-vault')).toContainText('notes');

      // The renderer asking for the parent must be refused by main, not served.
      const outcome = await page.evaluate(async (parent) => {
        const result = await (window as unknown as {
          notoWorkspace: { listFolder(request: unknown): Promise<{ ok: boolean }> };
        }).notoWorkspace.listFolder({ version: 1, requestId: 'e2e-escape', path: parent });
        return result.ok;
      }, path.dirname(folder));

      expect(outcome).toBe(false);
    } finally {
      await app.close();
    }
  });
});

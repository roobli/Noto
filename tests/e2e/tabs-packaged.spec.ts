import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable, placeCaret, placeCaretAtStart } from './packaged-app';

const resultRoot = path.join(process.cwd(), 'test-results', 'tabs');


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

/** Open a second document through the same path the renderer uses. */
async function openInTab(page: Page, filePath: string): Promise<void> {
  await page.evaluate(async (target) => {
    await (window as unknown as {
      notoWorkspace: { openPath(request: unknown): Promise<unknown> };
    }).notoWorkspace.openPath({ version: 1, requestId: `e2e-open-${Date.now()}`, path: target });
  }, filePath);
}

interface Workspace {
  app: ElectronApplication;
  page: Page;
  first: string;
  second: string;
}

async function launch(name: string): Promise<Workspace> {
  const workspace = path.join(resultRoot, name);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });

  const first = path.join(workspace, 'alpha.md');
  const second = path.join(workspace, 'beta.md');
  await writeFile(first, '# Alpha\n\nAlpha body.\n', 'utf8');
  await writeFile(second, '# Beta\n\nBeta body.\n', 'utf8');

  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${first}`],
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
  await page.setViewportSize({ width: 1280, height: 900 });
  return { app, page, first, second };
}

test.describe('tabs', () => {
  test('shows no tab bar for a single document', async () => {
    const { app, page } = await launch('single');
    try {
      await expect(page.getByTestId('recent-strip')).toBeHidden();
    } finally {
      await app.close();
    }
  });

  test('opens a second document in its own tab and switches between them', async () => {
    const { app, page, second } = await launch('switch');
    try {
      await openInTab(page, second);
      await expect(page.getByTestId('recent-strip')).toBeVisible();
      await expect(page.getByTestId('recent-chip')).toHaveCount(2);

      // The newly opened document is in front.
      await expect(page.locator('.ProseMirror:visible')).toContainText('Beta body.');

      await page.getByTestId('recent-chip').filter({ hasText: 'alpha' }).click();
      await expect(page.locator('.ProseMirror:visible')).toContainText('Alpha body.');

      await page.getByTestId('recent-chip').filter({ hasText: 'beta' }).click();
      await expect(page.locator('.ProseMirror:visible')).toContainText('Beta body.');
    } finally {
      await app.close();
    }
  });

  test('keeps each document undo history when switching tabs', async () => {
    const { app, page, second } = await launch('history');
    try {
      // Edit the first document, then open a second and come back.
      await placeCaretAtStart(page, page.locator('.ProseMirror p').first());
      await page.keyboard.type('EDITED ');
      await expect(page.locator('.ProseMirror:visible')).toContainText('EDITED Alpha body.');

      await openInTab(page, second);
      await expect(page.locator('.ProseMirror:visible')).toContainText('Beta body.');

      await page.getByTestId('recent-chip').filter({ hasText: 'alpha' }).click();
      await expect(page.locator('.ProseMirror:visible')).toContainText('EDITED Alpha body.');

      // The edit is still undoable, which is only true if the editor was never
      // torn down while the other tab was in front.
      await invokeMenu(app, 'undo');
      await expect(page.locator('.ProseMirror:visible')).toContainText('Alpha body.');
      await expect(page.locator('.ProseMirror:visible')).not.toContainText('EDITED');
    } finally {
      await app.close();
    }
  });

  test('marks the tab of a document with unsaved changes', async () => {
    const { app, page, second } = await launch('dirty');
    try {
      await openInTab(page, second);
      await placeCaret(page, page.locator('.ProseMirror:visible p').first());
      await page.keyboard.type('X');

      const betaChip = page.getByTestId('recent-chip').filter({ hasText: 'beta' });
      await expect(betaChip.locator('.recent-dot')).toBeVisible();
      // The untouched document is not marked.
      await expect(page.getByTestId('recent-chip').filter({ hasText: 'alpha' })
        .locator('.recent-dot')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('saves the document in front without disturbing the other', async () => {
    const { app, page, first, second } = await launch('save');
    try {
      await openInTab(page, second);
      await placeCaretAtStart(page, page.locator('.ProseMirror:visible p').first());
      await page.keyboard.type('CHANGED ');
      await page.getByTestId('save-button').click();
      await expect(page.getByTestId('file-state')).toHaveText('Saved', { timeout: 15_000 });

      expect(await readFile(second, 'utf8')).toBe('# Beta\n\nCHANGED Beta body.\n');
      // The other document was never written, so it is byte identical.
      expect(await readFile(first, 'utf8')).toBe('# Alpha\n\nAlpha body.\n');
    } finally {
      await app.close();
    }
  });

  test('reuses the existing tab when the same file is opened again', async () => {
    const { app, page, second } = await launch('reuse');
    try {
      await openInTab(page, second);
      await expect(page.getByTestId('recent-chip')).toHaveCount(2);
      await openInTab(page, second);
      await expect(page.getByTestId('recent-chip')).toHaveCount(2);
    } finally {
      await app.close();
    }
  });

  test('closing a tab leaves the neighbour in front', async () => {
    const { app, page, second } = await launch('close');
    try {
      await openInTab(page, second);
      await expect(page.getByTestId('recent-chip')).toHaveCount(2);

      // The strip has no close control by design; closing is the menu item and
      // its shortcut, which is what the tab's cross used to stand in for.
      await invokeMenu(app, 'close-tab');
      await expect(page.getByTestId('recent-strip')).toBeHidden();
      await expect(page.locator('.ProseMirror:visible')).toContainText('Alpha body.');
    } finally {
      await app.close();
    }
  });

  test('closing the last document returns to the empty state', async () => {
    const { app, page } = await launch('close-last');
    try {
      await invokeMenu(app, 'close-tab');
      await expect(page.getByTestId('empty-state')).toBeVisible();
    } finally {
      await app.close();
    }
  });
});

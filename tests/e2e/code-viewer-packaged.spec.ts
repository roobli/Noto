import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

const resultRoot = path.join(process.cwd(), 'test-results', 'code-viewer');

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

async function launch(folder: string): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = path.join(folder, 'user-data');
  await mkdir(userData, { recursive: true });
  const note = path.join(folder, 'note.md');
  await writeFile(note, '# Hello\n\nA note.\n', 'utf8');
  await writeFile(path.join(folder, 'sample.py'), 'def greet(name):\n    return f"hi {name}"\n', 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${userData}`, `--open=${note}`, `--folder=${folder}`],
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
  // Sized before the tree is awaited: under a tiling WM a new window can open
  // at the floor where the rail is hidden.
  await page.setViewportSize({ width: 1200, height: 700 });
  // `--folder=` marks the vault as chosen so the rail springs open. Give that
  // event a moment; only toggle if it never arrived (same menu path the
  // file-tree specs use), so we do not close a rail that is mid-open.
  const tree = page.getByTestId('file-tree');
  try {
    await tree.waitFor({ state: 'visible', timeout: 5_000 });
  } catch {
    await invokeMenu(app, 'toggle-sidebar');
    await tree.waitFor({ state: 'visible', timeout: 30_000 });
  }
  return { app, page };
}

test.describe('code viewer', () => {
  test('opens a .py from the tree as a read-only highlighted pane', async () => {
    const workspace = path.join(resultRoot, 'py');
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true });
    const { app, page } = await launch(workspace);
    try {
      await page.locator('[data-testid="tree-file"][data-path$="sample.py"]').click();

      const viewer = page.getByTestId('code-viewer');
      await expect(viewer).toBeVisible({ timeout: 10_000 });
      await expect(viewer.locator('.code-viewer-name')).toHaveText('sample.py');
      await expect(viewer.locator('.code-viewer-ro')).toHaveText('Read-only');
      await expect(viewer.locator('.code-viewer-lang')).toHaveText('python');
      await expect(viewer.locator('.code-viewer-src').first()).toContainText('def');

      await page.evaluate(() => window.notoSettings.write({
        version: 1, requestId: 'code-viewer-off', patch: { codeViewer: false },
      }));
      await expect(viewer).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('opens .html and .svg with isolated Preview, Source toggle, Read-only badge', async () => {
    const workspace = path.join(resultRoot, 'markup');
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      path.join(workspace, 'page.html'),
      '<!doctype html><html><head><title>Hi</title></head><body><h1 data-testid="html-body">Hello HTML</h1></body></html>\n',
      'utf8',
    );
    await writeFile(
      path.join(workspace, 'icon.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#4c8bf5"/></svg>\n',
      'utf8',
    );
    const { app, page } = await launch(workspace);
    try {
      await page.locator('[data-testid="tree-file"][data-path$="page.html"]').click();
      const viewer = page.getByTestId('code-viewer');
      await expect(viewer).toBeVisible({ timeout: 10_000 });
      await expect(viewer).toHaveAttribute('data-preview-mode', 'preview');
      await expect(viewer).toHaveAttribute('data-markup-preview', 'html');
      await expect(viewer.locator('.code-viewer-ro')).toHaveText('Read-only');
      const htmlPreview = page.getByTestId('code-viewer-preview');
      await expect(htmlPreview).toHaveAttribute('data-preview-kind', 'html');
      const frame = htmlPreview.locator('iframe.code-viewer-preview-frame');
      await expect(frame).toBeVisible();
      await expect(frame).toHaveAttribute('sandbox', '');
      await expect(page.getByTestId('code-viewer-mode-toggle')).toHaveText('Source');

      await page.getByTestId('code-viewer-mode-toggle').click();
      await expect(viewer).toHaveAttribute('data-preview-mode', 'source');
      await expect(page.getByTestId('code-viewer-preview')).toHaveCount(0);
      await expect(viewer.locator('.code-viewer-src').first()).toContainText('doctype');
      await expect(page.getByTestId('code-viewer-mode-toggle')).toHaveText('Preview');

      await page.locator('[data-testid="tree-file"][data-path$="icon.svg"]').click();
      await expect(viewer).toHaveAttribute('data-path', /icon\.svg$/);
      await expect(viewer).toHaveAttribute('data-preview-mode', 'preview');
      await expect(viewer).toHaveAttribute('data-markup-preview', 'svg');
      const svgPreview = page.getByTestId('code-viewer-preview');
      await expect(svgPreview).toHaveAttribute('data-preview-kind', 'svg');
      await expect(svgPreview.locator('img.code-viewer-preview-img')).toBeVisible();
      await expect(viewer.locator('.code-viewer-ro')).toHaveText('Read-only');
    } finally {
      await app.close();
    }
  });

});

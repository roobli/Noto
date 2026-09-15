import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test';
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

test('typing two brackets offers the notes, and writes the link where they were', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'wiki-trigger');
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const vault = path.join(workspace, 'vault');
  await mkdir(path.join(vault, 'topics'), { recursive: true });
  const file = path.join(vault, 'note.md');
  await writeFile(file, '# Links\n\nSee\n', 'utf8');
  await writeFile(path.join(vault, 'topics', 'kestrels.md'), '# Kestrels\n', 'utf8');
  await writeFile(path.join(vault, 'sparrows.md'), '# Sparrows\n', 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, vault],
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
    await page.getByTestId('tree-file').filter({ hasText: 'note' }).click();
    const editor = page.locator('.canvas-slot:not([hidden]) .ProseMirror');
    await editor.waitFor({ state: 'visible' });

    await editor.locator('p').filter({ hasText: 'See' }).click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
    await expect(page.locator('.canvas-slot:not([hidden]) [data-testid="noto-editor"]'))
      .toHaveAttribute('data-caret', /\d+/);
    // Separating space is typed (not left as a fixture trailing space): open may
    // keep or drop a trailing space depending on enrich timing / engine path,
    // and a fixture `See ` + typed ` [[` flakes as `See  [[` on save.
    await page.keyboard.type(' [[');

    // The palette opens, saying it is here to link rather than to open.
    const palette = page.getByTestId('quick-open');
    await expect(palette).toBeVisible();
    await expect(page.getByTestId('quick-linking')).toBeVisible();
    await expect(page.getByTestId('quick-input')).toHaveAttribute('placeholder', /Link to one of/);

    await page.getByTestId('quick-input').fill('kestrel');
    await expect(page.getByTestId('quick-result').first()).toContainText('kestrels');
    await page.keyboard.press('Enter');
    await expect(palette).toHaveCount(0);

    // The link replaced the brackets, and the pair auto-pairing added.
    await expect(editor.locator('p').filter({ hasText: 'See' })).toHaveText('See [[topics/kestrels|kestrels]]');
    await invokeMenu(app, 'save');
    await expect.poll(() => readFile(file, 'utf8')).toBe('# Links\n\nSee [[topics/kestrels|kestrels]]\n');

    // And it is a link: following it opens the note.
    await editor.locator('.noto-wiki-link').first()
      .click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
    await expect(page.locator('.canvas-slot:not([hidden]) .ProseMirror h1')).toHaveText('Kestrels');
  } finally {
    await app.close();
  }
});

test('leaving the palette leaves the brackets as they were typed', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'wiki-trigger-escape');
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const vault = path.join(workspace, 'vault');
  await mkdir(vault, { recursive: true });
  await writeFile(path.join(vault, 'note.md'), '# Links\n\nSee\n', 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, vault],
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
    await page.getByTestId('tree-file').first().click();
    const editor = page.locator('.canvas-slot:not([hidden]) .ProseMirror');
    await editor.waitFor({ state: 'visible' });
    await editor.locator('p').filter({ hasText: 'See' }).click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
    // Type the space here: CommonMark / engine IR→PM drop a trailing space on
    // open, so leaving it only in the fixture would yield `See[[` after `[[`.
    await page.keyboard.type(' [[');
    await expect(page.getByTestId('quick-open')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('quick-open')).toHaveCount(0);
    // A reader who meant the brackets keeps them, and the pair with them.
    await expect(editor.locator('p').filter({ hasText: 'See' })).toHaveText('See [[]]');
  } finally {
    await app.close();
  }
});

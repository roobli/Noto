import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

/*
 * The caret Noto draws: two pixels in the accent where the browser would put
 * its own, solid while the reader types and breathing once it sits still. A
 * click around the text, or naming a new note, leaves a caret in the note.
 */
const resultRoot = path.join(process.cwd(), 'test-results', 'caret');

async function launch(name: string, files: Record<string, string>): Promise<{ app: ElectronApplication; page: Page }> {
  const workspace = path.join(resultRoot, name);
  await rm(workspace, { recursive: true, force: true });
  const vault = path.join(workspace, 'vault');
  await mkdir(vault, { recursive: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  for (const [file, body] of Object.entries(files)) await writeFile(path.join(vault, file), body, 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, vault],
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
  await page.setViewportSize({ width: 1280, height: 800 });
  return { app, page };
}

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

/** The drawn caret of the note in front, and the browser's caret colour there. */
const caretOf = (page: Page) => page.locator('.canvas-slot:not([hidden]) [data-testid="caret"]');

test('draw a caret where the click put it, solid while typing and breathing after', async () => {
  const { app, page } = await launch('draw', { 'note.md': '# Caret\n\nA paragraph to click into.\n' });
  try {
    await page.getByTestId('tree-file').first().click();
    const paragraph = page.locator('.canvas-slot:not([hidden]) .ProseMirror p').first();
    await paragraph.click({ position: { x: 20, y: 8 } });
    const caret = caretOf(page);
    await expect(caret).toHaveClass(/is-shown/);
    const [box, line] = [await caret.boundingBox(), await paragraph.boundingBox()];
    expect(box!.width).toBe(2);
    expect(box!.x).toBeGreaterThan(line!.x);
    expect(box!.y).toBeGreaterThanOrEqual(line!.y - 2);
    expect(box!.y + box!.height).toBeLessThanOrEqual(line!.y + line!.height + 2);
    // The browser's own caret is hidden in the note while this one is drawn.
    expect(await paragraph.evaluate((element) => getComputedStyle(element).caretColor)).toBe('rgba(0, 0, 0, 0)');

    await page.keyboard.type('ab');
    await expect(caret).toHaveClass(/is-solid/);
    await expect(caret).not.toHaveClass(/is-solid/, { timeout: 2000 });

    // A selection is shown as a selection, with no caret on top of it.
    await page.keyboard.press('Shift+ArrowLeft');
    await expect(caret).not.toHaveClass(/is-shown/);
  } finally {
    await app.close();
  }
});

test('put the caret in an empty note when the click lands in the page around the text', async () => {
  const { app, page } = await launch('margin', { 'empty.md': '' });
  try {
    await page.getByTestId('tree-file').first().click();
    const editor = page.locator('.canvas-slot:not([hidden]) .ProseMirror');
    await editor.waitFor({ state: 'visible' });
    const box = (await editor.boundingBox())!;
    // Well to the left of the text column, in the page's margin.
    await page.mouse.click(Math.max(box.x - 120, 300), box.y + 40);
    await expect(editor).toBeFocused();
    await expect(caretOf(page)).toHaveClass(/is-shown/);
    await page.keyboard.type('Typed.');
    await expect(editor.locator('p').first()).toHaveText('Typed.');
  } finally {
    await app.close();
  }
});

test('leave the caret in a new note once it is named', async () => {
  const { app, page } = await launch('new-note', { 'existing.md': '# Existing\n' });
  try {
    await page.getByTestId('tree-file').first().click();
    await invokeMenu(app, 'new-file');
    const field = page.getByTestId('tree-name-field');
    await expect(field).toBeFocused();
    await page.keyboard.type('Fresh');
    await page.keyboard.press('Enter');
    await expect(page.locator('.titlebar')).toContainText('Fresh.md');
    const editor = page.locator('.canvas-slot:not([hidden]) .ProseMirror');
    await expect(editor).toBeFocused();
    await expect(caretOf(page)).toHaveClass(/is-shown/);
    await page.keyboard.type('First words.');
    await expect(editor.locator('p').first()).toHaveText('First words.');
  } finally {
    await app.close();
  }
});

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

const NOTE = '# Title\n\nFirst   paragraph  with odd   spacing kept.\n\n- one\n- two\n\nLast words.\n';

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

test('Source Code Mode shows the note as text, takes edits, and hands the caret back', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'source-mode');
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const vault = path.join(workspace, 'vault');
  await mkdir(vault, { recursive: true });
  const file = path.join(vault, 'note.md');
  await writeFile(file, NOTE, 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, vault],
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
    await page.getByTestId('tree-file').first().click();
    const rendered = page.locator('.canvas-slot:not([hidden]) .ProseMirror');
    await rendered.waitFor({ state: 'visible' });

    // From the last paragraph into the text: the caret arrives at that block.
    await rendered.locator('p').filter({ hasText: 'Last words.' }).click();
    await expect(rendered.locator('.noto-active-block')).toHaveText('Last words.');
    await invokeMenu(app, 'source-code-mode');
    const input = page.getByTestId('source-input');
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(NOTE);
    await expect(rendered).toBeHidden();
    // The text keeps the column the document had, whatever it was set to.
    const columnOf = (selector: string) => page.locator(selector).evaluate(
      (node) => Math.round(node.getBoundingClientRect().width),
    );
    const wide = await columnOf('.noto-source');
    expect(await input.evaluate((node) => (node as HTMLTextAreaElement).selectionStart)).toBe(NOTE.indexOf('Last words.'));
    // The marks are coloured underneath.
    await expect(page.locator('.noto-source-highlight .token.title').first()).toContainText('# Title');

    // An edit to one line, then back: only that block is rendered anew, and
    // the caret's block is the one in front.
    await input.evaluate((node) => {
      const area = node as HTMLTextAreaElement;
      const at = area.value.indexOf('Last words.');
      area.setSelectionRange(at, at + 'Last words.'.length);
    });
    await page.keyboard.type('Final words.');
    await invokeMenu(app, 'source-code-mode');
    await expect(rendered).toBeVisible();
    await expect(rendered.locator('p').last()).toHaveText('Final words.');
    await expect(rendered.locator('.noto-active-block')).toHaveText('Final words.');
    await expect(page.getByTestId('source-input')).toHaveCount(0);

    // The rendered column and the text's are the same width, so Command-slash
    // changes what is shown and not how wide it is.
    expect(await columnOf('.canvas-slot:not([hidden]) [data-testid="noto-editor"]')).toBe(wide);

    // Saved, the untouched paragraph keeps its odd spacing byte for byte.
    await invokeMenu(app, 'save');
    await expect.poll(() => readFile(file, 'utf8')).toBe(NOTE.replace('Last words.', 'Final words.'));
  } finally {
    await app.close();
  }
});

test('a save from inside Source Code Mode writes what is on screen', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'source-mode-save');
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const vault = path.join(workspace, 'vault');
  await mkdir(vault, { recursive: true });
  const file = path.join(vault, 'note.md');
  await writeFile(file, NOTE, 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, vault],
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
    await page.getByTestId('tree-file').first().click();
    await page.locator('.canvas-slot:not([hidden]) .ProseMirror').waitFor({ state: 'visible' });
    await invokeMenu(app, 'source-code-mode');
    const input = page.getByTestId('source-input');
    await expect(input).toBeFocused();
    await input.evaluate((node) => { const area = node as HTMLTextAreaElement; area.setSelectionRange(2, 7); });
    await page.keyboard.type('Heading');
    // Straight away, before the text has settled into the document.
    await invokeMenu(app, 'save');
    await expect.poll(() => readFile(file, 'utf8')).toBe(NOTE.replace('Title', 'Heading'));
    // Still in the text, still editable.
    await expect(input).toBeVisible();
    await expect(input).toHaveValue(NOTE.replace('Title', 'Heading'));
  } finally {
    await app.close();
  }
});

test('Undo and Redo in Source Code Mode act on the text, and leaving shows what it says', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'source-mode-undo');
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const vault = path.join(workspace, 'vault');
  await mkdir(vault, { recursive: true });
  const file = path.join(vault, 'note.md');
  await writeFile(file, NOTE, 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, vault],
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
    await page.getByTestId('tree-file').first().click();
    const rendered = page.locator('.canvas-slot:not([hidden]) .ProseMirror');
    await rendered.waitFor({ state: 'visible' });
    await invokeMenu(app, 'source-code-mode');
    const input = page.getByTestId('source-input');
    await expect(input).toBeFocused();
    await input.evaluate((node) => { (node as HTMLTextAreaElement).setSelectionRange(2, 7); });
    await page.keyboard.type('Heading');
    // Long enough for the text to settle into the note behind it.
    await page.waitForTimeout(700);

    // Undo from the menu takes back the word typed, in one step, in the text
    // and not in the note behind it; Redo brings it back.
    await invokeMenu(app, 'undo');
    await expect(input).toHaveValue(NOTE);
    await invokeMenu(app, 'redo');
    await expect(input).toHaveValue(NOTE.replace('Title', 'Heading'));
    await page.waitForTimeout(700);

    // A save keeps the view and its caret; typed straight after, the words
    // reach the note even though the view is left before they settle.
    await invokeMenu(app, 'save');
    await expect.poll(() => readFile(file, 'utf8')).toBe(NOTE.replace('Title', 'Heading'));
    await expect(input).toBeFocused();
    await page.keyboard.type(' Two');
    await invokeMenu(app, 'source-code-mode');
    await expect(rendered.locator('h1')).toHaveText('Heading Two');
  } finally {
    await app.close();
  }
});

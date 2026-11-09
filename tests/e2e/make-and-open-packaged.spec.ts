/**
 * Making a folder or a note where the reader is, and opening a note from
 * anywhere, in the packaged app: New Folder on the vault's own row and from
 * the File menu, Quick Open making the note or folder that was typed and
 * opening a note by its path, and Backspace taking back a smart quote.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable, placeCaretAtEnd } from './packaged-app';

const made: string[] = [];
test.afterAll(() => {
  for (const directory of made) rmSync(directory, { recursive: true, force: true });
});

function scratch(name: string): string {
  // Native: on Windows only it spells a short name such as RUNNER~1 out in
  // full, as the paths the app reports are.
  const directory = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), `noto-e2e-${name}-`)));
  made.push(directory);
  return directory;
}

function vault(): string {
  const root = scratch('make');
  mkdirSync(path.join(root, 'Ideas'), { recursive: true });
  writeFileSync(path.join(root, 'Ideas', 'plan.md'), '# Plan\n\nThe plan.\n', 'utf8');
  writeFileSync(path.join(root, 'readme.md'), '# Readme\n\nStart here.\n', 'utf8');
  // A folder with no notes in it, which Quick Open's folder list cannot know about.
  mkdirSync(path.join(root, 'Empty'));
  return root;
}

async function launch(root: string, open = 'readme.md', settings: Record<string, unknown> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = scratch('user-data');
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(settings));
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${userData}`, `--folder=${root}`, `--open=${path.join(root, open)}`],
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
  await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
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

const action = (page: Page, kind: string) => page.locator(`[data-testid="quick-action"][data-kind="${kind}"]`);

test.describe('making a folder', () => {
  test('from the vault\'s own row, at the top of the folder', async () => {
    const root = vault();
    const { app, page } = await launch(root);
    try {
      // A native menu holds the input loop, so main keeps the menu it would have shown and the test picks from it.
      await app.evaluate(({ Menu }) => {
        const shown: Electron.Menu[] = [];
        (globalThis as { shownMenus?: Electron.Menu[] }).shownMenus = shown;
        Menu.prototype.popup = function popup(this: Electron.Menu) { shown.push(this); };
      });
      await page.getByTestId('tree-vault').click({ button: 'right' });
      await expect.poll(() => app.evaluate(() => (globalThis as { shownMenus?: Electron.Menu[] }).shownMenus!.length)).toBeGreaterThan(0);
      await app.evaluate(() => {
        (globalThis as { shownMenus?: Electron.Menu[] }).shownMenus!.at(-1)!.items.find((item) => item.id === 'tree-new-folder')!.click();
      });
      const field = page.getByTestId('tree-name-field');
      await expect(field).toBeFocused();
      await expect(field).toHaveValue('New Folder');
      // The whole name is selected, so typing replaces it.
      await page.keyboard.type('Archive');
      await page.keyboard.press('Enter');
      await expect.poll(() => existsSync(path.join(root, 'Archive'))).toBe(true);
      await expect(page.getByTestId('tree-directory').filter({ hasText: /^Archive$/ })).toHaveCount(1);
    } finally {
      await app.close();
    }
  });

  test('from the File menu, beside the note in front', async () => {
    const root = vault();
    const { app, page } = await launch(root, path.join('Ideas', 'plan.md'));
    try {
      await invokeMenu(app, 'new-folder');
      await expect(page.getByTestId('tree-name-field')).toBeFocused();
      await page.keyboard.type('Drafts');
      await page.keyboard.press('Enter');
      await expect.poll(() => existsSync(path.join(root, 'Ideas', 'Drafts'))).toBe(true);
    } finally {
      await app.close();
    }
  });
});

test.describe('Quick Open, beyond what it found', () => {
  test('makes the note that was typed and puts the caret in it', async () => {
    const root = vault();
    const { app, page } = await launch(root);
    try {
      await invokeMenu(app, 'quick-open');
      await page.getByTestId('quick-input').fill('budget 2027');
      // Nothing matched, so the row that makes it is the one Enter takes, and it says so.
      await expect(action(page, 'new-note')).toHaveAttribute('aria-selected', 'true');
      await expect(action(page, 'new-note')).toContainText('budget 2027.md');
      await expect(action(page, 'new-note')).toContainText(`in ${path.basename(root)}`);
      await expect(page.getByTestId('quick-hint-new')).toBeVisible();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('quick-open')).toHaveCount(0);
      await expect.poll(() => existsSync(path.join(root, 'budget 2027.md'))).toBe(true);
      await expect(page.locator('.titlebar')).toContainText('budget 2027');
      // The caret is in the new note, so what is typed next is its first line.
      await expect(page.locator('.canvas-slot:not([hidden]) .ProseMirror')).toBeFocused();
      await page.keyboard.type('Numbers first.');
      await invokeMenu(app, 'save');
      await expect.poll(() => readFileSync(path.join(root, 'budget 2027.md'), 'utf8')).toContain('Numbers first.');
    } finally {
      await app.close();
    }
  });

  test('makes a folder, moves into it, and makes its first note with Shift-Enter; says why when it cannot', async () => {
    const root = vault();
    const { app, page } = await launch(root);
    try {
      await invokeMenu(app, 'quick-open');
      const input = page.getByTestId('quick-input');
      // A folder already on disk with nothing in it: offered, refused, and said so where the row was.
      await input.fill('Empty');
      await action(page, 'new-folder').click();
      await expect(page.getByTestId('quick-notice')).toHaveText('Something here is already called that.');
      await expect(page.getByTestId('quick-open')).toBeVisible();

      await input.fill('Travel');
      await action(page, 'new-folder').click();
      await expect.poll(() => existsSync(path.join(root, 'Travel'))).toBe(true);
      await expect(page.getByTestId('quick-scope')).toHaveText('Travel');
      await expect(input).toHaveValue('');
      await expect(input).toHaveAttribute('placeholder', /Name a note/);
      await input.fill('Kyoto');
      await expect(action(page, 'new-note')).toContainText('in Travel');
      await page.keyboard.press('Shift+Enter');
      await expect.poll(() => existsSync(path.join(root, 'Travel', 'Kyoto.md'))).toBe(true);
      await expect(page.locator('.titlebar')).toContainText('Kyoto');
    } finally {
      await app.close();
    }
  });

  test('opens a note outside the open folder by its path, pasted in quotes', async () => {
    const root = vault();
    const outside = path.join(scratch('elsewhere'), 'Far away.md');
    writeFileSync(outside, '# Far away\n\nNot in the vault.\n', 'utf8');
    const { app, page } = await launch(root);
    try {
      await invokeMenu(app, 'quick-open');
      await page.getByTestId('quick-input').fill(`"${outside}"`);
      await expect(action(page, 'open-path')).toHaveAttribute('aria-selected', 'true');
      await expect(action(page, 'open-path')).toContainText(outside);
      await page.keyboard.press('Enter');
      await expect(page.locator('.titlebar')).toContainText('Far away');
      const note = page.locator('.canvas-slot:not([hidden]) .ProseMirror');
      await expect(note).toContainText('Not in the vault.');
      // The caret went with it, as it does for a note Quick Open found: typing lands in this note.
      await expect(note).toBeFocused();
      await page.keyboard.type('Typed here. ');
      await expect(note).toContainText('Typed here.');
    } finally {
      await app.close();
    }
  });
});

test('Backspace straight after a smart quote gives the straight one back', async () => {
  const root = vault();
  const { app, page } = await launch(root, 'readme.md', { smartQuotes: true });
  try {
    const paragraph = page.locator('.canvas-slot:not([hidden]) .ProseMirror > p').first();
    await placeCaretAtEnd(page, paragraph);
    await page.keyboard.type(' "');
    await expect(paragraph).toHaveText('Start here. \u201c');
    await page.keyboard.press('Backspace');
    await expect(paragraph).toHaveText('Start here. "');
  } finally {
    await app.close();
  }
});

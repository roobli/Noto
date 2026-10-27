import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

const resultRoot = path.join(process.cwd(), 'test-results', 'find-replace');


const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/**
 * Open the bar through the real menu item.
 *
 * A synthetic keystroke reaches the renderer, not the native menu, so pressing
 * the accelerator would prove nothing about the wiring a user triggers.
 */
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

const SOURCE = [
  '# Needle report',
  '',
  'The needle appears here and the needle appears again.',
  '',
  '```ts',
  'const needle = 1;',
  '```',
  '',
  'A closing paragraph with one needle.',
  '',
].join('\n');

async function launch(name: string, source = SOURCE): Promise<{
  app: ElectronApplication; page: Page; file: string;
}> {
  const workspace = path.join(resultRoot, name);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const file = path.join(workspace, 'notes.md');
  await writeFile(file, source, 'utf8');

  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${file}`],
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
  await page.setViewportSize({ width: 1280, height: 900 });
  return { app, page, file };
}

test.describe('find and replace', () => {
  test('finds matches and steps through them', async () => {
    const { app, page } = await launch('find');
    try {
      await invokeMenu(app, 'find');
      await expect(page.getByTestId('find-bar')).toBeVisible();

      await page.getByTestId('find-input').fill('needle');
      // Five occurrences, since matching ignores case by default and so the
      // capitalised heading counts: heading, two in the paragraph, one in the
      // fence, one at the end.
      await expect(page.getByTestId('find-status')).toHaveText('1 of 5');

      await page.getByTestId('find-next').click();
      await expect(page.getByTestId('find-status')).toHaveText('2 of 5');

      await page.getByTestId('find-previous').click();
      await expect(page.getByTestId('find-status')).toHaveText('1 of 5');

      // Every match is highlighted, not only the current one.
      await expect(page.locator('.noto-match')).toHaveCount(5);
      await expect(page.locator('.noto-match-active')).toHaveCount(1);
    } finally {
      await app.close();
    }
  });

  test('honours match case', async () => {
    const { app, page } = await launch('case');
    try {
      await invokeMenu(app, 'find');
      await page.getByTestId('find-input').fill('Needle');
      await expect(page.getByTestId('find-status')).toHaveText('1 of 5');

      // Only the heading actually has a capital N.
      await page.getByTestId('find-case').click();
      await expect(page.getByTestId('find-status')).toHaveText('1 of 1');
    } finally {
      await app.close();
    }
  });

  test('honours whole word', async () => {
    const { app, page } = await launch('word', '# Notes\n\nA needle and some needles.\n');
    try {
      await invokeMenu(app, 'find');
      await page.getByTestId('find-input').fill('needle');
      // "needles" contains "needle", so both match until whole word is on.
      await expect(page.getByTestId('find-status')).toHaveText('1 of 2');

      await page.getByTestId('find-word').click();
      await expect(page.getByTestId('find-status')).toHaveText('1 of 1');
    } finally {
      await app.close();
    }
  });

  test('reports when nothing matches instead of looking broken', async () => {
    const { app, page } = await launch('empty');
    try {
      await invokeMenu(app, 'find');
      await page.getByTestId('find-input').fill('haystack');
      await expect(page.getByTestId('find-status')).toHaveText('No results');
      await expect(page.locator('.noto-match')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('replaces one match and leaves the rest of the file byte identical', async () => {
    const { app, page, file } = await launch('replace-one');
    try {
      await invokeMenu(app, 'find-replace');
      await expect(page.getByTestId('replace-input')).toBeVisible();

      await page.getByTestId('find-input').fill('Needle report');
      await page.getByTestId('replace-input').fill('Pin report');
      await page.getByTestId('replace-one').click();

      await page.getByTestId('save-button').click();
      await expect(page.getByTestId('file-state')).toHaveText('Saved', { timeout: 15_000 });

      // Only the heading changed. Every other byte, including the code fence,
      // is exactly as it was.
      expect(await readFile(file, 'utf8')).toBe(SOURCE.replace('# Needle report', '# Pin report'));
    } finally {
      await app.close();
    }
  });

  test('replaces every match in one undoable step', async () => {
    const { app, page, file } = await launch('replace-all');
    try {
      await invokeMenu(app, 'find-replace');
      await page.getByTestId('find-input').fill('needle');
      await page.getByTestId('replace-input').fill('pin');
      await page.getByTestId('replace-all').click();
      await expect(page.getByTestId('find-status')).toHaveText('No results');

      // Undo before saving, to see history in isolation.
      await invokeMenu(app, 'undo');
      await expect(page.locator('.ProseMirror')).toContainText('the needle appears again');
      await invokeMenu(app, 'redo');

      await page.getByTestId('save-button').click();
      await expect(page.getByTestId('file-state')).toHaveText('Saved', { timeout: 15_000 });
      const saved = await readFile(file, 'utf8');
      expect(saved.toLowerCase()).not.toContain('needle');
      expect(saved).toContain('const pin = 1;');
      // Matching ignores case, so the heading was replaced as well.
      expect(saved).toContain('# pin report');

      // One transaction, so one undo restores the whole document. Driven
      // through the menu, which is the path the accelerator actually takes.
      await invokeMenu(app, 'undo');
      await expect(page.locator('.ProseMirror')).toContainText('the needle appears again');
    } finally {
      await app.close();
    }
  });

  test('steps through matches with the bar closed, which is where Cmd+G earns its keep', async () => {
    const { app, page } = await launch('stepping');
    try {
      await invokeMenu(app, 'find');
      await page.getByTestId('find-input').fill('needle');
      await expect(page.getByTestId('find-status')).toContainText('1 of');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('find-bar')).toBeHidden();
      await expect(page.locator('.noto-match')).toHaveCount(0);

      // The whole point: the query survives the bar closing, so stepping is one
      // key rather than reopening the bar and pressing Enter.
      await invokeMenu(app, 'find-next');
      await expect(page.locator('.noto-match-active')).toHaveCount(1);
      const second = await page.locator('.noto-match-active').boundingBox();

      // The highlight moves a frame after the command, so wait for it rather
      // than reading the box once: on a slow runner the single read came
      // before the move and saw the match it had just left.
      const active = async () => {
        const box = await page.locator('.noto-match-active').boundingBox();
        return `${box?.x},${box?.y}`;
      };
      await invokeMenu(app, 'find-next');
      await expect.poll(active).not.toBe(`${second?.x},${second?.y}`);

      // And back the other way lands where it was.
      await invokeMenu(app, 'find-previous');
      await expect.poll(active).toBe(`${second?.x},${second?.y}`);
    } finally {
      await app.close();
    }
  });

  test('opens the bar when there is no query to step through yet', async () => {
    const { app, page } = await launch('no-query');
    try {
      await expect(page.getByTestId('find-bar')).toBeHidden();
      await invokeMenu(app, 'find-next');
      await expect(page.getByTestId('find-bar')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('closes on escape and clears the highlight', async () => {
    const { app, page } = await launch('escape');
    try {
      await invokeMenu(app, 'find');
      await page.getByTestId('find-input').fill('needle');
      await expect(page.locator('.noto-match').first()).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(page.getByTestId('find-bar')).toBeHidden();
      await expect(page.locator('.noto-match')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});

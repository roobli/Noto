/**
 * Save pressed again while a save is still landing, in the packaged app. It
 * used to be dropped: the note stayed marked unsaved and what was typed
 * between the two presses was not written. Now the second press waits for
 * the first save and then writes what is on screen.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test';
import { packagedExecutable, placeCaret } from './packaged-app';

const resultRoot = path.join(process.cwd(), 'test-results', 'save-again');

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
    find(Menu.getApplicationMenu()!.items)!.click();
  }, id);
}

test('a save asked for while one is landing writes what was typed in between', async () => {
  await rm(resultRoot, { recursive: true, force: true });
  await mkdir(path.join(resultRoot, 'user-data'), { recursive: true });
  await writeFile(path.join(resultRoot, 'user-data', 'settings.json'), JSON.stringify({ autoSave: false }));
  const file = path.join(resultRoot, 'note.md');
  // Long enough that a save takes a while to land.
  const body = Array.from({ length: 4000 }, (_, at) => `Paragraph ${at} with a few words in it so the note is long.`).join('\n\n');
  await writeFile(file, `# Long\n\n${body}\n\nEnd.\n`, 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(resultRoot, 'user-data')}`, `--open=${file}`],
    // Shown off macOS, as click-stays-put is. On Linux and Windows a window
    // that is never shown does not draw "Saving" until the save has landed,
    // so the first save looked already done when the second was asked for.
    // Each save held a second as it writes, so the second is surely asked for while the first lands.
    env: { ...process.env, NOTO_HEADLESS: process.platform === 'darwin' ? '1' : '0', NOTO_TEST_SAVE_HOLD_MS: '1000' },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
    // The heading: in a note this long the last paragraph drawn is not the last one.
    await placeCaret(page, page.locator('.ProseMirror > h1'));
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
    await page.keyboard.type(' one');
    await invokeMenu(app, 'save');
    // The first save is under way before the next words are typed; otherwise this proves nothing.
    // Waited for rather than read once: a slow runner can take a frame or two to say so.
    await expect(page.getByTestId('file-state')).toHaveText('Saving', { timeout: 5_000 });
    // Typed and asked for at once, in the page, so no round trip to the test lets the first
    // save land in between; a fast runner finished it while ' two' was being typed key by key.
    const during = await page.evaluate(() => {
      const view = document.querySelector('.canvas-slot:not([hidden]) .ProseMirror') as HTMLElement & { pmViewDesc?: unknown };
      document.execCommand('insertText', false, ' two');
      void view;
      return document.querySelector('[data-testid="file-state"]')?.textContent ?? '';
    });
    await invokeMenu(app, 'save');
    expect(during).toBe('Saving');
    await expect.poll(() => readFile(file, 'utf8'), { timeout: 20_000 }).toMatch(/^# Long one two\n/);
    await expect(page.getByTestId('file-state')).toHaveText('Saved', { timeout: 20_000 });
  } finally {
    await app.close();
  }
});

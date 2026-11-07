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
  const app = await electron.launch({ executablePath: packagedExecutable(), args: [`--user-data-dir=${path.join(resultRoot, 'user-data')}`, `--open=${file}`] });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
    // The heading: in a note this long the last paragraph drawn is not the last one.
    await placeCaret(page, page.locator('.ProseMirror > h1'));
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
    await page.keyboard.type(' one');
    await invokeMenu(app, 'save');
    await page.keyboard.type(' two');
    // The first save is still landing when the second is asked for; otherwise this proves nothing.
    const during = await page.getByTestId('file-state').innerText();
    await invokeMenu(app, 'save');
    expect(during).toBe('Saving');
    await expect.poll(() => readFile(file, 'utf8'), { timeout: 20_000 }).toMatch(/^# Long one two\n/);
    await expect(page.getByTestId('file-state')).toHaveText('Saved', { timeout: 20_000 });
  } finally {
    await app.close();
  }
});

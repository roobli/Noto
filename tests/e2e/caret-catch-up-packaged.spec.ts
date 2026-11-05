/**
 * A key pressed straight after a click or a caret move acts where the caret
 * is now. The browser reports that the caret moved a moment after it moves,
 * and keys at a script's speed used to arrive first: Enter split the line the
 * caret had left, and the sidenote key found nothing selected.
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

test('Enter straight after a click and Command-Down acts at the end of the note', async () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'noto-e2e-catch-up-')));
  const file = path.join(dir, 'note.md');
  writeFileSync(file, '> hello\n', 'utf8');
  const app = await electron.launch({ executablePath: packagedExecutable(), args: [`--user-data-dir=${path.join(dir, 'user-data')}`, `--open=${file}`] });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
    await page.locator('.ProseMirror p').first().click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('x');
    await app.evaluate(({ Menu }) => {
      const find = (items: Electron.MenuItem[]): Electron.MenuItem | null => {
        for (const item of items) {
          if (item.id === 'save') return item;
          const nested = item.submenu ? find(item.submenu.items) : null;
          if (nested) return nested;
        }
        return null;
      };
      find(Menu.getApplicationMenu()!.items)!.click();
    });
    await expect.poll(() => readFileSync(file, 'utf8')).toBe('> hello\n\nx\n');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

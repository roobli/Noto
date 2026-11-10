/**
 * Closing a sheet over the page gives the keys back to the note, at the
 * caret they left from, in the packaged app. Quick Open once handed them to
 * a note that was no longer in front, and what was typed next went out of
 * sight; this checks every sheet the reader can open from the keyboard: open
 * it from the caret, close it with Escape, type, and the letters land where
 * the caret was.
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable, placeCaretAtEnd } from './packaged-app';

const made: string[] = [];
test.afterAll(() => {
  for (const directory of made) rmSync(directory, { recursive: true, force: true });
});

function scratch(name: string): string {
  const directory = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), `noto-e2e-${name}-`)));
  made.push(directory);
  return directory;
}

async function launch(): Promise<{ app: ElectronApplication; page: Page; note: string }> {
  const root = scratch('focus');
  const note = path.join(root, 'note.md');
  writeFileSync(note, '# Note\n\nFirst line\n\nSecond line\n', 'utf8');
  writeFileSync(path.join(root, 'other.md'), '# Other\n', 'utf8');
  const userData = scratch('user-data');
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({}));
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${userData}`, `--folder=${root}`, `--open=${note}`],
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
  return { app, page, note };
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

const SHEETS: readonly (readonly [command: string, open: string])[] = [
  ['quick-open', '[data-testid="quick-open"]'],
  ['command-palette', '[data-testid="command-palette"]'],
  ['settings', '[data-testid="settings-panel"]'],
  ['shortcuts', '[data-testid="shortcuts-panel"]'],
  ['find', '[data-testid="find-bar"]'],
];

for (const [command, open] of SHEETS) {
  test(`closing ${command} gives the keys back to the note at its caret`, async () => {
    const { app, page } = await launch();
    try {
      const first = page.locator('.canvas-slot:not([hidden]) .ProseMirror p').first();
      await placeCaretAtEnd(page, first);
      await invokeMenu(app, command);
      const sheet = page.locator(open).first();
      await expect(sheet).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
      await page.keyboard.type('Z');
      await expect(first).toHaveText('First lineZ');
    } finally {
      await app.close();
    }
  });
}

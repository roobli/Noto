import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';
import { packagedExecutable, placeCaret } from './packaged-app';

/*
 * Notes with the same bytes are still different notes. Every new note starts
 * empty, and so does an untouched copy of a template, so a working folder
 * holds several identical files. A note's identity used to be the hash of its
 * bytes: a click on the second empty note showed the first, the tree marked
 * the first as the one in front, and typing there saved into the wrong file.
 */
test('empty notes open as themselves, and an edit to one is saved to that one', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'twin-notes');
  await rm(workspace, { recursive: true, force: true });
  const vault = path.join(workspace, 'vault');
  await mkdir(vault, { recursive: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const names = ['a-first.md', 'b-second.md', 'c-third.md'];
  for (const name of names) await writeFile(path.join(vault, name), '', 'utf8');
  await writeFile(path.join(vault, 'd-other.md'), '# Other\n\nNot empty.\n', 'utf8');

  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, vault],
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
    const row = (name: string) => page.getByTestId('tree-file').filter({ hasText: name });

    // Each in turn, then back again: the one clicked is the one in front.
    for (const name of [...names, 'd-other.md', ...[...names].reverse()]) {
      await row(name).click();
      await expect(page.locator('.titlebar')).toContainText(name);
      await expect(row(name)).toHaveAttribute('aria-current', /.+/);
    }

    // Typing into the second empty note saves into that file, not the first.
    await row('b-second.md').click();
    await expect(page.locator('.titlebar')).toContainText('b-second.md');
    await placeCaret(page, page.locator('.ProseMirror:visible').first());
    await page.keyboard.type('Only in the second.');
    // Through the menu: a key Playwright sends never reaches the native menu.
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
    await expect.poll(() => readFile(path.join(vault, 'b-second.md'), 'utf8')).toContain('Only in the second.');
    expect(await readFile(path.join(vault, 'a-first.md'), 'utf8')).toBe('');
    expect(await readFile(path.join(vault, 'c-third.md'), 'utf8')).toBe('');
  } finally {
    await app.close();
  }
});

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';
import { packagedExecutable, placeCaret } from './packaged-app';

/* `**abc**` at the head of a line: the caret reaches the place before the
   `**`, where typing is plain, as it can in Typora, and both sides of each
   revealed delimiter are places of their own. */
test('the caret reaches both sides of a revealed bold delimiter', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'mark-boundary');
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const file = path.join(workspace, 'note.md');
  await writeFile(file, '# Title\n\n**abc** then text.\n\nOther.\n', 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${file}`],
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
    const line = page.locator('.ProseMirror > p').first();
    const caretX = () => page.evaluate(() => Math.round(document.querySelector('.noto-caret')?.getBoundingClientRect().left ?? NaN));
    const openLeft = () => page.evaluate(() => Math.round(document.querySelector('.noto-syntax[data-edge="open"]')?.getBoundingClientRect().left ?? NaN));
    const openRight = () => page.evaluate(() => Math.round(document.querySelector('.noto-syntax[data-edge="open"]')?.getBoundingClientRect().right ?? NaN));
    const home = process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home';

    await placeCaret(page, line);
    await page.keyboard.press(home);
    // Home lands before the `**`.
    await expect.poll(async () => Math.abs((await caretX()) - (await openLeft()))).toBeLessThan(2);
    // Right steps over the delimiter without moving through the text.
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => Math.abs((await caretX()) - (await openRight()))).toBeLessThan(2);
    // And left steps back out.
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => Math.abs((await caretX()) - (await openLeft()))).toBeLessThan(2);
    // Typed there, it is plain; one step right is inside the bold.
    await page.keyboard.type('X');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('Y');

    // To the end of the bold: Right first lands inside the closing `**`, then outside it.
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('Z');
    await page.getByTestId('save-button').click();
    await expect(page.getByTestId('file-state')).toHaveText('Saved', { timeout: 15_000 });
    expect(await readFile(file, 'utf8')).toBe('# Title\n\nX**Yabc**Z then text.\n\nOther.\n');
  } finally {
    await app.close();
  }
});

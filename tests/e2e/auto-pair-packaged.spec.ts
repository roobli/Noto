import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable, placeCaret, selectTextIn } from './packaged-app';

const resultRoot = path.join(process.cwd(), 'test-results', 'auto-pair');

async function launch(name: string): Promise<{ app: ElectronApplication; page: Page }> {
  const workspace = path.join(resultRoot, name);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const file = path.join(workspace, 'note.md');
  await writeFile(file, '# Pairs\n\nHere.\n', 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${file}`],
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
  await page.setViewportSize({ width: 1100, height: 700 });
  return { app, page };
}

/** Put the caret at the end of the paragraph. */
async function atEnd(page: Page): Promise<void> {
  const paragraph = page.locator('.ProseMirror > p').last();
  await placeCaret(page, paragraph);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
}

const text = (page: Page) => page.locator('.ProseMirror > p').last().innerText();

test.describe('closing what you open', () => {
  test('writes the partner, steps over it, and takes both on backspace', async () => {
    const { app, page } = await launch('pairs');
    try {
      await atEnd(page);
      await page.keyboard.type(' (');
      await expect.poll(() => text(page)).toBe('Here. ()');

      // Typing the closer walks past the one already there.
      await page.keyboard.type('x)');
      await expect.poll(() => text(page)).toBe('Here. (x)');

      // Backspace between an empty pair takes both.
      await page.keyboard.type(' [');
      await expect.poll(() => text(page)).toBe('Here. (x) []');
      await page.keyboard.press('Backspace');
      await expect.poll(() => text(page)).toBe('Here. (x) ');
    } finally {
      await app.close();
    }
  });

  test('leaves an apostrophe in the middle of a word alone', async () => {
    const { app, page } = await launch('apostrophe');
    try {
      await atEnd(page);
      await page.keyboard.type(" don't");
      // Smart typography curls it, which is the other feature doing its job.
      // What matters here is that there is one apostrophe and not two.
      await expect.poll(() => text(page)).toBe('Here. don\u2019t');
    } finally {
      await app.close();
    }
  });

  test('wraps a selection', async () => {
    const { app, page } = await launch('wrap');
    try {
      const paragraph = page.locator('.ProseMirror > p').last();
      // Shift+ArrowLeft from End can leave an empty caret before the period on
      // packaged macos-14, so the opener pairs instead of wrapping. Select
      // "Here" via the Selection API (same harden as placeCaretAtStart/End).
      await selectTextIn(page, paragraph, 0, 4);
      await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('Here');
      await page.keyboard.type('（');
      await expect.poll(() => text(page)).toBe('（Here）.');
    } finally {
      await app.close();
    }
  });
});

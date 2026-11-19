import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable, placeCaret } from './packaged-app';

const resultRoot = path.join(process.cwd(), 'test-results', 'word-count');

async function launch(name: string, body: string): Promise<{ app: ElectronApplication; page: Page }> {
  const workspace = path.join(resultRoot, name);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const file = path.join(workspace, 'note.md');
  await writeFile(file, body, 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${file}`],
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
  await page.setViewportSize({ width: 1100, height: 700 });
  return { app, page };
}

test.describe('the size of a note', () => {
  test('is counted from what the document draws, not from the file', async () => {
    // Nine words of prose, and an image whose address is longer than all of
    // them. Counting the file would say far more.
    const body = '# Title\n\nOne two three four five six seven eight nine.\n\n![a](https://images.invalid/a/very/long/address/that/nobody/reads.png)\n';
    const { app, page } = await launch('drawn', body);
    try {
      // "Title" and the nine, and nothing from the address or the alt text.
      await expect(page.getByTestId('status-count')).toHaveText('10 words');

      // The count opens on a click to the rest of the numbers, as Typora's
      // does: the title and the sentence are two lines, the picture a third
      // block that draws no text.
      await page.getByTestId('status-count').click();
      const popover = page.getByTestId('count-popover');
      await expect(popover).toBeVisible();
      await expect(popover.locator('dd')).toHaveText(['10', '53', '42', '2', '3']);
      await page.getByTestId('status-count').click();
      await expect(popover).toBeHidden();
    } finally {
      await app.close();
    }
  });

  test('follows the words as they are written', async () => {
    const { app, page } = await launch('typing', '# T\n\nOne two.\n');
    try {
      await expect(page.getByTestId('status-count')).toHaveText('3 words');
      await placeCaret(page, page.locator('.ProseMirror > p').first());
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
      await page.keyboard.type(' three four');
      await expect(page.getByTestId('status-count')).toHaveText('5 words');
    } finally {
      await app.close();
    }
  });

  test('counts a Chinese character as a word, as every editor that handles it does', async () => {
    const { app, page } = await launch('chinese', '机器性能还是非常强劲的\n');
    try {
      await expect(page.getByTestId('status-count')).toHaveText('11 words');
    } finally {
      await app.close();
    }
  });

  test('says one word rather than 1 words', async () => {
    const { app, page } = await launch('singular', 'Alone\n');
    try {
      await expect(page.getByTestId('status-count')).toHaveText('1 word');
    } finally {
      await app.close();
    }
  });
});

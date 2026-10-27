import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
    const target = find(Menu.getApplicationMenu()!.items);
    if (!target) throw new Error(`no menu item ${wanted}`);
    target.click();
  }, id);
}

test.describe('what the file holds', () => {
  // Each of these used to change the saved bytes: the character before a single
  // star went, an identifier became italics, auto-pair's closer stayed behind
  // after inline code, and a typed link was saved escaped.
  test('keeps every character typed around marks, code and links', async () => {
    const { app, page } = await launch('typed-bytes');
    try {
      await atEnd(page);
      await page.keyboard.type(' 中文*斜体*中文 snake_case_name a `x` b see [text](https://a.b) after');
      await invokeMenu(app, 'save');
      await expect.poll(() => readFile(path.join(resultRoot, 'typed-bytes', 'note.md'), 'utf8'))
        .toBe('# Pairs\n\nHere. 中文*斜体*中文 snake_case_name a `x` b see [text](https://a.b) after\n');
    } finally {
      await app.close();
    }
  });
});

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
      // Smart quotes are off by default, so the apostrophe stays straight.
      // What matters here is that there is one apostrophe and not two.
      await expect.poll(() => text(page)).toBe("Here. don't");
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

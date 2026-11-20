import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable, placeCaret } from './packaged-app';

const resultRoot = path.join(process.cwd(), 'test-results', 'width-keys');

const NOTE = '# Title\n\nA paragraph.\n\n- first\n- second\n\nBetween.\n\n1. one\n2. two\n\nAnd.\n\n- [ ] task\n- [ ] subtask\n';

async function launch(name: string): Promise<{ app: ElectronApplication; page: Page }> {
  const workspace = path.join(resultRoot, name);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const file = path.join(workspace, 'note.md');
  await writeFile(file, NOTE, 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${file}`],
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
  await page.setViewportSize({ width: 1280, height: 800 });
  return { app, page };
}

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const widthMode = (page: Page) => page.evaluate(() =>
  document.documentElement.getAttribute('data-width-mode'));

test.describe('Command and a bracket', () => {
  test('walks the page width when the caret is not in a list', async () => {
    const { app, page } = await launch('width');
    try {
      await placeCaret(page, page.locator('.ProseMirror > p').first());
      expect(await widthMode(page)).toBe('default');

      await page.keyboard.press(`${mod}+BracketRight`);
      await expect.poll(() => widthMode(page)).toBe('wide');
      await page.keyboard.press(`${mod}+BracketRight`);
      await expect.poll(() => widthMode(page)).toBe('full');
      // A ring, so the chord never lands on nothing.
      await page.keyboard.press(`${mod}+BracketRight`);
      await expect.poll(() => widthMode(page)).toBe('default');

      await page.keyboard.press(`${mod}+BracketLeft`);
      await expect.poll(() => widthMode(page)).toBe('full');
    } finally {
      await app.close();
    }
  });

  test('steps the page width in a list too, and leaves indenting to Tab', async () => {
    const { app, page } = await launch('list');
    try {
      const nested = page.locator('.ProseMirror li ul li, .ProseMirror li ol li');
      await placeCaret(page, page.locator('.ProseMirror ul > li').nth(1));
      expect(await widthMode(page)).toBe('default');

      // The brackets mean the page width here as anywhere, and nest nothing.
      await page.keyboard.press(`${mod}+BracketRight`);
      await expect.poll(() => widthMode(page)).toBe('wide');
      await expect(nested).toHaveCount(0);
      await page.keyboard.press(`${mod}+BracketLeft`);
      await expect.poll(() => widthMode(page)).toBe('default');

      // Tab indents a bulleted item, a numbered one and a task; Shift-Tab brings each back.
      for (const item of ['second', 'two', 'subtask']) {
        await placeCaret(page, page.locator('.ProseMirror li', { hasText: item }).last());
        await page.keyboard.press('Tab');
        await expect(nested).toHaveCount(1);
        await expect(nested.first()).toContainText(item);
        await page.keyboard.press('Shift+Tab');
        await expect(nested).toHaveCount(0);
      }
      expect(await widthMode(page)).toBe('default');
    } finally {
      await app.close();
    }
  });

  test('shows the chord on the View menu without taking it from the note or the sheets', async () => {
    const { app } = await launch('menu');
    try {
      const items = await app.evaluate(({ Menu }) => {
        const out: { id: string; accelerator: string | null; registered: boolean }[] = [];
        const walk = (list: Electron.MenuItem[]) => {
          for (const item of list) {
            if (item.id === 'widen' || item.id === 'narrow') {
              out.push({
                id: item.id,
                accelerator: item.accelerator ?? null,
                registered: item.registerAccelerator,
              });
            }
            if (item.submenu) walk(item.submenu.items);
          }
        };
        const menu = Menu.getApplicationMenu();
        if (menu) walk(menu.items);
        return out;
      });
      expect(items).toEqual([
        { id: 'widen', accelerator: 'CmdOrCtrl+]', registered: false },
        { id: 'narrow', accelerator: 'CmdOrCtrl+[', registered: false },
      ]);
    } finally {
      await app.close();
    }
  });
});

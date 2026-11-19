import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test';
import { packagedExecutable, placeCaret, placeCaretAtStart } from './packaged-app';

const menu = (app: ElectronApplication, id: string) => app.evaluate(({ Menu }, itemId) => {
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

async function launch(name: string, text: string) {
  const workspace = path.join(process.cwd(), 'test-results', 'rule-frontmatter', name);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const file = path.join(workspace, 'note.md');
  await writeFile(file, text, 'utf8');
  const app = await electron.launch({ executablePath: packagedExecutable(), args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${file}`] });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
  return { app, page, file };
}

test('--- typed at the head of a note opens front matter, as in Typora', async () => {
  const { app, page, file } = await launch('front', 'Body.\n');
  try {
    const editor = page.locator('.canvas-slot:not([hidden]) .ProseMirror');
    await placeCaretAtStart(page, editor.locator('p').first());
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.type('---');
    const front = editor.locator('.noto-frontmatter');
    await expect(front).toHaveCount(1);
    await page.keyboard.type('title: Plan');
    await page.keyboard.press('Enter');
    await page.keyboard.type('tags: [work]');
    // The keys are coloured as YAML is.
    await expect(front.locator('.token').first()).toBeVisible();
    await menu(app, 'save');
    await expect.poll(() => readFile(file, 'utf8')).toBe('---\ntitle: Plan\ntags: [work]\n---\n\nBody.\n');
  } finally {
    await app.close();
  }
});

test('--- typed in a note makes a rule, and typing goes on under it', async () => {
  const { app, page, file } = await launch('rule', '# Title\n\nOne.\n\nTwo.\n');
  try {
    const editor = page.locator('.canvas-slot:not([hidden]) .ProseMirror');
    await placeCaret(page, editor.locator('p').first());
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('---');
    await expect(editor.locator('hr')).toHaveCount(1);
    // A rule you can see: a line across the page, not a hairline the paper swallows.
    const rule = await editor.locator('hr').evaluate((element) => {
      const box = element.getBoundingClientRect();
      const page = element.parentElement!.getBoundingClientRect();
      return { height: box.height, width: box.width / page.width };
    });
    expect(rule.height).toBeGreaterThanOrEqual(1);
    expect(rule.width).toBeGreaterThan(0.9);
    await page.keyboard.type('Under the rule.');
    await menu(app, 'save');
    await expect.poll(() => readFile(file, 'utf8')).toBe('# Title\n\nOne.\n\n---\n\nUnder the rule.\n\nTwo.\n');
  } finally {
    await app.close();
  }
});

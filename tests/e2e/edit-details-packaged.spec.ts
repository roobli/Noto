import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

const NOTE = '# Title\n\n## Second heading\n\nA claim[^1] with more words after it.\n\n[^1]: The footnote says this.\n';

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

test("Typora's small things: the heading badge, the footnote on hover, the selections", async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'edit-details');
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const vault = path.join(workspace, 'vault');
  await mkdir(vault, { recursive: true });
  await writeFile(path.join(vault, 'note.md'), NOTE, 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, vault],
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
    await page.getByTestId('tree-file').first().click();
    const editor = page.locator('.canvas-slot:not([hidden]) .ProseMirror');
    await editor.waitFor({ state: 'visible' });

    // The badge names the level, and shows for the heading being written
    // and for no other.
    const badge = (selector: string) => editor.locator(selector).evaluate((node) => {
      const style = getComputedStyle(node, '::before');
      return { content: style.content, opacity: style.opacity };
    });
    // And reads as one word: a badge with no room beside the heading used to
    // break between its characters, `h` stacked over `1`, two lines tall.
    const badgeLines = (selector: string) => editor.locator(selector).evaluate((node) => {
      const style = getComputedStyle(node, '::before');
      return Math.round(parseFloat(style.height) / parseFloat(style.lineHeight));
    });
    await editor.locator('h2').click();
    await expect(editor.locator('h2')).toHaveClass(/noto-active-block/);
    await expect.poll(() => badge('h2')).toEqual({ content: '"h2"', opacity: '1' });
    expect(await badge('h1')).toEqual({ content: '"h1"', opacity: '0' });
    expect(await badgeLines('h1')).toBe(1);
    expect(await badgeLines('h2')).toBe(1);

    // The footnote's words ride on its number.
    await expect(editor.locator('.noto-footnote-reference').first()).toHaveAttribute('title', 'The footnote says this.');

    // Select Word takes the word under the caret; Select Line the block.
    await editor.locator('p').filter({ hasText: 'A claim' }).click();
    await expect(editor.locator('.noto-active-block')).toContainText('A claim');
    // Into "claim": the line start, then three to the right, and a wait for
    // the editor to have the caret there before the command runs on it.
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home');
    for (let step = 0; step < 3; step += 1) await page.keyboard.press('ArrowRight');
    await expect(page.locator('.canvas-slot:not([hidden]) [data-testid="noto-editor"]')).toHaveAttribute('data-caret', '27');
    await invokeMenu(app, 'select-word');
    const selection = () => page.evaluate(() => window.getSelection()?.toString() ?? '');
    await expect.poll(selection).toBe('claim');
    await invokeMenu(app, 'select-line');
    await expect.poll(selection).toContain('with more words after it.');
  } finally {
    await app.close();
  }
});

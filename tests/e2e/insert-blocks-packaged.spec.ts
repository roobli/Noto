import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable, placeCaret } from './packaged-app';

const resultRoot = path.join(process.cwd(), 'test-results', 'insert-blocks');

async function launch(name: string, contents: string): Promise<{
  app: ElectronApplication; page: Page; file: string;
}> {
  const workspace = path.join(resultRoot, name);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const file = path.join(workspace, 'note.md');
  await writeFile(file, contents, 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${file}`],
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
  await page.setViewportSize({ width: 1100, height: 700 });
  return { app, page, file };
}

/**
 * Click until the editor agrees the caret is in the target, then stop.
 *
 * Checking the browser's own selection is not enough, and that is what made
 * this test fail about one run in four. The click moves the DOM selection at
 * once and ProseMirror learns of it from a `selectionchange` a moment later, so
 * between the two the editor still holds the position it had before, and a
 * command run in that window acts on the old one: the second footnote's
 * reference landed inside the first footnote's definition.
 *
 * The editor marks the block the caret is in, and that mark is set from its own
 * state, so waiting for it is waiting for the thing that actually matters.
 */
async function caretIn(page: Page, target: ReturnType<Page['locator']>): Promise<void> {
  await expect.poll(async () => {
    await placeCaret(page, target);
    return target.evaluate((node) => node.classList.contains('noto-active-block'));
  }, { timeout: 10_000 }).toBe(true);
}

/** Definitions on screen, which is how the effect of an insert is waited for. */
const definitions = (page: Page) => page.locator('.ProseMirror .noto-footnote-definition');

/**
 * Click the real menu item, without opening a native menu.
 *
 * A native menu holds the input loop, so a test that opens one hangs. Clicking
 * the item directly exercises everything the menu does except the drawing.
 */
async function run(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ Menu }, itemId) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | null => {
      for (const item of items) {
        if (item.id === itemId) return item;
        const nested = item.submenu ? find(item.submenu.items) : null;
        if (nested) return nested;
      }
      return null;
    };
    const menu = Menu.getApplicationMenu();
    const target = menu ? find(menu.items) : null;
    if (!target) throw new Error(`No menu item with id ${itemId}`);
    target.click();
  }, id);
}

test.describe('the things Typora\'s Paragraph menu inserts', () => {
  test('writes a footnote reference and its definition, and both survive the save', async () => {
    const { app, page, file } = await launch('footnote', '# Note\n\nA claim worth sourcing.\n');
    try {
      await placeCaret(page, page.locator('.ProseMirror > p').first());
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
      await run(app, 'insert-footnote');
      await expect(definitions(page)).toHaveCount(1);
      await page.keyboard.type('Where it came from.');
      await page.getByTestId('save-button').click();
      await expect.poll(() => readFile(file, 'utf8'), { timeout: 15_000 })
        .toContain('A claim worth sourcing.[^1]');
      expect(await readFile(file, 'utf8')).toContain('[^1]: Where it came from.');
    } finally {
      await app.close();
    }
  });

  test('numbers a second footnote after the first rather than repeating it', async () => {
    const { app, page, file } = await launch('footnote-2', '# Note\n\nFirst claim.\n\nSecond claim.\n');
    try {
      await placeCaret(page, page.locator('.ProseMirror > p').first());
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
      await run(app, 'insert-footnote');
      // Wait for the first to land. Clicking a menu item returns as soon as
      // main has sent the command, not when the renderer has applied it, and
      // the second footnote's number is read from the document.
      // Both halves of the first footnote have to be on screen before the
      // second is asked for: its number is read from the definitions in the
      // document, and clicking a menu item returns when main has sent the
      // command, not when the renderer has applied it.
      await expect(definitions(page)).toHaveCount(1);
      await expect(page.locator('.ProseMirror > p').first().locator('.noto-footnote-reference')).toHaveText('1');
      // Verify the caret actually landed before asking for the second
      // footnote. `placeCaret` waits for a `selectionchange`, and the first
      // insert moves the selection into its own definition, which fires the
      // same event: that can satisfy the wait before the click has happened,
      // leaving the caret in the definition and the reference inserted there.
      await caretIn(page, page.locator('.ProseMirror > p').nth(1));
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
      await run(app, 'insert-footnote');
      await expect(definitions(page)).toHaveCount(2);
      await expect(page.locator('.ProseMirror > p').nth(1).locator('.noto-footnote-reference')).toHaveText('2');
      await page.getByTestId('save-button').click();
      await expect.poll(() => readFile(file, 'utf8'), { timeout: 15_000 }).toContain('[^2]');
      const written = await readFile(file, 'utf8');
      expect(written).toContain('First claim.[^1]');
      expect(written).toContain('Second claim.[^2]');
    } finally {
      await app.close();
    }
  });

  test('writes a table of contents marker that survives the round trip', async () => {
    const { app, page, file } = await launch('toc', '# Note\n\nThe body.\n');
    try {
      await placeCaret(page, page.locator('.ProseMirror > p').first());
      await run(app, 'insert-toc');
      await expect(page.locator('.ProseMirror')).toContainText('[TOC]');
      await page.getByTestId('save-button').click();
      // Unescaped, or it stops being a marker anything reads.
      await expect.poll(() => readFile(file, 'utf8'), { timeout: 15_000 }).toContain('\n[TOC]\n');
      expect(await readFile(file, 'utf8')).not.toContain('\\[TOC]');
    } finally {
      await app.close();
    }
  });

  test('puts front matter at the top whatever is selected, and refuses a second block', async () => {
    const { app, page, file } = await launch('frontmatter', '# Note\n\nThe body.\n');
    try {
      await placeCaret(page, page.locator('.ProseMirror > p').first());
      await run(app, 'insert-frontmatter');
      await expect(page.locator('.ProseMirror .noto-frontmatter')).toHaveCount(1);
      await page.keyboard.type('A title');
      await run(app, 'insert-frontmatter');
      await page.getByTestId('save-button').click();
      await expect.poll(() => readFile(file, 'utf8'), { timeout: 15_000 }).toMatch(/^---\n/);
      const written = await readFile(file, 'utf8');
      // The caret lands after the seed, so the title reads forwards.
      expect(written).toContain('title: A title');
      // One block, not two. A second would serialize as a rule and a stray line.
      expect(written.split('---\n').length).toBe(3);
      // The rest of the file keeps its shape, blank lines included.
      expect(written).toContain('# Note\n\nThe body.\n');
    } finally {
      await app.close();
    }
  });
});

test.describe('table source', () => {
  const RAGGED = '# Note\n\n| Name | Description |\n| --- | --- |\n| a | A long description |\n| bb | Short |\n';

  test('lines the columns up only when asked, and leaves the file alone until then', async () => {
    const { app, page, file } = await launch('prettify', RAGGED);
    try {
      // Untouched, so the file is still exactly what the author wrote.
      expect(await readFile(file, 'utf8')).toBe(RAGGED);

      await placeCaret(page, page.locator('.ProseMirror td').first());
      await run(app, 'table-prettify');
      await expect(page.getByTestId('save-button')).toBeEnabled();
      await page.getByTestId('save-button').click();
      await expect.poll(() => readFile(file, 'utf8'), { timeout: 15_000 })
        .toContain('| Name | Description        |');
      const written = await readFile(file, 'utf8');
      expect(written).toContain('| ---- | ------------------ |');
      expect(written).toContain('| a    | A long description |');
      // Nothing outside the table moved.
      expect(written).toContain('# Note\n');
    } finally {
      await app.close();
    }
  });
});

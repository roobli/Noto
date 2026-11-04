import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable, placeCaret } from './packaged-app';

const resultRoot = path.join(process.cwd(), 'test-results', 'sidenotes');

const NOTE = [
  '# Notes',
  '',
  'A claim<span class="sidenote">The source for this claim.</span> and another<span class="sidenote">A second note.</span> after.',
  '',
].join('\n');

async function launch(
  note = NOTE,
  name = 'note',
  size = { width: 1200, height: 700 },
  settings: Record<string, unknown> | null = null,
): Promise<{ app: ElectronApplication; page: Page }> {
  const workspace = path.join(resultRoot, name);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  if (settings) await writeFile(path.join(workspace, 'user-data', 'settings.json'), JSON.stringify(settings), 'utf8');
  const file = path.join(workspace, 'note.md');
  await writeFile(file, note, 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${file}`],
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
  await page.setViewportSize(size);
  return { app, page };
}

test.describe('sidenotes', () => {
  test('number the notes and hide the tags until the caret enters', async () => {
    const { app, page } = await launch();
    try {
      const markers = page.locator('.ProseMirror .noto-sidenote-num');
      await expect(markers).toHaveCount(2);
      await expect(markers.nth(0)).toHaveAttribute('data-sidenote-index', '1');
      await expect(markers.nth(1)).toHaveAttribute('data-sidenote-index', '2');

      const notes = page.locator('.ProseMirror .noto-sidenote');
      await expect(notes).toHaveCount(2);
      await expect(notes.nth(0)).toContainText('The source for this claim.');

      // Tags stay in the DOM (byte-faithful) but are display:none until edited.
      // Assert via innerText so hidden source is not mistaken for a drawing bug.
      await expect(page.locator('.ProseMirror')).not.toContainText('<span class="sidenote">', {
        useInnerText: true,
      });
      await expect(page.locator('.ProseMirror .noto-sidenote-tag').first()).toBeHidden();

      // Off in Plugin Center: the plugin's editor extension leaves the open
      // note, the decorations go and the tags return as source.
      const plugin = (action: 'enable' | 'disable') => page.evaluate((a) => window.notoDesktop.plugins[a]({
        version: 1, requestId: `sidenotes-${a}-${Date.now()}`, pluginId: 'dev.lr00rl.noto.sidenotes',
      }), action);
      await plugin('disable');
      await expect(page.locator('.ProseMirror .noto-sidenote-num')).toHaveCount(0);
      await expect(page.locator('.noto-editor-host.noto-has-sidenotes')).toHaveCount(0);
      await expect(page.locator('.ProseMirror')).toContainText('<span class="sidenote">', {
        useInnerText: true,
      });

      // On again: drawn again, in the note that stayed open.
      await plugin('enable');
      await expect(page.locator('.ProseMirror .noto-sidenote-num')).toHaveCount(2);
    } finally {
      await app.close();
    }
  });

  test('wrap the selection in a note with the plugin\u2019s key', async () => {
    const { app, page } = await launch(['# Notes', '', 'Plain words here.', ''].join('\n'), 'wrap');
    try {
      // The plugin's key reaches it once it is running; on a loaded machine the
      // press could otherwise land before the plugin snapshots do.
      await expect.poll(() => page.evaluate(async () => {
        const result = await window.notoDesktop.plugins.getSnapshots({ version: 1, requestId: `snapshots-${Date.now()}` });
        return result.ok ? result.value.snapshots.find((plugin) => plugin.id === 'dev.lr00rl.noto.sidenotes')?.lifecycle : null;
      }), { timeout: 15_000 }).toBe('active');
      // Select "words" from the keyboard, and wait until the editor holds that
      // selection: a range set straight on the DOM could still be unread when
      // the key arrived, and the note went in empty at the top of the
      // document. A double click is no better, since Windows takes the space
      // after the word with it.
      const paragraph = page.locator('.ProseMirror p').first();
      await paragraph.click();
      await expect(paragraph).toHaveClass(/noto-active-block/);
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home');
      for (let step = 0; step < 'Plain '.length; step += 1) await page.keyboard.press('ArrowRight');
      for (let step = 0; step < 'words'.length; step += 1) await page.keyboard.press('Shift+ArrowRight');
      await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('words');
      // The editor reads the selection on the browser's selectionchange, which
      // is queued after the selection moves; two frames let the last one land.
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Alt+KeyS' : 'Control+Alt+KeyS');
      await expect(page.locator('.ProseMirror .noto-sidenote')).toHaveText('words');
    } finally {
      await app.close();
    }
  });

  test('draw a note in the margin wherever the caret is, from the moment the note opens', async () => {
    // The note sits several blocks from the caret, so its block is not one the
    // viewport keeps live around the selection.
    const filler = Array.from({ length: 8 }, (_, index) => `Paragraph ${index + 1} of plain text.`);
    const note = ['# Margin', '', ...filler.flatMap((line) => [line, '']),
      'A claim<span class="sidenote">Out in the margin.</span> and the text goes on.', '',
      ...filler.flatMap((line) => [line, ''])].join('\n');
    const { app, page } = await launch(note, 'margin', { width: 1440, height: 1000 });
    try {
      const margin = page.locator('.ProseMirror .noto-sidenote');
      const visibleInMargin = () => margin.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const block = element.closest('.ProseMirror > *')!.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return {
          floated: getComputedStyle(element).float === 'right',
          pastText: box.left >= block.right - 1,
          painted: hit === element || element.contains(hit),
        };
      });
      // Before anything is pressed: it was inline until the first transaction.
      await expect.poll(visibleInMargin).toEqual({ floated: true, pastText: true, painted: true });

      // The caret in the first paragraph, far from the note: it stays drawn.
      await page.locator('.ProseMirror p').first().click();
      await page.waitForTimeout(300);
      await expect.poll(visibleInMargin).toEqual({ floated: true, pastText: true, painted: true });
    } finally {
      await app.close();
    }
  });

  test('draw a note typed by hand as soon as its closing tag is typed, with smart quotes on', async () => {
    const note = '# Notes\n\nA typed claim.\n';
    const { app, page } = await launch(note, 'typed', { width: 1200, height: 700 }, { smartQuotes: true });
    try {
      const paragraph = page.locator('.ProseMirror > p').first();
      await placeCaret(page, paragraph);
      await page.keyboard.press('End');
      await page.keyboard.type('<span class="sidenote">Typed by hand.</span>');
      await expect(page.locator('.ProseMirror .noto-sidenote')).toHaveText('Typed by hand.');
      // The caret leaving the block draws it as a numbered note.
      await page.locator('.ProseMirror > h1').click();
      await expect(page.locator('.ProseMirror .noto-sidenote-num')).toHaveCount(1);

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
      const file = path.join(resultRoot, 'typed', 'note.md');
      await expect.poll(() => readFile(file, 'utf8')).toContain('Typed by hand.');
      expect(await readFile(file, 'utf8')).toBe('# Notes\n\nA typed claim.<span class="sidenote">Typed by hand.</span>\n');
    } finally {
      await app.close();
    }
  });
});

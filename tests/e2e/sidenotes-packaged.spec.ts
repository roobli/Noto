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

/** The plugin's keys and menu items reach it once it runs; on a loaded machine a press could land first. */
async function pluginRunning(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(async () => {
    const result = await window.notoDesktop.plugins.getSnapshots({ version: 1, requestId: `snapshots-${Date.now()}` });
    return result.ok ? result.value.snapshots.find((plugin) => plugin.id === 'dev.lr00rl.noto.sidenotes')?.lifecycle : null;
  }), { timeout: 15_000 }).toBe('active');
}

/**
 * Select `word` after `before` in the first paragraph from the keyboard, and
 * wait until the editor holds that selection: a range set straight on the DOM
 * could still be unread when the next key arrived. A double click is no
 * better, since Windows takes the space after the word with it.
 */
async function selectWord(page: Page, before: string, word: string): Promise<void> {
  const paragraph = page.locator('.ProseMirror p').first();
  await paragraph.click();
  await expect(paragraph).toHaveClass(/noto-active-block/);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home');
  for (let step = 0; step < before.length; step += 1) await page.keyboard.press('ArrowRight');
  for (let step = 0; step < word.length; step += 1) await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(word);
  // The editor reads the selection on the browser's selectionchange, which is
  // queued after the selection moves; two frames let the last one land.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** Save from the menu: keys sent from here never reach the native menu. */
async function save(app: ElectronApplication): Promise<void> {
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
}

test.describe('sidenotes', () => {
  test('number the notes and keep the tags hidden, even with the caret in a note', async () => {
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

      // In a note, the note stays in the margin and its tags stay hidden: it
      // is edited where it is drawn.
      await notes.nth(0).click();
      await expect(notes.nth(0)).toHaveClass(/is-active/);
      await expect(page.locator('.ProseMirror .noto-sidenote-tag').first()).toBeHidden();
      expect(await notes.nth(0).evaluate((element) => getComputedStyle(element).float)).toBe('right');
      // Typed there, the words go into the note, which stays where it is.
      await page.keyboard.type('!');
      await expect(notes.nth(0)).toContainText('!');
      expect(await notes.nth(0).evaluate((element) => getComputedStyle(element).float)).toBe('right');
      await expect(page.locator('.ProseMirror .noto-sidenote-tag').first()).toBeHidden();
      // Enter in a note leaves it whole, the caret after it, rather than
      // splitting it across two paragraphs.
      const typed = await notes.nth(0).innerText();
      await page.keyboard.press('Enter');
      await expect(page.locator('.ProseMirror > p')).toHaveCount(1);
      await expect(notes).toHaveCount(2);
      await expect(notes.nth(0)).toHaveText(typed);

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

  test('write a note on the selected words from the plugin\u2019s key, and take it out with Backspace', async () => {
    const { app, page } = await launch(['# Notes', '', 'Plain words here.', ''].join('\n'), 'compose');
    try {
      await pluginRunning(page);
      await selectWord(page, 'Plain ', 'words');
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Alt+KeyS' : 'Control+Alt+KeyS');

      // The card opens in the margin with the keys in it; nothing is written yet.
      const field = page.locator('.ProseMirror .noto-sidenote-composer textarea');
      await expect(field).toBeFocused();
      await expect(page.locator('.ProseMirror .noto-sidenote-target')).toHaveText('words');
      await page.keyboard.type('Why these words?');
      await page.keyboard.press('Enter');

      await expect(field).toHaveCount(0);
      await expect(page.locator('.ProseMirror .noto-sidenote')).toHaveText('Why these words?');
      await expect(page.locator('.ProseMirror .noto-sidenote-target')).toHaveText('words');
      await save(app);
      const file = path.join(resultRoot, 'compose', 'note.md');
      await expect.poll(() => readFile(file, 'utf8')).toBe(
        '# Notes\n\nPlain <span class="sidenote-target">words</span><span class="sidenote">Why these words?</span> here.\n',
      );

      // The caret is after the note: Backspace selects it, a second takes it
      // out and leaves the words as they were.
      await page.keyboard.press('Backspace');
      await expect(page.locator('.ProseMirror .noto-sidenote')).toHaveCount(1);
      await page.keyboard.press('Backspace');
      await expect(page.locator('.ProseMirror .noto-sidenote')).toHaveCount(0);
      await expect(page.locator('.ProseMirror .noto-sidenote-target')).toHaveCount(0);
      await expect(page.locator('.ProseMirror p').first()).toHaveText('Plain words here.');
    } finally {
      await app.close();
    }
  });

  test('write nothing when the card is left with Escape', async () => {
    const { app, page } = await launch(['# Notes', '', 'Plain words here.', ''].join('\n'), 'escape');
    try {
      await pluginRunning(page);
      await selectWord(page, 'Plain ', 'words');
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Alt+KeyS' : 'Control+Alt+KeyS');
      await expect(page.locator('.ProseMirror .noto-sidenote-composer textarea')).toBeFocused();
      await page.keyboard.type('Second thoughts');
      await page.keyboard.press('Escape');
      await expect(page.locator('.ProseMirror .noto-sidenote-composer')).toHaveCount(0);
      await expect(page.locator('.ProseMirror .noto-sidenote-target')).toHaveCount(0);
      await expect(page.locator('.ProseMirror p').first()).toHaveText('Plain words here.');
      // The selection comes back to the words, in the note.
      await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('words');
    } finally {
      await app.close();
    }
  });

  test('add and remove a note from the right-click menu', async () => {
    const { app, page } = await launch(['# Notes', '', 'Plain words here.', ''].join('\n'), 'context');
    try {
      await pluginRunning(page);
      // The native menu cannot be clicked from here: record what it would show
      // and choose the item named in `__choose`.
      await app.evaluate(({ Menu }) => {
        const state = globalThis as unknown as { __shown: string[][]; __choose: string };
        state.__shown = [];
        Menu.prototype.popup = function popup(this: Electron.Menu) {
          state.__shown.push(this.items.map((item) => item.label));
          this.items.find((item) => item.label === state.__choose)?.click();
        } as typeof Menu.prototype.popup;
      });
      const choose = (label: string) => app.evaluate((_electron, value) => {
        (globalThis as unknown as { __choose: string }).__choose = value;
      }, label);
      const lastMenu = () => app.evaluate(() => {
        const shown = (globalThis as unknown as { __shown: string[][] }).__shown;
        return shown[shown.length - 1] ?? [];
      });

      await selectWord(page, 'Plain ', 'words');
      const word = await page.evaluate(() => {
        const box = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      });
      await choose('Add Sidenote');
      await page.mouse.click(word.x, word.y, { button: 'right' });
      await expect.poll(lastMenu).toContain('Add Sidenote');
      await expect(page.locator('.ProseMirror .noto-sidenote-composer textarea')).toBeFocused();
      await page.keyboard.type('From the menu.');
      await page.keyboard.press('Enter');
      await expect(page.locator('.ProseMirror .noto-sidenote')).toHaveText('From the menu.');

      // Over the note in the margin, the menu offers to remove it.
      const note = await page.locator('.ProseMirror .noto-sidenote').evaluate((element) => {
        const box = element.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      });
      await choose('Remove Sidenote');
      await page.mouse.click(note.x, note.y, { button: 'right' });
      await expect.poll(lastMenu).toContain('Remove Sidenote');
      await expect(page.locator('.ProseMirror .noto-sidenote')).toHaveCount(0);
      await expect(page.locator('.ProseMirror p').first()).toHaveText('Plain words here.');
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

      await save(app);
      const file = path.join(resultRoot, 'typed', 'note.md');
      await expect.poll(() => readFile(file, 'utf8')).toContain('Typed by hand.');
      expect(await readFile(file, 'utf8')).toBe('# Notes\n\nA typed claim.<span class="sidenote">Typed by hand.</span>\n');
    } finally {
      await app.close();
    }
  });
});

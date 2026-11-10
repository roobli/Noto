/**
 * Tables by the row, and the edges of a note.
 *
 * Rows and columns are taken out from the right-click menu or by selecting
 * them by their handles and pressing Delete, several at once; Down past a
 * quote at the end of a note, or Up past one at its start, makes a plain line
 * there, and a line made and left empty is not saved; and in a folder under
 * git, a table with one row changed is marked at that row.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

const made: string[] = [];
test.afterAll(() => {
  for (const directory of made) rmSync(directory, { recursive: true, force: true });
});

function scratch(name: string): string {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), `noto-e2e-${name}-`)));
  made.push(directory);
  return directory;
}

const TABLE = [
  '| head a | head b | head c |',
  '| --- | --- | --- |',
  '| one | two | three |',
  '| four | five | six |',
  '| seven | eight | nine |',
];

async function open(target: string, args: string[] = []): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = scratch('user-data');
  const app = await electron.launch({ executablePath: packagedExecutable(), args: [`--user-data-dir=${userData}`, ...args, target] });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
  return { app, page };
}

async function openNote(text: string): Promise<{ app: ElectronApplication; page: Page; file: string }> {
  const file = path.join(scratch('note'), 'note.md');
  writeFileSync(file, text, 'utf8');
  return { ...(await open(`--open=${file}`)), file };
}

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

/** Keep the menus main would pop up, since a native menu cannot be reached from a test. */
async function catchMenus(app: ElectronApplication): Promise<{ labels: () => Promise<string[][]>; pick: (label: string) => Promise<void> }> {
  await app.evaluate(({ Menu }) => {
    const shown: Electron.Menu[] = [];
    (globalThis as { shownMenus?: Electron.Menu[] }).shownMenus = shown;
    Menu.prototype.popup = function popup(this: Electron.Menu) { shown.push(this); };
  });
  return {
    labels: () => app.evaluate(() => (globalThis as { shownMenus?: Electron.Menu[] }).shownMenus!
      .map((menu) => menu.items.filter((item) => item.type !== 'separator').map((item) => item.label))),
    pick: (label) => app.evaluate((_electron, wanted) => {
      const shown = (globalThis as { shownMenus?: Electron.Menu[] }).shownMenus!;
      shown[shown.length - 1]!.items.find((item) => item.label === wanted)!.click();
    }, label),
  };
}

/** A press in the page below the text, which puts the caret at the end; the next key follows at once. */
async function clickBelow(page: Page): Promise<void> {
  await page.locator('.ProseMirror').click();
}

const firstColumn = (page: Page) => page.locator('.noto-table-frame tr td:first-child').allInnerTexts();

test.describe('tables by the row', () => {
  test('a right click offers the rows and columns, and selected rows go with Delete', async () => {
    const { app, page, file } = await openNote(['# Rows', '', ...TABLE, ''].join('\n'));
    try {
      const menus = await catchMenus(app);
      const two = page.locator('.noto-table-frame td', { hasText: 'two' });
      await two.click();
      await two.click({ button: 'right' });
      await expect.poll(async () => (await menus.labels()).length).toBe(1);
      expect((await menus.labels())[0]).toEqual(expect.arrayContaining([
        'Insert Row Above', 'Insert Row Below', 'Insert Column Left', 'Insert Column Right', 'Delete Row', 'Delete Column', 'Delete Table',
      ]));
      await menus.pick('Delete Row');
      await expect.poll(() => firstColumn(page)).toEqual(['four', 'seven']);

      // A handle says what it does, a press selects its row, and Shift with a
      // press takes in the rows up to the next.
      await page.locator('.noto-table-frame table').hover();
      const handles = page.locator('.noto-table-rail-rows .noto-table-handle');
      await expect(handles).toHaveCount(2);
      await expect(handles.first()).toHaveAttribute('title', /Shift-click/);
      await handles.nth(0).click();
      await handles.nth(1).click({ modifiers: ['Shift'] });
      await expect(page.locator('.noto-table-frame td.selectedCell')).toHaveCount(6);
      // A right click inside the selection keeps it, and the menu counts it.
      await page.locator('.noto-table-frame td', { hasText: 'five' }).click({ button: 'right' });
      await expect.poll(async () => (await menus.labels()).length).toBe(2);
      expect((await menus.labels())[1]).toContain('Delete 2 Rows');
      await expect(page.locator('.noto-table-frame td.selectedCell')).toHaveCount(6);
      await page.keyboard.press('Delete');
      await expect(page.locator('.noto-table-frame td')).toHaveCount(0);

      await save(app);
      await expect.poll(() => readFileSync(file, 'utf8')).not.toContain('four');
      expect(readFileSync(file, 'utf8')).toContain('| head a | head b | head c |');
    } finally {
      await app.close();
    }
  });
});

test.describe('the edges of a note', () => {
  test('Down past a quote that ends the note makes a line, and Up past one that starts it', async () => {
    const { app, page, file } = await openNote('> hello\n');
    try {
      // A press in the page below the text puts the caret at the end.
      await clickBelow(page);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.type('after');
      await expect(page.locator('.ProseMirror > p')).toHaveText('after');
      await save(app);
      await expect.poll(() => readFileSync(file, 'utf8')).toBe('> hello\n\nafter\n');

      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
      await page.keyboard.press('ArrowUp');
      await page.keyboard.type('before');
      await save(app);
      await expect.poll(() => readFileSync(file, 'utf8')).toBe('before\n\n> hello\n\nafter\n');
    } finally {
      await app.close();
    }
  });

  test('a line made and left empty is not saved', async () => {
    const { app, page, file } = await openNote('- one\n- two\n');
    try {
      await clickBelow(page);
      await page.keyboard.press('ArrowDown');
      await expect(page.locator('.ProseMirror > p')).toHaveCount(1);
      // Back up into the list (at the start of the line above, where Up from
      // an empty line lands), leaving the new line empty.
      await page.keyboard.press('ArrowUp');
      await page.keyboard.type('!');
      await save(app);
      await expect.poll(() => readFileSync(file, 'utf8')).toBe('- one\n- !two\n');
    } finally {
      await app.close();
    }
  });
});

test.describe('git marks in a table', () => {
  test('one row changed since the commit is marked at that row, not over the whole table', async () => {
    const repo = scratch('git-rows');
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=noto@example.invalid', '-c', 'user.name=Noto', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: 'ignore' });
    git('init', '-q');
    mkdirSync(repo, { recursive: true });
    writeFileSync(path.join(repo, 'note.md'), ['# Rows', '', ...TABLE, ''].join('\n'));
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
    writeFileSync(path.join(repo, 'note.md'), ['# Rows', '', ...TABLE.map((line) => line.replace('five', 'FIVE')), ''].join('\n'));
    const { app, page } = await open(path.join(repo, 'note.md'));
    try {
      const mark = page.getByTestId('git-row-line');
      await expect(mark).toHaveCount(1);
      await expect(page.getByTestId('git-line')).toHaveCount(0);
      const row = (await page.locator('.noto-table-frame tr', { hasText: 'FIVE' }).boundingBox())!;
      const bar = (await mark.boundingBox())!;
      expect(Math.abs(bar.y - row.y)).toBeLessThan(3);
      expect(Math.abs(bar.height - row.height)).toBeLessThan(3);
    } finally {
      await app.close();
    }
  });
});

test.describe('the edges of a table', () => {
  const endOfLine = process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End';
  const startOfLine = process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home';

  test('the arrows move within a table at the edge of the note, and make nothing past it', async () => {
    const { app, page, file } = await openNote('| a | b |\n| --- | --- |\n| one | two |\n');
    try {
      // Down from the end of the last cell used to make an empty line under the table.
      await page.locator('.noto-table-frame td', { hasText: 'two' }).click();
      await page.keyboard.press(endOfLine);
      await page.keyboard.press('ArrowDown');
      await expect(page.locator('.ProseMirror > p')).toHaveCount(0);
      await page.keyboard.type('!');
      await save(app);
      await expect.poll(() => readFileSync(file, 'utf8')).toBe('| a | b |\n| --- | --- |\n| one | two! |\n');

      // Up from the start of the first cell stays in the table too. The first
      // row is a header row, whose cells the table draws as th, not td.
      await page.locator('.noto-table-frame th', { hasText: 'a' }).click();
      await page.keyboard.press(startOfLine);
      await page.keyboard.press('ArrowUp');
      await expect(page.locator('.ProseMirror > p')).toHaveCount(0);
      await page.keyboard.type('!');
      await save(app);
      await expect.poll(() => readFileSync(file, 'utf8')).toBe('| !a | b |\n| --- | --- |\n| one | two! |\n');
    } finally {
      await app.close();
    }
  });

  test('the up and down arrows go to the cell directly above or below, not to the next one', async () => {
    const { app, page, file } = await openNote('| a | b |\n| --- | --- |\n| one | two |\n| three | four |\n');
    try {
      // Down from the middle of a single-line cell: the cell below it, in the
      // same column, where the caret is put at its start.
      const one = page.locator('.noto-table-frame td', { hasText: 'one' });
      const box = (await one.boundingBox())!;
      await page.mouse.click(box.x + 10, box.y + box.height / 2);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.type('!');
      await save(app);
      await expect.poll(() => readFileSync(file, 'utf8')).toBe('| a | b |\n| --- | --- |\n| one | two |\n| !three | four |\n');

      // Up from the second column reaches the header cell above it, not the
      // cell before it on the left.
      const four = page.locator('.noto-table-frame td', { hasText: 'four' });
      const box4 = (await four.boundingBox())!;
      await page.mouse.click(box4.x + 10, box4.y + box4.height / 2);
      await page.keyboard.press('ArrowUp');
      await page.keyboard.type('!');
      await save(app);
      await expect.poll(() => readFileSync(file, 'utf8')).toBe('| a | b |\n| --- | --- |\n| one | !two |\n| !three | four |\n');
    } finally {
      await app.close();
    }
  });

  test('an arrow steps into the line that is already beyond the table', async () => {
    const { app, page, file } = await openNote('before\n\n| a | b |\n| --- | --- |\n| one | two |\n\nafter\n');
    try {
      // Down from the end of the last cell goes to the paragraph below. The
      // browser's caret lands at the end of it, which is the nearest place
      // to the cell's right edge; either way the table itself is untouched.
      await page.locator('.noto-table-frame td', { hasText: 'two' }).click();
      await page.keyboard.press(endOfLine);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.type('!');
      await expect(page.locator('.ProseMirror > p')).toHaveCount(2);
      await save(app);
      await expect.poll(() => readFileSync(file, 'utf8')).toBe('before\n\n| a | b |\n| --- | --- |\n| one | two |\n\nafter!\n');

      // Up from the start of the first cell goes to the paragraph above.
      await page.locator('.noto-table-frame th', { hasText: 'a' }).click();
      await page.keyboard.press(startOfLine);
      await page.keyboard.press('ArrowUp');
      await page.keyboard.type('!');
      await save(app);
      await expect.poll(() => readFileSync(file, 'utf8')).toBe('!before\n\n| a | b |\n| --- | --- |\n| one | two |\n\nafter!\n');
    } finally {
      await app.close();
    }
  });
});

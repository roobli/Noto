import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable, placeCaret } from './packaged-app';

/*
 * Nothing used to ask before unsaved edits were lost: Close Tab, closing the
 * window and quitting all went through. The native question is stubbed in
 * main, recording what it was asked and answering as a reader would. A test
 * build asks only when `NOTO_UNSAVED_PROMPT` opts in, since every other spec
 * closes the app with notes left unsaved.
 */
async function launch(name: string, settings: Record<string, unknown> = {}): Promise<{ app: ElectronApplication; page: Page; vault: string }> {
  const workspace = path.join(process.cwd(), 'test-results', 'unsaved-guard', name);
  await rm(workspace, { recursive: true, force: true });
  const vault = path.join(workspace, 'vault');
  await mkdir(vault, { recursive: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  await writeFile(path.join(vault, 'alpha.md'), '# Alpha\n\nFirst note.\n', 'utf8');
  await writeFile(path.join(vault, 'beta.md'), '# Beta\n\nSecond note.\n', 'utf8');
  await writeFile(path.join(workspace, 'user-data', 'settings.json'), JSON.stringify(settings), 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, vault],
    env: { ...process.env, NOTO_UNSAVED_PROMPT: '1' },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
  // Every question main asks is recorded and answered with `__answer`.
  await app.evaluate(({ dialog }) => {
    const state = globalThis as unknown as { __asked: string[]; __answer: number };
    state.__asked = [];
    state.__answer = 0;
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = (args.length > 1 ? args[1] : args[0]) as Electron.MessageBoxOptions;
      state.__asked.push(options.message);
      return { response: state.__answer, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  });
  return { app, page, vault };
}

const asked = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __asked: string[] }).__asked);
const answer = (app: ElectronApplication, response: number) => app.evaluate((_electron, value) => {
  (globalThis as unknown as { __answer: number }).__answer = value;
}, response);
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

async function editAlpha(page: Page): Promise<void> {
  await page.getByTestId('tree-file').filter({ hasText: 'alpha.md' }).click();
  await placeCaret(page, page.locator('.ProseMirror > p').first());
  await page.keyboard.type(' Typed, not saved.');
  await expect(page.locator('.ProseMirror')).toContainText('Typed, not saved.');
}

const alphaOnDisk = (vault: string) => readFile(path.join(vault, 'alpha.md'), 'utf8');

test.describe('unsaved edits are asked about before they are lost', () => {
  test('leaving a note for another saves it first, by default', async () => {
    const { app, page, vault } = await launch('leave-save');
    try {
      await editAlpha(page);
      await page.getByTestId('tree-file').filter({ hasText: 'beta.md' }).click();
      await expect(page.locator('.titlebar')).toContainText('beta.md');
      await expect.poll(() => alphaOnDisk(vault)).toBe('# Alpha\n\nFirst note. Typed, not saved.\n');
      // Nothing is left behind to ask about.
      await expect(page.getByTestId('leave-unsaved')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('asked instead, Cancel stays, Don\'t Save puts the note back as on disk, Save writes it', async () => {
    const { app, page, vault } = await launch('leave-ask', { leaveUnsaved: 'ask' });
    try {
      await editAlpha(page);
      const beta = page.getByTestId('tree-file').filter({ hasText: 'beta.md' });
      await beta.click();
      const question = page.getByTestId('leave-unsaved');
      await expect(question).toContainText('alpha.md');
      await page.getByTestId('leave-unsaved-cancel').click();
      await expect(question).toHaveCount(0);
      await expect(page.locator('.titlebar')).toContainText('alpha.md');
      await expect(page.locator('.ProseMirror:visible')).toContainText('Typed, not saved.');

      await beta.click();
      await page.getByTestId('leave-unsaved-discard').click();
      await expect(page.locator('.titlebar')).toContainText('beta.md');
      expect(await alphaOnDisk(vault)).toBe('# Alpha\n\nFirst note.\n');
      // Back on alpha, it is the file on disk, with nothing unsaved.
      await page.getByTestId('tree-file').filter({ hasText: 'alpha.md' }).click();
      await expect(page.locator('.titlebar')).toContainText('alpha.md');
      const alphaPage = page.locator('.canvas-slot:not([hidden]) .ProseMirror');
      await expect(alphaPage).toContainText('First note.');
      await expect(alphaPage).not.toContainText('Typed, not saved.');

      await placeCaret(page, alphaPage.locator('p').first());
      await page.keyboard.type(' Second try.');
      await beta.click();
      // Return presses Save.
      await page.keyboard.press('Enter');
      await expect(page.locator('.titlebar')).toContainText('beta.md');
      await expect.poll(() => alphaOnDisk(vault)).toContain('Second try.');
    } finally {
      await app.close();
    }
  });

  test('quitting with a note unsaved asks, and Review brings it back', async () => {
    const { app, page, vault } = await launch('quit');
    let gone = false;
    app.process().once('exit', () => { gone = true; });
    try {
      await editAlpha(page);
      // Answer 0 is Review Changes.
      await answer(app, 0);
      await app.evaluate(({ app: electronApp }) => { electronApp.quit(); });
      await expect.poll(() => asked(app)).toEqual(['"alpha.md" has unsaved changes.']);
      await expect(page.locator('.titlebar')).toContainText('alpha.md');
      await expect(page.locator('.ProseMirror:visible')).toContainText('Typed, not saved.');

      // Discard and Quit: the app goes, and the file on disk is as it was.
      await answer(app, 1);
      const exited = new Promise((resolve) => app.process().once('exit', resolve));
      // Not awaited: the call never answers once the process it ran in is gone.
      void app.evaluate(({ app: electronApp }) => { electronApp.quit(); }).catch(() => {});
      await exited;
      expect(await readFile(path.join(vault, 'alpha.md'), 'utf8')).toBe('# Alpha\n\nFirst note.\n');
    } finally {
      // A failure above leaves a note unsaved, and closing would ask again.
      if (!gone) {
        await answer(app, 1).catch(() => {});
        await app.close();
      }
    }
  });

  test('Close Tab on an unsaved note asks, Cancel keeps it and Save saves it', async () => {
    const { app, page, vault } = await launch('close-tab');
    try {
      await page.getByTestId('tree-file').filter({ hasText: 'alpha.md' }).click();
      await placeCaret(page, page.locator('.ProseMirror > p').first());
      await page.keyboard.type(' Kept.');

      // Cancel (2): still open, still edited.
      await answer(app, 2);
      await menu(app, 'close-tab');
      await expect.poll(() => asked(app)).toEqual(['Save the changes to "alpha.md" before closing it?']);
      await expect(page.locator('.titlebar')).toContainText('alpha.md');
      await expect(page.locator('.ProseMirror:visible')).toContainText('Kept.');

      // Save (0): written to disk, then closed.
      await answer(app, 0);
      await menu(app, 'close-tab');
      await expect.poll(async () => readFile(path.join(vault, 'alpha.md'), 'utf8')).toContain('Kept.');
      await expect(page.locator('.titlebar')).not.toContainText('alpha.md');
    } finally {
      await answer(app, 1).catch(() => {});
      await app.close();
    }
  });

  test('Close Tab on a saved note closes it without asking', async () => {
    const { app, page } = await launch('close-clean');
    try {
      await page.getByTestId('tree-file').filter({ hasText: 'alpha.md' }).click();
      await expect(page.locator('.titlebar')).toContainText('alpha.md');
      await menu(app, 'close-tab');
      await expect(page.locator('.titlebar')).not.toContainText('alpha.md');
      expect(await asked(app)).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

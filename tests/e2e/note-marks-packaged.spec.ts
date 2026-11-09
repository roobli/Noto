/**
 * Marks on the note in front, in the packaged app: the Memory plugin marks a
 * note named but not linked, its card opens from the pointer and from the
 * keyboard, Link writes the link as one edit Undo takes back, Not This says
 * no to it for good, and View's switch takes every mark off.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

/** Screenshots for review, when asked for: `NOTO_MARKS_SHOTS=/some/dir`. */
const SHOTS = process.env.NOTO_MARKS_SHOTS ?? '';

const made: string[] = [];
test.afterAll(() => {
  for (const directory of made) rmSync(directory, { recursive: true, force: true });
});

function scratch(name: string): string {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), `noto-e2e-${name}-`)));
  made.push(directory);
  return directory;
}

function write(root: string, rel: string, text: string): void {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text, 'utf8');
}

function folder(): string {
  const root = scratch('marks');
  write(root, 'Ideas/Argus Index.md', '# Argus Index\n\nThe audit service and how its index names carry a date.\n');
  write(root, 'Ideas/plan.md', '# Plan\n\nRead the Argus Index before the rollout starts.\n\nAfter that, nothing else.\n');
  write(root, 'Ideas/other.md', '# Other\n\nUnrelated.\n');
  write(root, '.noto/brain.yaml', 'kinds:\n  dated_names_are_logs: true\n');
  return root;
}

async function launch(root: string): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = scratch('user-data');
  const app = await electron.launch({ executablePath: packagedExecutable(), args: [`--user-data-dir=${userData}`, ...(SHOTS ? ['--force-device-scale-factor=2'] : []), `--folder=${root}`, `--open=${path.join(root, 'Ideas', 'plan.md')}`] });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
  return { app, page };
}

/** File → Save, as the menu runs it: a key pressed in the page never reaches the menu's accelerators. */
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

const editorText = (page: Page) => page.evaluate(() => document.querySelector('.ProseMirror')?.textContent ?? '');

const shot = async (app: ElectronApplication, name: string) => {
  if (!SHOTS) return;
  await new Promise((resolve) => setTimeout(resolve, 400));
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  writeFileSync(path.join(SHOTS, name), Buffer.from(png, 'base64'));
};

test.describe('marks on the note in front', () => {
  test('marks a note named but not linked, links it as one edit Undo takes back, and says no for good', async () => {
    const root = folder();
    const plan = path.join(root, 'Ideas', 'plan.md');
    const { app, page } = await launch(root);
    try {
      const mark = page.getByTestId('note-mark');
      await expect(mark).toHaveText('Argus Index', { timeout: 30_000 });

      // The pointer resting on it opens its card.
      await mark.hover();
      const card = page.getByTestId('note-mark-card');
      await expect(card).toContainText('Link suggestion');
      await expect(card).toContainText('Link to Argus Index');
      await expect(card).toContainText('In Ideas');
      await shot(app, 'note-mark-card.png');

      await card.getByTestId('note-mark-action-link').click();
      await expect(card).toHaveCount(0);
      expect(await editorText(page)).toContain('Read the [[Argus Index]] before');
      await save(app);
      await expect.poll(() => readFileSync(plan, 'utf8')).toContain('Read the [[Argus Index]] before');
      // Settled, not only written: a save asked for while one is still landing is not taken.
      await expect(page.locator('.status-message')).toHaveText('Exact source saved');
      // Undo takes the link back, and the mark returns once the note is saved again.
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
      expect(await editorText(page)).toContain('Read the Argus Index before');
      await save(app);
      await expect.poll(() => readFileSync(plan, 'utf8')).toContain('Read the Argus Index before');
      await expect(mark).toHaveText('Argus Index', { timeout: 30_000 });

      // From the keyboard: Option-Return with the caret in the words opens the card, its first action in focus.
      await mark.click();
      await page.keyboard.press('Alt+Enter');
      await expect(card).toBeVisible();
      await expect(card.getByTestId('note-mark-action-link')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(card).toHaveCount(0);

      // Not This: gone, and not offered again, here or in Review.
      await mark.hover();
      await card.getByTestId('note-mark-action-dismiss').click();
      await expect(mark).toHaveCount(0);
      await expect.poll(() => (existsSync(path.join(root, '.noto', 'dismissed.jsonl')) ? readFileSync(path.join(root, '.noto', 'dismissed.jsonl'), 'utf8') : '')).toContain('Ideas/Argus Index.md');
      // To the end of the line.
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
      await page.keyboard.type(' Still.');
      await save(app);
      await expect.poll(() => readFileSync(plan, 'utf8')).toContain('Still.');
      await page.waitForTimeout(1_500);
      await expect(mark).toHaveCount(0);
      expect(readFileSync(plan, 'utf8')).toContain('Read the Argus Index before');
    } finally {
      await app.close();
    }
  });

  test('draws no marks once View says not to', async () => {
    const root = folder();
    const { app, page } = await launch(root);
    try {
      const mark = page.getByTestId('note-mark');
      await expect(mark).toHaveText('Argus Index', { timeout: 30_000 });
      await app.evaluate(({ Menu }) => {
        Menu.getApplicationMenu()!.getMenuItemById('toggle-note-marks')!.click();
      });
      await expect(mark).toHaveCount(0);
      await app.evaluate(({ Menu }) => {
        Menu.getApplicationMenu()!.getMenuItemById('toggle-note-marks')!.click();
      });
      await expect(mark).toHaveText('Argus Index', { timeout: 10_000 });
    } finally {
      await app.close();
    }
  });
});

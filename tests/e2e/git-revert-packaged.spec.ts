/**
 * Revert to committed, from the git gutter's popover and the palette.
 *
 * The same repository as the gutter's spec: a note committed and then changed
 * every way a block can change. Pinned: the popover's action for a changed
 * block, a deleted run and a new block; that it is an ordinary edit (the note
 * goes dirty, undo takes it back, nothing is written until a save); that the
 * save writes the committed bytes exactly and undo then the prior bytes
 * exactly; the palette's route from the caret; the gutter clearing once the
 * note matches the commit; and that the repository is untouched (no stage, no
 * commit, the index as it was).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { MOD, packagedExecutable, placeCaretAtEnd } from './packaged-app';

/** Screenshots for review, when asked for: `NOTO_GIT_SHOTS=/some/dir`. */
const SHOTS = process.env.NOTO_GIT_SHOTS ?? '';

const made: string[] = [];
test.afterAll(() => {
  for (const directory of made) rmSync(directory, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=noto@example.invalid', '-c', 'user.name=Noto', '-c', 'commit.gpgsign=false', ...args], {
    cwd, stdio: 'ignore',
  });
}

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function scratch(name: string): string {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), `noto-e2e-${name}-`)));
  made.push(directory);
  return directory;
}

const COMMITTED = [
  '# Field notes',
  'The first paragraph has not changed since the commit.',
  'The second paragraph, as it was committed.',
  'A third paragraph that has since been deleted.',
  '- a list\n- that stayed',
  'The last paragraph.',
].join('\n\n') + '\n';

const NOW = [
  '# Field notes',
  'The first paragraph has not changed since the commit.',
  'The second paragraph, rewritten after the commit.',
  '- a list\n- that stayed',
  'A paragraph written after the commit.',
  'The last paragraph.',
].join('\n\n') + '\n';

function repository(name: string): { repo: string; note: string } {
  const repo = scratch(name);
  git(repo, 'init', '-q');
  write(path.join(repo, 'note.md'), COMMITTED);
  write(path.join(repo, 'other.md'), '# Other\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'first');
  write(path.join(repo, 'note.md'), NOW);
  write(path.join(repo, 'untracked.md'), '# Untracked\n\nNever committed.\n');
  return { repo, note: path.join(repo, 'note.md') };
}

async function launch(
  folder: string,
  options: { env?: NodeJS.ProcessEnv; theme?: 'light' | 'dark' } = {},
): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = scratch('user-data');
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ theme: options.theme ?? 'light' }));
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${userData}`, ...(SHOTS ? ['--force-device-scale-factor=2'] : []), folder],
    env: { ...process.env, ...options.env } as Record<string, string>,
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
  return { app, page };
}

async function capture(app: ElectronApplication, file: string): Promise<void> {
  // The first capture can return a frame drawn before the last layout; the
  // second is of the page as it is.
  await captureOnce(app, file);
  await captureOnce(app, file);
}

async function captureOnce(app: ElectronApplication, file: string): Promise<void> {
  // A fresh frame first: without one, a capture can return the last frame drawn.
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    for (let frame = 0; frame < 3; frame += 1) {
      contents.invalidate();
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return (await contents.capturePage()).toPNG().toString('base64');
  });
  writeFileSync(file, Buffer.from(png, 'base64'));
}

const fileRow = (page: Page, name: string) => page.getByTestId('tree-file').filter({ hasText: name });
const editor = (page: Page) => page.locator('.canvas-slot:not([hidden]) .ProseMirror');
const block = (page: Page, text: string) => editor(page).locator(':scope > *').filter({ hasText: text });

async function open(page: Page, name: string): Promise<void> {
  await fileRow(page, name).click();
  await editor(page).waitFor({ state: 'visible' });
}

const gutter = (page: Page) => page.locator('.canvas-slot:not([hidden]) [data-testid="git-gutter"]');
const lines = (page: Page) => gutter(page).getByTestId('git-line');
const deletedMarks = (page: Page) => gutter(page).getByTestId('git-deleted-mark');

/** The kind of line drawn beside a block, left of it and level with its middle, or null. */
async function beside(page: Page, target: ReturnType<typeof block>): Promise<string | null> {
  const box = await target.boundingBox();
  if (!box) return null;
  return page.evaluate(({ x, y }) => {
    for (const line of document.querySelectorAll<HTMLElement>('.canvas-slot:not([hidden]) [data-testid="git-line"]')) {
      const rect = line.getBoundingClientRect();
      if (rect.right <= x && rect.right > x - 8 && rect.top <= y && rect.bottom >= y) return line.dataset.gitMark ?? null;
    }
    return null;
  }, { x: box.x, y: box.y + box.height / 2 });
}

/** A press on the gutter line beside a block: 8px left of its box, half way down. */
async function pressGutter(page: Page, target: ReturnType<typeof block>): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error('block has no box');
  await page.mouse.click(box.x - 8, box.y + box.height / 2);
}

/**
 * The arrival animation at its end. Under a virtual display the window's
 * animation clock does not advance between frames nobody asked for, so a
 * capture would catch the popover at opacity 0.
 */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) animation.finish();
    document.querySelector<HTMLElement>('.noto-git-popover')?.style.setProperty('animation', 'none');
  });
}

const focusInEditor = (page: Page) => page.evaluate(() => document.activeElement?.closest('.ProseMirror') !== null);


const popover = (page: Page) => page.getByTestId('git-popover');
const revertButton = (page: Page) => page.getByTestId('git-popover-revert');
const fileText = (repo: string) => readFileSync(path.join(repo, 'note.md'), 'utf8');

async function save(page: Page, repo: string, expected: string): Promise<void> {
  await page.keyboard.press(`${MOD}+KeyS`);
  await expect.poll(() => fileText(repo), { timeout: 10_000 }).toBe(expected);
}

/** The repository's own record: HEAD, the index and the status, which nothing in Noto may change. */
function gitRecord(repo: string): string {
  const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  return [run('rev-parse', 'HEAD'), run('ls-files', '-s'), run('stash', 'list'), run('branch', '--list')].join('\n');
}

test.describe('revert to committed', () => {
  test('reverts a changed block, puts back a deleted one and removes a new one, as undoable edits', async () => {
    const { repo } = repository('revert');
    const record = gitRecord(repo);
    const { app, page } = await launch(repo);
    try {
      await open(page, 'note.md');
      await expect(lines(page)).toHaveCount(2, { timeout: 15_000 });
      const changed = block(page, 'rewritten after the commit');

      // A changed block: the action under the committed text.
      await pressGutter(page, changed);
      await expect(popover(page)).toBeVisible();
      await expect(revertButton(page)).toHaveText('Revert to Committed');
      await expect(revertButton(page)).toHaveAttribute('data-git-revert', 'restore');
      // Under the panel, at its end.
      const panelBox = (await page.getByTestId('git-popover-text').boundingBox())!;
      const buttonBox = (await revertButton(page).boundingBox())!;
      expect(buttonBox.y).toBeGreaterThan(panelBox.y + panelBox.height);
      expect(Math.abs(buttonBox.x + buttonBox.width - (panelBox.x + panelBox.width))).toBeLessThanOrEqual(1);
      if (SHOTS) {
        await settle(page);
        await capture(app, path.join(SHOTS, 'pr3-light-popover.png'));
      }
      await revertButton(page).click();
      await expect(popover(page)).toHaveCount(0);
      expect(await focusInEditor(page)).toBe(true);
      await expect(block(page, 'The second paragraph, as it was committed.')).toHaveCount(1);
      await expect(changed).toHaveCount(0);
      // The block now matches the commit: no line beside it.
      await expect(lines(page)).toHaveCount(1);
      await expect.poll(() => beside(page, block(page, 'as it was committed'))).toBeNull();
      // An edit, not a write: the file is as it was until a save.
      expect(fileText(repo)).toBe(NOW);

      // Undo takes it back, redo puts it again.
      await page.keyboard.press(`${MOD}+KeyZ`);
      await expect(block(page, 'rewritten after the commit')).toHaveCount(1);
      await expect.poll(() => beside(page, block(page, 'rewritten after the commit'))).toBe('modified');
      await page.keyboard.press(`${MOD}+Shift+KeyZ`);
      await expect(block(page, 'as it was committed')).toHaveCount(1);

      // The deleted run: put back where it was.
      await deletedMarks(page).click();
      await expect(revertButton(page)).toHaveText('Revert to Committed');
      if (SHOTS) {
        await settle(page);
        await capture(app, path.join(SHOTS, 'pr3-light-deleted-popover.png'));
      }
      await revertButton(page).click();
      await expect(popover(page)).toHaveCount(0);
      await expect(deletedMarks(page)).toHaveCount(0);
      const order = await editor(page).locator(':scope > *').allTextContents();
      expect(order.findIndex((text) => text.includes('since been deleted'))).toBe(order.findIndex((text) => text.includes('as it was committed')) + 1);

      // A new block: the commit does not have it, so the action removes it.
      await pressGutter(page, block(page, 'A paragraph written after'));
      await expect(revertButton(page)).toHaveText('Remove Block');
      await expect(revertButton(page)).toHaveAttribute('data-git-revert', 'remove');
      if (SHOTS) {
        await settle(page);
        await capture(app, path.join(SHOTS, 'pr3-light-added-popover.png'));
      }
      // By keyboard: Tab from the panel reaches it, Enter presses it.
      await expect(page.getByTestId('git-popover-text')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(revertButton(page)).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(popover(page)).toHaveCount(0);
      await expect(block(page, 'A paragraph written after')).toHaveCount(0);
      await expect(lines(page)).toHaveCount(0);

      // Saved through the ordinary save: the committed bytes exactly, and
      // once main compares again, no gutter.
      await save(page, repo, COMMITTED);
      await page.waitForTimeout(800);
      await expect(lines(page)).toHaveCount(0);
      await expect(deletedMarks(page)).toHaveCount(0);

      // Undo after the save, every step, and save: the working bytes exactly.
      for (let step = 0; step < 3; step += 1) await page.keyboard.press(`${MOD}+KeyZ`);
      await save(page, repo, NOW);
      await expect(lines(page)).toHaveCount(2, { timeout: 15_000 });
      await expect(deletedMarks(page)).toHaveCount(1);

      // Noto wrote the note and nothing else: the repository is as it was.
      expect(gitRecord(repo)).toBe(record);
    } finally {
      await app.close();
    }
  });

  test('reverts the block at the caret from the palette', async () => {
    const { repo } = repository('revert-palette');
    const { app, page } = await launch(repo);
    try {
      await open(page, 'note.md');
      await expect(lines(page)).toHaveCount(2, { timeout: 15_000 });
      await placeCaretAtEnd(page, block(page, 'rewritten after the commit'));
      await page.keyboard.press(`${MOD}+KeyK`);
      await page.getByTestId('palette-input').fill('revert block');
      await expect(page.getByTestId('palette-git-revert')).toBeVisible();
      await page.keyboard.press('Enter');
      await expect(block(page, 'The second paragraph, as it was committed.')).toHaveCount(1);
      expect(await focusInEditor(page)).toBe(true);
      await expect(lines(page)).toHaveCount(1);

      // Beside a deleted run, it puts the run back.
      await placeCaretAtEnd(page, block(page, 'as it was committed'));
      await page.keyboard.press(`${MOD}+KeyK`);
      await page.getByTestId('palette-input').fill('revert block');
      await page.keyboard.press('Enter');
      await expect(block(page, 'since been deleted')).toHaveCount(1);
      await expect(deletedMarks(page)).toHaveCount(0);

      // On a block with nothing to revert, it does nothing and the caret stays in the note.
      await placeCaretAtEnd(page, block(page, 'has not changed since'));
      await page.keyboard.press(`${MOD}+KeyK`);
      await page.getByTestId('palette-input').fill('revert block');
      await page.keyboard.press('Enter');
      expect(await focusInEditor(page)).toBe(true);
      await page.keyboard.press(`${MOD}+KeyZ`);
      await page.keyboard.press(`${MOD}+KeyZ`);
      await save(page, repo, NOW);
    } finally {
      await app.close();
    }
  });

  test('reads the same at night', async () => {
    const { repo } = repository('revert-dark');
    const { app, page } = await launch(repo, { theme: 'dark' });
    try {
      await open(page, 'note.md');
      await expect.poll(() => beside(page, block(page, 'rewritten after the commit')), { timeout: 15_000 }).toBe('modified');
      await pressGutter(page, block(page, 'rewritten after the commit'));
      await expect(revertButton(page)).toHaveText('Revert to Committed');
      if (SHOTS) {
        await settle(page);
        await page.waitForTimeout(500);
        await capture(app, path.join(SHOTS, 'pr3-dark-popover.png'));
        await page.keyboard.press('Escape');
        await pressGutter(page, block(page, 'A paragraph written after'));
        await expect(revertButton(page)).toHaveText('Remove Block');
        await settle(page);
        await capture(app, path.join(SHOTS, 'pr3-dark-added-popover.png'));
      }
    } finally {
      await app.close();
    }
  });
});

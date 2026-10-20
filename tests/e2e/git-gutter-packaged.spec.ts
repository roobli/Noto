/**
 * The git gutter in the open note.
 *
 * A real repository made with the system git in a temporary directory, a
 * note committed and then changed every way a block can change, and the
 * packaged app opened on it. Pinned: a line beside a changed block and a new
 * one, a marker where blocks were deleted, nothing beside the rest; the
 * popover with the block as committed, by pointer and by keyboard, closing on
 * Escape with the focus back in the note; a gutter that follows a save and a
 * commit; and no gutter at all for an untracked note or outside a repository.
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

test.describe('git gutter', () => {
  test('marks changed, new and deleted blocks, and shows a block as committed', async () => {
    const { repo } = repository('gutter');
    const { app, page } = await launch(repo);
    try {
      await open(page, 'note.md');
      const changed = block(page, 'rewritten after the commit');
      const added = block(page, 'A paragraph written after');
      await expect(changed).toHaveClass(/noto-git-modified/, { timeout: 15_000 });
      await expect(added).toHaveClass(/noto-git-added/);
      await expect(editor(page).locator('.noto-git-block')).toHaveCount(2);
      await expect(editor(page).getByTestId('git-deleted-mark')).toHaveCount(1);
      // The marker sits where the deleted block was: before the list.
      await expect(page.locator('.noto-git-deleted + ul')).toHaveCount(1);
      // A line, in the gutter, in the tree's colour for a change and success for new.
      const line = (target: ReturnType<typeof block>) => target.evaluate((element) => {
        const style = getComputedStyle(element, '::after');
        return { content: style.content, left: style.left, image: style.backgroundImage };
      });
      expect((await line(changed)).content).toBe('""');
      expect(parseFloat((await line(changed)).left)).toBeLessThan(0);
      const tokens = await page.evaluate(() => {
        const probe = document.createElement('i');
        document.body.append(probe);
        probe.style.color = 'var(--git-changed)';
        const changedColour = getComputedStyle(probe).color;
        probe.style.color = 'var(--success)';
        const success = getComputedStyle(probe).color;
        probe.remove();
        return { changedColour, success };
      });
      expect((await line(changed)).image).toContain(tokens.changedColour);
      expect((await line(added)).image).toContain(tokens.success);

      if (SHOTS) {
        await page.mouse.move(700, 650);
        await page.waitForTimeout(300);
        await capture(app, path.join(SHOTS, 'pr2-light.png'));
      }

      // The pointer: the line opens the block as committed.
      await pressGutter(page, changed);
      const popover = page.getByTestId('git-popover');
      await expect(popover).toBeVisible();
      await expect(popover).toHaveAttribute('role', 'dialog');
      await expect(popover.getByRole('heading')).toHaveText('As committed');
      await expect(page.getByTestId('git-popover-text')).toHaveText('The second paragraph, as it was committed.');
      // Read-only: nothing in it edits, and the note is untouched by opening it.
      await expect(popover.locator('[contenteditable="true"], textarea, input')).toHaveCount(0);
      if (SHOTS) {
        await settle(page);
        await capture(app, path.join(SHOTS, 'pr2-light-popover.png'));
      }
      await page.keyboard.press('Escape');
      await expect(popover).toHaveCount(0);
      expect(await focusInEditor(page)).toBe(true);

      // A new block has no committed text, and says so.
      await pressGutter(page, added);
      await expect(popover.getByRole('heading')).toHaveText('New since the last commit');
      await expect(page.getByTestId('git-popover-text')).toHaveCount(0);
      await page.getByTestId('git-popover-close').click();
      await expect(popover).toHaveCount(0);

      // The deleted marker is a button: what was there.
      await editor(page).getByTestId('git-deleted-mark').click();
      await expect(popover.getByRole('heading')).toHaveText('Deleted since the last commit');
      await expect(page.getByTestId('git-popover-text')).toHaveText('A third paragraph that has since been deleted.');
      await page.keyboard.press('Escape');
      await expect(popover).toHaveCount(0);

      // A press on the text itself is typing, not the gutter.
      await changed.click();
      await expect(popover).toHaveCount(0);

      // The keyboard: the palette's command for the block holding the caret.
      await placeCaretAtEnd(page, changed);
      await page.keyboard.press(`${MOD}+KeyK`);
      await page.getByTestId('palette-input').fill('as committed');
      await page.keyboard.press('Enter');
      await expect(popover).toBeVisible();
      await expect(page.getByTestId('git-popover-text')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.getByTestId('git-popover-close')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.getByTestId('git-popover-text')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(popover).toHaveCount(0);
      expect(await focusInEditor(page)).toBe(true);

      // Typing elsewhere moves nothing: the line stays on its block.
      await placeCaretAtEnd(page, block(page, 'has not changed since'));
      await page.keyboard.type(' Typed.');
      await expect(editor(page).locator('.noto-git-block')).toHaveCount(2);
      await expect(changed).toHaveClass(/noto-git-modified/);
      // A save is what the gutter compares: the typed block is now changed.
      await page.getByTestId('save-button').click();
      await expect.poll(() => readFileSync(path.join(repo, 'note.md'), 'utf8')).toContain('Typed.');
      await expect(block(page, 'has not changed since')).toHaveClass(/noto-git-modified/, { timeout: 15_000 });

      // A commit made elsewhere clears it.
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'second');
      await expect(editor(page).locator('.noto-git-block')).toHaveCount(0, { timeout: 15_000 });
      await expect(editor(page).getByTestId('git-deleted-mark')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('draws nothing for an untracked note', async () => {
    const { repo } = repository('untracked');
    const { app, page } = await launch(repo);
    try {
      // The tracked note gets its gutter, so one has had every chance to arrive.
      await open(page, 'note.md');
      await expect(editor(page).locator('.noto-git-block')).toHaveCount(2, { timeout: 15_000 });
      await open(page, 'untracked.md');
      await expect(block(page, 'Never committed')).toBeVisible();
      await page.waitForTimeout(1_000);
      await expect(editor(page).locator('.noto-git-block')).toHaveCount(0);
      await expect(editor(page).getByTestId('git-deleted-mark')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('draws nothing outside a repository', async () => {
    const folder = scratch('plain');
    write(path.join(folder, 'note.md'), NOW);
    const { app, page } = await launch(folder, { env: { GIT_CEILING_DIRECTORIES: path.dirname(folder) } });
    try {
      await open(page, 'note.md');
      await page.waitForTimeout(1_500);
      await expect(editor(page).locator('.noto-git-block')).toHaveCount(0);
      await expect(editor(page).getByTestId('git-deleted-mark')).toHaveCount(0);
      await expect(page.locator('[role="alert"]')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('reads the same at night', async () => {
    const { repo } = repository('dark');
    const { app, page } = await launch(repo, { theme: 'dark' });
    try {
      await open(page, 'note.md');
      await expect(block(page, 'rewritten after the commit')).toHaveClass(/noto-git-modified/, { timeout: 15_000 });
      if (SHOTS) {
        await page.mouse.move(700, 650);
        await page.waitForTimeout(300);
        await capture(app, path.join(SHOTS, 'pr2-dark.png'));
        await pressGutter(page, block(page, 'rewritten after the commit'));
        await expect(page.getByTestId('git-popover')).toBeVisible();
        await expect(page.getByTestId('git-popover-text')).toBeFocused();
        await settle(page);
        await page.waitForTimeout(1_000);
        await capture(app, path.join(SHOTS, 'pr2-dark-popover.png'));
      }
    } finally {
      await app.close();
    }
  });
});

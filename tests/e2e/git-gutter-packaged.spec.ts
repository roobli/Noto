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

test.describe('git gutter', () => {
  test('marks changed, new and deleted blocks, and shows a block as committed', async () => {
    const { repo } = repository('gutter');
    const { app, page } = await launch(repo);
    try {
      await open(page, 'note.md');
      const changed = block(page, 'rewritten after the commit');
      const added = block(page, 'A paragraph written after');
      await expect(lines(page)).toHaveCount(2, { timeout: 15_000 });
      await expect.poll(() => beside(page, changed)).toBe('modified');
      expect(await beside(page, added)).toBe('added');
      expect(await beside(page, block(page, 'has not changed since'))).toBeNull();
      expect(await beside(page, block(page, 'The last paragraph'))).toBeNull();
      await expect(deletedMarks(page)).toHaveCount(1);
      // Not part of the document: nothing in ProseMirror's DOM changed for it.
      await expect(editor(page).locator('[data-testid="git-line"], [data-testid="git-deleted-mark"]')).toHaveCount(0);

      // The bars: in the tree's colours, changed solid and new dashed (3 on, 2
      // off, from the block's top), 2px wide, 8px from the text.
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
      const bar = (kind: string) => gutter(page).locator(`[data-git-mark="${kind}"]`).evaluate((element) => {
        const style = getComputedStyle(element, '::before');
        const box = element.getBoundingClientRect();
        const right = box.right - parseFloat(style.right);
        return {
          colour: style.backgroundColor, image: style.backgroundImage, width: parseFloat(style.width),
          left: right - parseFloat(style.width), right, top: box.top, bottom: box.bottom,
        };
      });
      const solid = await bar('modified');
      expect(solid.colour).toBe(tokens.changedColour);
      expect(solid.image).toBe('none');
      expect(solid.width).toBe(2);
      const dashed = await bar('added');
      expect(dashed.image).toContain('repeating-linear-gradient');
      expect(dashed.image).toContain(tokens.success);
      expect(dashed.image).toMatch(/ 0px, [^)]+\) 3px, rgba\(0, 0, 0, 0\) 3px, rgba\(0, 0, 0, 0\) 5px\)$/);
      expect(dashed.width).toBe(2);
      const changedBox = (await changed.boundingBox())!;
      expect(changedBox.x - solid.right).toBeCloseTo(8, 0);
      expect((await added.boundingBox())!.x - dashed.right).toBeCloseTo(8, 0);

      // Hover widens the bar to 4px away from the text: the 8px gap holds and nothing else moves.
      const textBefore = changedBox.x;
      await page.mouse.move(solid.right - 1, (solid.top + solid.bottom) / 2);
      await expect.poll(async () => (await bar('modified')).width).toBe(4);
      const hovered = await bar('modified');
      expect(hovered.right).toBeCloseTo(solid.right, 1);
      expect(hovered.left).toBeCloseTo(solid.left - 2, 1);
      expect((await changed.boundingBox())!.x).toBe(textBefore);
      await page.mouse.move(700, 650);
      await expect.poll(async () => (await bar('modified')).width).toBe(2);

      // The triangle: centred in the gap where the deleted block was, its point
      // on the bars' centre line, and at least 4px clear of the bar above it.
      await expect(deletedMarks(page)).toHaveCount(1);
      const triangle = await deletedMarks(page).evaluate((element) => {
        const style = getComputedStyle(element, '::before');
        const box = element.getBoundingClientRect();
        const left = box.left + parseFloat(style.left);
        const top = box.top + parseFloat(style.top);
        const height = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
        return { point: left + parseFloat(style.borderLeftWidth), top, bottom: top + height, width: parseFloat(style.borderLeftWidth), height };
      });
      expect(triangle).toMatchObject({ width: 6, height: 8 });
      const listBox = (await editor(page).locator('ul').boundingBox())!;
      const gapMiddle = (changedBox.y + changedBox.height + listBox.y) / 2;
      expect(Math.abs((triangle.top + triangle.bottom) / 2 - gapMiddle)).toBeLessThanOrEqual(1);
      expect(Math.abs(triangle.point - (solid.left + solid.right) / 2)).toBeLessThanOrEqual(0.5);
      expect(triangle.top - solid.bottom).toBeGreaterThanOrEqual(4);

      if (SHOTS) {
        await page.mouse.move(700, 650);
        await page.waitForTimeout(300);
        await capture(app, path.join(SHOTS, 'pr2-v2-light.png'));
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
        await capture(app, path.join(SHOTS, 'pr2-v2-light-popover.png'));
      }
      await page.keyboard.press('Escape');
      await expect(popover).toHaveCount(0);
      expect(await focusInEditor(page)).toBe(true);

      // A new block has no committed text, and says so.
      await pressGutter(page, added);
      await expect(popover.getByRole('heading')).toHaveText('New since the last commit');
      await expect(page.getByTestId('git-popover-text')).toHaveCount(0);
      await expect(page.getByTestId('git-popover-empty')).toHaveText('The last commit does not have this block.');
      await page.getByTestId('git-popover-close').click();
      await expect(popover).toHaveCount(0);

      // The deleted marker is a button: what was there.
      await deletedMarks(page).click();
      await expect(popover.getByRole('heading')).toHaveText('Deleted since the last commit');
      await expect(page.getByTestId('git-popover-text')).toHaveText('A third paragraph that has since been deleted.');
      // One structure for all three: a title over the same mono panel.
      const panel = (testId: string) => page.getByTestId(testId).evaluate((element) => ({
        tag: element.tagName, font: getComputedStyle(element).fontFamily, background: getComputedStyle(element).backgroundColor,
        afterTitle: element.previousElementSibling?.querySelector('h2') !== null,
      }));
      const deletedPanel = await panel('git-popover-text');
      expect(deletedPanel.tag).toBe('PRE');
      expect(deletedPanel.afterTitle).toBe(true);
      expect(deletedPanel.font).toMatch(/mono/i);
      if (SHOTS) {
        await settle(page);
        await capture(app, path.join(SHOTS, 'pr2-v2-deleted-popover.png'));
      }
      await page.keyboard.press('Escape');
      await expect(popover).toHaveCount(0);

      // A press on the text itself is typing, not the gutter.
      await changed.click();
      await expect(popover).toHaveCount(0);

      // The keyboard: the palette's command for the block holding the caret.
      await placeCaretAtEnd(page, changed);
      await page.keyboard.press(`${MOD}+KeyK`);
      await page.getByTestId('palette-input').fill('show block as committed');
      await page.keyboard.press('Enter');
      await expect(popover).toBeVisible();
      await expect(page.getByTestId('git-popover-text')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.getByTestId('git-popover-revert')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.getByTestId('git-popover-close')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.getByTestId('git-popover-text')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(popover).toHaveCount(0);
      expect(await focusInEditor(page)).toBe(true);

      // A block added above moves the lines down with their blocks.
      await placeCaretAtEnd(page, editor(page).locator('h1'));
      await page.keyboard.press('Enter');
      await page.keyboard.type('Inserted above.');
      await expect.poll(() => beside(page, changed)).toBe('modified');
      expect(await beside(page, added)).toBe('added');
      expect(await beside(page, block(page, 'Inserted above.'))).toBeNull();

      // Typing elsewhere moves nothing: the line stays on its block.
      await placeCaretAtEnd(page, block(page, 'has not changed since'));
      await page.keyboard.type(' Typed.');
      await expect(lines(page)).toHaveCount(2);
      expect(await beside(page, changed)).toBe('modified');
      // A save is what the gutter compares: the typed block is now changed.
      await page.getByTestId('save-button').click();
      await expect.poll(() => readFileSync(path.join(repo, 'note.md'), 'utf8')).toContain('Typed.');
      await expect.poll(() => beside(page, block(page, 'has not changed since')), { timeout: 15_000 }).toBe('modified');
      expect(await beside(page, block(page, 'Inserted above.'))).toBe('added');
      await expect(lines(page)).toHaveCount(4);

      // A commit made elsewhere clears it.
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'second');
      await expect(lines(page)).toHaveCount(0, { timeout: 15_000 });
      await expect(deletedMarks(page)).toHaveCount(0);
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
      await expect(lines(page)).toHaveCount(2, { timeout: 15_000 });
      await open(page, 'untracked.md');
      await expect(block(page, 'Never committed')).toBeVisible();
      await page.waitForTimeout(1_000);
      await expect(lines(page)).toHaveCount(0);
      await expect(deletedMarks(page)).toHaveCount(0);
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
      await expect(lines(page)).toHaveCount(0);
      await expect(deletedMarks(page)).toHaveCount(0);
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
      await expect.poll(() => beside(page, block(page, 'rewritten after the commit')), { timeout: 15_000 }).toBe('modified');
      if (SHOTS) {
        await page.mouse.move(700, 650);
        await page.waitForTimeout(300);
        await capture(app, path.join(SHOTS, 'pr2-v2-dark.png'));
        await pressGutter(page, block(page, 'rewritten after the commit'));
        await expect(page.getByTestId('git-popover')).toBeVisible();
        await expect(page.getByTestId('git-popover-text')).toBeFocused();
        await settle(page);
        await page.waitForTimeout(1_000);
        await capture(app, path.join(SHOTS, 'pr2-v2-dark-popover.png'));
      }
    } finally {
      await app.close();
    }
  });
});

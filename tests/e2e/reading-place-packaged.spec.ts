/**
 * A note keeps its place, and a launch puts you back where you were, in the
 * packaged app (daily-use audit, findings 7 and 9): switching to another note
 * and back finds the paragraph you were reading; quitting and launching again
 * reopens the last note at that paragraph; an open folder with no note in
 * front offers its index note and the notes opened lately instead of asking
 * for a folder.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable, placeCaretAtEnd } from './packaged-app';

const made: string[] = [];
test.afterAll(() => {
  for (const directory of made) rmSync(directory, { recursive: true, force: true });
});

function scratch(name: string): string {
  const directory = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), `noto-e2e-${name}-`)));
  made.push(directory);
  return directory;
}

const long = (title: string) => `# ${title}\n\n${Array.from({ length: 220 }, (_, index) => `${title} paragraph ${index + 1}.`).join('\n\n')}\n`;

function vault(): string {
  const root = scratch('place');
  mkdirSync(path.join(root, 'notes'));
  writeFileSync(path.join(root, 'notes', 'alpha.md'), long('Alpha'), 'utf8');
  writeFileSync(path.join(root, 'notes', 'beta.md'), long('Beta'), 'utf8');
  writeFileSync(path.join(root, 'README.md'), '# Readme\n\nStart here.\n', 'utf8');
  return root;
}

async function launch(userData: string, args: readonly string[]): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ executablePath: packagedExecutable(), args: [`--user-data-dir=${userData}`, ...args] });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 900 });
  return { app, page };
}

/** The text of the paragraph at the top of the page. */
const topParagraph = (page: Page) => page.evaluate(() => {
  const canvas = document.getElementById('document-canvas')!;
  const box = canvas.getBoundingClientRect();
  const slot = [...document.querySelectorAll<HTMLElement>('.canvas-slot')].find((element) => !element.hidden)!;
  const editor = slot.querySelector('.ProseMirror')!;
  const left = editor.getBoundingClientRect().left + 40;
  for (let y = box.top + 2; y < box.top + 200; y += 6) {
    const hit = document.elementFromPoint(left, y)?.closest('.ProseMirror > *');
    if (hit?.textContent) return hit.textContent;
  }
  return '';
});

/** Scroll the page until the given paragraph is at its top. */
const scrollTo = (page: Page, text: string) => page.evaluate((wanted) => {
  const canvas = document.getElementById('document-canvas')!;
  const slot = [...document.querySelectorAll<HTMLElement>('.canvas-slot')].find((element) => !element.hidden)!;
  const block = [...slot.querySelectorAll<HTMLElement>('.ProseMirror > *')].find((element) => element.textContent === wanted)!;
  canvas.scrollTop += block.getBoundingClientRect().top - canvas.getBoundingClientRect().top;
  canvas.dispatchEvent(new Event('scroll'));
}, text);

const openFromTree = async (page: Page, name: string) => {
  await page.locator(`[data-testid="tree-file"][data-path$="${name}"]`).click();
  await expect(page.locator('.canvas-slot:not([hidden]) .ProseMirror h1')).toHaveText(name.startsWith('alpha') ? 'Alpha' : 'Beta');
};

test('a note comes back to the front at the paragraph it was left at', async () => {
  const root = vault();
  const userData = scratch('user-data');
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({}));
  const { app, page } = await launch(userData, [`--folder=${root}`, `--open=${path.join(root, 'notes', 'alpha.md')}`]);
  try {
    await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
    await scrollTo(page, 'Alpha paragraph 120.');
    await expect.poll(() => topParagraph(page)).toBe('Alpha paragraph 120.');
    await page.waitForTimeout(100);

    await openFromTree(page, 'beta.md');
    await expect.poll(() => page.evaluate(() => document.getElementById('document-canvas')!.scrollTop)).toBe(0);

    await openFromTree(page, 'alpha.md');
    await expect.poll(() => topParagraph(page)).toBe('Alpha paragraph 120.');
  } finally {
    await app.close();
  }
});

test('a launch reopens the last note at its place', async () => {
  const root = vault();
  const userData = scratch('user-data');
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({}));
  const first = await launch(userData, [`--folder=${root}`, `--open=${path.join(root, 'notes', 'beta.md')}`]);
  try {
    await first.page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
    await scrollTo(first.page, 'Beta paragraph 150.');
    await expect.poll(() => topParagraph(first.page)).toBe('Beta paragraph 150.');
    // Past the store's one second of quiet, so the place is written before quitting.
    await first.page.waitForTimeout(1300);
  } finally {
    await first.app.close();
  }

  const second = await launch(userData, []);
  try {
    await expect(second.page.locator('.canvas-slot:not([hidden]) .ProseMirror h1')).toHaveText('Beta', { timeout: 30_000 });
    await expect.poll(() => topParagraph(second.page)).toBe('Beta paragraph 150.');
  } finally {
    await second.app.close();
  }
});

test('a note closed before quitting stays closed at the next launch', async () => {
  const root = vault();
  const userData = scratch('user-data');
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({}));
  const first = await launch(userData, [`--folder=${root}`, `--open=${path.join(root, 'notes', 'beta.md')}`]);
  try {
    await first.page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
    await first.app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('close-tab')!.click());
    await expect(first.page.getByTestId('empty-state')).toBeVisible();
  } finally {
    await first.app.close();
  }
  const second = await launch(userData, []);
  try {
    await expect(second.page.getByTestId('empty-state')).toBeVisible({ timeout: 30_000 });
    await expect(second.page.getByTestId('empty-recent')).toContainText('beta');
  } finally {
    await second.app.close();
  }
});

test("an open folder with no note in front offers its own notes", async () => {
  const root = vault();
  const userData = scratch('user-data');
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({}));
  const { app, page } = await launch(userData, [`--folder=${root}`]);
  try {
    const empty = page.getByTestId('empty-state');
    await expect(empty).toBeVisible({ timeout: 30_000 });
    await expect(empty.locator('h1')).toHaveText(path.basename(root));
    await expect(page.getByTestId('empty-new-note')).toBeVisible();
    await page.getByTestId('empty-index-note').click();
    await expect(page.locator('.canvas-slot:not([hidden]) .ProseMirror h1')).toHaveText('Readme');
  } finally {
    await app.close();
  }
});

test('Source Code Mode there and back keeps the paragraph where it was', async () => {
  const root = vault();
  const userData = scratch('user-data');
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({}));
  const { app, page } = await launch(userData, [`--folder=${root}`, `--open=${path.join(root, 'notes', 'alpha.md')}`]);
  try {
    await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
    await scrollTo(page, 'Alpha paragraph 100.');
    const target = page.locator('.canvas-slot:not([hidden]) .ProseMirror p', { hasText: /^Alpha paragraph 104\.$/ });
    await placeCaretAtEnd(page, target);
    const top = () => target.evaluate((element) => Math.round(element.getBoundingClientRect().top));
    const before = await top();
    const toggle = () => app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('source-code-mode')!.click());
    await toggle();
    await expect(page.locator('.canvas-slot:not([hidden]) .ProseMirror')).toBeHidden();
    await toggle();
    await expect(target).toBeVisible();
    await expect.poll(async () => Math.abs((await top()) - before)).toBeLessThan(40);
  } finally {
    await app.close();
  }
});

/**
 * A heading chosen from the outline is placed a tenth of the way down the
 * page, by smooth scroll, in the packaged app. It used to land wherever the
 * page could fit it (at the foot of a long note) and not move at all when it
 * was already on screen; the first heading, with no page above it, goes to
 * the very top.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

async function invokeMenu(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ Menu }, itemId) => {
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
}

const scrollTop = (page: Page) => page.evaluate(() => document.querySelector<HTMLElement>('.canvas-scroll')!.scrollTop);

/** Where the page would rest for the heading to sit 10% down, from the note's top. */
function restingSpot(page: Page, text: string, tag: string): Promise<number> {
  return page.evaluate(({ text, tag }) => {
    const scroller = document.querySelector<HTMLElement>('.canvas-scroll')!;
    const heading = [...document.querySelectorAll<HTMLElement>(`.ProseMirror ${tag}`)].find((h) => h.textContent === text)!;
    const top = heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    return Math.max(0, Math.round(top - scroller.clientHeight * 0.1));
  }, { text, tag });
}

test('a heading chosen from the outline rests a tenth of the way down the page', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'outline-jump');
  await rm(workspace, { recursive: true, force: true });
  const file = path.join(workspace, 'note.md');
  const sections = Array.from({ length: 10 }, (_, at) => [`## Section ${at + 1}`, '', ...Array.from({ length: 14 }, () => 'A line of prose long enough to fill a row of the page.')].join('\n'));
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  await writeFile(file, `# Title\n\nUnder the title.\n\n${sections.join('\n\n')}\n`, 'utf8');

  const app = await electron.launch({ executablePath: packagedExecutable(), args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${file}`] });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
    await invokeMenu(app, 'toggle-outline');
    await page.waitForSelector('[data-testid="outline-panel"]', { state: 'visible', timeout: 10_000 });

    const seventh = await restingSpot(page, 'Section 7', 'h2');
    expect(seventh).toBeGreaterThan(200);
    await page.locator('.outline-entry', { hasText: 'Section 7' }).click();
    await expect.poll(() => scrollTop(page), { timeout: 10_000 }).toBeLessThanOrEqual(seventh + 4);
    await expect.poll(() => scrollTop(page), { timeout: 10_000 }).toBeGreaterThanOrEqual(seventh - 4);
    // The caret followed: typing writes into that heading.
    await page.keyboard.type('!');
    const saved = await page.evaluate(() => document.querySelector('.canvas-slot:not([hidden]) .ProseMirror h2:nth-of-type(7)')?.textContent);
    expect(saved).toBe('!Section 7');

    // The first heading has no page above it to spare: it goes to the very top.
    await page.locator('.outline-entry', { hasText: 'Title' }).click();
    await expect.poll(() => scrollTop(page), { timeout: 10_000 }).toBe(0);
  } finally {
    await app.close();
  }
});

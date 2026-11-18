import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';
import { packagedExecutable, placeCaret } from './packaged-app';

/* A table of seventeen columns, each cell a sentence: what a research note's
   results table looks like. It must scroll sideways inside the page, keep its
   first column in view, and never make the page itself scroll sideways. */
const cell = '一个比较长的单元格，写了好几句话的内容，用来看列宽和换行';
const header = `| 姓名 | ${Array.from({ length: 16 }, (_, i) => `字段${i + 1}`).join(' | ')} |`;
const rule = `|${'---|'.repeat(17)}`;
const rows = Array.from({ length: 4 }, (_, r) => `| 人${r + 1} | ${Array.from({ length: 16 }, () => cell).join(' | ')} |`);
const SOURCE = ['# Wide', '', header, rule, ...rows, '', '| a | b |', '|---|---|', '| 1 | 2 |', '', 'After.', ''].join('\n');

test('a table wider than the page scrolls inside it, its first column kept', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'wide-table');
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const file = path.join(workspace, 'wide.md');
  await writeFile(file, SOURCE, 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${file}`],
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
    await page.setViewportSize({ width: 1280, height: 900 });
    const wide = page.locator('.noto-table-frame').first();
    const narrow = page.locator('.noto-table-frame').nth(1);
    await expect(wide).toHaveAttribute('data-wide', '');
    await expect(narrow).not.toHaveAttribute('data-wide', '');
    const scroller = wide.locator('.noto-table-scroll');
    const sizes = await scroller.evaluate((element) => ({
      room: element.scrollWidth - element.clientWidth,
      page: (document.querySelector('.workspace-layout') as HTMLElement).scrollWidth - (document.querySelector('.workspace-layout') as HTMLElement).clientWidth,
      tallest: Math.max(...[...element.querySelectorAll('tr')].map((row) => row.getBoundingClientRect().height)),
    }));
    expect(sizes.room).toBeGreaterThan(500);
    expect(sizes.page).toBe(0);
    // Columns are given a readable width, not squeezed to a few characters a line.
    expect(sizes.tallest).toBeLessThan(260);

    // A sideways wheel scrolls the table, and the first column stays where it was.
    const box = (await scroller.boundingBox())!;
    const firstBefore = (await wide.locator('td').first().boundingBox())!.x;
    await page.mouse.move(box.x + box.width / 2, box.y + 60);
    await page.mouse.wheel(400, 0);
    await expect.poll(() => scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(100);
    expect(Math.abs((await wide.locator('td').first().boundingBox())!.x - firstBefore)).toBeLessThan(1);

    // The caret going to the last column brings it into view.
    await scroller.evaluate((element) => { element.scrollLeft = 0; });
    await placeCaret(page, wide.locator('tr').first().locator('th, td').last());
    await expect.poll(() => scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(500);
  } finally {
    await app.close();
  }
});

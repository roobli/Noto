import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

/*
 * A click in a paragraph shows the source of the span it lands in and moves
 * nothing else. Highlight, super- and subscript and inline tags used to show
 * every delimiter in the paragraph as soon as the caret entered it, so the
 * words after each one stepped right by its width.
 */

/** Where a word starts on screen, read off its text node. */
const leftOf = (page: Page, word: string) => page.evaluate((target) => {
  const prose = document.querySelector('.canvas-slot:not([hidden]) .ProseMirror')!;
  const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.textContent!.indexOf(target);
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + 1);
    const box = range.getBoundingClientRect();
    return { x: box.left, y: box.top + box.height / 2 };
  }
  throw new Error(`no ${target}`);
}, word);

test('a click shows the source of the span it lands in, and moves nothing else', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'inline-source');
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const file = path.join(workspace, 'note.md');
  await writeFile(file, [
    '# Title', '',
    '中文开头 ==高亮== 然后 ^sup^ 和 <u>under</u> 还有 **bold** 最后 TAIL 结尾。', '',
    'Another paragraph.', '',
  ].join('\n'), 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${file}`],
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
    const live = page.locator('.ProseMirror .noto-source-live:visible');

    // Into the paragraph, on plain words: no delimiter appears, nothing moves.
    const before = await leftOf(page, 'TAIL');
    await page.mouse.click(before.x + 2, before.y);
    await expect(page.locator('.ProseMirror p').first()).toHaveClass(/noto-active-block/);
    await expect(live).toHaveCount(0);
    expect(Math.abs((await leftOf(page, 'TAIL')).x - before.x)).toBeLessThan(0.5);

    // Into the highlight: its two delimiters and nothing else.
    const mark = await leftOf(page, '亮');
    await page.mouse.click(mark.x + 2, mark.y);
    await expect(live).toHaveCount(2);
    await expect(live.first()).toHaveText('==');

    // Into the tag pair: the tags, and the highlight's delimiters go again.
    const under = await leftOf(page, 'nder');
    await page.mouse.click(under.x + 2, under.y);
    await expect(live).toHaveCount(2);
    await expect(page.locator('.ProseMirror .noto-typora-delim:visible')).toHaveCount(0);

    // Out to the next paragraph: the first one is back as it was.
    await page.locator('.ProseMirror p').nth(1).click();
    await expect(live).toHaveCount(0);
    expect(Math.abs((await leftOf(page, 'TAIL')).x - before.x)).toBeLessThan(0.5);
  } finally {
    await app.close();
  }
});

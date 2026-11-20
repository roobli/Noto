/**
 * A long code block whose lines wrap ends at its last line.
 *
 * With wrapped lines each line number is placed where its line starts. The
 * numbers were rounded line by line and never let shorter than a row, so a
 * row of a fractional height grew the column a little at every line, and in
 * a block of a few hundred lines the column stood rows taller than the code.
 * The block stretched to it, and blank rows the caret could not reach stood
 * under the last line.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

test('a long wrapped code block ends at its last line, its numbers in step', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'fence-gutter');
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const file = path.join(workspace, 'note.md');
  const lines = Array.from({ length: 360 }, (_, at) => (at % 9 === 0
    ? `line ${at}: ${'a long path segment that wraps across the block '.repeat(4)}`
    : `  "Key${at}": ${at},`));
  await writeFile(file, `# Log\n\n\`\`\`json\n${lines.join('\n')}\n}\n\`\`\`\n\nAfter.\n`, 'utf8');
  const app = await electron.launch({ executablePath: packagedExecutable(), args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${file}`] });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
    const fence = page.locator('pre.noto-fence').first();
    await expect(fence.locator('.noto-fence-gutter')).toHaveAttribute('data-wrapped', '');
    await expect.poll(() => fence.locator('.noto-fence-number').count()).toBe(361);
    const measured = await fence.evaluate((pre) => {
      const code = pre.querySelector('.noto-fence-code') as HTMLElement;
      const range = document.createRange();
      range.selectNodeContents(code);
      const rects = range.getClientRects();
      const style = getComputedStyle(code);
      const numbers = [...pre.querySelectorAll<HTMLElement>('.noto-fence-number')];
      return {
        gap: code.getBoundingClientRect().bottom - rects[rects.length - 1]!.bottom,
        padding: Number.parseFloat(style.paddingBottom),
        row: Number.parseFloat(style.lineHeight),
        // The last number stands on the last line, not rows above it.
        drift: Math.abs(numbers.at(-1)!.getBoundingClientRect().top - rects[rects.length - 1]!.top),
      };
    });
    // No blank row under the last line: what is there is the block's own padding.
    expect(measured.gap).toBeLessThan(measured.padding + measured.row / 2);
    expect(measured.drift).toBeLessThan(measured.row / 2);
  } finally {
    await app.close();
  }
});

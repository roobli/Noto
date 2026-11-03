import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

const resultRoot = path.join(process.cwd(), 'test-results', 'click-stays-put');

/**
 * A long note that opens on tall blocks: frontmatter of sixteen keys and a
 * fence of thirty lines, the way a working note does. The caret starts at the
 * top, so these are the blocks held fully painted from the moment the note
 * opens. Below them, paragraphs with a table every few.
 */
function longNote(): string {
  const parts: string[] = ['---', ...Array.from({ length: 16 }, (_, key) => `key${key}: value ${key}`), '---', ''];
  parts.push('# A long note', '');
  parts.push('```text', ...Array.from({ length: 30 }, (_, line) => `line ${line} of the opening fence`), '```', '');
  for (let index = 0; index < 60; index += 1) {
    parts.push(`Paragraph ${index}. ${'Words that wrap across the column of the page. '.repeat(4)}`, '');
    if (index % 6 === 5) {
      parts.push('| key | value |', '| --- | --- |', ...Array.from({ length: 20 }, (_, row) => `| k${row} | v${row} |`), '');
    }
  }
  return parts.join('\n');
}

async function launch(name: string): Promise<{ app: ElectronApplication; page: Page }> {
  const workspace = path.join(resultRoot, name);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const file = path.join(workspace, 'note.md');
  await writeFile(file, longNote(), 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${file}`],
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
  await page.setViewportSize({ width: 1100, height: 800 });
  return { app, page };
}

/** Bring a paragraph to the middle of the canvas, and say where it ends up. */
async function centre(page: Page, text: string): Promise<{ x: number; y: number }> {
  const paragraph = page.locator('.canvas-slot:not([hidden]) .ProseMirror > p').filter({ hasText: text }).first();
  await paragraph.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  const box = (await paragraph.boundingBox())!;
  return { x: box.x + 40, y: box.y + 8 };
}

test.describe('a click in the document', () => {
  test('leaves the page where it was when the caret first leaves the top of the note', async () => {
    const { app, page } = await launch('first-click');
    try {
      // Far down the note, with the blocks the caret opened among off screen.
      const target = await centre(page, 'Paragraph 40.');
      const before = await page.evaluate(() => {
        const pane = document.querySelector<HTMLElement>('.canvas-scroll')!;
        const prose = document.querySelector<HTMLElement>('.canvas-slot:not([hidden]) .ProseMirror')!;
        return { scroll: pane.scrollTop, height: prose.scrollHeight };
      });

      await page.mouse.click(target.x, target.y);
      await page.waitForTimeout(400);

      // Painted in full since the note opened, those blocks had never had a
      // height remembered for them. Let go by the caret, they fell back to a
      // one-line guess off screen and took everything below up with them, so
      // the paragraph just clicked jumped and the caret with it.
      const after = await page.evaluate((text) => {
        const pane = document.querySelector<HTMLElement>('.canvas-scroll')!;
        const prose = document.querySelector<HTMLElement>('.canvas-slot:not([hidden]) .ProseMirror')!;
        const paragraph = [...prose.querySelectorAll<HTMLElement>(':scope > p')].find((element) => element.textContent?.startsWith(text))!;
        return { scroll: pane.scrollTop, height: prose.scrollHeight, top: paragraph.getBoundingClientRect().top };
      }, 'Paragraph 40.');
      expect(after.scroll).toBe(before.scroll);
      expect(Math.abs(after.height - before.height)).toBeLessThan(2);
      expect(Math.abs(after.top + 8 - target.y)).toBeLessThan(2);
    } finally {
      await app.close();
    }
  });
});

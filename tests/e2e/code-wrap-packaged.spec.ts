/**
 * Long code lines wrap, each under its one number, and the setting turns
 * wrapping off again, in the packaged app. Code blocks only scrolled
 * sideways, where Typora wraps by default (Auto wrap long lines).
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

const made: string[] = [];
test.afterAll(() => {
  for (const directory of made) rmSync(directory, { recursive: true, force: true });
});

function scratch(name: string): string {
  const directory = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), `noto-e2e-${name}-`)));
  made.push(directory);
  return directory;
}

const LONG = `const message = "${'a long line that will not fit in the column '.repeat(6)}";`;

async function invokeMenu(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu()!.getMenuItemById(itemId)!.click(), id);
}

test('a long code line wraps under its one number, and View turns wrapping off', async () => {
  const root = scratch('code-wrap');
  writeFileSync(path.join(root, 'code.md'), `# Code\n\n\`\`\`js\nconst first = 1;\n${LONG}\nconst third = 3;\n\`\`\`\n`, 'utf8');
  const userData = scratch('user-data');
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({}));
  const app = await electron.launch({ executablePath: packagedExecutable(), args: [`--user-data-dir=${userData}`, `--open=${path.join(root, 'code.md')}`] });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
    const fence = page.locator('.canvas-slot:not([hidden]) .ProseMirror pre').first();
    const layout = () => fence.evaluate((pre) => {
      const code = pre.querySelector('code')!;
      const numbers = [...pre.querySelectorAll<HTMLElement>('.noto-fence-number')];
      const range = document.createRange();
      const text = code.textContent ?? '';
      const third = text.indexOf('const third');
      // The top of the third line, from the text node that holds it.
      const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
      let seen = 0;
      let top = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const length = node.textContent?.length ?? 0;
        if (seen + length > third) { range.setStart(node, third - seen); range.setEnd(node, third - seen + 1); top = range.getBoundingClientRect().top; break; }
        seen += length;
      }
      return {
        sideways: code.scrollWidth > code.clientWidth + 1,
        numbers: numbers.length,
        third: numbers[2] ? Math.round(numbers[2].getBoundingClientRect().top - top) : null,
      };
    });
    await expect.poll(async () => (await layout()).numbers).toBe(3);
    const wrapped = await layout();
    expect(wrapped.sideways).toBe(false);
    // The third number stands level with the third line, past the wrapped second.
    expect(Math.abs(wrapped.third ?? 99)).toBeLessThanOrEqual(3);

    await invokeMenu(app, 'toggle-code-wrap');
    await expect.poll(async () => (await layout()).sideways).toBe(true);
    await expect.poll(async () => (await layout()).numbers).toBe(0);
  } finally {
    await app.close();
  }
});

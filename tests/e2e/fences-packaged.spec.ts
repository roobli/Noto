import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable, placeCaret } from './packaged-app';

const resultRoot = path.join(process.cwd(), 'test-results', 'fences');

const TWELVE = Array.from({ length: 12 }, (_, index) => `const line${index + 1} = ${index + 1};`);

async function launch(name: string): Promise<{ app: ElectronApplication; page: Page }> {
  const workspace = path.join(resultRoot, name);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  const file = path.join(workspace, 'note.md');
  await writeFile(file, [
    '# Fences',
    '',
    '```ts',
    ...TWELVE,
    '```',
    '',
    'Between.',
    '',
    '```',
    'plain',
    'text',
    'here',
    '```',
    '',
  ].join('\n'), 'utf8');

  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${file}`],
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
  await page.setViewportSize({ width: 1280, height: 900 });
  return { app, page };
}

const gutterLines = (page: Page, index: number) => page.evaluate((at) => {
  const gutter = document.querySelectorAll('.ProseMirror pre .noto-fence-gutter')[at];
  return gutter ? gutter.textContent!.split('\n') : [];
}, index);

const digitsOf = (page: Page, index: number) => page.evaluate((at) => {
  const pre = document.querySelectorAll<HTMLElement>('.ProseMirror pre')[at];
  return pre?.style.getPropertyValue('--fence-digits') ?? '';
}, index);

/** Press a gutter number by line index (0-based), using the same metrics as the node view. */
async function pressGutterLine(page: Page, fenceIndex: number, lineIndex: number): Promise<void> {
  await page.evaluate(({ fenceIndex: at, lineIndex: line }) => {
    const gutter = document.querySelectorAll('.ProseMirror pre .noto-fence-gutter')[at] as HTMLElement | undefined;
    if (!gutter) throw new Error(`no gutter at fence ${at}`);
    const style = getComputedStyle(gutter);
    const lineHeight = Number.parseFloat(style.lineHeight) || 20;
    const paddingTop = Number.parseFloat(style.paddingTop) || 0;
    const rect = gutter.getBoundingClientRect();
    gutter.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + paddingTop + (line + 0.5) * lineHeight,
      button: 0,
    }));
  }, { fenceIndex, lineIndex });
}

test.describe('code fences', () => {
  test('number their lines, as wide as each block needs, and follow typing', async () => {
    const { app, page } = await launch('gutter');
    try {
      await expect.poll(() => gutterLines(page, 0)).toEqual(TWELVE.map((_, index) => String(index + 1)));
      await expect.poll(() => gutterLines(page, 1)).toEqual(['1', '2', '3']);
      await expect.poll(() => digitsOf(page, 0)).toBe('2');
      // Tools mount on hover (lazy chrome); reveal before reading the language field.
      await page.locator('.ProseMirror pre').first().hover();
      await expect(page.locator('.ProseMirror pre').first().locator('.noto-fence-lang')).toHaveValue('ts');
      await page.locator('.ProseMirror pre').nth(1).hover();
      await expect(page.locator('.ProseMirror pre').nth(1).locator('.noto-fence-lang')).toHaveValue('');

      // A new line in the block is a new number in the gutter, at once.
      const code = page.locator('.ProseMirror pre').nth(1).locator('code');
      await placeCaret(page, code);
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('more');
      await expect.poll(() => gutterLines(page, 1)).toEqual(['1', '2', '3', '4']);
      // And the gutter never enters the document.
      await expect(code).toContainText('more');
      await expect(code).not.toContainText('1\n2');
    } finally {
      await app.close();
    }
  });

  test('put the caret on the line whose number is pressed, and let it leave', async () => {
    const { app, page } = await launch('caret');
    try {
      const fence = page.locator('.ProseMirror pre').nth(1);
      // Second number → caret on "text"; typing there must not touch the lines around it.
      await pressGutterLine(page, 1, 1);
      await page.keyboard.type('> ');
      await expect(fence.locator('code')).toHaveText('plain\n> text\nhere');

      // The gutter is not a place the caret can be: up from the first line is
      // the paragraph above, as it would be without a gutter at all.
      await pressGutterLine(page, 1, 0);
      await page.keyboard.press('ArrowUp');
      await page.keyboard.type('!');
      // Wherever along the word the caret landed, it landed in the paragraph.
      await expect(page.locator('.ProseMirror p', { hasText: '!' })).toHaveText(/^[Between.]*![Between.]*$/);
      await expect(fence.locator('code')).toHaveText('plain\n> text\nhere');
    } finally {
      await app.close();
    }
  });

  test('copy the code, and only the code', async () => {
    const { app, page } = await launch('copy');
    try {
      await app.evaluate(({ clipboard }) => clipboard.writeText('untouched'));
      const first = page.locator('.ProseMirror pre').first();
      await first.hover();
      await first.locator('.noto-fence-copy').click();
      await expect(first.locator('.noto-fence-copy')).toHaveText('Copied');
      // Read back with the platform's own line endings folded away: Windows
      // puts CRLF on the clipboard, which is right for pasting into anything
      // else there and is not what this test is about.
      await expect
        .poll(async () => (await app.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, '\n'))
        .toBe(TWELVE.join('\n'));
      // The button says so briefly, then goes back to being a button.
      await expect(first.locator('.noto-fence-copy')).toHaveText('Copy', { timeout: 5_000 });
    } finally {
      await app.close();
    }
  });

  test('hide the numbers when the setting says so, without a restart', async () => {
    const { app, page } = await launch('setting');
    try {
      const gutter = page.locator('.ProseMirror pre').first().locator('.noto-fence-gutter');
      await expect(gutter).toBeVisible();
      const write = (codeLineNumbers: boolean) => page.evaluate(async (value) => {
        const result = await (window as unknown as {
          notoSettings: { write(request: unknown): Promise<{ ok: boolean }> };
        }).notoSettings.write({ version: 1, requestId: `e2e-lines-${value}`, patch: { codeLineNumbers: value } });
        return result.ok;
      }, codeLineNumbers);
      expect(await write(false)).toBe(true);
      await expect(gutter).toBeHidden();
      expect(await write(true)).toBe(true);
      await expect(gutter).toBeVisible();
    } finally {
      await app.close();
    }
  });
});

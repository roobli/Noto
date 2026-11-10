import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable, placeCaret } from './packaged-app';

const resultRoot = path.join(process.cwd(), 'test-results', 'paste');

async function launch(name: string, body = '# Paste\n\nBefore.\n\nAfter.\n'): Promise<{ app: ElectronApplication; page: Page; file: string }> {
  const workspace = path.join(resultRoot, name);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const file = path.join(workspace, 'note.md');
  await writeFile(file, body, 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${file}`],
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
  await page.setViewportSize({ width: 1100, height: 800 });
  return { app, page, file };
}

/** Paste a clipboard fragment where the caret is. */
async function paste(page: Page, html: string, text: string): Promise<void> {
  await page.evaluate(({ html: markup, text: plain }) => {
    const data = new DataTransfer();
    data.setData('text/html', markup);
    data.setData('text/plain', plain);
    document.querySelector('.ProseMirror')!
      .dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, { html, text });
  await page.waitForTimeout(300);
}

test.describe('pasting', () => {
  test('turns a web page fragment into the markdown it means', async () => {
    const { app, page, file } = await launch('html');
    try {
      // On a new line of its own. A fragment pasted into the middle of a
      // sentence merges with it, which is what every editor does; what is
      // being checked here is that the blocks survive when there is room for
      // them.
      const last = page.locator('.ProseMirror > p').last();
      await placeCaret(page, last);
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
      await page.keyboard.press('Enter');
      await paste(
        page,
        '<h3>A heading</h3><p>A <strong>bold</strong> word and a <a href="https://example.com">link</a>.</p><ul><li>one</li><li>two</li></ul>',
        'A heading',
      );

      // The heading keeps the level it had, rather than becoming a title.
      await expect(page.locator('.ProseMirror h3')).toHaveText('A heading');
      await expect(page.locator('.ProseMirror strong')).toHaveText('bold');
      await expect(page.locator('.ProseMirror a')).toHaveText('link');
      await expect(page.locator('.ProseMirror > ul > li')).toHaveCount(2);

      // And it is markdown in the file, not a wall of HTML.
      await page.getByTestId('save-button').click();
      await expect.poll(async () => readFile(file, 'utf8')).toContain('### A heading');
      const saved = await readFile(file, 'utf8');
      expect(saved).toContain('A **bold** word and a [link](https://example.com).');
      expect(saved).toContain('- one\n- two');
      expect(saved).not.toContain('<h3>');
    } finally {
      await app.close();
    }
  });

  test('drops the markup when the paste is plain text', async () => {
    const { app, page } = await launch('plain');
    try {
      const last = page.locator('.ProseMirror > p').last();
      await placeCaret(page, last);
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
      await paste(page, '', ' and some plain text');
      await expect(last).toHaveText('After. and some plain text');
      await expect(page.locator('.ProseMirror strong')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});

test.describe('what copying puts on the clipboard', () => {
  test('is the markdown, so a bold word stays bold somewhere else', async () => {
    const { app, page } = await launch('copy-markdown', 'Some **bold** words here.\n');
    try {
      // Select the whole paragraph and copy it.
      await page.locator('.ProseMirror > p').first().click({ clickCount: 3 });
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+c');

      const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
      expect(copied).toBe('Some **bold** words here.');
    } finally {
      await app.close();
    }
  });

  test('tidies a ChatGPT answer as it is pasted, says so, and gives the plain text on request', async () => {
    const { app, page } = await launch('tidy');
    try {
      const last = page.locator('.ProseMirror > p').last();
      await placeCaret(page, last);
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
      await page.keyboard.press('Enter');
      const html = '<p>Run this:</p>'
        + '<pre class="overflow-visible"><div class="contain-inline-size"><div class="flex">bash</div>'
        + '<div class="sticky"><button><svg><path d="M0"/></svg>Copy code</button></div></div>'
        + '<div class="overflow-y-auto"><code class="whitespace-pre! language-bash"><span class="hljs-built_in">ls</span> -la\n</code></div></pre>'
        + '<table><thead><tr><th>Item</th><th>Notes</th></tr></thead><tbody>'
        + '<tr><td>A</td><td><p>first line</p><p>second line</p></td></tr></tbody></table>';
      await paste(page, html, 'Run this:\nbash\nCopy code\nls -la\nItem Notes\nA first line second line');

      // The code and its language, no button text; the table whole, its cell on one line.
      await expect(page.locator('.ProseMirror pre')).toHaveCount(1);
      await expect(page.locator('.ProseMirror pre')).toHaveAttribute('data-lang', 'bash');
      await expect(page.locator('.ProseMirror')).not.toContainText('Copy code');
      await expect(page.locator('.ProseMirror td').nth(1)).toHaveText('first line second line');

      // Told what was changed, with the plain text a click away.
      await expect(page.getByTestId('status-notice')).toHaveText(
        'Pasted and tidied: took out "Copy code"; joined the lines of a table cell.');
      await page.getByTestId('status-notice-action').click();
      await expect(page.locator('.ProseMirror pre')).toHaveCount(0);
      await expect(page.locator('.ProseMirror table')).toHaveCount(0);
      await expect(page.locator('.ProseMirror')).toContainText('Copy code');
    } finally {
      await app.close();
    }
  });
});

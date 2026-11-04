import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

/*
 * Copying a selection inside one block puts on the clipboard what was
 * selected and nothing around it: ten words out of a table cell used to leave
 * as a one-cell table with a header rule, part of a list item as a list item,
 * and the command inside backticks with its backticks.
 */
const NOTE = [
  '# Copy',
  '',
  '| 问题 | 处理 |',
  '| --- | --- |',
  '| 账号被封、换厂商、换区域；系统盘没有快照 | 重建 |',
  '',
  '- 第一项里有一段比较长的文字用来复制',
  '- 第二项',
  '',
  'Run `kubectl get pods -A` now, and **bold words** here.',
  '',
  '```sh',
  'echo one',
  'echo two',
  '```',
  '',
].join('\n');

/** Select `length` characters from `from` within the text of the first element matching `selector` that contains `needle`. */
async function select(page: Page, selector: string, needle: string, from: number, length: number): Promise<void> {
  await page.evaluate(({ selector, needle, from, length }) => {
    const element = [...document.querySelectorAll(selector)].find((node) => node.textContent?.includes(needle));
    if (!element) throw new Error(`nothing matching ${selector} holds ${needle}`);
    const start = element.textContent!.indexOf(needle) + from;
    const end = start + length;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let seen = 0;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const size = node.textContent!.length;
      if (seen <= start && start <= seen + size) range.setStart(node, start - seen);
      if (seen <= end && end <= seen + size) { range.setEnd(node, end - seen); break; }
      seen += size;
    }
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }, { selector, needle, from, length });
  // The editor reads the selection on selectionchange; two frames let it land.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** Copy as the menu does, and read back both flavours the editor put on the clipboard. */
async function copy(app: ElectronApplication, page: Page): Promise<{ text: string; html: string }> {
  await page.evaluate(() => {
    const holder = window as unknown as { __html: string };
    holder.__html = '';
    document.addEventListener('copy', (event) => {
      const data = event.clipboardData!;
      const set = data.setData.bind(data);
      data.setData = (type: string, value: string) => { if (type === 'text/html') holder.__html = value; set(type, value); };
    }, { capture: true, once: true });
  });
  await app.evaluate(({ clipboard }) => clipboard.clear());
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.copy());
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).not.toBe('');
  return {
    text: (await app.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, '\n'),
    html: await page.evaluate(() => (window as unknown as { __html: string }).__html),
  };
}

test('copy a selection inside one block as what was selected', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'copy');
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const file = path.join(workspace, 'note.md');
  await writeFile(file, NOTE, 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${file}`],
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('.ProseMirror table', { timeout: 30_000 });
    await page.locator('.ProseMirror h1').click();

    await select(page, '.ProseMirror td', '账号被封', 0, 10);
    const cell = await copy(app, page);
    expect(cell.text).toBe('账号被封、换厂商、换');
    expect(cell.html).not.toContain('<table');

    await select(page, '.ProseMirror li', '第一项', 2, 8);
    expect((await copy(app, page)).text).toBe('项里有一段比较长');

    await select(page, '.ProseMirror code', 'kubectl', 0, 16);
    expect((await copy(app, page)).text).toBe('kubectl get pods');

    // Held whole with more beside them, the code and the bold keep their markdown.
    await select(page, '.ProseMirror p', 'kubectl', 0, 'kubectl get pods -A now, and bold words'.length);
    expect((await copy(app, page)).text).toBe('`kubectl get pods -A` now, and **bold words**');

    await select(page, '.ProseMirror pre', 'echo one', 0, 13);
    expect((await copy(app, page)).text).toBe('echo one\necho');
  } finally {
    await app.close();
  }
});

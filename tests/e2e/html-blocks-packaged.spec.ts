import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

const NOTE = [
  '# Blocks',
  '',
  '<table>',
  '  <tr><th colspan="2" align="center">Merged</th></tr>',
  '  <tr><td>1</td><td>2</td></tr>',
  '</table>',
  '',
  '<details>',
  '  <summary>Fold me</summary>',
  '  <p>Hidden until asked.</p>',
  '</details>',
  '',
  '<div align="center"><span style="color: #a85d3b; position: fixed">Centred and red</span></div>',
  '',
  '<p onclick="steal()" class="pref-dialog">Handlers go</p>',
  '',
  '<script>globalThis.__ran = true;</script>',
  '',
  'After.',
  '',
].join('\n');

async function invokeMenu(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ Menu }, wanted) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | null => {
      for (const item of items) {
        if (item.id === wanted) return item;
        const nested = item.submenu ? find(item.submenu.items) : null;
        if (nested) return nested;
      }
      return null;
    };
    const target = find(Menu.getApplicationMenu()!.items);
    if (!target) throw new Error(`no menu item ${wanted}`);
    target.click();
  }, id);
}

test('a note draws its own HTML, and nothing in it can act', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'html-blocks');
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const vault = path.join(workspace, 'vault');
  await mkdir(vault, { recursive: true });
  const file = path.join(vault, 'note.md');
  await writeFile(file, NOTE, 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, vault],
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
    await page.getByTestId('tree-file').first().click();
    const editor = page.locator('.canvas-slot:not([hidden]) .ProseMirror');
    await editor.waitFor({ state: 'visible' });

    // The table is a table, with its merged header.
    const table = editor.locator('.noto-html-drawn table');
    await expect(table).toHaveCount(1);
    await expect(table.locator('th')).toHaveAttribute('colspan', '2');
    await expect(table.locator('td')).toHaveText(['1', '2']);

    // The details folds, and opens on a click without moving the caret.
    const details = editor.locator('.noto-html-drawn details');
    await expect(details.locator('p')).toBeHidden();
    await details.locator('summary').click();
    await expect(details.locator('p')).toBeVisible();

    // The style that was safe survived; the one that was not did not.
    const span = editor.locator('.noto-html-drawn span').filter({ hasText: 'Centred and red' });
    await expect(span).toHaveCSS('color', 'rgb(168, 93, 59)');
    await expect(span).toHaveCSS('position', 'static');

    // The handler and the borrowed class are gone, and the script never ran.
    const marked = editor.locator('.noto-html-drawn p').filter({ hasText: 'Handlers go' });
    await expect(marked).toHaveCount(1);
    expect(await marked.evaluate((node) => node.outerHTML)).toBe('<p>Handlers go</p>');
    expect(await page.evaluate(() => (globalThis as { __ran?: boolean }).__ran ?? false)).toBe(false);
    await expect(editor.locator('.noto-html-drawn script')).toHaveCount(0);

    // The caret in a block brings its source back, and the file is untouched.
    await editor.locator('.noto-html-drawn table').click();
    await expect(editor.locator('.noto-html-block.noto-html-editing')).toHaveCount(1);
    await expect(editor.locator('.noto-html-block.noto-html-editing')).toContainText('<table>');
    await invokeMenu(app, 'save');
    await expect.poll(() => readFile(file, 'utf8')).toBe(NOTE);
  } finally {
    await app.close();
  }
});

test('a picture in a note\u2019s HTML is not fetched while web images are off', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'html-blocks-remote');
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const vault = path.join(workspace, 'vault');
  await mkdir(vault, { recursive: true });
  const note = (name: string) => `# Web\n\n<div align="center"><img src="https://example.invalid/${name}.png" alt="web"></div>\n\nAfter.\n`;
  await writeFile(path.join(vault, 'a-off.md'), note('off'), 'utf8');
  await writeFile(path.join(vault, 'b-on.md'), note('on'), 'utf8');
  // Web images start off, so the note's first drawing is with them off.
  await writeFile(path.join(workspace, 'user-data', 'settings.json'), JSON.stringify({ remoteImages: false }), 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, vault],
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
    const asked: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('example.invalid')) asked.push(request.url());
    });
    const write = (remoteImages: boolean) => page.evaluate(async (value) => {
      const result = await (window as unknown as {
        notoSettings: { write(request: unknown): Promise<{ ok: boolean }> };
      }).notoSettings.write({ version: 1, requestId: `e2e-html-remote-${value}`, patch: { remoteImages: value } });
      return result.ok;
    }, remoteImages);

    // The block is cleaned before its address is judged; the cleaning must
    // not ask for the picture on its own.
    await page.getByTestId('tree-file').first().click();
    const editor = page.locator('.canvas-slot:not([hidden]) .ProseMirror');
    await expect(editor.locator('.noto-html-drawn div[align="center"]')).toHaveCount(1);
    await expect(editor.locator('.noto-html-drawn img[alt="web"]')).not.toHaveAttribute('src', /./);
    await page.waitForTimeout(1_000);
    expect(asked).toEqual([]);

    // With web images on, the same picture in another note is asked for,
    // which shows the listener above would have heard a request. The note
    // already open is drawn again under the new setting, as its markdown
    // pictures are, so its picture is asked for now and not before.
    expect(await write(true)).toBe(true);
    await page.getByTestId('tree-file').nth(1).click();
    await expect.poll(() => asked, { timeout: 10_000 }).toContain('https://example.invalid/on.png');
    await expect.poll(() => asked, { timeout: 10_000 }).toContain('https://example.invalid/off.png');

    // Switched off again, the open note's drawn picture gives up its address.
    expect(await write(false)).toBe(true);
    await expect(editor.locator('.noto-html-drawn img[alt="web"]')).not.toHaveAttribute('src', /./);
  } finally {
    await app.close();
  }
});

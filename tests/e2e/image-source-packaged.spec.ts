import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

/** A flat grey PNG of the given size, built by hand so no fixture file is needed. */
function pngOf(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(typed));
    return Buffer.concat([length, typed, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2; header[10] = 0; header[11] = 0; header[12] = 0;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x99)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

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

test('a picture beside the caret opens its source, which is edited in place', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'image-source');
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const vault = path.join(workspace, 'vault');
  await mkdir(vault, { recursive: true });
  const file = path.join(vault, 'note.md');
  await writeFile(path.join(vault, 'pic.png'), pngOf(400, 100));
  await writeFile(path.join(vault, 'other.png'), pngOf(200, 100));
  await writeFile(file, '# Pictures\n\nBefore ![pic](pic.png) after.\n\nLast.\n', 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, vault],
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
    await page.getByTestId('tree-file').filter({ hasText: 'note.md' }).click();
    const editor = page.locator('.canvas-slot:not([hidden]) .ProseMirror');
    const img = editor.locator('img.noto-image');
    await expect.poll(() => img.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(400);
    const field = editor.locator('[data-testid="image-source"]');
    await expect(field).toHaveCount(0);

    // The caret walks to the picture from the words after it: its source opens over it.
    const after = editor.locator('p').nth(0);
    await after.click({ position: { x: 4, y: 8 } });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
    for (let i = 0; i < ' after.'.length; i += 1) await page.keyboard.press('ArrowLeft');
    await expect(field).toHaveValue('![pic](pic.png)');
    await expect(img).toBeVisible();
    // Moving on past it closes it again, and nothing in the note changed.
    await page.keyboard.press('ArrowRight');
    await expect(field).toHaveCount(0);
    await expect(page.getByTestId('file-state')).not.toHaveText('Unsaved changes');

    // Back, and one more step left goes into the source, at its end.
    await page.keyboard.press('ArrowLeft');
    await expect(field).toHaveValue('![pic](pic.png)');
    await page.keyboard.press('ArrowLeft');
    await expect(field).toBeFocused();
    await page.keyboard.press('Backspace');
    for (let i = 0; i < 'pic.png'.length; i += 1) await page.keyboard.press('Backspace');
    await page.keyboard.type('other.png)');
    await page.keyboard.press('Enter');
    await expect.poll(() => img.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(200);
    await invokeMenu(app, 'save');
    await expect.poll(() => readFile(file, 'utf8')).toBe('# Pictures\n\nBefore ![pic](other.png) after.\n\nLast.\n');

    // Escape puts the source back as it was. The caret is after the picture: one step left goes in.
    await page.keyboard.press('ArrowLeft');
    await expect(field).toBeFocused();
    await page.keyboard.type('junk');
    await page.keyboard.press('Escape');
    await expect(field).toHaveCount(0);
    await expect(page.getByTestId('file-state')).not.toHaveText('Unsaved changes');

    // A right click on the picture offers its zooms; one chosen writes the tag, as Typora does.
    // The native menu cannot be pressed from a test, so main's two halves are driven as a right
    // click drives them: ask the window what it offers at the point, then send the line chosen.
    const box = (await img.boundingBox())!;
    const offered = await app.evaluate(async ({ BrowserWindow, ipcMain }, point) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      const requestId = `context:test-${Date.now()}`;
      return await new Promise<{ title: string; command: string }[]>((resolve) => {
        const listener = (_event: unknown, value: { requestId: string; items: { title: string; command: string }[] }) => {
          if (value.requestId !== requestId) return;
          ipcMain.removeListener('noto:v1:workspace:context-items-reply', listener);
          resolve(value.items);
        };
        ipcMain.on('noto:v1:workspace:context-items-reply', listener);
        window.webContents.send('noto:v1:workspace:context-items', { version: 1, requestId, x: point.x, y: point.y });
      });
    }, { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) });
    expect(offered.map((item) => item.title).slice(0, 6)).toEqual(['Zoom Picture 33%', 'Zoom Picture 50%', 'Zoom Picture 67%', '\u2713 Zoom Picture 100%', 'Zoom Picture 150%', 'Zoom Picture 200%']);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.webContents.send('noto:v1:workspace:context-command', { version: 1, command: 'noto.image-zoom-50' });
    });
    await expect.poll(() => img.evaluate((node) => (node as HTMLElement).style.zoom)).toBe('0.5');
    await invokeMenu(app, 'save');
    await expect.poll(() => readFile(file, 'utf8')).toBe('# Pictures\n\nBefore <img src="other.png" alt="pic" style="zoom:50%;" /> after.\n\nLast.\n');

    // And the tag's source opens beside the caret as the markdown image's did.
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
    for (let i = 0; i < ' after.'.length; i += 1) await page.keyboard.press('ArrowLeft');
    await expect(field).toHaveValue('<img src="other.png" alt="pic" style="zoom:50%;" />');
  } finally {
    await app.close();
  }
});


import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

const resultRoot = path.join(process.cwd(), 'test-results', 'export');

const NOTE = [
  '# 季度复盘',
  '',
  'A paragraph with **bold** and `code` in it.',
  '',
  '| 指标 | 说明 |',
  '| --- | --- |',
  '| DAU | 日活跃 |',
  '',
  '- one',
  '- two',
  '',
  '```js',
  'const answer = 1;',
  '```',
  '',
  'Inline maths $E = mc^2$ and a block:',
  '',
  '$$',
  '\\int_0^1 x^2 dx',
  '$$',
  '',
  '```mermaid',
  'graph LR',
  '  A --> B',
  '```',
  '',
].join('\n');

async function launch(name: string): Promise<{
  app: ElectronApplication; page: Page; out: string;
}> {
  const workspace = path.join(resultRoot, name);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const vault = path.join(workspace, 'vault');
  await mkdir(vault, { recursive: true });
  // A real picture, referenced the way the editor writes one: relative to the
  // note, in a folder beside it.
  await mkdir(path.join(vault, 'assets'), { recursive: true });
  await writeFile(path.join(vault, 'assets', 'dot.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'));
  await writeFile(path.join(vault, 'note.md'), `${NOTE}\n![a dot](./assets/dot.png)\n`, 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, vault],
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
  await page.getByTestId('tree-file').first().click();
  await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
  await page.waitForTimeout(600);
  return { app, page, out: path.join(workspace, 'out') };
}

/**
 * Answer the save dialog without opening one, then use the real menu item.
 *
 * A native dialog holds the input loop and no automated pointer can reach one,
 * so it is replaced for the length of the call. Everything after it is the code
 * under test, reached the way a person reaches it: through the menu, so the
 * renderer serializes the document exactly as it does in the app rather than
 * the test doing it a second and slightly different way.
 */
async function exportTo(
  app: ElectronApplication,
  target: string,
  destination: string,
): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    (dialog as unknown as { showSaveDialog: unknown }).showSaveDialog =
      async () => ({ canceled: false, filePath });
  }, destination);
  await app.evaluate(({ Menu }, itemId) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | null => {
      for (const item of items) {
        if (item.id === itemId) return item;
        const nested = item.submenu ? find(item.submenu.items) : null;
        if (nested) return nested;
      }
      return null;
    };
    const menu = Menu.getApplicationMenu();
    const found = menu ? find(menu.items) : null;
    if (!found) throw new Error(`No menu item with id ${itemId}`);
    found.click();
  }, `export-${target}`);
}

/** The exported file, once it appears. */
const written = (file: string) => expect.poll(
  async () => readFile(file, 'utf8').catch(() => null),
  { timeout: 20_000 },
);

test.describe('export', () => {
  test('writes a standalone HTML page with the styles in it', async () => {
    const { app, page, out } = await launch('html');
    try {
      // Mermaid draws asynchronously in its frame; export lifts that SVG, so
      // the drawing has to be there before the menu item is pressed.
      await expect(page.locator('.noto-diagram[data-state="rendered"]')).toBeVisible({ timeout: 20_000 });
      await mkdir(out, { recursive: true });
      const destination = path.join(out, 'note.html');
      await exportTo(app, 'html', destination);
      await written(destination).not.toBeNull();

      const html = await readFile(destination, 'utf8');
      expect(html).toMatch(/^<!doctype html>/);
      expect(html).toContain('<title>note</title>');
      // Standalone: the styles travel with it.
      expect(html).toContain('<style>');
      // And the document itself came through, table and all.
      expect(html).toContain('季度复盘');
      expect(html).toContain('<table');
      expect(html).toContain('日活跃');
      // The picture travels inside the file too. Its address in the note is
      // relative, which is right in the note and wrong in a file saved
      // anywhere else, so an exported page that only worked next to its own
      // note would not be one you could send to anybody.
      expect(html).toContain('src="data:image/png;base64,');
      expect(html).not.toContain('./assets/dot.png');

      // Maths arrives as maths. The schema knows only the TeX source, so
      // exporting from it gave a page of backslashes; this comes from what
      // KaTeX drew, reduced to the MathML the browser draws for itself.
      expect(html).toContain('<math');
      // The TeX survives only inside MathML's own annotation, which is where it
      // belongs: it makes the formula copyable and recoverable without being
      // drawn. What must not survive is the source as visible text.
      const outsideAnnotation = html.replace(/<annotation[^>]*>[\s\S]*?<\/annotation>/g, '');
      expect(outsideAnnotation).not.toContain('\\int_0^1');
      expect(html).toContain('<annotation');
      // And KaTeX's own spans are gone, or the formula would arrive twice over
      // with no stylesheet to hide either half.
      expect(html).not.toContain('katex-html');

      // Code arrives coloured, because Prism had already done it.
      expect(html).toContain('token keyword');
      expect(html).toContain('answer');

      // A mermaid fence arrives as the SVG the frame had drawn, not as an
      // empty iframe. cloneNode does not carry an iframe's document.
      expect(html).toContain('<svg');
      expect(html).not.toContain('noto-diagram-frame');
      expect(html).not.toContain('<iframe');

      // None of the editing furniture comes with it.
      expect(html).not.toContain('noto-fence-gutter');
      expect(html).not.toContain('noto-fence-copy');
      expect(html).not.toContain('contenteditable');
    } finally {
      await app.close();
    }
  });

  test('writes the markup alone when the styles are not wanted', async () => {
    const { app, page, out } = await launch('html-plain');
    try {
      await mkdir(out, { recursive: true });
      const destination = path.join(out, 'plain.html');
      await exportTo(app, 'html-plain', destination);
      await written(destination).not.toBeNull();
      const html = await readFile(destination, 'utf8');
      expect(html).not.toContain('<style>');
      expect(html).toContain('季度复盘');
    } finally {
      await app.close();
    }
  });

  test('prints a PDF, in a window nobody sees', async () => {
    const { app, page, out } = await launch('pdf');
    try {
      await mkdir(out, { recursive: true });
      const destination = path.join(out, 'note.pdf');
      await exportTo(app, 'pdf', destination);
      await expect.poll(async () => stat(destination).then((s) => s.size).catch(() => 0),
        { timeout: 20_000 }).toBeGreaterThan(2_000);

      const bytes = await readFile(destination);
      // A PDF says so in its first five bytes, and a page of this note is not
      // an empty one.
      expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    } finally {
      await app.close();
    }
  });

  test('refuses a Pandoc format while the note has unsaved changes', async () => {
    const { app, page, out } = await launch('unsaved');
    try {
      await mkdir(out, { recursive: true });
      const refused = await page.evaluate(async () => {
        const result = await window.notoWorkspace.exportRendered({
          version: 1,
          requestId: 'export:dirty',
          target: 'docx',
          html: null,
          title: 'note',
          dirty: true,
        });
        return result.ok ? result.value : { transport: result.error.message };
      });
      // It converts the file, not the screen, so exporting now would produce a
      // document of the last saved version.
      expect(refused).toMatchObject({ exported: false, reason: 'unsaved' });
    } finally {
      await app.close();
    }
  });

  test('says Pandoc is needed for a format it cannot render itself', async () => {
    const { app, page, out } = await launch('no-pandoc');
    try {
      await mkdir(out, { recursive: true });
      // Pandoc is not installed on this machine, which is what happens to
      // anybody who has not installed it either.
      await exportTo(app, 'docx', path.join(out, 'note.docx'));
      await expect(page.getByTestId('file-truth-alert')).toContainText('Pandoc', { timeout: 20_000 });
      await expect.poll(async () => readFile(path.join(out, 'note.docx')).catch(() => null))
        .toBeNull();
    } finally {
      await app.close();
    }
  });
});

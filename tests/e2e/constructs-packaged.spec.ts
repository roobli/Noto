import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable, placeCaret } from './packaged-app';

/**
 * The constructs the product promises are editable rather than read-only source
 * islands: frontmatter, footnotes and raw HTML.
 *
 * Tables, task lists, math and code fences are covered elsewhere. These three
 * had unit coverage of the markdown pipeline but nothing proving they can be
 * edited in the running application, which is the part the promise is about.
 */

const resultRoot = path.join(process.cwd(), 'test-results', 'constructs');

const SOURCE = [
  '---',
  'title: Survey notes',
  'status: draft',
  '---',
  '',
  '# Survey',
  '',
  'A claim that needs support.[^source]',
  '',
  '[^source]: Hodgson and Reeve, 1998, page 44.',
  '',
  '<div class="callout">',
  '  Raw HTML kept as written.',
  '</div>',
  '',
  'A closing paragraph.',
  '',
].join('\n');

/** Put the caret at the start of `target` via the selection itself.
 *
 * Home / Meta+ArrowLeft does not always reach a packaged macOS window (it can
 * scroll or race after click — see block-edges-packaged). These fidelity tests
 * care that the edit lands at the head of the closing paragraph, not how the
 * caret got there.
 */
async function caretAtStart(page: Page, target: import('@playwright/test').Locator): Promise<void> {
  await placeCaret(page, target);
  await target.evaluate((node) => {
    const text = node.firstChild;
    if (!text) throw new Error('no text to put the caret in');
    const range = document.createRange();
    range.setStart(text, 0);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

async function launch(name: string): Promise<{ app: ElectronApplication; page: Page; file: string }> {
  const workspace = path.join(resultRoot, name);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const file = path.join(workspace, 'notes.md');
  await writeFile(file, SOURCE, 'utf8');

  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${file}`],
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
  await page.setViewportSize({ width: 1280, height: 900 });
  return { app, page, file };
}

test.describe('constructs stay editable', () => {
  test('renders frontmatter, a footnote and raw HTML as real content', async () => {
    const { app, page } = await launch('render');
    try {
      // Each is a node in the document, not an opaque block of source text.
      await expect(page.locator('.noto-frontmatter')).toHaveCount(1);
      await expect(page.locator('.noto-frontmatter')).toContainText('title: Survey notes');

      await expect(page.locator('.noto-footnote-reference')).toHaveCount(1);
      await expect(page.locator('.noto-footnote-definition')).toHaveCount(1);
      await expect(page.locator('.noto-footnote-definition')).toContainText('Hodgson and Reeve');

      await expect(page.locator('.noto-html-block')).toHaveCount(1);
      await expect(page.locator('.noto-html-block')).toContainText('Raw HTML kept as written');
    } finally {
      await app.close();
    }
  });

  test('edits frontmatter in place and leaves the rest of the file untouched', async () => {
    const { app, page, file } = await launch('frontmatter');
    try {
      // Click at the end of the last frontmatter line and add another key.
      // Not a document-end shortcut, which would leave the block entirely.
      await placeCaret(page, page.getByText('status: draft'));
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
      await page.keyboard.type('\nreviewed: yes');

      await page.getByTestId('save-button').click();
      await expect(page.getByTestId('file-state')).toHaveText('Saved', { timeout: 15_000 });

      const saved = await readFile(file, 'utf8');
      expect(saved).toContain('reviewed: yes');
      // Everything below the frontmatter is byte for byte as it was.
      expect(saved).toContain('[^source]: Hodgson and Reeve, 1998, page 44.');
      expect(saved).toContain('<div class="callout">');
      expect(saved.endsWith('A closing paragraph.\n')).toBe(true);
    } finally {
      await app.close();
    }
  });

  test('edits a footnote definition in place', async () => {
    const { app, page, file } = await launch('footnote');
    try {
      await placeCaret(page, page.locator('.noto-footnote-definition'));
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
      await page.keyboard.type(' Reprinted 2004.');

      await page.getByTestId('save-button').click();
      await expect(page.getByTestId('file-state')).toHaveText('Saved', { timeout: 15_000 });

      const saved = await readFile(file, 'utf8');
      expect(saved).toContain('page 44. Reprinted 2004.');
      // The frontmatter and the HTML block were not touched.
      expect(saved).toContain('---\ntitle: Survey notes\nstatus: draft\n---');
      expect(saved).toContain('  Raw HTML kept as written.');
    } finally {
      await app.close();
    }
  });

  test('edits raw HTML as text without executing it', async () => {
    const { app, page, file } = await launch('html');
    try {
      const html = page.locator('.noto-html-block');
      // The markup is shown as source. If it were being rendered there would be
      // a real element with that class inside the editor instead.
      await expect(page.locator('.ProseMirror div.callout')).toHaveCount(0);

      await placeCaret(page, html);
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
      await page.keyboard.type(' edited');

      await page.getByTestId('save-button').click();
      await expect(page.getByTestId('file-state')).toHaveText('Saved', { timeout: 15_000 });

      const saved = await readFile(file, 'utf8');
      expect(saved).toContain('edited');
      expect(saved).toContain('---\ntitle: Survey notes');
    } finally {
      await app.close();
    }
  });

  test('saves an untouched document byte for byte', async () => {
    const { app, page, file } = await launch('fidelity');
    try {
      // One edit somewhere unrelated, so there is something to save.
      await caretAtStart(page, page.locator('.ProseMirror p').last());
      await page.keyboard.type('Yes. ');

      await page.getByTestId('save-button').click();
      await expect(page.getByTestId('file-state')).toHaveText('Saved', { timeout: 15_000 });

      // Frontmatter, footnote and HTML all survive exactly, including the
      // two-space indent inside the HTML block.
      expect(await readFile(file, 'utf8'))
        .toBe(SOURCE.replace('A closing paragraph.', 'Yes. A closing paragraph.'));
    } finally {
      await app.close();
    }
  });
});

/**
 * Save a copy.
 *
 * Named in the product requirements and previously untested. It writes a second
 * file without changing which document is open, which is the part worth
 * pinning: a "save as" that silently rebinds the editor to the new path would
 * leave the original stale without saying so.
 */
test.describe('save a copy', () => {
  test('writes a second file and keeps editing the original', async () => {
    const { app, page, file } = await launch('save-copy');
    const destination = path.join(path.dirname(file), 'copy.md');
    try {
      await caretAtStart(page, page.locator('.ProseMirror p').last());
      await page.keyboard.type('Copied. ');

      // The dialog cannot be driven from a test, so it is answered directly.
      await app.evaluate(({ dialog }, target) => {
        (dialog as unknown as { showSaveDialog: unknown }).showSaveDialog =
          async () => ({ canceled: false, filePath: target });
      }, destination);

      await app.evaluate(({ Menu }) => {
        const find = (items: Electron.MenuItem[]): Electron.MenuItem | null => {
          for (const item of items) {
            if (item.id === 'save-as') return item;
            const nested = item.submenu ? find(item.submenu.items) : null;
            if (nested) return nested;
          }
          return null;
        };
        const target = find(Menu.getApplicationMenu()!.items);
        if (!target) throw new Error('no save-as menu item');
        target.click();
      });

      // The copy holds the edit.
      await expect
        .poll(async () => readFile(destination, 'utf8').catch(() => ''), { timeout: 15_000 })
        .toContain('Copied. A closing paragraph.');

      // The original is untouched on disk, because a copy is not a save, and
      // the document is still reported as having unsaved changes. Reporting it
      // saved would be the dangerous answer: the edit would look safe while the
      // file the user is editing had never received it.
      expect(await readFile(file, 'utf8')).toBe(SOURCE);
      await expect(page.getByTestId('file-state')).toHaveText('Unsaved changes');
      await expect(page.getByTestId('save-button')).toBeEnabled();
      // And the editor is still on the original document.
      await expect(page.getByTestId('noto-editor')).toBeVisible();
    } finally {
      await app.close();
    }
  });
});

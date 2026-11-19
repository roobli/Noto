import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable, placeCaret } from './packaged-app';

const resultRoot = path.join(process.cwd(), 'test-results', 'math');


const SOURCE = [
  '# Formulas',
  '',
  'Inline $E = mc^2$ in a sentence.',
  '',
  '$$',
  '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}',
  '$$',
  '',
  'Closing paragraph.',
  '',
].join('\n');

async function launch(name: string, source = SOURCE): Promise<{
  app: ElectronApplication; page: Page; file: string;
}> {
  const workspace = path.join(resultRoot, name);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const file = path.join(workspace, 'math.md');
  await writeFile(file, source, 'utf8');

  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${file}`],
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
  await page.setViewportSize({ width: 1280, height: 900 });
  return { app, page, file };
}

test.describe('math', () => {
  test('renders formulas instead of showing LaTeX source', async () => {
    const { app, page } = await launch('render');
    try {
      // KaTeX output, not the raw source.
      await expect(page.locator('.noto-math-block .katex')).toHaveCount(1);
      await expect(page.locator('.noto-math-inline .katex')).toHaveCount(1);

      const block = page.locator('.noto-math-block .noto-math-render');
      await expect(block).toHaveAttribute('data-state', 'rendered');
      // The visual layer shows symbols, not backslash commands. KaTeX also
      // emits a MathML annotation holding the original TeX, which is why this
      // looks at the rendered HTML rather than the whole subtree.
      const visual = page.locator('.noto-math-block .katex-html');
      await expect(visual).toContainText('∑');
      await expect(visual).not.toContainText('\\sum');
    } finally {
      await app.close();
    }
  });

  test('reveals the source when the caret enters, and is editable there', async () => {
    const { app, page, file } = await launch('edit');
    try {
      const block = page.locator('.noto-math-block');
      await expect(block).not.toHaveClass(/noto-math-editing/);

      // Clicking the rendered formula puts the caret in its source.
      await page.locator('.noto-math-block .noto-math-render').click();
      await expect(block).toHaveClass(/noto-math-editing/);
      await expect(page.locator('.noto-math-block .noto-math-source')).toBeVisible();

      // It is ordinary editable text, not a widget.
      await page.keyboard.type(' + 0');
      await page.getByTestId('save-button').click();
      await expect(page.getByTestId('file-state')).toHaveText('Saved', { timeout: 15_000 });

      const saved = await readFile(file, 'utf8');
      expect(saved).toContain('\\frac{n(n+1)}{2} + 0');
      // Every other block is untouched, byte for byte.
      expect(saved).toContain('Inline $E = mc^2$ in a sentence.');
      expect(saved).toContain('Closing paragraph.');
    } finally {
      await app.close();
    }
  });

  test('re-renders after the caret leaves', async () => {
    const { app, page } = await launch('rerender');
    try {
      await page.locator('.noto-math-block .noto-math-render').click();
      await expect(page.locator('.noto-math-block')).toHaveClass(/noto-math-editing/);

      // Move the caret into ordinary prose.
      await placeCaret(page, page.locator('.ProseMirror p').last());
      await expect(page.locator('.noto-math-block')).not.toHaveClass(/noto-math-editing/);
      await expect(page.locator('.noto-math-block .katex')).toHaveCount(1);
    } finally {
      await app.close();
    }
  });

  test('reports a formula it cannot render without breaking the document', async () => {
    const source = '# Broken\n\n$$\n\\frac{1\n$$\n\nStill here.\n';
    const { app, page } = await launch('invalid', source);
    try {
      const render = page.locator('.noto-math-block .noto-math-render');
      await expect(render).toHaveAttribute('data-state', 'error');
      // The rest of the document still renders.
      await expect(page.locator('.ProseMirror')).toContainText('Still here.');
    } finally {
      await app.close();
    }
  });

  test('shows a formula being edited as its whole source, delimiters and all, with the formula live under it', async () => {
    const { app, page } = await launch('unit');
    try {
      // Inline: the caret in it shows `$E = mc^2$`, both dollars, and the typeset formula floating below.
      // Pressed at the middle of the typeset formula, where a reader presses. (Playwright's own
      // click refuses on Linux, where the line box of the text around it overlaps the formula's.)
      const at = (await page.locator('.noto-math-inline .noto-math-render .katex').boundingBox())!;
      await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
      const inline = page.locator('.noto-math-inline');
      await expect(inline).toHaveClass(/noto-math-editing/);
      const edit = inline.locator('.noto-math-edit');
      await expect(edit).toBeVisible();
      await expect(edit).toHaveText('$E = mc^2$');
      const preview = inline.locator('.noto-math-render');
      await expect(preview).toBeVisible();
      await expect(preview.locator('.katex')).toHaveCount(1);
      // A card above the formula (below only near the top of the page), never over the line under it.
      const [source, pop] = await Promise.all([edit.boundingBox(), preview.boundingBox()]);
      const above = pop!.y + pop!.height <= source!.y + 1;
      const below = pop!.y >= source!.y + source!.height - 1;
      expect(above || below).toBe(true);
      // A press on the card stays on the formula being edited.
      await preview.click({ force: true });
      await expect(inline).toHaveClass(/noto-math-editing/);
      // Typing redraws the preview. The click put the caret in the source near where it landed,
      // and typing goes there. (Not End: on Windows and Linux it leaves for the end of the line.)
      await page.keyboard.type('+1');
      await expect(preview.locator('.katex-html')).toContainText('+1');

      // A block: `$$`, the TeX, `$$`, and the formula centred under it.
      await page.locator('.noto-math-block .noto-math-render').click();
      const block = page.locator('.noto-math-block');
      await expect(block).toHaveClass(/noto-math-editing/);
      const lines = await block.locator('.noto-math-edit').evaluate((node) => (node as HTMLElement).innerText.split('\n'));
      expect(lines[0]).toBe('$$');
      expect(lines[lines.length - 1]).toBe('$$');
      await expect(block.locator('.noto-math-render .katex')).toBeVisible();
      // The inline formula the caret left is typeset again, and nothing drawn reached the file.
      await expect(inline).not.toHaveClass(/noto-math-editing/);
      // Collapsed to nothing while at rest (kept in the layout for the caret).
      expect(await inline.locator('.noto-math-edit').evaluate((node) => node.getBoundingClientRect().width)).toBeLessThanOrEqual(1);
    } finally {
      await app.close();
    }
  });

  test('types a dollar into a formula, steps out at the closing dollar, and leaves a price a price', async () => {
    const { app, page, file } = await launch('pair', '# Pair\n\nStart\n');
    try {
      await placeCaret(page, page.locator('.ProseMirror p').last());
      await page.keyboard.press('End');
      // `$` opens an empty formula, its preview saying so.
      await page.keyboard.type(' $');
      const math = page.locator('.ProseMirror p .noto-math-inline');
      await expect(math).toHaveCount(1);
      await expect(math.first()).toHaveClass(/noto-math-editing/);
      await expect(math.first().locator('.noto-math-render')).toHaveAttribute('data-state', 'empty');
      // TeX goes in; `$` at the end steps past the closing dollar.
      await page.keyboard.type('t \\cap (t-1)');
      await page.keyboard.type('$');
      await page.keyboard.type(' and US$5 or $8,000.');
      // Two prices stayed prices: still one formula, and it is typeset.
      await expect(math).toHaveCount(1);
      await expect(math).not.toHaveClass(/noto-math-editing/);
      await expect(math.locator('.katex-html')).toContainText('∩');
      await page.getByTestId('save-button').click();
      await expect(page.getByTestId('file-state')).toHaveText('Saved', { timeout: 15_000 });
      // Written as typed: the prices stay plain dollars, which no reader takes for maths.
      expect(await readFile(file, 'utf8')).toBe('# Pair\n\nStart $t \\cap (t-1)$ and US$5 or $8,000.\n');

      // An empty formula: Backspace takes both dollars, and one the caret leaves is gone too.
      // (The save button took the keys; the caret goes back to the end of the line.)
      await placeCaret(page, page.locator('.ProseMirror p').last());
      await page.keyboard.press('End');
      await page.keyboard.type(' $');
      await expect(math).toHaveCount(2);
      await page.keyboard.press('Backspace');
      await expect(math).toHaveCount(1);
      await page.keyboard.type('$');
      await expect(math).toHaveCount(2);
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      await expect(math).toHaveCount(1);
    } finally {
      await app.close();
    }
  });

  test('makes a block from `$$` and Enter, previews it live, and leaves it with Command-Enter or Down', async () => {
    const { app, page, file } = await launch('block', '# Block\n\nBefore\n');
    try {
      await placeCaret(page, page.locator('.ProseMirror p').last());
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('$$');
      await page.keyboard.press('Enter');
      const block = page.locator('.noto-math-block');
      await expect(block).toHaveCount(1);
      await expect(block).toHaveClass(/noto-math-editing/);
      await expect(block.locator('.noto-math-render')).toHaveAttribute('data-state', 'empty');
      await page.keyboard.type('a^2 + b^2 = c^2');
      await expect(block.locator('.noto-math-render .katex-html')).toContainText('=');
      // Command-Enter: out to a new paragraph after it.
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
      await expect(block).not.toHaveClass(/noto-math-editing/);
      await page.keyboard.type('After');
      // Back in, and Down from its last line goes to that paragraph, not a new one.
      await block.locator('.noto-math-render').click();
      await expect(block).toHaveClass(/noto-math-editing/);
      await page.keyboard.press('ArrowDown');
      await expect(block).not.toHaveClass(/noto-math-editing/);
      await page.keyboard.type('!');
      await page.getByTestId('save-button').click();
      await expect(page.getByTestId('file-state')).toHaveText('Saved', { timeout: 15_000 });
      expect(await readFile(file, 'utf8')).toBe('# Block\n\nBefore\n\n$$\na^2 + b^2 = c^2\n$$\n\n!After\n');
    } finally {
      await app.close();
    }
  });

  test('saves an untouched document byte for byte', async () => {
    const { app, page, file } = await launch('fidelity');
    try {
      // Make one unrelated edit so there is something to save.
      await placeCaret(page, page.locator('.ProseMirror p').last());
      await page.keyboard.type('!');
      await page.getByTestId('save-button').click();
      await expect(page.getByTestId('file-state')).toHaveText('Saved', { timeout: 15_000 });

      // The math blocks were never entered, so they are exactly as written,
      // including the fence style and line breaks.
      expect(await readFile(file, 'utf8'))
        .toBe(SOURCE.replace('Closing paragraph.', 'Closing paragraph.!'));
    } finally {
      await app.close();
    }
  });
});

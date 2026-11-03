import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable, placeCaret } from './packaged-app';

const resultRoot = path.join(process.cwd(), 'test-results', 'diagrams');

const SOURCE = [
  '# Diagrams',
  '',
  'Before.',
  '',
  '```mermaid',
  'graph TD',
  '  A[Start] --> B[End]',
  '```',
  '',
  'After.',
  '',
].join('\n');

async function launch(name: string, markdown: string): Promise<{ app: ElectronApplication; page: Page; file: string }> {
  const workspace = path.join(resultRoot, name);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const file = path.join(workspace, 'note.md');
  await writeFile(file, markdown, 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${file}`],
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
  await page.setViewportSize({ width: 1280, height: 800 });
  return { app, page, file };
}

test.describe('diagrams', () => {
  test('draws Typora\'s flow and sequence fences, with their source out of sight', async () => {
    const { app, page } = await launch('typora-dialects', [
      '# Typora diagrams',
      '',
      '```flow',
      'st=>start: Start',
      'cond=>condition: Ready?',
      'e=>end: Done',
      'st->cond',
      'cond(yes)->e',
      'cond(no)->st',
      '```',
      '',
      '```sequence',
      'Title: Asking',
      'Alice->Bob: How are you?',
      'Note right of Bob: thinks',
      'Bob-->>Alice: Fine',
      '```',
      '',
    ].join('\n'));
    try {
      for (const lang of ['flow', 'sequence']) {
        const fence = page.locator(`pre.noto-fence[data-lang="${lang}"]`);
        await expect(fence.locator('.noto-diagram')).toHaveAttribute('data-state', 'rendered', { timeout: 20_000 });
        await expect.poll(async () => fence.locator('iframe').evaluate((element) => element.getBoundingClientRect().height))
          .toBeGreaterThan(80);
        const hidden = await fence.locator('.noto-fence-code').evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width <= 1 && rect.height <= 1;
        });
        expect(hidden, lang).toBe(true);
      }
    } finally {
      await app.close();
    }
  });

  test('draws a mermaid fence, keeps the source out of sight, and gives it back to a press', async () => {
    const { app, page, file } = await launch('draw', SOURCE);
    try {
      const fence = page.locator('pre.noto-fence[data-lang="mermaid"]');
      const diagram = fence.locator('.noto-diagram');
      await expect(diagram).toHaveAttribute('data-state', 'rendered', { timeout: 20_000 });
      const frame = diagram.locator('iframe');
      // The frame's height is animated, so it is polled rather than read once:
      // a single read right after the drawing lands can catch the transition
      // halfway and see a height the diagram never actually had.
      await expect.poll(async () => frame.evaluate((element) => element.getBoundingClientRect().height))
        .toBeGreaterThan(80);
      const drawn = await frame.evaluate((element) => element.getBoundingClientRect().height);

      // The caret is in the heading, so only the drawing shows: the source is
      // in the page but not in sight, and the fence has no box.
      const hidden = await fence.locator('.noto-fence-code').evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width <= 1 && rect.height <= 1;
      });
      expect(hidden).toBe(true);
      await expect(fence).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');

      // A press on the drawing puts the caret in the source, which comes back.
      // Through the helper, which waits for the selection to settle before
      // any key is sent; a key sent sooner is lost to the editor's own sync.
      await placeCaret(page, diagram);
      await expect(fence).toHaveClass(/noto-active-block/);
      const shown = await fence.locator('.noto-fence-code').evaluate((element) => element.getBoundingClientRect().height);
      expect(shown).toBeGreaterThan(20);

      // A change redraws, taller. The caret goes to the end of the last line by
      // a press there: an arrow key sent right after the click that entered the
      // fence is lost to the editor's own selection sync.
      const code = fence.locator('.noto-fence-code');
      // The caret goes to the end of the source through the selection itself.
      // Clicking at the corner of the box lands wherever the last line
      // happens to end, which differs with the font the platform has, and
      // typing from the wrong place makes a diagram that cannot be drawn: the
      // failure then reads as a drawing that collapsed rather than as a caret
      // that missed.
      await placeCaret(page, code);
      const host = page.locator('.canvas-slot:not([hidden]) [data-testid="noto-editor"]');
      const entered = await host.getAttribute('data-caret');
      // The end of the last line of code, found as the last text there rather
      // than as the end of the element: the element's own end maps back to the
      // head of the fence, and typing from there writes the new lines in front
      // of `graph TD`, which is a diagram nothing can draw.
      await code.evaluate((element) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let last: Node | null = null;
        while (walker.nextNode()) last = walker.currentNode;
        const range = document.createRange();
        if (last) range.setStart(last, last.nodeValue?.length ?? 0);
        else range.selectNodeContents(element);
        range.collapse(true);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      });
      await expect(host).not.toHaveAttribute('data-caret', entered ?? '');
      await page.keyboard.type('\n  B --> C[Then]\n  C --> D[Last]');
      await expect(diagram).toHaveAttribute('data-state', 'rendered');
      await expect.poll(async () => frame.evaluate((element) => element.getBoundingClientRect().height), { timeout: 10_000 })
        .toBeGreaterThan(drawn + 40);

      // The file holds the source and nothing of the drawing.
      await page.getByTestId('save-button').click();
      await expect.poll(async () => readFile(file, 'utf8')).toContain('  B --> C[Then]\n  C --> D[Last]\n```');
      expect(await readFile(file, 'utf8')).not.toContain('svg');
    } finally {
      await app.close();
    }
  });

  test('says when a diagram cannot be drawn, without touching the source', async () => {
    const broken = SOURCE.replace('graph TD\n  A[Start] --> B[End]', 'graph TD\n  A[Start] --> ');
    const { app, page } = await launch('broken', broken);
    try {
      const diagram = page.locator('pre.noto-fence[data-lang="mermaid"] .noto-diagram');
      await expect(diagram).toHaveAttribute('data-state', 'failed', { timeout: 20_000 });
      await expect(diagram.locator('.noto-diagram-status')).toContainText('could not be drawn');
      await expect(page.locator('pre.noto-fence[data-lang="mermaid"] .noto-fence-code')).toHaveText('graph TD\n  A[Start] --> ');
    } finally {
      await app.close();
    }
  });
});

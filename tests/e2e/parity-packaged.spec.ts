import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable, placeCaret } from './packaged-app';

const resultRoot = path.join(process.cwd(), 'test-results', 'parity');

const LONG_NAME = '2026_09_01_一个长得放不进任何侧边栏的文件名_platform加注册ref参数与is-deleted-records过滤.md';

/**
 * A vault shaped like the author's: a note with a fence, an alert and a
 * quote, a file with a name no rail is wide enough for, and a folder deep
 * enough to scroll.
 */
async function launch(name: string): Promise<{ app: ElectronApplication; page: Page; vault: string; note: string }> {
  const workspace = path.join(resultRoot, name);
  await rm(workspace, { recursive: true, force: true });
  const vault = path.join(workspace, 'vault');
  const deep = path.join(vault, 'projects', 'data');
  await mkdir(deep, { recursive: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  await writeFile(path.join(deep, LONG_NAME), '# Long\n', 'utf8');
  for (let index = 1; index <= 50; index += 1) {
    await writeFile(path.join(deep, `log-${String(index).padStart(2, '0')}.md`), `# ${index}\n`, 'utf8');
  }
  const note = path.join(deep, 'note.md');
  await writeFile(note, [
    '# Parity',
    '',
    'A paragraph to align against.',
    '',
    '```',
    'const untyped = 1;',
    '```',
    '',
    '> [!NOTE]',
    '> Something worth knowing.',
    '',
    '> [!WARNING]',
    '>',
    '> Two paragraphs, the marker on its own line.',
    '',
    '> An ordinary quote.',
    '',
    'Mark ==key point== here, x^2^ and H~2~O.',
    '',
    'Press <kbd>Ctrl</kbd> for CO<sub>2</sub> first<br>second.',
    '',
    '```haskell',
    'main = putStrLn "hi"',
    '```',
    '',
  ].join('\n'), 'utf8');

  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, vault, note],
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
  // Sized before the tree is awaited: under a tiling window manager a new
  // window can open at the 720px floor, where the rail is hidden.
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
  return { app, page, vault, note };
}

test.describe('parity with Typora', () => {
  test('every block starts where the text starts', async () => {
    const { app, page } = await launch('align');
    try {
      const left = await page.evaluate(() => {
        const root = document.querySelector('.ProseMirror')!;
        const at = (selector: string) => Math.round(root.querySelector(selector)!.getBoundingClientRect().left);
        // The paragraph's first glyph, read from a range, since the block
        // box of a paragraph is the column and its text is what the eye
        // aligns.
        const paragraph = root.querySelector('p')!;
        const range = document.createRange();
        range.setStart(paragraph.firstChild!, 0);
        range.setEnd(paragraph.firstChild!, 1);
        return {
          text: Math.round(range.getBoundingClientRect().left),
          fence: at('pre'),
          alert: at('.noto-alert'),
          quote: at('blockquote:not(.noto-alert)'),
        };
      });
      expect(left.fence).toBe(left.text);
      expect(left.alert).toBe(left.text);
      expect(left.quote).toBe(left.text);
    } finally {
      await app.close();
    }
  });

  test('draws GitHub alerts as callouts and reveals the marker to the caret', async () => {
    const { app, page } = await launch('alerts');
    try {
      const note = page.locator('.noto-alert-note');
      await expect(note).toHaveCount(1);
      await expect(note.locator('.noto-alert-title')).toHaveText('Note');
      await expect(note.locator('.noto-alert-marker')).toBeHidden();
      await expect(note).toContainText('Something worth knowing.');
      await expect(page.locator('.noto-alert-warning .noto-alert-title')).toHaveText('Warning');
      await expect(page.locator('blockquote:not(.noto-alert)')).toHaveCount(1);

      // Caret in: the syntax is back, and the title steps aside.
      await placeCaret(page, note.locator('p').last());
      await expect(note).toHaveClass(/noto-alert-editing/);
      await expect(note.locator('.noto-alert-marker')).toBeVisible();
      await expect(note.locator('.noto-alert-marker')).toHaveText('[!NOTE]');
      await expect(note.locator('.noto-alert-title')).toBeHidden();
    } finally {
      await app.close();
    }
  });

  test('takes a language for a fence and writes it to the file', async () => {
    const { app, page, note } = await launch('language');
    try {
      const fence = page.locator('.ProseMirror pre').first();
      await expect(fence).not.toHaveAttribute('data-lang');
      await fence.hover();
      const field = fence.locator('.noto-fence-lang');
      await expect(field).toHaveAttribute('placeholder', 'language');
      await field.click();
      await field.fill('ts');
      await page.keyboard.press('Enter');
      await expect(fence).toHaveAttribute('data-lang', 'ts');
      await expect(fence.locator('.token.keyword').first()).toBeVisible();

      await page.getByTestId('save-button').click();
      await expect(page.getByTestId('file-state')).toHaveText('Saved', { timeout: 15_000 });
      expect(await readFile(note, 'utf8')).toContain('```ts\nconst untyped = 1;\n```');
    } finally {
      await app.close();
    }
  });

  test('scrolls the rail sideways to a long name rather than cutting it', async () => {
    const { app, page } = await launch('rail');
    try {
      // The note opened from the shell is in this folder, so the tree is already open to it.
      const long = page.getByTestId('tree-file').filter({ hasText: '一个长得放不进' });
      await expect(long).toBeVisible();
      const rail = await page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>('.rail-view')!;
        const name = [...document.querySelectorAll<HTMLElement>('.tree-name')]
          .find((element) => element.textContent?.includes('一个长得放不进'))!;
        const row = name.closest<HTMLElement>('.tree-row')!;
        return {
          scrollable: scroller.scrollWidth > scroller.clientWidth,
          textOverflow: getComputedStyle(name).textOverflow,
          nameOverflow: getComputedStyle(name).overflow,
          rowOverflow: getComputedStyle(row).overflow,
          // The row grows to hold the whole name; nothing clips it.
          fits: name.getBoundingClientRect().right <= row.getBoundingClientRect().right + 0.5,
          paddingTop: getComputedStyle(scroller).paddingTop,
        };
      });
      expect(rail.scrollable).toBe(true);
      expect(rail.textOverflow).not.toBe('ellipsis');
      expect(rail.nameOverflow).toBe('visible');
      expect(rail.rowOverflow).toBe('visible');
      expect(rail.fits).toBe(true);
      expect(rail.paddingTop).toBe('0px');
    } finally {
      await app.close();
    }
  });

  test('stacks the path flush against the top and lights the branch', async () => {
    const { app, page } = await launch('stack');
    try {
      // The note opened from the shell is deep in the tree. Nothing is clicked:
      // the tree opens to the current file on its own, as Typora's does.
      const projects = page.getByTestId('tree-directory').filter({ hasText: 'projects' });
      await expect(projects).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByTestId('tree-directory').filter({ hasText: 'data' })).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByTestId('tree-file').filter({ hasText: 'note.md' })).toBeVisible();
      await expect(page.locator('.tree-node-active')).toHaveCount(1);

      const drawn = await page.evaluate(() => {
        const levels = [...document.querySelectorAll<HTMLElement>('.tree-level')];
        const stops = levels.map((level) => level.style.getPropertyValue('--path-stop')).filter(Boolean);
        const arms = [...document.querySelectorAll<HTMLElement>('.tree-level:not(.is-root) > .tree-node')]
          .map((node) => ({ node, colour: getComputedStyle(node, '::before').borderBottomColor }));
        const active = arms.find(({ node }) => node.classList.contains('tree-node-active'))?.colour ?? null;
        const plain = arms.find(({ node }) => !node.classList.contains('tree-node-active')
          && !node.querySelector(':scope > .tree-on-path'))?.colour ?? null;
        return { stops, active, plain };
      });
      // Three levels on the way down, each lit to the child that leads on, and
      // the arm to the file itself lit too: the author's V2 scheme, in the
      // muted colour the tree-guides plugin uses rather than the raw accent.
      expect(drawn.stops.length).toBe(3);
      expect(drawn.active).not.toBeNull();
      expect(drawn.active).not.toBe(drawn.plain);

      // Scroll into the logs: the stack sits flush at the top of the scrollport.
      await page.getByTestId('tree-file').filter({ hasText: 'log-50' }).scrollIntoViewIfNeeded();
      await expect(projects).toHaveAttribute('data-stuck');
      const flush = await page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>('.rail-view')!;
        const rows = [...document.querySelectorAll<HTMLElement>('[data-stuck]')]
          .map((row) => row.getBoundingClientRect());
        const top = scroller.getBoundingClientRect().top;
        rows.sort((a, b) => a.top - b.top);
        const gaps = rows.map((rect, index) => index === 0 ? rect.top - top : rect.top - rows[index - 1].bottom);
        return { count: rows.length, gaps: gaps.map((gap) => Math.round(gap * 10) / 10) };
      });
      expect(flush.count).toBeGreaterThanOrEqual(2);
      for (const gap of flush.gaps) expect(Math.abs(gap)).toBeLessThanOrEqual(0.5);
    } finally {
      await app.close();
    }
  });
  test('Typora marks draw as marks and give their delimiters back to the caret', async () => {
    const { app, page } = await launch('marks');
    try {
      const highlight = page.locator('.noto-mark-highlight');
      await expect(highlight).toHaveText('key point');
      await expect(page.locator('.noto-mark-sup')).toHaveText('2');
      await expect(page.locator('.noto-mark-sub')).toHaveText('2');
      const delimiters = page.locator('.noto-typora-delim');
      await expect(delimiters).toHaveCount(6);
      await expect(delimiters.first()).toBeHidden();

      await placeCaret(page, highlight);
      await expect(delimiters.first()).toBeVisible();
      await expect(delimiters.first()).toHaveText('==');

      // The marks are drawings: the file still holds the syntax.
      await expect(page.locator('.noto-marks-editing')).toHaveCount(1);
    } finally {
      await app.close();
    }
  });

  test('inline HTML draws as what it says, and a break breaks', async () => {
    const { app, page } = await launch('inline-html');
    try {
      const key = page.locator('.noto-html-kbd');
      await expect(key).toHaveText('Ctrl');
      await expect(page.locator('.noto-html-sub')).toHaveText('2');
      const tags = page.locator('.noto-inline-tag');
      await expect(tags).toHaveCount(5);
      await expect(tags.first()).toBeHidden();

      const broken = await page.locator('.noto-inline-break').evaluate((element) => {
        const paragraph = element.parentElement as HTMLElement;
        const before = document.createRange();
        before.selectNodeContents(paragraph.firstChild as Node);
        const after = document.createRange();
        after.selectNodeContents(paragraph.lastChild as Node);
        return after.getBoundingClientRect().top - before.getBoundingClientRect().top;
      });
      expect(broken).toBeGreaterThan(10);

      await placeCaret(page, key);
      await expect(tags.first()).toBeVisible();
      await expect(tags.first()).toHaveText('<kbd>');
      await expect(page.locator('.noto-inline-break > .noto-inline-html-source')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('the languages the vault fences are highlighted', async () => {
    const { app, page } = await launch('languages');
    try {
      const fence = page.locator('.noto-fence[data-lang="haskell"]');
      await expect(fence).toHaveCount(1);
      await expect(fence.locator('.token.string')).toHaveText('"hi"');
    } finally {
      await app.close();
    }
  });
});

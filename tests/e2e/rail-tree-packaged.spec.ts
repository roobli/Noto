import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

const resultRoot = path.join(process.cwd(), 'test-results', 'rail-tree');

/** Enough files in one folder that the rail has to scroll through it. */
const MANY = 60;

/**
 * A vault named on the command line, as `noto ~/notes`, with a folder deep
 * enough and long enough to scroll inside.
 */
async function launch(name: string): Promise<{ app: ElectronApplication; page: Page; vault: string }> {
  const workspace = path.join(resultRoot, name);
  await rm(workspace, { recursive: true, force: true });
  const vault = path.join(workspace, 'vault');
  const chapters = path.join(vault, 'chapters');
  await mkdir(path.join(chapters, 'drafts'), { recursive: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  await writeFile(path.join(vault, 'index.md'), '# Index\n', 'utf8');
  await writeFile(path.join(vault, 'notes.md'), '# Notes\n', 'utf8');
  for (let index = 1; index <= MANY; index += 1) {
    await writeFile(path.join(chapters, `chapter-${String(index).padStart(2, '0')}.md`), `# ${index}\n`, 'utf8');
  }
  await writeFile(path.join(chapters, 'drafts', 'idea.md'), '# Idea\n', 'utf8');

  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, vault],
  });
  const page = await app.firstWindow();
  // Sized before the tree is awaited: under a tiling window manager a new
  // window can open at the 720px floor, where the rail is hidden.
  await page.setViewportSize({ width: 1100, height: 600 });
  await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
  return { app, page, vault };
}

test.describe('the rail tree', () => {
  test('opens a folder named on the command line, headed by its own row', async () => {
    const { app, page } = await launch('cli');
    try {
      const vaultRow = page.getByTestId('tree-vault');
      // The name, not the row: the row also carries the folder's action menu.
      await expect(vaultRow.locator('.tree-name')).toHaveText('vault');
      // The first level hangs from the folder's row like every deeper level:
      // it is a connected level, not the bare root list it used to be.
      const firstLevel = page.locator('.tree-vault > .tree-level');
      await expect(firstLevel).toHaveCount(1);
      await expect(firstLevel).not.toHaveClass(/is-root/);
      await expect(firstLevel.locator('> .tree-node')).toHaveCount(3);
      await expect(page.getByTestId('empty-state')).toBeVisible();
      await expect(page.getByTestId('empty-open-folder')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('holds the path to the current file at the top while the rest scrolls', async () => {
    const { app, page } = await launch('sticky');
    try {
      const chapters = page.getByTestId('tree-directory').filter({ hasText: 'chapters' });
      await chapters.click();
      const first = page.getByTestId('tree-file').filter({ hasText: 'chapter-01' });
      await expect(first).toBeVisible();
      // An open folder that is not on the way to the current file scrolls
      // like anything else; there is no current file yet.
      await expect(chapters).not.toHaveCSS('position', 'sticky');

      // Open the first chapter: the folder is now on the path and holds at the
      // top of the first level; the file's own row holds a row beneath it.
      await first.click();
      const firstNode = page.locator('.tree-node-active');
      await expect(chapters).toHaveCSS('position', 'sticky');
      await expect(chapters).toHaveCSS('top', '0px');
      // The file's whole node holds, since its row fills the node.
      await expect(firstNode).toHaveCSS('position', 'sticky');
      // One row down, and a row is Typora's 32.
      await expect(firstNode).toHaveCSS('top', '32px');
      await expect(page.getByTestId('tree-vault')).not.toHaveCSS('position', 'sticky');
      await expect(chapters).not.toHaveAttribute('data-stuck');

      // Scroll the rail down through the chapters, and both hold.
      await page.getByTestId('tree-file').filter({ hasText: 'chapter-60' }).scrollIntoViewIfNeeded();
      await expect(chapters).toHaveAttribute('data-stuck');
      await expect(firstNode).toHaveAttribute('data-stuck');
      const offset = await page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>('.rail-view')!;
        const row = document.querySelector<HTMLElement>('.tree-file-active')!;
        return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top
          - Number.parseFloat(getComputedStyle(scroller).paddingTop);
      });
      expect(Math.round(offset)).toBe(32);

      // A sibling folder opened off the path does not join the stack.
      const drafts = page.getByTestId('tree-directory').filter({ hasText: 'drafts' });
      await drafts.scrollIntoViewIfNeeded();
      await drafts.click();
      await expect(drafts).not.toHaveCSS('position', 'sticky');

      // Back at the top, the folder rests in place again.
      await page.locator('.rail-view').evaluate((element) => element.scrollTo(0, 0));
      await expect(chapters).not.toHaveAttribute('data-stuck');
    } finally {
      await app.close();
    }
  });

  test('hangs its lines from the folder they belong to, and turns the corner', async () => {
    const { app, page } = await launch('guides');
    try {
      await page.getByTestId('tree-directory').first().click();
      await page.waitForTimeout(200);

      const geometry = await page.evaluate(() => {
        const level = document.querySelector<HTMLElement>('.tree-vault > .tree-level')!;
        const glyph = document.querySelector<HTMLElement>('.tree-vault-row svg')!;
        const glyphBox = glyph.getBoundingClientRect();
        const last = level.lastElementChild as HTMLElement;
        return {
          stemX: level.getBoundingClientRect().left,
          glyphLeft: glyphBox.left,
          glyphCentre: glyphBox.left + glyphBox.width / 2,
          // The stem stops at the last child's top so the corner can finish it.
          stemStop: level.style.getPropertyValue('--stem-stop'),
          // The level is the positioned ancestor of its own children, so a
          // child's offset is already measured from it.
          lastTop: last.offsetParent === level ? last.offsetTop : last.offsetTop - level.offsetTop,
          corner: getComputedStyle(last, '::before').borderBottomLeftRadius,
          cornerLeft: getComputedStyle(last, '::before').borderLeftWidth,
        };
      });

      // The line descends from inside the folder's icon, just in from its left
      // edge, which is where the theme's own stem stands: 10px in against an
      // icon that starts at 7px. Not from the blank column beside it.
      expect(geometry.stemX).toBeGreaterThanOrEqual(geometry.glyphLeft);
      expect(geometry.stemX).toBeLessThan(geometry.glyphCentre);
      // The last child turns a rounded corner, and the stem stops where that
      // corner starts rather than being drawn straight over the curve.
      expect(geometry.corner).not.toBe('0px');
      expect(geometry.cornerLeft).toBe('1px');
      expect(parseFloat(geometry.stemStop)).toBeLessThanOrEqual(geometry.lastTop + 1);
    } finally {
      await app.close();
    }
  });

  test('says an empty folder is empty where its first file would have been', async () => {
    const workspace = path.join(resultRoot, 'empty-folder');
    await rm(workspace, { recursive: true, force: true });
    const vault = path.join(workspace, 'vault');
    await mkdir(path.join(vault, 'hollow'), { recursive: true });
    await mkdir(path.join(vault, 'full'), { recursive: true });
    await mkdir(path.join(workspace, 'user-data'), { recursive: true });
    await writeFile(path.join(vault, 'full', 'note.md'), '# Note\n', 'utf8');
    const app = await electron.launch({
      executablePath: packagedExecutable(),
      args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, vault],
    });
    try {
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1100, height: 700 });
      await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
      for (const row of await page.getByTestId('tree-directory').all()) await row.click();
      await expect(page.locator('.tree-empty')).toHaveCount(1);

      const indents = await page.evaluate(() => ({
        empty: document.querySelector<HTMLElement>('.tree-empty')!.getBoundingClientRect().left,
        file: document.querySelector<HTMLElement>('.tree-file')!.getBoundingClientRect().left,
        directory: document.querySelector<HTMLElement>('.tree-level .tree-directory')!.getBoundingClientRect().left,
      }));

      // It sits exactly where a file inside that folder would sit, not at the
      // folder's own indent, where it read as a sibling rather than as the
      // folder's contents.
      expect(indents.empty).toBe(indents.file);
      expect(indents.empty).toBeGreaterThan(indents.directory);
    } finally {
      await app.close();
    }
  });

  test('lights the branch to the note in front, muted, and keeps the raw accent for its row', async () => {
    const { app, page } = await launch('lit-branch');
    try {
      await page.getByTestId('tree-file').first().click();
      await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible' });
      await page.getByTestId('tree-directory').first().click();
      await expect(page.getByTestId('tree-directory')).not.toHaveCount(1);

      const drawn = await page.evaluate(() => {
        const levels = [...document.querySelectorAll<HTMLElement>('.tree-body .tree-level')].map((level) => ({
          lit: level.style.getPropertyValue('--path-stop'),
          onPath: Boolean(level.querySelector(':scope > .tree-node-active, :scope > .tree-node:has(> .tree-on-path)')),
        }));
        const arms = [...document.querySelectorAll<HTMLElement>('.tree-level:not(.is-root) > .tree-node')]
          .map((node) => ({ node, style: getComputedStyle(node, '::before') }))
          .filter(({ style }) => parseFloat(style.borderBottomWidth) > 0);
        const active = arms.find(({ node }) => node.classList.contains('tree-node-active'));
        const plain = arms.find(({ node }) => !node.classList.contains('tree-node-active')
          && !node.querySelector(':scope > .tree-on-path'));
        const row = document.querySelector<HTMLElement>('.tree-file-active');
        return {
          levels,
          activeArm: active?.style.borderBottomColor ?? null,
          plainArm: plain?.style.borderBottomColor ?? null,
          activeBar: row ? getComputedStyle(row).boxShadow : null,
        };
      });

      // V2 of the author's guide-line schemes: the levels on the way to the
      // file are lit down to the child that leads on, and no other level is.
      for (const level of drawn.levels) {
        if (level.onPath) expect(level.lit).not.toBe('');
        else expect(level.lit).toBe('');
      }
      expect(drawn.levels.some((level) => level.onPath)).toBe(true);
      // The lit arm is a different colour from a plain one, and it is not the
      // raw accent: that is kept for the 2px bar inset on the active row.
      expect(drawn.activeArm).not.toBeNull();
      expect(drawn.activeArm).not.toBe(drawn.plainArm);
      expect(drawn.activeBar).toContain('inset');
      expect(drawn.activeBar).toMatch(/2px 0px 0px/);
    } finally {
      await app.close();
    }
  });
});

test.describe('a note opened on its own', () => {
  /** One note among others, opened directly, the way Finder opens a file. */
  async function launchFile(name: string) {
    const workspace = path.join(resultRoot, name);
    await rm(workspace, { recursive: true, force: true });
    const vault = path.join(workspace, 'vault');
    await mkdir(path.join(vault, 'sub'), { recursive: true });
    await mkdir(path.join(workspace, 'user-data'), { recursive: true });
    await writeFile(path.join(vault, 'opened.md'), '# Opened\n', 'utf8');
    await writeFile(path.join(vault, 'sibling.md'), '# Sibling\n', 'utf8');
    await writeFile(path.join(vault, 'sub', 'deeper.md'), '# Deeper\n', 'utf8');
    const app = await electron.launch({
      executablePath: packagedExecutable(),
      args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${path.join(vault, 'opened.md')}`],
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1100, height: 600 });
    await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
    return { app, page };
  }

  /** The shortcut is a menu accelerator, which only the menu item can fire. */
  async function invokeMenu(app: ElectronApplication, id: string): Promise<void> {
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
      const target = menu ? find(menu.items) : null;
      if (!target) throw new Error(`No menu item with id ${itemId}`);
      target.click();
    }, id);
  }

  test('keeps the rail under the title bar, and hides it when the window is too narrow', async () => {
    const { app, page } = await launchFile('narrow');
    try {
      // Claude-style shell: the title bar spans the window; the rail starts on
      // the row below so traffic lights never cover the sidebar toggle / trail.
      await page.setViewportSize({ width: 1200, height: 700 });
      await invokeMenu(app, 'toggle-sidebar');
      await expect(page.getByTestId('file-tree')).toBeVisible();
      const geometry = await page.evaluate(() => {
        const title = document.querySelector('.titlebar');
        const rail = document.querySelector('.workspace-rail');
        const shell = document.querySelector('.app-shell');
        if (!title || !rail || !shell) return null;
        const t = title.getBoundingClientRect();
        const r = rail.getBoundingClientRect();
        const s = shell.getBoundingClientRect();
        return {
          titleLeft: t.left,
          titleWidth: t.width,
          shellWidth: s.width,
          titleBottom: t.bottom,
          railTop: r.top,
        };
      });
      expect(geometry).not.toBeNull();
      expect(geometry!.titleLeft).toBeLessThanOrEqual(1);
      expect(geometry!.titleWidth).toBeGreaterThan(geometry!.shellWidth - 2);
      expect(geometry!.railTop).toBeGreaterThanOrEqual(geometry!.titleBottom - 1);

      // Below 900 the rail is hidden and the document takes the window.
      await page.setViewportSize({ width: 640, height: 700 });
      await expect(page.getByTestId('file-tree')).toBeHidden();
      await expect(page.getByTestId('sidebar-toggle')).toBeHidden();
    } finally {
      await app.close();
    }
  });

  test('brings its own folder with it, so quick open has something to search', async () => {
    const { app, page } = await launchFile('lone-file');
    try {
      // The rail stays shut: the reader did not ask for this folder, and the
      // setting that decides whether it opens at launch is off by default.
      await expect(page.getByTestId('file-tree')).toBeHidden();

      await invokeMenu(app, 'quick-open');
      await page.getByTestId('quick-input').fill('deeper');
      await expect(page.getByTestId('quick-result').first()).toContainText('deeper.md');

      await page.keyboard.press('Escape');
      // And the tree knows the folder once it is asked for.
      await page.getByTestId('sidebar-toggle').click();
      await expect(page.getByTestId('tree-vault')).toContainText('vault');
      await expect(page.getByTestId('file-tree')).toContainText('sibling.md');
    } finally {
      await app.close();
    }
  });
});

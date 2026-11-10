/**
 * A deep folder in a narrow window, in the packaged app: the rail never
 * scrolls sideways, each level steps in less when the open tree is deep, a
 * long name keeps its end and shows whole on a rest over it, the folders you
 * are in can fold into one trail row, a folder can be made the rail's root,
 * and the filename is centred over the page when Note Info is open.
 *
 * The window is a 13-inch laptop's, 1000 by 650, which is where the rail ran
 * out of room. `NOTO_TREE_SHOTS=/some/dir` saves screenshots to look at.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { dataPath, packagedExecutable } from './packaged-app';

const SHOTS = process.env.NOTO_TREE_SHOTS ?? '';

const DEEP = ['A000_Theoretical_Knowledge', 'A407_Data', '03_计算引擎', 'Duckdb', '源码研读'];
const NOTES = [
  '00_总览与导读.md',
  'duckdb_ext_httpfs与远程读取.md',
  'duckdb_ext_icu时区与排序规则.md',
  'duckdb_ext_parquet读写路径.md',
  '执行器_向量化与管道模型.md',
  '存储_行组与轻量压缩.md',
  '优化器_连接顺序与统计信息.md',
  '事务_MVCC与乐观并发控制.md',
  '并行_morsel驱动的任务调度.md',
  '大文件_外部排序与溢写.md',
  '扩展机制_加载与签名校验.md',
  '内存管理_缓冲池与淘汰.md',
  '向量格式_平坦常量与字典.md',
  '聚合_哈希表与分区.md',
];
const ACTIVE = '执行器_向量化与管道模型.md';

async function launch(name: string, settings: Readonly<Record<string, unknown>> = {}): Promise<{ app: ElectronApplication; page: Page; vault: string }> {
  const workspace = path.join(process.cwd(), 'test-results', 'tree-narrow', name);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  // `NOTO_TREE_THEME=dark` with the screenshots, to look at both.
  const theme = process.env.NOTO_TREE_THEME ? { theme: process.env.NOTO_TREE_THEME } : {};
  await writeFile(path.join(workspace, 'user-data', 'settings.json'), JSON.stringify({ ...theme, ...settings }), 'utf8');
  const vault = path.join(workspace, 'RooB');
  const deep = path.join(vault, ...DEEP);
  await mkdir(deep, { recursive: true });
  for (const note of NOTES) await writeFile(path.join(deep, note), `# ${note.replace(/\.md$/, '')}\n\nAn example note.\n`, 'utf8');
  // Siblings at every level, so the tree is long enough to scroll and each folder has company.
  for (let depth = 1; depth <= DEEP.length; depth++) {
    const folder = path.join(vault, ...DEEP.slice(0, depth - 1));
    for (let index = 0; index < 3; index++) await writeFile(path.join(folder, `${String(index).padStart(2, '0')}_索引${depth}.md`), '# 索引\n', 'utf8');
  }
  await mkdir(path.join(vault, 'Z000_Plans'), { recursive: true });
  await writeFile(path.join(vault, 'Z000_Plans', '2026_Q4_计划.md'), '# 计划\n', 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, ...(SHOTS ? ['--force-device-scale-factor=2'] : []), vault],
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1000, height: 650 });
  await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
  return { app, page, vault };
}

/** Open each folder down to the deep one, then the note, by clicking their rows as a reader would. */
async function openDeepNote(page: Page, vault: string): Promise<void> {
  let at = vault;
  for (const folder of DEEP) {
    at = path.join(at, folder);
    const row = page.locator(`[data-testid="tree-directory"]${dataPath(at)}`);
    await row.click();
    await expect(row).toHaveAttribute('aria-expanded', 'true');
  }
  await page.locator(`[data-testid="tree-file"]${dataPath(path.join(at, ACTIVE))}`).click();
  await expect(page.locator('.tree-file-active')).toHaveAttribute('data-path', path.join(at, ACTIVE));
}

const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

test('a deep note in a narrow window: no sideways scroll, tighter steps, names that keep their end', async () => {
  const { app, page, vault } = await launch('fit');
  try {
    await openDeepNote(page, vault);
    const rail = page.locator('#rail-view-files');
    // Nothing to scroll sideways, and a swipe across the rail moves nothing.
    await expect.poll(() => rail.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0);
    await rail.evaluate((element) => { element.scrollLeft = 200; });
    expect(await rail.evaluate((element) => element.scrollLeft)).toBe(0);
    // Six levels deep in a 1000px window: each level steps in less than its resting 20px indent.
    await expect.poll(() => page.locator('[data-testid="file-tree"]').evaluate((element) => parseFloat(getComputedStyle(element).getPropertyValue('--tree-indent-now'))))
      .toBeLessThan(20);
    // Every name ends inside the rail.
    const overflow = await page.evaluate(() => {
      const edge = document.querySelector('#rail-view-files')!.getBoundingClientRect().right;
      return Array.from(document.querySelectorAll('.tree-name')).filter((name) => name.getBoundingClientRect().right > edge + 0.5).length;
    });
    expect(overflow).toBe(0);
    // A long name that shares its start with its siblings loses that start
    // first, so what tells it from them stays in sight.
    const httpfs = page.locator('[data-testid="tree-file"][data-label="duckdb_ext_httpfs与远程读取.md"]');
    await expect(httpfs).toHaveAttribute('data-cut', 'true');
    const shown = await httpfs.locator('.tree-name').textContent();
    expect(shown?.startsWith('…')).toBe(true);
    expect(shown).toContain('httpfs');
    // One with nothing shared keeps a head and its end.
    const active = await page.locator('.tree-file-active .tree-name').textContent();
    expect(active).toContain('…');
    expect(active?.endsWith('模型')).toBe(true);
    // A rest on it shows it whole over the page. From the top, where no held
    // row covers it: a scroll puts away a name shown whole.
    await rail.evaluate((element) => { element.scrollTop = 0; });
    await page.waitForTimeout(100);
    await httpfs.hover();
    const peek = page.locator('[data-testid="tree-peek"]');
    await expect(peek).toHaveText('duckdb_ext_httpfs与远程读取.md');
    await shot(page, 'fit-peek');
    await page.mouse.move(600, 300);
    await expect(peek).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('Hide .md leaves a note its name alone', async () => {
  const { app, page, vault } = await launch('bare', { treeNoteExtensions: false });
  try {
    await openDeepNote(page, vault);
    await expect(page.locator('.tree-file-active')).toHaveAttribute('data-label', '执行器_向量化与管道模型');
  } finally {
    await app.close();
  }
});

test('the trail folds the folders you are in into one row, and a part leads back to its folder', async () => {
  const { app, page, vault } = await launch('trail', { treeHeld: 'trail' });
  try {
    await openDeepNote(page, vault);
    const rail = page.locator('#rail-view-files');
    const source = path.join(vault, ...DEEP);
    // Scroll the deep folder's own row up under the top, with its notes still in view.
    await rail.evaluate((element, folder) => {
      const row = element.querySelector<HTMLElement>(`[data-path="${CSS.escape(folder)}"]`)!;
      element.scrollTop += row.getBoundingClientRect().top - element.getBoundingClientRect().top + 40;
    }, source);
    const trail = page.locator('[data-testid="tree-trail"]');
    await expect(trail).toHaveAttribute('data-on', 'true');
    await expect(trail.locator('.tree-path-part.is-last')).toHaveText('源码研读');
    // Nothing in the tree holds itself: the trail does.
    expect(await page.locator(dataPath(source)).evaluate((row) => getComputedStyle(row).position)).toBe('relative');
    await shot(page, 'trail');
    // One row, however deep.
    expect(await trail.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(32);
    // A part of the trail brings its folder's row back to just under it.
    const duckdb = path.join(vault, ...DEEP.slice(0, 4));
    await rail.evaluate((element) => { element.scrollTop += 120; });
    const part = trail.locator('.tree-path-part', { hasText: 'Duckdb' });
    if (await part.count() === 0) await trail.locator('.tree-path-part[data-folded]').click();
    else await part.click();
    await expect.poll(() => page.evaluate((folder) => {
      const scroller = document.querySelector('#rail-view-files')!.getBoundingClientRect();
      const row = document.querySelector(`[data-path="${CSS.escape(folder)}"]`)!.getBoundingClientRect();
      return Math.round(row.top - scroller.top);
    }, duckdb)).toBeGreaterThanOrEqual(30);
  } finally {
    await app.close();
  }
});

test('a folder made the root with Option-click: full steps, a bar back up, and Esc to see it all', async () => {
  const { app, page, vault } = await launch('focus');
  try {
    await openDeepNote(page, vault);
    const duckdb = path.join(vault, ...DEEP.slice(0, 4));
    await page.locator(`[data-testid="tree-directory"]${dataPath(duckdb)}`).click({ modifiers: ['Alt'] });
    await expect(page.locator('[data-testid="tree-focusbar"]')).toBeVisible();
    await expect(page.locator('[data-testid="tree-vault"] .tree-name')).toHaveText('Duckdb');
    // Only what is inside, two levels deep now, at the resting step.
    await expect(page.locator('[data-testid="tree-directory"]', { hasText: 'Z000_Plans' })).toHaveCount(0);
    await expect.poll(() => page.locator('[data-testid="file-tree"]').evaluate((element) => parseFloat(getComputedStyle(element).getPropertyValue('--tree-indent-now'))))
      .toBe(20);
    // The note in front is still there and still lit.
    await expect(page.locator('.tree-file-active')).toHaveAttribute('data-label', ACTIVE);
    await expect(page.locator('[data-testid="tree-focus-path"]')).toContainText('03_计算引擎');
    await shot(page, 'focus');
    // Up one folder, then Esc for the whole open folder.
    await page.locator('[data-testid="tree-focus-up"]').click();
    await expect(page.locator('[data-testid="tree-vault"] .tree-name')).toHaveText('03_计算引擎');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="tree-focusbar"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="tree-vault"] .tree-name')).toHaveText('RooB');
  } finally {
    await app.close();
  }
});

test('with Note Info open, the filename is centred over the page it names', async () => {
  const { app, page, vault } = await launch('title', { infoOpen: true });
  try {
    await openDeepNote(page, vault);
    await expect(page.locator('.document-identity strong')).toContainText('执行器');
    await expect.poll(() => page.evaluate(() => {
      const canvas = document.querySelector('#document-canvas')!.getBoundingClientRect();
      const identity = document.querySelector('.document-identity')!.getBoundingClientRect();
      return Math.round(Math.abs((identity.left + identity.right) / 2 - (canvas.left + canvas.right) / 2));
    })).toBeLessThanOrEqual(2);
    await shot(page, 'title');
  } finally {
    await app.close();
  }
});

test('Settings → Appearance → File tree switches between the stack and the trail', async () => {
  const { app, page } = await launch('settings');
  try {
    await expect(page.locator('[data-testid="file-tree"]')).not.toHaveClass(/is-trail/);
    await page.getByTestId('settings-toggle').click();
    const trail = page.getByTestId('tree-held-trail');
    await trail.scrollIntoViewIfNeeded();
    await expect(page.getByTestId('tree-held-stack')).toHaveAttribute('aria-checked', 'true');
    await trail.click();
    await expect(trail).toHaveAttribute('aria-checked', 'true');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'settings.png') });
    await page.getByTestId('settings-close').click();
    await expect(page.locator('[data-testid="file-tree"]')).toHaveClass(/is-trail/);
  } finally {
    await app.close();
  }
});

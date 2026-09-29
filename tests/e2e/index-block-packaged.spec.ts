import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

const resultRoot = path.join(process.cwd(), 'test-results', 'index-block');

const INDEX = [
  '---', 'moc: true', '---', '',
  '# Acme 索引', '',
  '<!-- note-assistant:index:start -->', '',
  '## 目录索引', '',
  '自动生成，勿手改；由索引脚本维护。', '',
  '### 子目录', '',
  '- 合作方（2 篇）',
  '  - [[合作方/联系人整理|联系人 整理]]',
  '  - [[合作方/20260101-02_周记|20260101 02 周记]]',
  '- [[回顾/00_索引|回顾]]（3 篇）', '',
  '### 日志', '',
  '- [[搜索笔记|搜索笔记]]',
  '- [[git_使用笔记|git 使用笔记]]', '',
  '<!-- note-assistant:index:end -->', '',
  'A paragraph after the generated block.', '',
].join('\n');

async function launch(name: string): Promise<{ app: ElectronApplication; page: Page }> {
  const workspace = path.join(resultRoot, name);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const vault = path.join(workspace, 'vault');
  await mkdir(path.join(vault, '合作方'), { recursive: true });
  await mkdir(path.join(vault, '回顾'), { recursive: true });
  await writeFile(path.join(vault, '00_索引.md'), INDEX, 'utf8');
  await writeFile(path.join(vault, '搜索笔记.md'), '# 搜索笔记\n\nThe search note.\n', 'utf8');
  await writeFile(path.join(vault, 'git_使用笔记.md'), '# git\n', 'utf8');
  await writeFile(path.join(vault, '回顾', '00_索引.md'), '# 回顾\n', 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, vault],
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
  await page.getByTestId('tree-file').filter({ hasText: '00_索引' }).first().click();
  await page.locator('.canvas-slot:not([hidden]) [data-testid="noto-editor"]').waitFor({ state: 'visible' });
  return { app, page };
}

test.describe('a generated index', () => {
  test('is drawn as the list it is, with its markers and markdown out of sight', async () => {
    const { app, page } = await launch('drawn');
    try {
      const index = page.locator('.ProseMirror .noto-index');
      await expect(index).toBeVisible();
      await expect(index.locator('.noto-index-title')).toHaveText('目录索引');
      // Five lines link somewhere; the label with the count does not.
      await expect(index.locator('.noto-index-count')).toHaveText('5 条');
      await expect(index.locator('.noto-index-section')).toHaveText(['子目录', '日志']);
      await expect(index.locator('.noto-index-item')).toHaveCount(5);
      await expect(index.locator('.noto-index-label')).toHaveText('合作方（2 篇）');

      // The region's own markdown is hidden, markers included, and the note
      // around it is untouched.
      // Two markers, a heading, a paragraph, two section headings, two lists.
      await expect(page.locator('.ProseMirror .noto-index-source')).toHaveCount(8);
      await expect(page.locator('.ProseMirror .noto-index-source').first()).toBeHidden();
      // The markdown stays in the document, which is how it is saved back
      // byte for byte, and out of what is drawn.
      const drawn = await page.locator('.ProseMirror').evaluate((node) => (node as HTMLElement).innerText);
      expect(drawn).not.toContain('note-assistant:index:start');
      expect(drawn).not.toContain('[[');
      await expect(page.locator('.ProseMirror h1')).toHaveText('Acme 索引');
      await expect(page.locator('.ProseMirror')).toContainText('A paragraph after the generated block.');

      // A line shows the title first and the path after it, in small type.
      const first = index.locator('.noto-index-item').first();
      await expect(first.locator('.noto-index-item-title')).toHaveText('联系人 整理');
      await expect(first.locator('.noto-index-item-path')).toHaveText('合作方/联系人整理');
      // A count after a link is kept as its note rather than read as a path.
      await expect(index.locator('.noto-index-item').nth(2).locator('.noto-index-item-path')).toHaveText('（3 篇）');
    } finally {
      await app.close();
    }
  });

  test('opens the note a line points at', async () => {
    const { app, page } = await launch('follow');
    try {
      await page.locator('.ProseMirror .noto-index-item').filter({ hasText: '搜索笔记' }).click();
      await expect(page.locator('.canvas-slot:not([hidden]) .ProseMirror')).toContainText('The search note.', { timeout: 15_000 });
    } finally {
      await app.close();
    }
  });
});

/**
 * Git changes in the file tree.
 *
 * Real repositories made with the system git in a temporary directory, and
 * the packaged app opened on them. What is pinned is the decision: a quiet
 * mark per changed note, a ring on the folders holding a change (including a
 * deleted note's), nothing outside the vault, nothing at all outside a
 * repository or without git, and marks that follow a commit made elsewhere
 * and a save made here.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable, placeCaretAtEnd } from './packaged-app';

/** Screenshots for review, when asked for: `NOTO_GIT_SHOTS=/some/dir`. */
const SHOTS = process.env.NOTO_GIT_SHOTS ?? '';

const made: string[] = [];
test.afterAll(() => {
  for (const directory of made) rmSync(directory, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=noto@example.invalid', '-c', 'user.name=Noto', '-c', 'commit.gpgsign=false', ...args], {
    cwd, stdio: 'ignore',
  });
}

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/**
 * Outside the Noto checkout, which is a repository itself: a "plain folder"
 * under it would be inside one.
 */
function scratch(name: string): string {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), `noto-e2e-${name}-`)));
  made.push(directory);
  return directory;
}

/** A repository whose notes live in `notes/`, committed and then changed every way. */
function changedRepository(name: string): { repo: string; vault: string } {
  const repo = scratch(name);
  git(repo, 'init', '-q');
  write(path.join(repo, 'notes', 'kept.md'), '# Kept\n\nUnchanged since the commit.\n');
  write(path.join(repo, 'notes', 'edited.md'), '# Edited\n\nBefore.\n');
  write(path.join(repo, 'notes', 'archive', 'gone.md'), '# Gone\n');
  write(path.join(repo, 'notes', 'archive', 'still.md'), '# Still here\n');
  write(path.join(repo, 'outside.md'), '# Outside the vault\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'first');
  write(path.join(repo, 'notes', 'edited.md'), '# Edited\n\nAfter.\n');
  rmSync(path.join(repo, 'notes', 'archive', 'gone.md'));
  write(path.join(repo, 'notes', 'drafts', 'idea.md'), '# A new idea\n');
  write(path.join(repo, 'outside.md'), '# Outside the vault, changed\n');
  return { repo, vault: path.join(repo, 'notes') };
}

async function launch(
  folder: string,
  options: { env?: NodeJS.ProcessEnv; theme?: 'light' | 'dark' } = {},
): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = scratch('user-data');
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ theme: options.theme ?? 'light' }));
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${userData}`, folder],
    env: { ...process.env, ...options.env } as Record<string, string>,
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1100, height: 640 });
  await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
  return { app, page };
}

const fileRow = (page: Page, name: string) => page.getByTestId('tree-file').filter({ hasText: name });
const folderRow = (page: Page, name: string) => page.getByTestId('tree-directory').filter({ hasText: name });
const mark = (row: ReturnType<typeof fileRow>) => row.getByTestId('tree-git-mark');

test.describe('git changes in the tree', () => {
  test('marks changed and new notes, and the folders holding them and a deleted one', async () => {
    const { vault } = changedRepository('marks');
    const { app, page } = await launch(vault);
    try {
      await expect(mark(fileRow(page, 'edited.md'))).toHaveAttribute('data-git', 'modified');
      await expect(mark(fileRow(page, 'kept.md'))).toHaveCount(0);
      // The deleted note has no row; its folder says something inside changed.
      await expect(mark(folderRow(page, 'archive'))).toHaveAttribute('data-git', 'folder');
      await expect(mark(folderRow(page, 'drafts'))).toHaveAttribute('data-git', 'folder');
      // The vault's own row is never marked: in a repository with changes it always would be.
      await expect(page.getByTestId('tree-vault').getByTestId('tree-git-mark')).toHaveCount(0);

      await folderRow(page, 'drafts').click();
      await expect(mark(fileRow(page, 'idea.md'))).toHaveAttribute('data-git', 'new');
      await folderRow(page, 'archive').click();
      await expect(fileRow(page, 'still.md')).toBeVisible();
      await expect(mark(fileRow(page, 'still.md'))).toHaveCount(0);
      await expect(fileRow(page, 'gone.md')).toHaveCount(0);

      // Said in words as well as colour: the row's name and its hover.
      await expect(fileRow(page, 'edited.md')).toHaveAccessibleName(/^edited\.md\s*, Changed$/);
      await expect(fileRow(page, 'idea.md')).toHaveAttribute('title', 'idea.md, New');
      // A mark is never a target, so the row's hit area is the row's.
      await expect(mark(fileRow(page, 'edited.md'))).toHaveCSS('pointer-events', 'none');
      await expect(folderRow(page, 'archive')).toHaveAttribute('title', 'archive, Contains changes');
      // New is a shape, not only a colour.
      await expect(mark(fileRow(page, 'idea.md')).locator('svg')).toHaveCount(1);
      await expect(mark(fileRow(page, 'edited.md')).locator('svg')).toHaveCount(0);

      if (SHOTS) {
        await fileRow(page, 'edited.md').click();
        await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible' });
        await page.screenshot({ path: path.join(SHOTS, 'git-marks-light.png') });
      }
    } finally {
      await app.close();
    }
  });

  test('follows a commit made elsewhere, and a save made here', async () => {
    const { repo, vault } = changedRepository('follow');
    const { app, page } = await launch(vault);
    try {
      await expect(mark(fileRow(page, 'edited.md'))).toHaveAttribute('data-git', 'modified');

      // A terminal commits everything: git's refs and index change, and the marks go.
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'second');
      await expect(page.getByTestId('tree-git-mark')).toHaveCount(0, { timeout: 15_000 });

      // An edit saved in Noto marks the note it changed.
      await fileRow(page, 'kept.md').click();
      await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible' });
      await placeCaretAtEnd(page, page.locator('.ProseMirror > p').first());
      await page.keyboard.type(' Edited in Noto.');
      await page.getByTestId('save-button').click();
      await expect.poll(() => readFileSync(path.join(vault, 'kept.md'), 'utf8')).toContain('Edited in Noto.');
      await expect(mark(fileRow(page, 'kept.md'))).toHaveAttribute('data-git', 'modified', { timeout: 15_000 });
    } finally {
      await app.close();
    }
  });

  test('marks the whole repository when the vault is its top level', async () => {
    const { repo } = changedRepository('toplevel');
    const { app, page } = await launch(repo);
    try {
      await expect(mark(fileRow(page, 'outside.md'))).toHaveAttribute('data-git', 'modified');
      await expect(mark(folderRow(page, 'notes'))).toHaveAttribute('data-git', 'folder');
    } finally {
      await app.close();
    }
  });

  test('draws nothing for a folder outside any repository', async () => {
    const folder = scratch('plain');
    write(path.join(folder, 'a.md'), '# A\n');
    write(path.join(folder, 'sub', 'b.md'), '# B\n');
    // A ceiling, so a temp directory inside someone's repository is still outside one here.
    const { app, page } = await launch(folder, { env: { GIT_CEILING_DIRECTORIES: path.dirname(folder) } });
    try {
      await expect(fileRow(page, 'a.md')).toBeVisible();
      await expect(folderRow(page, 'sub')).toBeVisible();
      await expect(page.getByTestId('tree-git-mark')).toHaveCount(0);
      await expect(page.locator('[role="alert"]')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('draws nothing, and says nothing, without git', async () => {
    // macOS looks for git in fixed places, so a PATH without it does not hide it there.
    test.skip(process.platform === 'darwin', 'git is found by absolute path on macOS');
    const { vault } = changedRepository('no-git');
    const noGit = scratch('empty-path');
    const { app, page } = await launch(vault, { env: { PATH: noGit, Path: noGit } });
    try {
      await expect(fileRow(page, 'edited.md')).toBeVisible();
      // Give a status every chance to have arrived, then check none did.
      await page.waitForTimeout(1_500);
      await expect(page.getByTestId('tree-git-mark')).toHaveCount(0);
      await expect(page.locator('[role="alert"]')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('reads the same at night', async () => {
    const { vault } = changedRepository('dark');
    const { app, page } = await launch(vault, { theme: 'dark' });
    try {
      await expect(mark(fileRow(page, 'edited.md'))).toHaveAttribute('data-git', 'modified');
      await folderRow(page, 'drafts').click();
      await expect(mark(fileRow(page, 'idea.md'))).toHaveAttribute('data-git', 'new');
      if (SHOTS) {
        await fileRow(page, 'edited.md').click();
        await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible' });
        await page.screenshot({ path: path.join(SHOTS, 'git-marks-dark.png') });
      }
    } finally {
      await app.close();
    }
  });
});

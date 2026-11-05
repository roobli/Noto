/**
 * Changes: the first page a plugin puts in the rail.
 *
 * A real repository, committed and then changed every way, and the packaged
 * app opened on it. What is pinned is the slot and the page together: the
 * bundled plugin is on by default, its toggle sits beside search with a count,
 * its page lists only the changed notes as a short tree, opens one on a click,
 * and leaves a deleted one inert; outside git it says so.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

/** Screenshots for review, when asked for: `NOTO_CHANGES_SHOTS=/some/dir`. */
const SHOTS = process.env.NOTO_CHANGES_SHOTS ?? '';

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

function scratch(name: string): string {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), `noto-e2e-${name}-`)));
  made.push(directory);
  return directory;
}

function changedVault(): string {
  const vault = scratch('changes');
  git(vault, 'init', '-q');
  write(path.join(vault, 'kept.md'), '# Kept\n\nUnchanged since the commit.\n');
  write(path.join(vault, 'Work', 'Acme', '研发组', 'TODO', 'audit.md'), '# Audit\n\nBefore.\n');
  write(path.join(vault, 'archive', 'gone.md'), '# Gone\n');
  git(vault, 'add', '-A');
  git(vault, 'commit', '-q', '-m', 'first');
  write(path.join(vault, 'Work', 'Acme', '研发组', 'TODO', 'audit.md'), '# Audit\n\nAfter.\n');
  write(path.join(vault, 'Work', 'Acme', '研发组', 'TODO', 'es-index.md'), '# ES index names\n\nNew.\n');
  rmSync(path.join(vault, 'archive', 'gone.md'));
  return vault;
}

async function launch(folder: string, theme: 'light' | 'dark' = 'light'): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = scratch('user-data');
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ theme }));
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${userData}`, ...(SHOTS ? ['--force-device-scale-factor=2'] : []), folder],
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1100, height: 640 });
  await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
  return { app, page };
}

async function capture(app: ElectronApplication, file: string): Promise<void> {
  const png = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  writeFileSync(file, Buffer.from(png, 'base64'));
}

const toggle = (page: Page) => page.locator('[data-testid="rail-page-toggle"][data-page="dev.lr00rl.noto.changes:changes"]');

test.describe('the Changes page', () => {
  test('lists only the changed notes, counts them, and opens one', async () => {
    const vault = changedVault();
    const { app, page } = await launch(vault);
    try {
      await expect(toggle(page)).toBeVisible();
      await expect(toggle(page).getByTestId('rail-page-badge')).toHaveText('3');
      await expect(toggle(page)).toHaveAttribute('aria-label', 'Changes, 3');
      await toggle(page).click();
      await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
      const view = page.getByTestId('rail-plugin-view');
      await expect(view.getByTestId('changes-summary')).toHaveText('1 changed · 1 new · 1 deleted');
      // A chain of folders holding only the next is one row.
      await expect(view.getByTestId('changes-folder').filter({ hasText: 'Work / Acme / 研发组 / TODO' })).toBeVisible();
      await expect(view.getByTestId('changes-file')).toHaveCount(3);
      await expect(view.locator('[data-testid="changes-file"][data-change="new"]')).toContainText('es-index.md');
      const gone = view.locator('[data-testid="changes-file"][data-change="deleted"]');
      await expect(gone).toHaveAttribute('aria-disabled', 'true');
      if (SHOTS) await capture(app, path.join(SHOTS, 'changes-light.png'));

      await view.locator('[data-testid="changes-file"][data-change="modified"]').click();
      await expect(page.locator('.titlebar')).toContainText('audit.md');
      await expect(view.locator('[data-testid="changes-file"][data-change="modified"]')).toHaveAttribute('aria-current', 'true');

      // A folder folds; the tree is the page's own, not the shell's.
      await view.getByTestId('changes-folder').filter({ hasText: 'Work / Acme' }).click();
      await expect(view.getByTestId('changes-file')).toHaveCount(1);

      // Pressed again, the toggle hands the rail back to the files.
      await toggle(page).click();
      await expect(page.getByTestId('rail-plugin-view')).toHaveCount(0);
      await expect(page.getByTestId('file-tree')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('says when there is nothing to list, and when the folder is not in git', async () => {
    const clean = scratch('clean');
    git(clean, 'init', '-q');
    write(path.join(clean, 'one.md'), '# One\n');
    git(clean, 'add', '-A');
    git(clean, 'commit', '-q', '-m', 'first');
    let { app, page } = await launch(clean, 'dark');
    try {
      await expect(toggle(page)).toBeVisible();
      await expect(toggle(page).getByTestId('rail-page-badge')).toHaveCount(0);
      await toggle(page).click();
      await expect(page.getByTestId('changes-empty')).toHaveText('Nothing has changed since the last commit.');
      if (SHOTS) await capture(app, path.join(SHOTS, 'changes-empty-dark.png'));
    } finally {
      await app.close();
    }

    const plain = scratch('plain');
    write(path.join(plain, 'one.md'), '# One\n');
    ({ app, page } = await launch(plain));
    try {
      await toggle(page).click();
      await expect(page.getByTestId('changes-not-git')).toBeVisible();
    } finally {
      await app.close();
    }
  });
});

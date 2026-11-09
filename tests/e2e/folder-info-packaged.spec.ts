/**
 * A folder's info, in the packaged app: Get Info on a folder in the tree
 * turns the info pane to it, with what its memory knows (how many notes,
 * broken links, the notes nothing links to or from) and the newest commits
 * that changed anything in it, and only in it; a note named there opens and
 * the pane turns back to the note, as Back does, and as a plugin's command
 * that leads to one of the note's tabs does. A folder outside git and
 * without memory says both, and offers to keep memory.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

/** Screenshots for review, when asked for: `NOTO_FOLDER_SHOTS=/some/dir`. */
const SHOTS = process.env.NOTO_FOLDER_SHOTS ?? '';
/** And in which theme: `NOTO_FOLDER_THEME=dark`. */
const THEME = process.env.NOTO_FOLDER_THEME ?? '';

const made: string[] = [];
test.afterAll(() => {
  for (const directory of made) rmSync(directory, { recursive: true, force: true });
});

function scratch(name: string): string {
  // Native: on Windows only it spells a short name such as RUNNER~1 out in
  // full, as the paths the app reports are.
  const directory = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), `noto-e2e-${name}-`)));
  made.push(directory);
  return directory;
}

function write(root: string, rel: string, text: string): void {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text, 'utf8');
}

function git(root: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=noto@example.invalid', '-c', 'user.name=Noto', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'ignore' });
}

/** Ideas holds three notes, one linked to nothing and one link that names nothing; Work changed last, outside Ideas. */
function folder(): string {
  const root = scratch('folder-info');
  write(root, 'Ideas/Argus Index.md', '# Argus Index\n\nThe audit service and its daily indexes.\n');
  write(root, 'Ideas/plan.md', '# Plan\n\nBuild on [[Argus Index]].\n');
  write(root, 'Ideas/garden.md', '# Garden\n\nTomatoes want sun.\n');
  write(root, 'Work/budget.md', '# Budget\n\nNumbers.\n');
  write(root, '.noto/brain.yaml', 'kinds:\n  dated_names_are_logs: true\n');
  write(root, '.gitignore', '.noto/\n');
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'begin');
  write(root, 'Ideas/plan.md', '# Plan\n\nBuild on [[Argus Index]], and on [[Nowhere]].\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'longer plan');
  write(root, 'Work/budget.md', '# Budget\n\nMore numbers.\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'budget, outside Ideas');
  return root;
}

async function launch(root: string, open: string): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = scratch('user-data');
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ infoOpen: true, ...(THEME ? { theme: THEME } : {}) }));
  const app = await electron.launch({ executablePath: packagedExecutable(), args: [`--user-data-dir=${userData}`, ...(SHOTS ? ['--force-device-scale-factor=2'] : []), `--folder=${root}`, `--open=${path.join(root, open)}`] });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
  // A native menu holds the input loop; the test keeps each one and clicks its items itself.
  await app.evaluate(({ Menu }) => {
    const shown: Electron.Menu[] = [];
    (globalThis as { shownMenus?: Electron.Menu[] }).shownMenus = shown;
    Menu.prototype.popup = function popup(this: Electron.Menu) { shown.push(this); };
  });
  return { app, page };
}

/** Right-click a folder's row and choose Get Info. */
async function getInfo(app: ElectronApplication, page: Page, name: string): Promise<void> {
  const before = await app.evaluate(() => (globalThis as { shownMenus?: Electron.Menu[] }).shownMenus!.length);
  await page.getByTestId('tree-directory').filter({ hasText: name }).first().click({ button: 'right' });
  await expect.poll(() => app.evaluate(() => (globalThis as { shownMenus?: Electron.Menu[] }).shownMenus!.length)).toBeGreaterThan(before);
  await app.evaluate(() => {
    const menu = (globalThis as { shownMenus?: Electron.Menu[] }).shownMenus!.at(-1)!;
    menu.items.find((item) => item.id === 'tree-info')!.click();
  });
}

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
    find(Menu.getApplicationMenu()!.items)!.click();
  }, id);
}

async function shoot(app: ElectronApplication, page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.waitForTimeout(400);
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  writeFileSync(path.join(SHOTS, THEME ? `${THEME}-${name}` : name), Buffer.from(png, 'base64'));
}

test.describe('a folder\'s info', () => {
  test('turns the pane to a folder: its memory and its own commits, and back to a note', async () => {
    const root = folder();
    const { app, page } = await launch(root, 'Ideas/plan.md');
    try {
      const pane = page.getByTestId('info-pane');
      await expect(pane.getByTestId('info-title')).toHaveText('plan');
      await getInfo(app, page, 'Ideas');
      await expect(pane).toHaveAttribute('data-folder', path.join(root, 'Ideas'));
      await expect(pane.getByTestId('info-title')).toHaveText('Ideas');
      await expect(pane.getByTestId('info-back')).toHaveText('Back to plan');

      // The memory: three notes, one link naming nothing, the garden linked to nothing.
      await expect(pane.getByTestId('folder-summary')).toHaveText('3 notes · 1 broken link', { timeout: 30_000 });
      await expect(pane.getByTestId('folder-orphans')).toContainText('Garden');
      await expect(pane.getByTestId('folder-orphans')).not.toContainText('Plan');

      // Git: the commits that changed Ideas, not the one that changed only Work.
      const commits = pane.getByTestId('folder-commit');
      await expect(commits).toHaveCount(2);
      await expect(commits.nth(0)).toContainText('longer plan');
      await expect(commits.nth(1)).toContainText('begin');
      await expect(commits.nth(1).getByTestId('folder-commit-note')).toHaveCount(3);
      await shoot(app, page, 'folder-info.png');

      // Back turns to the note in front; a note named in the folder opens and the pane follows it.
      await pane.getByTestId('info-back').click();
      await expect(pane).not.toHaveAttribute('data-folder', /.+/);
      await expect(pane.getByTestId('info-title')).toHaveText('plan');
      await getInfo(app, page, 'Ideas');
      await expect(pane.getByTestId('info-title')).toHaveText('Ideas');
      await pane.getByTestId('folder-orphans').getByTestId('folder-orphan-note').filter({ hasText: 'Garden' }).click();
      await expect(pane.getByTestId('info-title')).toHaveText('garden');
      await expect(pane).not.toHaveAttribute('data-folder', /.+/);

      // The note already in front, chosen from the folder, turns the pane back too.
      await getInfo(app, page, 'Ideas');
      await expect(pane.getByTestId('info-title')).toHaveText('Ideas');
      await pane.getByTestId('folder-commit').nth(0).getByTestId('folder-commit-note').filter({ hasText: 'plan' }).click();
      await expect(pane.getByTestId('info-title')).toHaveText('plan');
      await getInfo(app, page, 'Ideas');
      await pane.getByTestId('folder-commit').nth(0).getByTestId('folder-commit-note').filter({ hasText: 'plan' }).click();
      await expect(pane).not.toHaveAttribute('data-folder', /.+/);
      await expect(pane.getByTestId('info-title')).toHaveText('plan');

      // So does a plugin's command that leads to one of the note's tabs.
      await getInfo(app, page, 'Ideas');
      await expect(pane.getByTestId('info-title')).toHaveText('Ideas');
      await invokeMenu(app, 'command-palette');
      await page.getByTestId('palette-input').fill('ask the folder');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('memory-ask-field')).toBeFocused();
      await expect(pane).not.toHaveAttribute('data-folder', /.+/);
    } finally {
      await app.close();
    }
  });

  test('says a folder outside git and without memory has neither, and offers to keep memory', async () => {
    const root = scratch('folder-plain');
    write(root, 'Notes/a.md', '# A\n');
    const { app, page } = await launch(root, 'Notes/a.md');
    try {
      const pane = page.getByTestId('info-pane');
      await getInfo(app, page, 'Notes');
      await expect(pane.getByTestId('folder-commits')).toHaveAttribute('data-state', 'not-git');
      await expect(pane.getByTestId('folder-memory-state')).toHaveAttribute('data-state', 'no-memory');
      await expect(pane.getByTestId('folder-memory-state').getByRole('button')).toHaveText('Keep Memory for the Open Folder…');
      // Nothing else to say, so the second memory section is not there at all.
      await expect(pane.locator('[data-testid="folder-section"]:visible')).toHaveCount(2);
      await shoot(app, page, 'folder-info-plain.png');

      // The open folder's own row has Get Info too, for the whole of it, and nothing that would remove it.
      await page.getByTestId('tree-vault').click({ button: 'right' });
      await expect.poll(() => app.evaluate(() => (globalThis as { shownMenus?: Electron.Menu[] }).shownMenus!.at(-1)?.items.map((item) => item.label) ?? []))
        .toEqual(['New Note Here', 'New Folder Here', 'Get Info', '', 'Reveal in Finder', 'Copy Path']);
      await app.evaluate(() => {
        const menu = (globalThis as { shownMenus?: Electron.Menu[] }).shownMenus!.at(-1)!;
        menu.items.find((item) => item.id === 'tree-info')!.click();
      });
      await expect(pane.getByTestId('info-title')).toHaveText(path.basename(root));
      await expect(pane.getByTestId('folder-memory-state').getByRole('button')).toHaveText('Keep Memory for This Folder…');
    } finally {
      await app.close();
    }
  });
});

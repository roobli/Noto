/**
 * The note's info pane, with History and Properties, in the packaged app.
 *
 * A real repository with a note that was written, changed, moved and then
 * changed again without a commit. What is pinned: the pane opens from the
 * View menu and from Get Info in the tree's menu, says what git says about
 * the note, lays its commits on the timeline, lists them through the move,
 * opens one in the diff view and steps from it, takes a version back as an
 * edit that Undo reverses and that is not saved on its own, shows the note's
 * properties, says so when a folder is not in git, and is open again after
 * a restart.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

/** Screenshots for review, when asked for: `NOTO_INFO_SHOTS=/some/dir`. */
const SHOTS = process.env.NOTO_INFO_SHOTS ?? '';

const made: string[] = [];
test.afterAll(() => {
  for (const directory of made) rmSync(directory, { recursive: true, force: true });
});

function scratch(name: string): string {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), `noto-e2e-${name}-`)));
  made.push(directory);
  return directory;
}

const FIRST = '---\ntitle: A plan\ntags: [plans, probe]\n---\n\n# Plan\n\nFirst.\n';
const SECOND = '---\ntitle: A plan\ntags: [plans, probe]\n---\n\n# Plan\n\nFirst.\n\nMore.\n';
const NOW = '---\ntitle: A plan\ntags: [plans, probe]\n---\n\n# Plan\n\nFirst.\n\nMore.\n\nNot committed.\n';

/** A note written, changed, moved, and changed again on disk. */
function movedNote(): { repo: string; note: string } {
  const repo = scratch('info');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=noto@example.invalid', '-c', 'user.name=Noto', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  mkdirSync(path.join(repo, 'Drafts'));
  mkdirSync(path.join(repo, 'Areas'));
  writeFileSync(path.join(repo, 'Drafts', 'plan.md'), FIRST);
  writeFileSync(path.join(repo, 'kept.md'), '# Kept\n');
  git('add', '-A'); git('commit', '-q', '-m', 'start the plan');
  writeFileSync(path.join(repo, 'Drafts', 'plan.md'), SECOND);
  git('add', '-A'); git('commit', '-q', '-m', 'say more');
  git('mv', 'Drafts/plan.md', 'Areas/plan.md');
  git('commit', '-q', '-m', 'file the plan');
  const note = path.join(repo, 'Areas', 'plan.md');
  writeFileSync(note, NOW);
  return { repo, note };
}

async function launch(folder: string, note: string | null, userData = scratch('user-data')): Promise<{ app: ElectronApplication; page: Page; userData: string }> {
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${userData}`, ...(SHOTS ? ['--force-device-scale-factor=2'] : []), `--folder=${folder}`, ...(note ? [`--open=${note}`] : [])],
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 760 });
  await page.waitForSelector(note ? '[data-testid="noto-editor"]' : '[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
  return { app, page, userData };
}

async function menuItem(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ Menu }, wanted) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | null => {
      for (const item of items) {
        if (item.id === wanted) return item;
        const nested = item.submenu ? find(item.submenu.items) : null;
        if (nested) return nested;
      }
      return null;
    };
    find(Menu.getApplicationMenu()!.items)!.click();
  }, id);
}

async function capture(app: ElectronApplication, file: string): Promise<void> {
  const png = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString('base64'));
  writeFileSync(file, Buffer.from(png, 'base64'));
}

const pane = (page: Page) => page.getByTestId('info-pane');
const editorText = (page: Page) => page.locator('.ProseMirror').innerText();

/** A note with commits two years apart: one long ago, two this year. */
function longNote(): { repo: string; note: string } {
  const repo = scratch('info-long');
  const at = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const commit = (message: string, when: string) => execFileSync('git', ['-c', 'user.email=noto@example.invalid', '-c', 'user.name=Noto', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message],
    { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } });
  execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
  const note = path.join(repo, 'long.md');
  for (const [text, message, days] of [['# Long\n', 'begin', 730], ['# Long\n\nMore.\n', 'more', 700], ['# Long\n\nMore.\n\nNow.\n', 'now', 20]] as const) {
    writeFileSync(note, text);
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    commit(message, at(days));
  }
  return { repo, note };
}

test.describe('the info pane', () => {
  test('lists a note\'s commits through its move, opens one, steps from it, and takes a version back', async () => {
    const { repo, note } = movedNote();
    const { app, page } = await launch(repo, note);
    try {
      await menuItem(app, 'toggle-note-info');
      await expect(pane(page)).toBeVisible();
      await expect(pane(page).getByTestId('info-title')).toHaveText('plan');
      await expect(pane(page).getByTestId('info-state')).toHaveText('Uncommitted changes');
      // Related comes first; in a folder without memory it offers to keep some, and History is next.
      await expect(pane(page).getByTestId('memory-keep')).toBeVisible();
      await pane(page).getByTestId('info-tab').filter({ hasText: 'History' }).click();

      const commits = pane(page).getByTestId('history-commit');
      await expect(commits).toHaveCount(3);
      await expect(commits.locator('.history-subject')).toHaveText(['file the plan', 'say more', 'start the plan']);
      await expect(commits.first().getByTestId('history-moved')).toHaveText('Moved from Drafts/plan.md');
      await expect(pane(page).getByTestId('history-uncommitted')).toContainText('+2 -0');

      // Three commits a moment apart are one mark, and the note's own changes a ring at now.
      await expect(pane(page).getByTestId('info-mark')).toHaveCount(1);
      await expect(pane(page).getByTestId('info-mark')).toHaveAttribute('aria-label', /^3 commits/);
      await expect(pane(page).getByTestId('info-mark-pending')).toBeVisible();
      await expect(pane(page).getByTestId('info-summary')).toHaveText('3 commits, last today');
      if (SHOTS) await capture(app, path.join(SHOTS, 'info-history-light.png'));

      // A commit opens in the diff view; the keys step to the next one and back.
      await commits.nth(1).click();
      const diff = page.getByTestId('version-diff');
      await expect(diff).toBeVisible();
      await expect(diff.locator('.diff-title strong')).toHaveText('say more');
      await expect(diff.getByTestId('version-diff-detail')).toContainText('Noto');
      await expect(commits.nth(1)).toHaveAttribute('aria-current', 'true');
      if (SHOTS) await capture(app, path.join(SHOTS, 'info-diff-light.png'));
      await page.keyboard.press(']');
      await expect(diff.locator('.diff-title strong')).toHaveText('file the plan');
      await expect(diff.getByTestId('version-diff-newer')).toBeDisabled();
      await page.keyboard.press('[');
      await page.keyboard.press('[');
      await expect(diff.locator('.diff-title strong')).toHaveText('start the plan');
      await expect(diff.getByTestId('version-diff-older')).toBeDisabled();

      // Taken back: in the editor at once, on disk only when saved, and Undo reverses it.
      await diff.getByTestId('version-diff-restore').click();
      await expect(diff).toHaveCount(0);
      await expect(pane(page).getByTestId('history-status')).toContainText('Restored the version from');
      await expect.poll(() => editorText(page)).not.toContain('More.');
      expect(readFileSync(note, 'utf8')).toBe(NOW);
      await page.keyboard.press('Meta+z');
      await expect.poll(() => editorText(page)).toContain('Not committed.');

      // A mark on the timeline brings its commit forward in History.
      await pane(page).getByTestId('info-tab').filter({ hasText: 'Properties' }).click();
      await pane(page).getByTestId('info-mark').click();
      await expect(pane(page).getByTestId('info-tab').filter({ hasText: 'History' })).toHaveAttribute('aria-selected', 'true');
      await expect(commits.first()).toBeFocused();
    } finally {
      await app.close();
    }

    // For review only: the same pane in the dark theme.
    if (SHOTS) {
      const userData = scratch('user-data-dark');
      writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ theme: 'dark', infoOpen: true, infoTab: 'dev.lr00rl.noto.history:history' }));
      const dark = await launch(repo, note, userData);
      try {
        await expect(pane(dark.page).getByTestId('history-commit')).toHaveCount(3);
        await pane(dark.page).getByTestId('history-commit').nth(1).click();
        await expect(dark.page.getByTestId('version-diff')).toBeVisible();
        await capture(dark.app, path.join(SHOTS, 'info-diff-dark.png'));
        await dark.page.keyboard.press('Escape');
        await pane(dark.page).getByTestId('info-tab').filter({ hasText: 'Properties' }).click();
        await expect(pane(dark.page).getByTestId('properties-field')).toHaveCount(2);
        await dark.page.waitForTimeout(300);
        await capture(dark.app, path.join(SHOTS, 'info-properties-dark.png'));
      } finally {
        await dark.app.close();
      }
    }
  });

  test('shows a note\'s properties, opens from Get Info, comes back open, and says when there is no git', async () => {
    const { repo, note } = movedNote();
    let { app, page, userData } = await launch(repo, note);
    try {
      await menuItem(app, 'toggle-note-info');
      await pane(page).getByTestId('info-tab').filter({ hasText: 'Properties' }).click();
      const fields = pane(page).getByTestId('properties-field');
      await expect(fields).toHaveCount(2);
      await expect(fields.first()).toContainText('title');
      await expect(fields.first()).toContainText('A plan');
      await expect(fields.nth(1)).toContainText('plans, probe');
      await expect(pane(page).getByTestId('properties-first')).toContainText('Today');
      await expect(pane(page).getByTestId('properties-path')).toContainText(path.join('Areas', 'plan.md'));
      if (SHOTS) await capture(app, path.join(SHOTS, 'info-properties-light.png'));

      // Closed, then opened again from the tree's own menu on the note.
      await pane(page).getByTestId('info-close').click();
      await expect(pane(page)).toHaveCount(0);
      await app.evaluate(({ Menu }) => {
        Menu.prototype.popup = function popup(this: Electron.Menu) {
          this.items.find((item) => item.label === 'Get Info')!.click();
        };
      });
      await page.locator(`[data-testid="tree-file"][data-path="${note}"]`).click({ button: 'right' });
      await expect(pane(page)).toBeVisible();
      await expect(pane(page).getByTestId('info-tab').filter({ hasText: 'Properties' })).toHaveAttribute('aria-selected', 'true');
    } finally {
      await app.close();
    }

    // The pane, and the tab in front, are as they were left.
    ({ app, page } = await launch(repo, note, userData));
    try {
      await expect(pane(page)).toBeVisible();
      await expect(pane(page).getByTestId('info-tab').filter({ hasText: 'Properties' })).toHaveAttribute('aria-selected', 'true');
    } finally {
      await app.close();
    }

    const plain = scratch('info-plain');
    writeFileSync(path.join(plain, 'loose.md'), '# Loose\n\nNo git here.\n');
    ({ app, page } = await launch(plain, path.join(plain, 'loose.md'), userData));
    try {
      await expect(pane(page).getByTestId('info-state')).toHaveText('Not in git');
      await pane(page).getByTestId('info-tab').filter({ hasText: 'History' }).click();
      await expect(pane(page).getByTestId('history-state')).toHaveAttribute('data-state', 'not-git');
      await expect(pane(page).getByTestId('history-state')).toContainText('not in git');
      await expect(pane(page).getByTestId('info-timeline')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('draws a long note\'s last year, with what came before as one mark, and all of it when asked', async () => {
    const { repo, note } = longNote();
    const { app, page } = await launch(repo, note);
    try {
      await menuItem(app, 'toggle-note-info');
      const marks = pane(page).getByTestId('info-mark');
      await expect(marks.first()).toHaveAttribute('aria-label', /^2 commits before /, { timeout: 20_000 });
      await expect(marks.first()).toHaveClass(/is-earlier/);
      await expect(marks).toHaveCount(2);
      const span = pane(page).getByTestId('info-axis-span');
      await expect(span).toHaveText(/^Earlier · /);
      if (SHOTS) await capture(app, path.join(SHOTS, 'info-timeline-year.png'));
      await span.click();
      await expect(span).toHaveAttribute('aria-pressed', 'true');
      await expect(pane(page).locator('.info-mark.is-earlier')).toHaveCount(0);
      if (SHOTS) await capture(app, path.join(SHOTS, 'info-timeline-all.png'));
    } finally {
      await app.close();
    }
  });
});

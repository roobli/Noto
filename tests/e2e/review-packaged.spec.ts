/**
 * Review, the rail page of what waits on the person, in the packaged app.
 *
 * A folder under git that keeps memory, where a note moved (so a link still
 * names where it used to be), two notes name a third without linking it, and
 * an agent left two proposals, made with git's plumbing in the format the
 * vault documents. What is pinned: the badge counts the proposals and the
 * stale link; a proposal opens in the diff view, Accept takes it in and Undo
 * puts the note back, Reject asks once more and then deletes it; Fix All
 * mends the stale link; the names are linked from the keyboard alone, one at
 * a time; a note with unsaved edits is left alone and said to be; and what
 * was said no to can be brought back.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

/** Screenshots for review, when asked for: `NOTO_REVIEW_SHOTS=/some/dir`, in the theme `NOTO_REVIEW_THEME` names. */
const SHOTS = process.env.NOTO_REVIEW_SHOTS ?? '';
const THEME = process.env.NOTO_REVIEW_THEME === 'dark' ? 'dark' : 'light';

async function capture(app: ElectronApplication, name: string): Promise<void> {
  if (!SHOTS) return;
  const png = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  writeFileSync(path.join(SHOTS, `${name}-${THEME}.png`), Buffer.from(png, 'base64'));
}

const made: string[] = [];
test.afterAll(() => {
  for (const directory of made) rmSync(directory, { recursive: true, force: true });
});

function scratch(name: string): string {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), `noto-e2e-${name}-`)));
  made.push(directory);
  return directory;
}

function write(root: string, rel: string, text: string): void {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text, 'utf8');
}

const read = (root: string, rel: string) => readFileSync(path.join(root, rel), 'utf8');

const TARGET = '# Target\n\nThe note that moved.\n';
const SAID_MORE = '# Target\n\nThe note that moved, and what it is for.\n';

function git(root: string, args: readonly string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync('git', ['-c', 'user.email=noto@example.invalid', '-c', 'user.name=Noto', '-c', 'commit.gpgsign=false', ...args], {
    cwd: root, input: options.input, env: { ...process.env, ...options.env },
  }).toString().trim();
}

/**
 * A proposal as `@roobli/vault` records one: under refs/noto/proposals, a
 * commit holding the file as it is, and on it the change, by an agent.
 */
function propose(root: string, id: string, subject: string, rel: string, text: string): void {
  const index = path.join(scratch('proposal-index'), 'index');
  const env = { GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: 'claude-code', GIT_AUTHOR_EMAIL: 'agent@example.invalid', GIT_COMMITTER_NAME: 'claude-code', GIT_COMMITTER_EMAIL: 'agent@example.invalid' };
  git(root, ['read-tree', 'HEAD'], { env });
  const base = git(root, ['commit-tree', git(root, ['write-tree'], { env }), '-p', 'HEAD', '-m', `base: ${subject}`], { env });
  const blob = git(root, ['hash-object', '-w', '--stdin'], { input: text });
  git(root, ['update-index', '--add', '--cacheinfo', `100644,${blob},${rel}`], { env });
  const commit = git(root, ['commit-tree', git(root, ['write-tree'], { env }), '-p', base, '-m', subject], { env });
  git(root, ['update-ref', `refs/noto/proposals/${id}`, commit]);
}

function reviewFolder(): string {
  const root = scratch('review');
  git(root, ['init', '-q']);
  write(root, 'Old/target.md', TARGET);
  write(root, 'notes.md', '# Notes\n\nSee [the target](Old/target.md) first.\n');
  write(root, '目标设计说明.md', '# 目标设计说明\n\n怎么做。\n');
  write(root, 'essay.md', '# Essay\n\n先读目标设计说明，再动手。\n');
  write(root, 'plan.md', '# Plan\n\n写完目标设计说明之后再排期。\n');
  write(root, '.noto/brain.yaml', 'kinds:\n  dated_names_are_logs: true\n');
  write(root, '.noto/access.yaml', 'sensitivity:\n  default: open\n  private: []\n  sealed: []\n\nprincipals: {}\n');
  write(root, '.noto/.gitignore', 'index.sqlite*\nevents/\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'first']);
  mkdirSync(path.join(root, 'New'));
  git(root, ['mv', 'Old/target.md', 'New/target.md']);
  git(root, ['commit', '-q', '-m', 'move the target']);
  propose(root, '20261105-120000-say-what-the-target-is-for', 'Say what the target is for', 'New/target.md', SAID_MORE);
  propose(root, '20261105-120100-retitle-the-plan', 'Retitle the plan', 'plan.md', '# Schedule\n\n写完目标设计说明之后再排期。\n');
  return root;
}

async function launch(folder: string, note: string): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = scratch('user-data');
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ theme: THEME }));
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${userData}`, ...(SHOTS ? ['--force-device-scale-factor=2'] : []), `--folder=${folder}`, `--open=${note}`],
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1200, height: 760 });
  await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
  return { app, page };
}

const toggle = (page: Page) => page.locator('[data-testid="rail-page-toggle"][data-page="dev.lr00rl.noto.memory:review"]');
const view = (page: Page) => page.getByTestId('rail-plugin-view');
const kind = (page: Page, name: string) => view(page).locator(`[data-testid="review-kind"][data-kind="${name}"]`);

test.describe('the Review page', () => {
  test('counts what waits, takes a proposal in from the diff view and back with Undo, and rejects one', async () => {
    const root = reviewFolder();
    const { app, page } = await launch(root, path.join(root, 'notes.md'));
    try {
      // Two proposals and one link that still names where its note was.
      await expect(toggle(page).getByTestId('rail-page-badge')).toHaveText('3', { timeout: 30_000 });
      await toggle(page).click();
      const proposals = view(page).getByTestId('review-proposal');
      await expect(proposals).toHaveCount(2);
      await expect(kind(page, 'mention').getByTestId('review-count')).toHaveText('2', { timeout: 30_000 });
      await capture(app, 'review-list');

      await proposals.filter({ hasText: 'Say what the target is for' }).click();
      const diff = page.getByTestId('version-diff');
      await expect(diff).toBeVisible();
      await expect(diff.getByTestId('version-diff-detail')).toContainText('claude-code');
      await capture(app, 'review-proposal');
      await expect(diff.getByTestId('version-diff-detail')).toContainText('New/target.md');
      await diff.getByTestId('version-diff-accept').click();
      await expect.poll(() => read(root, 'New/target.md')).toBe(SAID_MORE);
      await expect(page.getByTestId('version-diff')).toHaveCount(0);
      await expect(view(page).getByTestId('review-status')).toContainText('Took in the changes to 1 note');
      await expect(proposals).toHaveCount(1);
      // Undo puts the note back as it was, since nothing wrote to it since.
      await view(page).getByTestId('review-undo').click();
      await expect.poll(() => read(root, 'New/target.md')).toBe(TARGET);
      await expect(view(page).getByTestId('review-status')).toContainText('Put 1 note back as it was');

      // Reject asks once more, then the proposal is gone and nothing was written.
      await proposals.filter({ hasText: 'Retitle the plan' }).click();
      await diff.getByTestId('version-diff-reject').click();
      await diff.getByTestId('version-diff-reject-for-good').click();
      await expect(proposals).toHaveCount(0);
      expect(git(root, ['for-each-ref', 'refs/noto/proposals'])).toBe('');
      expect(read(root, 'plan.md')).toContain('# Plan');
    } finally {
      await app.close();
    }
  });

  test('fixes the stale link, links names from the keyboard, leaves an unsaved note alone, and brings back a no', async () => {
    const root = reviewFolder();
    const { app, page } = await launch(root, path.join(root, 'essay.md'));
    try {
      await toggle(page).click();
      await expect(kind(page, 'stale').getByTestId('review-count')).toHaveText('1', { timeout: 30_000 });
      await kind(page, 'stale').getByTestId('review-fix-all').click();
      await expect.poll(() => read(root, 'notes.md')).toContain('(New/target.md)');
      await expect(view(page).getByTestId('review-status')).toContainText('Linked');

      // The names: counted on their own worker, then gone through by key.
      await expect(kind(page, 'mention').getByTestId('review-count')).toHaveText('2', { timeout: 30_000 });
      await kind(page, 'mention').getByTestId('review-start').click();
      const queue = view(page).getByTestId('review-queue');
      await expect(queue).toBeFocused();
      const card = queue.getByTestId('review-card');
      const from = () => card.locator('.review-where .memory-link').getAttribute('title');
      await expect(queue.getByTestId('review-position')).toHaveText('1 of 2');
      // The line reads as it will once linked: the name drawn as the link.
      await expect(card.locator('.review-linked')).toHaveText('目标设计说明');
      await capture(app, 'review-queue');
      if ((await from()) === 'essay.md') {
        await page.keyboard.press('s');
        await expect(queue.getByTestId('review-position')).toHaveText('2 of 2');
      }
      expect(await from()).toBe('plan.md');
      await page.keyboard.press('y');
      await expect.poll(() => read(root, 'plan.md')).toContain('[[目标设计说明]]');
      await page.keyboard.press('Escape');
      await expect(view(page).getByTestId('review-queue')).toHaveCount(0);

      // essay.md is open: with unsaved edits in it, Link leaves it alone and says so.
      await page.locator('.ProseMirror').click();
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
      await page.keyboard.type(' 还没存。');
      await kind(page, 'mention').getByTestId('review-start').click();
      await expect(view(page).getByTestId('review-queue')).toBeFocused();
      expect(await from()).toBe('essay.md');
      await page.keyboard.press('y');
      await expect(view(page).getByTestId('review-status')).toContainText('unsaved edits');
      expect(read(root, 'essay.md')).not.toContain('[[');
      await page.keyboard.press('n');
      await expect(view(page).getByTestId('review-queue-end')).toBeVisible();
      await page.keyboard.press('Escape');

      // What was said no to is listed, and comes back on request.
      await expect(view(page).getByTestId('review-dismissed')).toContainText('1');
      await view(page).getByTestId('review-dismissed').click();
      await expect(view(page).getByTestId('review-dismissal')).toContainText('essay → 目标设计说明');
      await view(page).getByTestId('review-dismissal').getByRole('button', { name: 'Bring Back' }).click();
      await expect(view(page).getByTestId('review-status')).toContainText('One suggestion comes back');
      expect(existsSync(path.join(root, '.noto', 'dismissed.jsonl'))).toBe(true);
    } finally {
      await app.close();
    }
  });
});

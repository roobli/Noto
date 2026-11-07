/**
 * Every way into the app that What Noto Can Do offers, in the packaged app:
 * each Show Me and Try It closes the guide and leaves the window where the
 * entry says, Settings among them filling the window as it does from the
 * gear; no key's name runs out of its column over the words beside it; and
 * a Try It that needs a folder or a note says so in its place when there is
 * none, rather than closing the guide on nothing.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

const made: string[] = [];
test.afterAll(() => { for (const directory of made) rmSync(directory, { recursive: true, force: true }); });

function scratch(name: string): string {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), `noto-e2e-${name}-`)));
  made.push(directory);
  return directory;
}

/** In git and keeping memory, with a change not committed, so every page has something to show. */
function vault(): string {
  const root = scratch('guide-try');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=noto@example.invalid', '-c', 'user.name=Noto', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'ignore' });
  mkdirSync(path.join(root, 'Notes'));
  mkdirSync(path.join(root, '.noto'));
  writeFileSync(path.join(root, '.noto', 'brain.yaml'), 'kinds:\n  dated_names_are_logs: true\n');
  writeFileSync(path.join(root, 'Notes', 'plan.md'), '# Plan\n\nBuild on [[Argus]].\n\n## Steps\n\nOne.\n');
  writeFileSync(path.join(root, 'Notes', 'Argus.md'), '# Argus\n\nThe audit service.\n');
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'begin');
  writeFileSync(path.join(root, 'Notes', 'plan.md'), '# Plan\n\nBuild on [[Argus]].\n\n## Steps\n\nOne. Two.\n');
  return root;
}

async function launch(args: string[]): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ executablePath: packagedExecutable(), args: [`--user-data-dir=${scratch('user-data')}`, ...args] });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForSelector('[data-testid="file-tree"], [data-testid="empty-state"]', { timeout: 30_000 });
  return { app, page };
}

const focused = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);

/** Where each one leads, said as what the window must then show. */
const LEADS: Record<string, (page: Page) => Promise<void>> = {
  'note-info': async (page) => {
    await expect(page.getByTestId('info-pane')).toBeVisible();
    await expect(page.locator('[data-testid="info-tab"][aria-selected="true"]')).toHaveText('Related');
  },
  'note-history': async (page) => {
    await expect(page.locator('[data-testid="info-tab"][aria-selected="true"]')).toHaveText('History');
  },
  ask: async (page) => { await expect.poll(() => focused(page)).toBe('memory-ask-field'); },
  review: async (page) => { await expect(page.getByTestId('review-page')).toBeVisible(); },
  changes: async (page) => { await expect(page.getByTestId('changes-page')).toBeVisible(); },
  'folder-info': async (page) => { await expect(page.getByTestId('info-pane')).toHaveAttribute('data-folder', /[\\/]Notes$/); },
  'settings-memory': async (page) => {
    await expect(page.getByTestId('memory-pane')).toBeVisible();
    // The whole window, as the gear opens it, not a strip at the top of the page.
    const box = await page.getByTestId('settings-scrim').boundingBox();
    expect(box).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
  },
  outline: async (page) => { await expect(page.getByTestId('outline-panel')).toBeVisible(); },
  search: async (page) => { await expect.poll(() => focused(page)).toBe('search-input'); },
  'quick-open': async (page) => { await expect.poll(() => focused(page)).toBe('quick-input'); },
  palette: async (page) => { await expect.poll(() => focused(page)).toBe('palette-input'); },
};

test.describe('the guide\'s ways in', () => {
  for (const [action, arrived] of Object.entries(LEADS)) {
    test(`${action} goes where it says`, async () => {
      const root = vault();
      const { app, page } = await launch([`--folder=${root}`, `--open=${path.join(root, 'Notes', 'plan.md')}`]);
      try {
        await page.waitForSelector('[data-testid="noto-editor"]', { timeout: 30_000 });
        await page.getByTestId('guide-toggle').click();
        await page.locator(`[data-testid="shortcuts-try"][data-try="${action}"]`).first().click();
        await expect(page.getByTestId('shortcuts-panel')).toHaveCount(0);
        await arrived(page);
      } finally {
        await app.close();
      }
    });
  }

  test('no key runs out of its column, and what needs a folder says so when there is none', async () => {
    const { app, page } = await launch([]);
    try {
      await page.getByTestId('guide-toggle').click();
      const spilled = await page.evaluate(() => [...document.querySelectorAll('.shortcuts-row')].flatMap((row) => {
        const column = row.querySelector('dt')!.getBoundingClientRect();
        return [...row.querySelectorAll('kbd')].filter((key) => key.getBoundingClientRect().right > column.right + 0.5).map((key) => key.textContent);
      }));
      expect(spilled).toEqual([]);
      // Nothing open: these say what they need instead of closing the guide on nothing; the palette still goes.
      await expect(page.locator('[data-testid="shortcuts-later"][data-try="review"]').first()).toHaveText('Open a folder first');
      await expect(page.locator('[data-testid="shortcuts-later"][data-try="note-history"]').first()).toHaveText('Open a note first');
      await expect(page.locator('[data-testid="shortcuts-try"][data-try="palette"]')).toBeVisible();
    } finally {
      await app.close();
    }
  });
});

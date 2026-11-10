/**
 * One passage's history, in the packaged app: a right click on a paragraph
 * offers History of This Passage, which opens History on the commits that
 * changed those lines and no others, following the paragraph where it moved;
 * Show All brings the rest back.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

const made: string[] = [];
test.afterAll(() => {
  for (const directory of made) rmSync(directory, { recursive: true, force: true });
});

function scratch(name: string): string {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), `noto-e2e-${name}-`)));
  made.push(directory);
  return directory;
}

/** A note in git, three commits: both paragraphs written, the first touched, then a line opened above and the second touched. */
function repository(): { root: string; note: string } {
  const root = scratch('passage');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=noto@example.invalid', '-c', 'user.name=Noto', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'ignore' });
  const note = path.join(root, 'plan.md');
  git('init', '-q');
  writeFileSync(note, '# Plan\n\nThe first paragraph.\n\nThe second paragraph.\n');
  git('add', '-A'); git('commit', '-q', '-m', 'Write both');
  writeFileSync(note, '# Plan\n\nThe first paragraph, longer.\n\nThe second paragraph.\n');
  git('add', '-A'); git('commit', '-q', '-m', 'Touch the first');
  writeFileSync(note, '# Plan\n\nAn opening line.\n\nThe first paragraph, longer.\n\nThe second paragraph, edited.\n');
  git('add', '-A'); git('commit', '-q', '-m', 'Open, and touch the second');
  return { root, note };
}

test('narrows History to the commits that changed one passage', async () => {
  const { root, note } = repository();
  const userData = scratch('user-data');
  const app = await electron.launch({ executablePath: packagedExecutable(), args: [`--user-data-dir=${userData}`, `--folder=${root}`, `--open=${note}`] });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 900 });
    const paragraph = page.locator('.canvas-slot:not([hidden]) .ProseMirror p').filter({ hasText: 'The first paragraph, longer.' });
    await paragraph.waitFor({ state: 'visible', timeout: 30_000 });
    // The native menu cannot be clicked from here: record what it would show and choose the item.
    await app.evaluate(({ Menu }) => {
      const state = globalThis as unknown as { __shown: string[][] };
      state.__shown = [];
      Menu.prototype.popup = function popup(this: Electron.Menu) {
        state.__shown.push(this.items.map((item) => item.label));
        this.items.find((item) => item.label === 'History of This Passage')?.click();
      } as typeof Menu.prototype.popup;
    });
    // The gutter is told the note is in git a moment after it opens.
    await expect.poll(async () => {
      await paragraph.click({ button: 'right' });
      return app.evaluate(() => (globalThis as unknown as { __shown: string[][] }).__shown.at(-1) ?? []);
    }, { timeout: 15_000 }).toContain('History of This Passage');

    const pane = page.getByTestId('info-pane');
    await expect(pane.getByTestId('history-passage')).toContainText('line 5 of the last commit: 2 commits changed it');
    await expect(pane.getByTestId('history-commit')).toHaveText([/Touch the first/, /Write both/]);
    await pane.getByTestId('history-passage-clear').click();
    await expect(pane.getByTestId('history-commit')).toHaveCount(3);
  } finally {
    await app.close();
  }
});

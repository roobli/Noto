import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';
import { packagedExecutable, placeCaret } from './packaged-app';

const NOTE = '# One\n\n## One A\n\n### One A i\n\n## One B\n\n# Two\n\nwords\n';

test('a heading folds its branch shut in the outline, and opens it again', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'outline-fold');
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const vault = path.join(workspace, 'vault');
  await mkdir(vault, { recursive: true });
  await writeFile(path.join(vault, 'headings.md'), NOTE, 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, vault],
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
    await page.getByTestId('tree-file').first().click();
    await page.locator('.canvas-slot:not([hidden]) [data-testid="noto-editor"]').waitFor({ state: 'visible' });
    await page.getByTestId('outline-toggle').click();

    const rows = page.getByTestId('outline-entry');
    await expect(rows).toHaveCount(5);
    const one = rows.filter({ hasText: /^One$/ });
    await expect(one).toHaveAttribute('aria-expanded', 'true');
    // A heading with nothing under it has no branch to fold.
    await expect(rows.filter({ hasText: /^Two$/ })).not.toHaveAttribute('aria-expanded', /.*/);

    // Folding takes the three headings under One away and leaves One and Two.
    await one.getByTestId('outline-twisty').click();
    await expect(rows).toHaveCount(2);
    await expect(one).toHaveAttribute('aria-expanded', 'false');
    await expect(one).toHaveClass(/is-closed/);

    // The caret's heading is inside the closed branch, so the closed row is
    // the current one. Then the branch is opened from the keyboard. The row
    // was current before the click too, so the click has to have landed
    // before focus moves to the outline, or the caret stays on One.
    await placeCaret(page, page.locator('.canvas-slot:not([hidden]) .ProseMirror h3'));
    await expect(one).toHaveClass(/is-current/);
    await one.focus();
    await page.keyboard.press('ArrowRight');
    await expect(rows).toHaveCount(5);
    await expect(rows.filter({ hasText: /^One A i$/ })).toHaveClass(/is-current/);
    await expect(one).not.toHaveClass(/is-current/);

    // Folding does not also go to the heading: the caret stays where it was.
    await one.getByTestId('outline-twisty').click();
    await expect(rows).toHaveCount(2);
    expect(await page.evaluate(() => window.getSelection()?.anchorNode?.parentElement?.closest('h3') !== null)).toBe(true);
  } finally {
    await app.close();
  }
});

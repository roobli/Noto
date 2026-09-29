import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

test('a wiki link is resolved against the folder the note lives in', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'wiki-links');
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const vault = path.join(workspace, 'vault');
  // The shape the author's vault has: an index in a folder, linking to the
  // index of a folder beside it.
  await mkdir(path.join(vault, 'works', 'lab网络规划'), { recursive: true });
  await mkdir(path.join(vault, 'elsewhere'), { recursive: true });
  await writeFile(
    path.join(vault, 'works', '00_索引.md'),
    '# 索引\n\n- [[lab网络规划/00_索引|lab网络规划]]（20 篇）\n- [[elsewhere/00_索引|elsewhere]]\n',
    'utf8',
  );
  await writeFile(path.join(vault, 'works', 'lab网络规划', '00_索引.md'), '# vpn\n\nThe vpn index.\n', 'utf8');
  await writeFile(path.join(vault, 'elsewhere', '00_索引.md'), '# elsewhere\n\nThe other index.\n', 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, vault],
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
    await page.getByTestId('tree-directory').filter({ hasText: 'works' }).click();
    await page.getByTestId('tree-file').filter({ hasText: '00_索引' }).first().click();
    const editor = page.locator('.canvas-slot:not([hidden]) .ProseMirror');
    await expect(editor).toContainText('lab网络规划');

    // A path relative to this note's own folder, which is neither a path from
    // the vault root nor a bare name.
    await editor.locator('.noto-wiki-link, a').filter({ hasText: 'lab网络规划' }).first()
      .click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
    await expect(page.locator('.canvas-slot:not([hidden]) .ProseMirror')).toContainText('The vpn index.', { timeout: 15_000 });
    await expect(page.getByTestId('file-truth-alert')).toHaveCount(0);

    // And one that only resolves from the root still does. Back along the
    // trail rather than through the tree, which now holds two notes of that
    // name and would need the right one picked out of them.
    await page.getByTestId('nav-back').click();
    await expect(page.locator('.canvas-slot:not([hidden]) .ProseMirror')).toContainText('（20 篇）');
    await page.locator('.canvas-slot:not([hidden]) .ProseMirror .noto-wiki-link, .canvas-slot:not([hidden]) .ProseMirror a')
      .filter({ hasText: 'elsewhere' }).first()
      .click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
    await expect(page.locator('.canvas-slot:not([hidden]) .ProseMirror')).toContainText('The other index.', { timeout: 15_000 });
  } finally {
    await app.close();
  }
});

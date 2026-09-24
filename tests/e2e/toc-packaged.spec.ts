import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';
import { packagedExecutable, placeCaretAtEnd } from './packaged-app';

const NOTE = '# Guide\n\n[TOC]\n\n## Setup\n\nwords\n\n### Install\n\n## Use\n\nmore\n';

test('[TOC] is drawn as the headings, goes to one on a click, and shows itself under the caret', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'toc');
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const vault = path.join(workspace, 'vault');
  await mkdir(vault, { recursive: true });
  await writeFile(path.join(vault, 'guide.md'), NOTE, 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, vault],
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
    await page.getByTestId('tree-file').first().click();
    const editor = page.locator('.canvas-slot:not([hidden]) .ProseMirror');
    await editor.waitFor({ state: 'visible' });

    const toc = editor.locator('.noto-toc');
    await expect(toc).toBeVisible();
    await expect(toc.locator('.noto-toc-item')).toHaveText(['Guide', 'Setup', 'Install', 'Use']);
    // Stepped in by level from the shallowest heading.
    await expect(toc.locator('.noto-toc-item').nth(2)).toHaveCSS('margin-inline-start', /[1-9]/);
    // The marker itself is out of sight.
    expect(await editor.evaluate((node) => (node as HTMLElement).innerText)).not.toContain('[TOC]');

    // A click goes to the heading.
    await toc.locator('.noto-toc-item').filter({ hasText: 'Install' }).click();
    await expect(editor.locator('.noto-active-block')).toHaveText('Install');

    // Typing a heading changes the list.
    // Meta+ArrowRight / End can leave the caret at the click point on packaged
    // macOS; place it at the end of the active heading via Selection API.
    await placeCaretAtEnd(page, editor.locator('.noto-active-block'));
    await expect(editor.locator('.noto-active-block')).toHaveText('Install');
    await page.keyboard.type('ation');
    await expect(toc.locator('.noto-toc-item').nth(2)).toHaveText('Installation');

    // A click on the list beside its entries puts the caret in the marker,
    // which then shows itself to edit; the list is gone while it does.
    const box = (await toc.boundingBox())!;
    await toc.click({ position: { x: box.width - 6, y: 4 } });
    await expect(editor.locator('.noto-toc')).toHaveCount(0);
    await expect(editor.locator('.noto-active-block')).toHaveText('[TOC]');
  } finally {
    await app.close();
  }
});

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';
import { packagedExecutable, placeCaretAtEnd } from './packaged-app';

const NOTES = 30;
const name = (index: number) => `n${String(index).padStart(2, '0')}.md`;

test('opens note after note from the tree, keeping a working set and every unsaved note', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'many-notes');
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const vault = path.join(workspace, 'vault');
  await mkdir(vault, { recursive: true });
  for (let index = 1; index <= NOTES; index += 1) {
    await writeFile(path.join(vault, name(index)), `# Note ${index}\n\nBody ${index}.\n`, 'utf8');
  }
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, vault],
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
    const identity = page.getByTestId('document-identity');

    // The first note is edited and left unsaved.
    await page.getByTestId('tree-file').filter({ hasText: name(1) }).first().click();
    await expect(identity).toContainText(name(1));
    await placeCaretAtEnd(page, page.locator('.canvas-slot:not([hidden]) .ProseMirror > p').first());
    await page.keyboard.type(' Unsaved words.');
    await expect(page.getByTestId('unsaved-dot')).toBeVisible();

    // Every later note opens. They used to stop at the 25th: each one stayed
    // loaded, main refused past 24, and the refusal was drawn nowhere.
    for (let index = 2; index <= NOTES; index += 1) {
      await page.getByTestId('tree-file').filter({ hasText: name(index) }).first().click();
      await expect(identity, name(index)).toContainText(name(index));
    }

    // Only a working set stays loaded: the most recent twelve, and the note
    // with unsaved changes, which is never let go.
    await expect.poll(async () => page.locator('.canvas-slot').count()).toBeLessThanOrEqual(13);
    await page.getByTestId('tree-file').filter({ hasText: name(1) }).first().click();
    await expect(identity).toContainText(name(1));
    await expect(page.locator('.canvas-slot:not([hidden]) .ProseMirror')).toContainText('Unsaved words.');
  } finally {
    await app.close();
  }
});

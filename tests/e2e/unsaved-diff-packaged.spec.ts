import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable, placeCaretAtEnd } from './packaged-app';

const resultRoot = path.join(process.cwd(), 'test-results', 'unsaved-diff');

const NOTE = [
  '# A note',
  '',
  'The first paragraph stays as it is.',
  '',
  'The second paragraph is about to change.',
  '',
  ...Array.from({ length: 12 }, (_, index) => [`Unchanged paragraph ${index}.`, '']).flat(),
  'The last paragraph.',
  '',
].join('\n');

async function launch(name: string): Promise<{ app: ElectronApplication; page: Page }> {
  const workspace = path.join(resultRoot, name);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const file = path.join(workspace, 'note.md');
  await writeFile(file, NOTE, 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${file}`],
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
  await page.setViewportSize({ width: 1280, height: 800 });
  return { app, page };
}

const paragraph = (page: Page, text: string) =>
  page.locator('.canvas-slot:not([hidden]) .ProseMirror > p').filter({ hasText: text }).first();

test.describe('the unsaved changes', () => {
  test('open from the note\'s name, in three layouts that show the same changes', async () => {
    const { app, page } = await launch('three-layouts');
    try {
      // A clean note's name is only a name.
      await expect(page.getByTestId('document-name')).toHaveCount(0);

      await placeCaretAtEnd(page, paragraph(page, 'The second paragraph'));
      await page.keyboard.type(' Edited now');
      await placeCaretAtEnd(page, paragraph(page, 'The last paragraph.'));
      await page.keyboard.press('Enter');
      await page.keyboard.type('A paragraph that is new.');

      await page.getByTestId('document-name').click();
      const view = page.getByTestId('unsaved-diff');
      await expect(view).toBeVisible();
      await expect(page.getByTestId('unsaved-diff-summary')).toHaveText('2 changes: 1 edited, 1 added');
      await expect(page.getByTestId('unsaved-diff-count')).toHaveText('1 of 2');

      // Side by side: the edited block on both sides, the new words marked on
      // the right only, and the added block against an empty left.
      await expect(view).toHaveAttribute('data-layout', 'side');
      const edited = view.locator('.diff-pair.is-modified');
      await expect(edited.locator('.diff-block.is-removed')).toContainText('The second paragraph is about to change.');
      await expect(edited.locator('.diff-block.is-added .diff-word-added')).toHaveText(' Edited now');
      await expect(view.locator('.diff-pair.is-added .diff-filler')).toHaveCount(1);
      // The long unchanged middle folds away.
      await expect(view.locator('.diff-fold')).toContainText('unchanged blocks');

      await page.getByTestId('unsaved-diff-next').click();
      await expect(page.getByTestId('unsaved-diff-count')).toHaveText('2 of 2');
      await expect(view.locator('.diff-block.is-active')).toContainText('A paragraph that is new.');

      // Stacked: pointing at the edit in the saved pane lights it in the other.
      await page.getByTestId('unsaved-diff-layout-stacked').click();
      await expect(view).toHaveAttribute('data-layout', 'stacked');
      const panes = view.locator('.diff-pane');
      await expect(panes).toHaveCount(2);
      await panes.nth(0).locator('.diff-block.is-removed').hover();
      await expect(panes.nth(1).locator('.diff-block.is-added.is-linked')).toContainText('Edited now');
      await expect(panes.nth(0).locator('.diff-gap.is-added')).toHaveCount(1);

      // Inline: one text, what changed marked where it happened.
      await page.getByTestId('unsaved-diff-layout-inline').click();
      await expect(view.locator('.diff-block.is-modified .diff-word-added')).toHaveText(' Edited now');
      await expect(view.locator('.diff-block.is-added')).toContainText('A paragraph that is new.');

      // Closed with Escape, and opened again from the palette's way in: the
      // layout last chosen is the one it opens in.
      await page.keyboard.press('Escape');
      await expect(view).toHaveCount(0);
      await page.getByTestId('document-name').click();
      await expect(page.getByTestId('unsaved-diff')).toHaveAttribute('data-layout', 'inline');

      // The page under the view takes no input while it is up.
      await expect(page.locator('#document-canvas')).toHaveJSProperty('inert', true);

      // Saved while on view: nothing is unsaved, so the reading closes rather
      // than going on showing changes that are now in the file.
      await page.getByTestId('save-button').click();
      await expect(page.getByTestId('unsaved-diff')).toHaveCount(0);
      await expect(page.getByTestId('document-name')).toHaveCount(0);
      await expect(page.locator('#document-canvas')).toHaveJSProperty('inert', false);
    } finally {
      await app.close();
    }
  });
});

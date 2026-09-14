/**
 * Feel acceptance for focused-block + span-level wiki source.
 *
 * A MOC / DailyNews-style list of `[[path|title]]` rows must not show every
 * pair of brackets while the caret is in one item. Only the focused textblock
 * may reveal, and within that block only the wiki match under the caret.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable, placeCaret } from './packaged-app';

const resultRoot = path.join(process.cwd(), 'test-results', 'focus-source');

const MOC = [
  '# Index',
  '',
  'Intro with [[hub|Hub]] and [[other|Other]] plus [[third|Third]] in one paragraph.',
  '',
  '- [[a/00_索引|Alpha]]',
  '- [[b/00_索引|Beta]]',
  '- [[c/00_索引|Gamma]]',
  '',
].join('\n');

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const workspace = path.join(resultRoot, 'moc');
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const file = path.join(workspace, '00_索引.md');
  await writeFile(file, MOC, 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${file}`],
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
  await page.setViewportSize({ width: 1100, height: 700 });
  return { app, page };
}

function bracketDisplay(locator: ReturnType<Page['locator']>): Promise<string[]> {
  return locator.evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).display));
}

test.describe('focused-block wiki source', () => {
  test('caret in one list item does not reveal wiki brackets in siblings', async () => {
    const { app, page } = await launch();
    try {
      const editor = page.locator('.canvas-slot:not([hidden]) .ProseMirror');
      await expect(editor).toContainText('Beta');

      const betaItem = editor.locator('li').filter({ hasText: 'Beta' });
      // Place caret inside the wiki match (on the label) so span-active fires.
      await placeCaret(page, betaItem.locator('.noto-wiki-link'));
      await expect(betaItem.locator('.noto-source-editing')).toHaveCount(1);

      const alphaBrackets = editor.locator('li').filter({ hasText: 'Alpha' }).locator('.noto-wiki-bracket');
      const betaBrackets = betaItem.locator('.noto-wiki-bracket');
      const betaActive = betaItem.locator('.noto-wiki-bracket.noto-wiki-source-active');
      const gammaBrackets = editor.locator('li').filter({ hasText: 'Gamma' }).locator('.noto-wiki-bracket');

      await expect(betaActive.first()).toBeVisible({ timeout: 5_000 });
      expect(await bracketDisplay(betaActive)).toContain('inline');
      expect((await bracketDisplay(alphaBrackets)).every((d) => d === 'none')).toBe(true);
      expect((await bracketDisplay(gammaBrackets)).every((d) => d === 'none')).toBe(true);
      // Non-active brackets in the focused item (if any) stay hidden.
      const betaHidden = await bracketDisplay(betaBrackets);
      expect(betaHidden.filter((d) => d === 'inline').length).toBe(
        (await betaActive.count()),
      );
    } finally {
      await app.close();
    }
  });

  test('three wikis in one paragraph: only the caret match reveals source', async () => {
    const { app, page } = await launch();
    try {
      const editor = page.locator('.canvas-slot:not([hidden]) .ProseMirror');
      const intro = editor.locator('p').filter({ hasText: 'Intro with' });

      // Caret on Other → only that match's brackets/target| visible.
      await placeCaret(page, intro.locator('.noto-wiki-link').filter({ hasText: 'Other' }));
      await expect(intro).toHaveClass(/noto-source-editing/);

      const active = intro.locator('.noto-wiki-bracket.noto-wiki-source-active');
      await expect.poll(async () => (await bracketDisplay(active)).filter((d) => d === 'inline').length)
        .toBeGreaterThanOrEqual(2);

      const allBrackets = intro.locator('.noto-wiki-bracket');
      const displays = await bracketDisplay(allBrackets);
      const inlineCount = displays.filter((d) => d === 'inline').length;
      const noneCount = displays.filter((d) => d === 'none').length;
      expect(inlineCount).toBeGreaterThanOrEqual(2);
      expect(noneCount).toBeGreaterThanOrEqual(4); // Hub + Third brackets stay hidden

      // Caret in the paragraph but off every wiki → all source hidden.
      // Click near the start ("Intro with") so we miss every [[…]] span.
      await intro.click({ position: { x: 12, y: 8 } });
      await expect(intro).toHaveClass(/noto-source-editing/);
      await expect.poll(async () => {
        const d = await bracketDisplay(intro.locator('.noto-wiki-bracket'));
        return d.length > 0 && d.every((x) => x === 'none');
      }).toBe(true);
    } finally {
      await app.close();
    }
  });
});

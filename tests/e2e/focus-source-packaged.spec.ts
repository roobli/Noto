/**
 * Feel acceptance for focused-block wiki source (#48).
 *
 * A MOC / DailyNews-style list of `[[path|title]]` rows must not show every
 * pair of brackets while the caret is in one item. Only the focused textblock
 * reveals wiki brackets; siblings stay title-only. Span-level wiki is deferred.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable, placeCaret } from './packaged-app';

const resultRoot = path.join(process.cwd(), 'test-results', 'focus-source');

const MOC = [
  '# Index',
  '',
  'Intro with [[hub|Hub]] and [[other|Other]] in one paragraph.',
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
      await placeCaret(page, betaItem.locator('p'));
      await expect(betaItem.locator('.noto-source-editing')).toHaveCount(1);

      const alphaBrackets = editor.locator('li').filter({ hasText: 'Alpha' }).locator('.noto-wiki-bracket');
      const betaBrackets = betaItem.locator('.noto-wiki-bracket');
      const gammaBrackets = editor.locator('li').filter({ hasText: 'Gamma' }).locator('.noto-wiki-bracket');

      await expect(betaBrackets.first()).toBeVisible({ timeout: 5_000 });
      expect(await bracketDisplay(betaBrackets)).toContain('inline');
      expect(await bracketDisplay(alphaBrackets)).toEqual(
        expect.arrayContaining([expect.stringMatching(/^none$/)]),
      );
      expect((await bracketDisplay(alphaBrackets)).every((d) => d === 'none')).toBe(true);
      expect((await bracketDisplay(gammaBrackets)).every((d) => d === 'none')).toBe(true);

      // Focused paragraph with two wiki links: block scope reveals both pairs.
      const intro = editor.locator('p').filter({ hasText: 'Intro with' });
      await placeCaret(page, intro);
      await expect(intro).toHaveClass(/noto-source-editing/);
      const introBrackets = intro.locator('.noto-wiki-bracket');
      await expect.poll(async () => (await bracketDisplay(introBrackets)).filter((d) => d === 'inline').length)
        .toBeGreaterThanOrEqual(4);
      expect((await bracketDisplay(betaBrackets)).every((d) => d === 'none')).toBe(true);
    } finally {
      await app.close();
    }
  });
});

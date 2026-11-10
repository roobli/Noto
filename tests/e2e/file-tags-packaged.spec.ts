/**
 * File tags: chips on the note, and Browse Tags across the vault.
 *
 * The author's brief was tags on a file and multi-file linking by tag. The
 * tags stay in frontmatter; this checks that they draw, that a click opens
 * the other notes that share one, and that the Settings switch hides them.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

const resultRoot = path.join(process.cwd(), 'test-results', 'file-tags');

async function invokeMenu(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ Menu }, itemId) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | null => {
      for (const item of items) {
        if (item.id === itemId) return item;
        const nested = item.submenu ? find(item.submenu.items) : null;
        if (nested) return nested;
      }
      return null;
    };
    const menu = Menu.getApplicationMenu();
    const target = menu ? find(menu.items) : null;
    if (!target) throw new Error(`No menu item with id ${itemId}`);
    target.click();
  }, id);
}

interface Workspace { app: ElectronApplication; page: Page; folder: string }

async function launch(name: string): Promise<Workspace> {
  const workspace = path.join(resultRoot, name);
  await rm(workspace, { recursive: true, force: true });
  const folder = path.join(workspace, 'vault');
  await mkdir(folder, { recursive: true });
  await writeFile(
    path.join(folder, 'agent.md'),
    '---\ntags: [agent, cloudflare]\ntype: theory\n---\n\n# Agent\n\nAbout agents.\n',
    'utf8',
  );
  await writeFile(
    path.join(folder, 'linux.md'),
    '---\ntags:\n  - linux\n  - agent\n---\n\n# Linux\n\nAbout linux.\n',
    'utf8',
  );
  await writeFile(path.join(folder, 'plain.md'), '# Plain\n\nNo tags here.\n', 'utf8');

  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${path.join(folder, 'agent.md')}`],
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
  await page.setViewportSize({ width: 1280, height: 900 });

  await app.evaluate(({ dialog }, target) => {
    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog =
      async () => ({ canceled: false, filePaths: [target] });
  }, folder);
  await invokeMenu(app, 'open-folder');
  await expect(page.getByTestId('file-tree')).toBeVisible();
  return { app, page, folder };
}

test.describe('file tags', () => {
  test('draws the note\'s tags and opens the others that share one', async () => {
    const { app, page } = await launch('chips');
    try {
      await expect(page.getByTestId('tag-strip')).toBeVisible();
      await expect(page.getByTestId('tag-chip')).toHaveCount(2);
      await expect(page.getByTestId('tag-chip').nth(0)).toHaveText('agent');
      await expect(page.getByTestId('tag-chip').nth(1)).toHaveText('cloudflare');

      await page.getByTestId('tag-chip').filter({ hasText: 'agent' }).click();
      await expect(page.getByTestId('tag-browser')).toBeVisible();
      await expect(page.getByTestId('tag-browser-note')).toHaveCount(2);
      await expect(page.getByTestId('tag-browser-note').filter({ hasText: 'linux' })).toBeVisible();

      await page.getByTestId('tag-browser-note').filter({ hasText: 'linux' }).click();
      await expect(page.getByTestId('tag-browser')).toBeHidden();
      await expect(page.locator('.canvas-slot:not([hidden]) .ProseMirror h1')).toHaveText('Linux');
      await expect(page.getByTestId('tag-chip').filter({ hasText: 'linux' })).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('sets the tags on the left edge of the text, at every column width', async () => {
    const { app, page } = await launch('aligned');
    try {
      await expect(page.getByTestId('tag-strip')).toBeVisible();
      // The strip was a centred 860px box keyed to a variable nothing defined,
      // so in the wide and full columns it hung to the right of the text. The
      // chip's own padding is the hover wash, so the edge that has to meet the
      // text is the chip's box plus that padding: where its `#` begins.
      for (const mode of ['default', 'wide', 'full']) {
        await page.evaluate((value) => document.documentElement.setAttribute('data-width-mode', value), mode);
        const edges = await page.evaluate(() => {
          const strip = document.querySelector<HTMLElement>('[data-testid="tag-strip"]')!;
          const chip = strip.querySelector<HTMLElement>('[data-testid="tag-chip"]')!;
          const prose = strip.parentElement!.querySelector<HTMLElement>('.ProseMirror')!;
          return {
            tag: chip.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(chip).paddingLeft),
            text: prose.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(prose).paddingLeft),
          };
        });
        expect(Math.abs(edges.tag - edges.text), mode).toBeLessThan(1);
      }
    } finally {
      await app.close();
    }
  });

  // The sheet was drawn on a background the theme never defined, so the page
  // showed through its rows, and 2,118 tags came A to Z with most used once.
  test('Browse Tags is a solid sheet, most used first, with the notes of the tag under the cursor beside it', async () => {
    const { app, page } = await launch('browse-panes');
    try {
      await invokeMenu(app, 'browse-tags');
      const sheet = page.locator('.tag-browser');
      await expect(sheet).toBeVisible();
      const alpha = await sheet.evaluate((element) => {
        const colour = getComputedStyle(element).backgroundColor;
        const parts = /rgba?\(([^)]+)\)/.exec(colour)?.[1]?.split(/[ ,/]+/).filter(Boolean) ?? [];
        return parts.length > 3 ? Number(parts[3]) : 1;
      });
      expect(alpha).toBe(1);
      const tags = page.getByTestId('tag-browser-tag');
      await expect(tags.first()).toHaveAttribute('data-tag', 'agent');
      await expect(page.locator('.tag-browser-group')).toContainText('Used once');
      // The first tag's notes are already beside it; Down shows the next tag's.
      await expect(page.getByTestId('tag-browser-note')).toHaveCount(2);
      await page.keyboard.press('ArrowDown');
      await expect(page.getByTestId('tag-browser-note')).toHaveCount(1);
      await page.keyboard.press('ArrowUp');
      await expect(page.getByTestId('tag-browser-note')).toHaveCount(2);
      // Right to the notes, Down to the second, Enter opens it.
      await page.keyboard.press('ArrowRight');
      await expect(page.getByTestId('tag-browser-note').first()).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('ArrowDown');
      const second = await page.getByTestId('tag-browser-note').nth(1).getAttribute('data-path');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('tag-browser')).toBeHidden();
      expect(second).toBeTruthy();
      await expect(page.locator('.canvas-slot:not([hidden]) .ProseMirror')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('Browse Tags lists every tag in the vault', async () => {
    const { app, page } = await launch('browse');
    try {
      await invokeMenu(app, 'browse-tags');
      await expect(page.getByTestId('tag-browser')).toBeVisible();
      await expect(page.getByTestId('tag-browser-tag')).toHaveCount(3);
      await page.getByTestId('tag-browser-tag').filter({ hasText: 'cloudflare' }).click();
      await expect(page.getByTestId('tag-browser-note')).toHaveCount(1);
      await expect(page.getByTestId('tag-browser-note')).toContainText('agent');
    } finally {
      await app.close();
    }
  });

  test('the Settings switch hides the chips', async () => {
    const { app, page } = await launch('toggle');
    try {
      await expect(page.getByTestId('tag-strip')).toBeVisible();
      await page.getByTestId('settings-toggle').click();
      await page.getByTestId('pref-editor').click();
      await page.getByTestId('setting-file-tags').click();
      await page.getByTestId('settings-close').click();
      await expect(page.getByTestId('tag-strip')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});

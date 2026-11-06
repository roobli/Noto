import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

async function invokeMenu(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ Menu }, wanted) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | null => {
      for (const item of items) {
        if (item.id === wanted) return item;
        const nested = item.submenu ? find(item.submenu.items) : null;
        if (nested) return nested;
      }
      return null;
    };
    const target = find(Menu.getApplicationMenu()!.items);
    if (!target) throw new Error(`no menu item ${wanted}`);
    target.click();
  }, id);
}

async function launch(name: string, options: { siblings?: boolean } = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const workspace = path.join(process.cwd(), 'test-results', 'guides-help', name);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const vault = path.join(workspace, 'vault');
  const deep = path.join(vault, 'works', 'jobs', 'data');
  await mkdir(deep, { recursive: true });
  for (let index = 1; index <= 30; index += 1) {
    await writeFile(path.join(deep, `note_${String(index).padStart(2, '0')}.md`), `# ${index}\n`, 'utf8');
  }
  // A folder beside the one on the path, open, with rows of its own on
  // screen: the shape that put a stray line across the held rows.
  const aside = path.join(vault, 'works', 'jobs', 'aside');
  await mkdir(aside, { recursive: true });
  for (let index = 1; index <= 12; index += 1) {
    await writeFile(path.join(aside, `other_${String(index).padStart(2, '0')}.md`), `# a${index}\n`, 'utf8');
  }
  // A note after `works` and after `jobs`, so neither is the last of its level
  // and their stems have to carry on through the rows held below them, while
  // `data` stays the last of its own and turns the corner.
  if (options.siblings) {
    await writeFile(path.join(vault, 'readme.md'), '# Readme\n', 'utf8');
    await writeFile(path.join(vault, 'works', 'zeta.md'), '# Zeta\n', 'utf8');
  }
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, vault],
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1100, height: 620 });
  await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
  return { app, page };
}

test.describe('the guide lines under a held row', () => {
  test('begin below the row that holds them, and stay under the sticky stack', async () => {
    const { app, page } = await launch('stems');
    try {
      // The folder beside the path is opened too, so its own level exists and
      // its rows are on screen while the path's rows are held.
      for (const name of ['works', 'jobs', 'aside', 'data']) {
        await page.getByTestId('tree-directory').filter({ hasText: name }).first().click();
      }
      await page.getByTestId('tree-file').filter({ hasText: 'note_28' }).click();
      await expect(page.locator('[data-stuck]').first()).toBeVisible();

      // Every level whose folder row is held starts its stems at that row's
      // bottom, so no line is drawn through the row it hangs from.
      const measured = await page.evaluate(() => Array.from(
        document.querySelectorAll<HTMLElement>('.tree-level:not(.is-root)'),
      ).map((level) => {
        const row = level.parentElement?.querySelector<HTMLElement>(':scope > .tree-row');
        const start = Number.parseFloat(level.style.getPropertyValue('--stem-start') || '0');
        const gap = row ? row.getBoundingClientRect().bottom - (level.getBoundingClientRect().top + start) : 0;
        const stuck = row?.hasAttribute('data-stuck') ?? false;
        return { start, gap, stuck };
      }));
      expect(measured.some((level) => level.stuck)).toBe(true);
      for (const level of measured) {
        if (level.stuck) expect(level.start).toBeGreaterThan(0);
        // The stem begins exactly where the row ends, within a pixel.
        expect(Math.abs(level.gap)).toBeLessThan(1.5);
      }

      // Stems stay under sticky path rows (Claude Like / product lock): an
      // earlier pass raised path guides above sticky and painted lines through
      // held names. Opaque sticky fill covers scrolled glyphs; --stem-start
      // keeps each level's line starting below its own held row.
      const order = await page.evaluate(() => {
        const level = document.querySelector<HTMLElement>('.tree-level:not(.is-root)');
        const stem = level ? getComputedStyle(level, '::before').zIndex : '';
        const row = document.querySelector<HTMLElement>('.tree-directory[data-stuck]');
        return { stem, row: row ? getComputedStyle(row).zIndex : '' };
      });
      expect(Number(order.stem)).toBeLessThanOrEqual(Number(order.row));

      // An open folder beside the path likewise keeps its stem under the band.
      const aside = await page.evaluate(() => {
        const row = Array.from(document.querySelectorAll<HTMLElement>('.tree-directory'))
          .find((candidate) => candidate.textContent?.includes('aside'));
        const level = row?.parentElement?.querySelector<HTMLElement>(':scope > .tree-level');
        return level ? getComputedStyle(level, '::before').zIndex : 'missing';
      });
      expect(aside).not.toBe('missing');
      expect(Number(aside)).toBeLessThanOrEqual(Number(order.row));
    } finally {
      await app.close();
    }
  });

  test('carry the stems of the levels above a held row on through it', async () => {
    const { app, page } = await launch('through', { siblings: true });
    try {
      for (const name of ['works', 'jobs', 'data']) {
        await page.getByTestId('tree-directory').filter({ hasText: name }).first().click();
      }
      await page.getByTestId('tree-file').filter({ hasText: 'note_28' }).click();
      await expect(page.locator('.tree-directory[data-stuck]').first()).toBeVisible();

      // For every held row, the stems that go on past it: each level above it
      // whose child on the way down has a later sibling. A held row's band
      // used to reach out to the rail's edge, so it covered every one of them
      // and each row in the stack was left a lone arm.
      const held = await page.evaluate(() => Array.from(
        document.querySelectorAll<HTMLElement>('.tree-directory[data-stuck], .tree-node-active[data-stuck]'),
      ).map((row) => {
        const box = row.getBoundingClientRect();
        const bandLeft = box.left + Number.parseFloat(getComputedStyle(row, '::before').left);
        const stems: { x: number; top: number; bottom: number }[] = [];
        let node: HTMLElement | null = row.classList.contains('tree-node') ? row : row.parentElement;
        while (node) {
          const level = node.parentElement;
          if (!level?.classList.contains('tree-level') || level.classList.contains('is-root')) break;
          if (node.nextElementSibling) {
            const stem = getComputedStyle(level, '::before');
            const top = level.getBoundingClientRect().top + Number.parseFloat(stem.top);
            stems.push({ x: level.getBoundingClientRect().left, top, bottom: top + Number.parseFloat(stem.height) });
          }
          node = level.parentElement;
        }
        return { top: box.top, bottom: box.bottom, bandLeft, stems };
      }));

      expect(held.some((row) => row.stems.length > 0)).toBe(true);
      for (const row of held) {
        for (const stem of row.stems) {
          // In the gutter the band leaves open, and the whole height of the row.
          expect(stem.x).toBeLessThan(row.bandLeft);
          expect(stem.top).toBeLessThanOrEqual(row.top + 1);
          expect(stem.bottom).toBeGreaterThanOrEqual(row.bottom - 1);
        }
      }
    } finally {
      await app.close();
    }
  });

  test('let go of the rows the branch has left when another note opens', async () => {
    const { app, page } = await launch('released', { siblings: true });
    try {
      for (const name of ['works', 'jobs', 'aside', 'data']) {
        await page.getByTestId('tree-directory').filter({ hasText: name }).first().click();
      }
      await page.getByTestId('tree-file').filter({ hasText: 'note_28' }).click();
      const data = page.getByTestId('tree-directory').filter({ hasText: 'data' }).first();
      await expect(data).toHaveAttribute('data-stuck');

      // A note at the top of the vault: every row of the old branch is off the
      // path now, and each kept its held band and lit elbow, the previous
      // note's own row included, until the mark was cleared.
      await page.getByTestId('tree-file').filter({ hasText: 'readme' }).click();
      await expect(data).not.toHaveClass(/tree-on-path/);
      await expect(data).not.toHaveAttribute('data-stuck');
      await expect(page.locator('.tree-directory[data-stuck]:not(.tree-on-path)')).toHaveCount(0);
      await expect(page.locator('.tree-node[data-stuck]:not(.tree-node-active)')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('bring a held row back to its place when it is pressed, rather than closing its folder', async () => {
    const { app, page } = await launch('reveal', { siblings: true });
    try {
      for (const name of ['works', 'jobs', 'aside', 'data']) {
        await page.getByTestId('tree-directory').filter({ hasText: name }).first().click();
      }
      await page.getByTestId('tree-file').filter({ hasText: 'note_28' }).click();
      const data = page.getByTestId('tree-directory').filter({ hasText: 'data' }).first();
      await expect(data).toHaveAttribute('data-stuck');
      const before = await data.boundingBox();

      // A press on the held row covers the rows scrolled under it. It used to
      // close the folder and throw every row under the pointer elsewhere; now
      // the row's own place scrolls back under it and the folder stays open.
      await data.click();
      await expect(data).not.toHaveAttribute('data-stuck');
      await expect(data).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByTestId('tree-file').filter({ hasText: 'note_28' })).toBeVisible();
      const after = await data.boundingBox();
      expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(2);

      // Now an ordinary row, a second press closes it as a press always did.
      await data.click();
      await expect(data).toHaveAttribute('aria-expanded', 'false');
    } finally {
      await app.close();
    }
  });

  test('light the branch only as far as the corner that finishes it', async () => {
    const { app, page } = await launch('lit');
    try {
      await page.getByTestId('tree-directory').filter({ hasText: 'works' }).first().click();
      await page.getByTestId('tree-directory').filter({ hasText: 'jobs' }).first().click();
      await page.getByTestId('tree-directory').filter({ hasText: 'data' }).first().click();
      // The last row of its level: the lit stem must stop at its top, where
      // the corner takes over, rather than running down through the curve.
      await page.getByTestId('tree-file').filter({ hasText: 'note_30' }).click();
      await expect(page.locator('.tree-node-active')).toBeVisible();
      const geometry = await page.evaluate(() => {
        const level = Array.from(document.querySelectorAll<HTMLElement>('.tree-level'))
          .find((candidate) => candidate.querySelector(':scope > .tree-node-active'));
        if (!level) return null;
        const last = level.lastElementChild as HTMLElement;
        return {
          lit: Number.parseFloat(level.style.getPropertyValue('--path-stop')),
          quiet: Number.parseFloat(level.style.getPropertyValue('--stem-stop')),
          activeIsLast: last.classList.contains('tree-node-active'),
        };
      });
      expect(geometry?.activeIsLast).toBe(true);
      // Both stems stop in the same place, which is the top of that last row.
      expect(geometry?.lit).toBe(geometry?.quiet);
    } finally {
      await app.close();
    }
  });
});

test('a held row keeps the shape it has standing still', async () => {
  const { app, page } = await launch('corner', { siblings: true });
  try {
    for (const name of ['works', 'jobs', 'data']) {
      await page.getByTestId('tree-directory').filter({ hasText: name }).first().click();
    }
    await page.getByTestId('tree-file').filter({ hasText: 'note_28' }).click();
    await expect(page.locator('.tree-directory[data-stuck]').first()).toBeVisible();

    // `data` is the last row of its level and turns a corner; `works` and
    // `jobs` are not and meet their stems at a right angle. Held, each keeps
    // its own shape: the lit stroke runs down from the row's top to its arm
    // either way, square in the middle of a folder and rounded at its end.
    const shapes = await page.evaluate(() => Array.from(
      document.querySelectorAll<HTMLElement>('.tree-directory[data-stuck]'),
    ).map((row) => ({
      name: row.textContent ?? '',
      last: row.parentElement?.matches(':last-child') ?? false,
      radius: getComputedStyle(row, '::after').borderBottomLeftRadius,
      left: getComputedStyle(row, '::after').borderLeftWidth,
    })));
    expect(shapes.some((shape) => shape.last)).toBe(true);
    expect(shapes.some((shape) => !shape.last)).toBe(true);
    for (const shape of shapes) {
      expect(shape.left).toBe('1px');
      if (shape.last) expect(shape.radius).not.toBe('0px');
      else expect(shape.radius).toBe('0px');
    }
  } finally {
    await app.close();
  }
});

test('the title bar\'s ? leads to what is new, with a way to each, and stops saying so once looked at', async () => {
  const { app, page } = await launch('guide');
  try {
    const toggle = page.getByTestId('guide-toggle');
    await expect(toggle).toHaveClass(/has-news/);
    await toggle.click();
    const panel = page.getByTestId('shortcuts-panel');
    await expect(panel.locator('.shortcuts-group').first()).toContainText('New since you last looked');
    await expect(panel.locator('.shortcuts-group').first()).toContainText('Ask the vault');
    // What an entry needs is said where it is.
    await expect(panel).toContainText('The folder keeps memory');
    // A Try It closes the list and goes there.
    await panel.locator('[data-testid="shortcuts-try"][data-try="note-info"]').first().click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByTestId('info-pane')).toBeVisible();
    // Looked at: no dot, and nothing marked New.
    await expect(toggle).not.toHaveClass(/has-news/);
    await toggle.click();
    await expect(panel.locator('.shortcuts-group').first()).not.toContainText('New since you last looked');
    await expect(panel.locator('[data-new]')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('the Help menu says what the app can do', async () => {
  const { app, page } = await launch('help');
  try {
    await invokeMenu(app, 'shortcuts');
    const panel = page.getByTestId('shortcuts-panel');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('shortcuts-search')).toBeFocused();
    const rows = page.getByTestId('shortcuts-row');
    expect(await rows.count()).toBeGreaterThan(12);
    await expect(panel).toContainText('Search the whole vault from the rail');

    // It can be searched, since a list this long is not read end to end.
    await page.getByTestId('shortcuts-search').fill('picgo');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('PicGo');
    await page.getByTestId('shortcuts-search').fill('nothing like this');
    await expect(panel).toContainText('Nothing here matches that.');

    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
  } finally {
    await app.close();
  }
});

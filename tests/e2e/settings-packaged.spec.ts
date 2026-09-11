import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

const resultRoot = path.join(process.cwd(), 'test-results', 'settings');


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

interface Workspace {
  app: ElectronApplication;
  page: Page;
  userData: string;
}

async function launch(name: string, reuse?: string): Promise<Workspace> {
  const workspace = path.join(resultRoot, name);
  const userData = reuse ?? path.join(workspace, 'user-data');
  if (!reuse) {
    await rm(workspace, { recursive: true, force: true });
    await mkdir(userData, { recursive: true });
  }
  const file = path.join(workspace, 'notes.md');
  await mkdir(path.dirname(file), { recursive: true });
  // Wide content on purpose: a fence and a token that cannot wrap are the two
  // things that would push a page sideways if the column did not contain them.
  await writeFile(file, [
    '# Notes',
    '',
    'Body.',
    '',
    '```ts',
    `const wide = ${'"x"'.repeat(120)};`,
    '```',
    '',
    `A token that never wraps: ${'unbroken'.repeat(40)}.`,
    '',
  ].join('\n'), 'utf8');

  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${userData}`, `--open=${file}`],
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
  await page.setViewportSize({ width: 1280, height: 900 });
  return { app, page, userData };
}

/** The page width mode, as the document actually carries it. */
const modeOf = (page: Page) => page.evaluate(
  () => document.documentElement.dataset.widthMode ?? '',
);

/** The column, the canvas it sits in, and how far the canvas could scroll sideways. */
const layoutOf = (page: Page) => page.evaluate(() => {
  const canvas = document.getElementById('document-canvas');
  const host = document.querySelector<HTMLElement>('.noto-editor-host');
  if (!canvas || !host) throw new Error('No canvas on screen');
  return {
    column: host.getBoundingClientRect().width,
    canvas: canvas.clientWidth,
    sideways: canvas.scrollWidth - canvas.clientWidth,
  };
});

const MODES = ['default', 'wide', 'full'] as const;

test.describe('settings', () => {
  test('opens from the menu and closes again', async () => {
    const { app, page } = await launch('open');
    try {
      await expect(page.getByTestId('settings-panel')).toBeHidden();
      await invokeMenu(app, 'settings');
      await expect(page.getByTestId('settings-panel')).toBeVisible();

      await page.getByTestId('settings-close').click();
      await expect(page.getByTestId('settings-panel')).toBeHidden();

      // Esc after a font change returns to typing; Cmd+, again leaves too.
      await invokeMenu(app, 'settings');
      await expect(page.getByTestId('settings-panel')).toBeVisible();
      await page.getByTestId('setting-font-size').fill('18');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('settings-panel')).toBeHidden();
      await expect(page.locator('.ProseMirror')).toBeFocused();

      await invokeMenu(app, 'settings');
      await expect(page.getByTestId('settings-panel')).toBeVisible();
      await invokeMenu(app, 'settings');
      await expect(page.getByTestId('settings-panel')).toBeHidden();
      await expect(page.locator('.ProseMirror')).toBeFocused();
    } finally {
      await app.close();
    }
  });

  test('applies a theme change immediately', async () => {
    const { app, page } = await launch('theme');
    try {
      await invokeMenu(app, 'settings');
      await page.getByTestId('theme-dark').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

      await page.getByTestId('theme-light').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    } finally {
      await app.close();
    }
  });

  test('steps the page width through three modes, never past the canvas', async () => {
    const { app, page } = await launch('width');
    try {
      // 1280 wide with the rail closed: the reading column stops at its cap,
      // wide is at least 1000, and full is the canvas less its gutters. The
      // cap is 796, which is what Typora's 860-wide page leaves for text
      // once its own 32px gutters are taken off.
      const reading = await layoutOf(page);
      expect(reading.column).toBeCloseTo(796, 0);
      expect(reading.sideways).toBe(0);

      await invokeMenu(app, 'settings');
      await page.getByTestId('width-wide').click();
      await expect.poll(() => modeOf(page)).toBe('wide');
      const wide = await layoutOf(page);
      expect(wide.column).toBeGreaterThanOrEqual(1000);
      expect(wide.column).toBeLessThanOrEqual(wide.canvas);

      await page.getByTestId('width-full').click();
      await expect.poll(() => modeOf(page)).toBe('full');
      const full = await layoutOf(page);
      expect(full.column).toBeGreaterThan(wide.column);
      expect(full.column).toBeLessThanOrEqual(full.canvas);
      expect(full.sideways).toBe(0);
      await page.getByTestId('settings-close').click();

      // The chord walks a ring: full wraps round to default.
      await invokeMenu(app, 'widen');
      await expect.poll(() => modeOf(page)).toBe('default');
      await invokeMenu(app, 'narrow');
      await expect.poll(() => modeOf(page)).toBe('full');

      // With the rail open the canvas is narrower and the column follows it.
      // Every mode at every window width is at most the canvas: the document
      // never scrolls sideways, which is the rule the modes exist under.
      await invokeMenu(app, 'toggle-sidebar');
      await expect(page.locator('.workspace-rail')).toBeVisible();
      let mode: (typeof MODES)[number] = 'full';
      for (const width of [1280, 960, 760]) {
        await page.setViewportSize({ width, height: 800 });
        for (let step = 0; step < MODES.length; step += 1) {
          await invokeMenu(app, 'widen');
          mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
          await expect.poll(() => modeOf(page)).toBe(mode);
          const layout = await layoutOf(page);
          expect(layout.column, `${mode} at ${width}`).toBeLessThanOrEqual(layout.canvas);
          expect(layout.sideways, `${mode} at ${width}`).toBe(0);
        }
      }
    } finally {
      await app.close();
    }
  });

  test('turns spell checking off in the editor', async () => {
    const { app, page } = await launch('spell');
    try {
      await expect(page.locator('.ProseMirror')).toHaveAttribute('spellcheck', 'true');
      await invokeMenu(app, 'settings');
      // Editing settings live in their own section of Settings.
      await page.getByTestId('pref-editor').click();
      await page.getByTestId('setting-spell-check').uncheck();
      await page.getByTestId('settings-close').click();
      await expect(page.locator('.ProseMirror')).toHaveAttribute('spellcheck', 'false');
    } finally {
      await app.close();
    }
  });

  test('remembers the choice across a restart, and writes it where it says', async () => {
    const first = await launch('persist');
    try {
      await invokeMenu(first.app, 'settings');
      await first.page.getByTestId('theme-dark').click();
      await first.page.getByTestId('width-wide').click();
      await first.page.getByTestId('setting-font-size').fill('21');
      await expect(first.page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expect.poll(() => modeOf(first.page)).toBe('wide');
    } finally {
      await first.app.close();
    }

    const stored = JSON.parse(await readFile(path.join(first.userData, 'settings.json'), 'utf8'));
    expect(stored).toMatchObject({ theme: 'dark', widthMode: 'wide', fontSize: 21 });

    const second = await launch('persist', first.userData);
    try {
      await expect(second.page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expect.poll(() => modeOf(second.page)).toBe('wide');
    } finally {
      await second.app.close();
    }
  });

  test('refuses a setting the app does not define', async () => {
    const { app, page } = await launch('reject');
    try {
      const outcome = await page.evaluate(async () => {
        const result = await (window as unknown as {
          notoSettings: { write(request: unknown): Promise<{ ok: boolean }> };
        }).notoSettings.write({ version: 1, requestId: 'e2e-bad', patch: { nonsense: true } });
        return result.ok;
      });
      expect(outcome).toBe(false);
    } finally {
      await app.close();
    }
  });
});

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

/** Screenshots for review, when asked for: `NOTO_DRAG_SHOTS=/some/dir`. */
const SHOTS = process.env.NOTO_DRAG_SHOTS ?? '';

async function launch(name: string, extra: Readonly<Record<string, string>> = {}, shown = false): Promise<{ app: ElectronApplication; page: Page; vault: string }> {
  const workspace = path.join(process.cwd(), 'test-results', 'tree-drag', name);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  // `NOTO_DRAG_THEME=dark` with the screenshots, to look at both.
  if (process.env.NOTO_DRAG_THEME) await writeFile(path.join(workspace, 'user-data', 'settings.json'), JSON.stringify({ theme: process.env.NOTO_DRAG_THEME }), 'utf8');
  const vault = path.join(workspace, 'vault');
  await mkdir(path.join(vault, 'topics'), { recursive: true });
  await mkdir(path.join(vault, 'archive'), { recursive: true });
  await writeFile(path.join(vault, 'loose.md'), '# Loose\n\nA note at the root.\n', 'utf8');
  await writeFile(path.join(vault, 'topics', 'kept.md'), '# Kept\n', 'utf8');
  // The tree is listed when the folder opens, so anything a test needs to see
  // has to be on disk before the window is.
  for (const [name, body] of Object.entries(extra)) await writeFile(path.join(vault, name), body, 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, ...(SHOTS ? ['--force-device-scale-factor=2'] : []), vault],
    // `shown` puts the window on screen off macOS, as click-stays-put does:
    // there a window that is never shown runs no animation frames, and the
    // scroll at an edge steps on them. On macOS a hidden window runs them.
    ...(shown ? { env: { ...process.env, NOTO_HEADLESS: process.platform === 'darwin' ? '1' : '0' } } : {}),
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
  return { app, page, vault };
}

/**
 * Drag one row onto another. The browser's own drag cannot be driven by the
 * mouse in a test, so the events are dispatched with a DataTransfer of their
 * own, which is what the handlers read.
 */
async function dragOnto(page: Page, source: string, target: string): Promise<void> {
  await page.evaluate(([from, to]) => {
    const find = (path: string) => Array.from(document.querySelectorAll<HTMLElement>('.tree-row'))
      .find((row) => row.getAttribute('title') === path || row.dataset.path === path
        || row.querySelector('.tree-name')?.textContent === path);
    const start = find(from as string);
    const end = find(to as string);
    if (!start || !end) throw new Error(`no row for ${!start ? from : to}`);
    const data = new DataTransfer();
    start.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }));
    end.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
    end.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    start.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }));
  }, [source, target]);
}

/** Begin a drag on a row and leave it in the air, as a hand holding the button would. */
async function lift(page: Page, source: string): Promise<void> {
  await page.evaluate((from) => {
    const start = Array.from(document.querySelectorAll<HTMLElement>('.tree-row'))
      .find((row) => row.dataset.path === from || row.querySelector('.tree-name')?.textContent === from);
    if (!start) throw new Error(`no row for ${from}`);
    const data = new DataTransfer();
    (window as unknown as { held: { row: HTMLElement; data: DataTransfer } }).held = { row: start, data };
    start.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }));
  }, source);
}

/** Hold the dragged row over a row, or at a point, for a while: the browser repeats dragover while it is held. */
async function hold(page: Page, at: { row?: string; y?: 'top' | 'bottom' }, ms: number): Promise<void> {
  await page.evaluate(async ({ row, y, ms }) => {
    const { data } = (window as unknown as { held: { row: HTMLElement; data: DataTransfer } }).held;
    const scroller = document.querySelector<HTMLElement>('.rail-view')!;
    const box = scroller.getBoundingClientRect();
    const find = () => (row
      ? Array.from(document.querySelectorAll<HTMLElement>('.tree-row')).find((candidate) => candidate.querySelector('.tree-name')?.textContent === row)!
      : null);
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const target = find();
      const point = target
        ? { x: target.getBoundingClientRect().left + 40, y: target.getBoundingClientRect().top + 10 }
        : { x: box.left + 60, y: y === 'top' ? box.top + 4 : box.bottom - 4 };
      const under = target ?? document.elementFromPoint(point.x, point.y) ?? scroller;
      under.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data, clientX: point.x, clientY: point.y }));
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }, { row: at.row, y: at.y, ms });
}

async function letGo(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { row, data } = (window as unknown as { held: { row: HTMLElement; data: DataTransfer } }).held;
    row.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }));
  });
}

async function shoot(app: ElectronApplication, name: string): Promise<void> {
  if (!SHOTS) return;
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  writeFileSync(path.join(SHOTS, name), Buffer.from(png, 'base64'));
}

test.describe('dragging in the tree', () => {
  test('moves a note into the folder it is dropped on, and back to the vault', async () => {
    const { app, page, vault } = await launch('move');
    try {
      await dragOnto(page, 'loose.md', 'archive');
      await expect.poll(() => readdir(path.join(vault, 'archive'))).toEqual(['loose.md']);
      await expect.poll(() => readdir(vault)).toEqual(['archive', 'topics']);
      // The tree shows it in its new place.
      await page.getByTestId('tree-directory').filter({ hasText: 'archive' }).click();
      await expect(page.getByTestId('tree-file').filter({ hasText: 'loose' })).toHaveCount(1);

      // And back onto the vault row, which is a folder too.
      await dragOnto(page, 'loose.md', path.basename(vault));
      await expect.poll(() => readdir(vault)).toEqual(['archive', 'loose.md', 'topics']);
    } finally {
      await app.close();
    }
  });

  test('scrolls when held at an edge, so a move can cross more than a rail of rows', async () => {
    const many: Record<string, string> = {};
    for (let index = 0; index < 90; index += 1) many[`note-${String(index).padStart(2, '0')}.md`] = `# Note ${index}\n`;
    const { app, page } = await launch('edge', many, true);
    try {
      const scroller = page.locator('.rail-view');
      await expect.poll(() => scroller.evaluate((element) => element.scrollHeight > element.clientHeight + 200)).toBe(true);
      await lift(page, 'note-00.md');
      await expect(page.getByTestId('tree-drop-chip')).toHaveText('Drop on a folder · hold at an edge to scroll');
      await hold(page, { y: 'bottom' }, 900);
      const down = await scroller.evaluate((element) => element.scrollTop);
      expect(down).toBeGreaterThan(200);
      const edge = await page.locator('.tree-edge-down').evaluate((element) => Number(getComputedStyle(element).getPropertyValue('--edge')));
      expect(edge).toBeGreaterThan(0);
      // While rows pass under the pointer, none is offered, and the foot says how to choose again.
      await expect(page.getByTestId('tree-drop-chip')).toHaveAttribute('data-verdict', 'scrolling');
      await expect(page.locator('.is-drop-target')).toHaveCount(0);
      // The edge is at the rail's own bottom, past its foot.
      const [cueBottom, railBottom] = await page.evaluate(() => [
        document.querySelector('.tree-edge-down')!.getBoundingClientRect().bottom,
        document.querySelector('.rail-view')!.getBoundingClientRect().bottom,
      ]);
      expect(Math.abs(cueBottom - railBottom)).toBeLessThan(2);
      await shoot(app, `${process.env.NOTO_DRAG_THEME ?? 'light'}-drag-edge.png`);
      // And back up, toward the top edge.
      await hold(page, { y: 'top' }, 700);
      expect(await scroller.evaluate((element) => element.scrollTop)).toBeLessThan(down);
      await letGo(page);
      // At rest the edges and the words are gone.
      await expect(page.getByTestId('tree-drop-chip')).toHaveCount(0);
      await expect(page.locator('.tree-edge')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('opens a closed folder held over, drops into a note\'s folder, and shuts what it opened', async () => {
    const { app, page, vault } = await launch('spring');
    try {
      await mkdir(path.join(vault, 'archive', 'deep'), { recursive: true });
      await page.getByTestId('tree-directory').filter({ hasText: 'archive' }).click();
      await page.getByTestId('tree-directory').filter({ hasText: 'archive' }).click();
      const topics = page.getByTestId('tree-directory').filter({ hasText: 'topics' });
      await expect(topics).toHaveAttribute('aria-expanded', 'false');
      await lift(page, 'loose.md');
      // Held over a closed folder, it fills its line and opens.
      await hold(page, { row: 'topics' }, 250);
      await expect(topics).toHaveClass(/is-springing/);
      await expect(topics).toHaveClass(/is-drop-target/);
      await expect(page.getByTestId('tree-drop-chip')).toHaveText('Move "loose" to topics');
      await shoot(app, `${process.env.NOTO_DRAG_THEME ?? 'light'}-drag-target.png`);
      await hold(page, { row: 'topics' }, 700);
      await expect(topics).toHaveAttribute('aria-expanded', 'true');
      // Over the note inside it, the drop is for its folder.
      await hold(page, { row: 'kept.md' }, 120);
      await expect(topics).toHaveClass(/is-drop-target/);
      // Let go elsewhere: what the drag opened shuts again.
      await letGo(page);
      await expect(topics).toHaveAttribute('aria-expanded', 'false');

      // Dropped on the note inside a folder, it lands in that folder, which stays open.
      await lift(page, 'loose.md');
      await hold(page, { row: 'topics' }, 900);
      await hold(page, { row: 'kept.md' }, 80);
      await page.evaluate(() => {
        const { data } = (window as unknown as { held: { row: HTMLElement; data: DataTransfer } }).held;
        const kept = Array.from(document.querySelectorAll<HTMLElement>('.tree-row')).find((row) => row.querySelector('.tree-name')?.textContent === 'kept.md')!;
        kept.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
      });
      await letGo(page);
      await expect.poll(() => readdir(path.join(vault, 'topics'))).toEqual(['kept.md', 'loose.md']);
      await expect(topics).toHaveAttribute('aria-expanded', 'true');
    } finally {
      await app.close();
    }
  });

  test('takes the links to a moved note along, says so, and takes them back with Undo', async () => {
    const { app, page, vault } = await launch('links', {
      'essay.md': '# Essay\n\nSee [the loose note](loose.md), and [[loose]] by name.\n',
    });
    try {
      const essay = () => readFile(path.join(vault, 'essay.md'), 'utf8');
      await dragOnto(page, 'loose.md', 'archive');
      await expect.poll(essay).toContain('[the loose note](archive/loose.md)');
      // A link by name still reaches the note, and is left as it was written.
      expect(await essay()).toContain('[[loose]] by name');
      await expect(page.getByTestId('status-notice')).toHaveText('Updated 1 link in 1 note');
      await page.getByTestId('status-notice-action').click();
      await expect.poll(essay).toContain('[the loose note](loose.md)');
      await expect(page.getByTestId('status-notice')).toHaveText('Put back the links in 1 note');
    } finally {
      await app.close();
    }
  });

  test('chooses several rows with Command and Shift, carries them all, and follows their links in one pass', async () => {
    const { app, page, vault } = await launch('many', {
      'a.md': '# A\n', 'b.md': '# B\n',
      'essay.md': '# Essay\n\n[a](a.md) and [b](b.md).\n',
    });
    try {
      await app.evaluate(({ Menu }) => {
        const shown: Electron.Menu[] = [];
        (globalThis as { shownMenus?: Electron.Menu[] }).shownMenus = shown;
        Menu.prototype.popup = function popup(this: Electron.Menu) { shown.push(this); };
      });
      const row = (name: string) => page.getByTestId('tree-file').filter({ hasText: name });
      await row('a.md').click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
      await row('b.md').click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
      await expect(page.locator('.tree-row.is-selected')).toHaveCount(2);
      await expect(page.getByTestId('tree-choice-chip')).toContainText('2 chosen');
      // Right-click one of them: the menu is for both.
      await row('a.md').click({ button: 'right' });
      await expect.poll(() => app.evaluate(() => (globalThis as { shownMenus?: Electron.Menu[] }).shownMenus!.at(-1)?.items.map((item) => item.label) ?? []))
        .toEqual(['Move 2 Items to…', 'Copy Paths', '',
          `Move 2 Items to ${process.platform === 'darwin' ? 'Trash' : process.platform === 'win32' ? 'Recycle Bin' : 'Rubbish Bin'}`]);
      await shoot(app, `${process.env.NOTO_DRAG_THEME ?? 'light'}-chosen.png`);

      // Dragging one of them carries both.
      await lift(page, 'a.md');
      await hold(page, { row: 'archive' }, 120);
      await expect(page.getByTestId('tree-drop-chip')).toHaveText('Move 2 items to archive');
      await page.evaluate(() => {
        const { data } = (window as unknown as { held: { row: HTMLElement; data: DataTransfer } }).held;
        const archive = Array.from(document.querySelectorAll<HTMLElement>('.tree-row')).find((candidate) => candidate.querySelector('.tree-name')?.textContent === 'archive')!;
        archive.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
      });
      await letGo(page);
      await expect.poll(() => readdir(path.join(vault, 'archive'))).toEqual(['a.md', 'b.md']);
      await expect.poll(() => readFile(path.join(vault, 'essay.md'), 'utf8')).toContain('[a](archive/a.md) and [b](archive/b.md)');
      // One pass, one notice, one Undo.
      await expect(page.getByTestId('status-notice')).toHaveText('Updated 2 links in 1 note');
      await expect(page.locator('.tree-row.is-selected')).toHaveCount(0);

      // Shift chooses a run of rows; Escape lets them go.
      await row('essay.md').click();
      await page.getByTestId('tree-directory').filter({ hasText: 'archive' }).click({ modifiers: ['Shift'] });
      expect(await page.locator('.tree-row.is-selected').count()).toBeGreaterThan(1);
      await page.keyboard.press('Escape');
      await expect(page.locator('.tree-row.is-selected')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('refuses a folder into itself and says when a name is taken', async () => {
    const { app, page, vault } = await launch('refuse', { 'kept.md': '# Another\n' });
    try {
      // A folder cannot be dropped into itself.
      await dragOnto(page, 'topics', 'topics');
      await expect.poll(() => readdir(path.join(vault, 'topics'))).toEqual(['kept.md']);

      // A note whose name is already taken there is refused, and said so.
      await dragOnto(page, 'kept.md', 'topics');
      await expect(page.getByTestId('file-truth-alert')).toContainText('already called that', { timeout: 15_000 });
      await expect.poll(() => readdir(vault)).toContain('kept.md');
      await expect.poll(() => readdir(path.join(vault, 'topics'))).toEqual(['kept.md']);
    } finally {
      await app.close();
    }
  });
});

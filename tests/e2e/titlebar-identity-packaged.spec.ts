import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

/*
 * The breadcrumb in the title bar never runs under the controls (#361).
 *
 * It used to be centred by absolute positioning with a cap of 60% of the
 * window, which knew nothing about the groups on either side. With a long
 * folder name in a narrow window the folder ran under Settings, and the gear
 * read as a glyph between the folder and the name. Now the folder is cut short
 * with an ellipsis, the name stays whole, and in a window wide enough for it
 * the name is still in the middle.
 */

type Geometry = {
  window: number;
  /** Where the page begins: the rail's right edge while it takes a column, else the window's left. */
  page: number;
  /** Where the caption buttons begin, or the window's edge where there are none. */
  controls: number;
  left: [number, number];
  actions: [number, number];
  identity: [number, number];
  crumbCut: boolean;
  nameCut: boolean;
};

const measure = (page: Page): Promise<Geometry> => page.evaluate(() => {
  const span = (selector: string): [number, number] => {
    const box = document.querySelector(selector)!.getBoundingClientRect();
    return [box.left, box.right];
  };
  const crumb = document.querySelector<HTMLElement>('.document-identity .crumb')!;
  const name = document.querySelector<HTMLElement>('.document-identity strong')!;
  const overlay = (navigator as Navigator & {
    windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect(): DOMRect };
  }).windowControlsOverlay;
  const window = document.documentElement.clientWidth;
  const rail = document.querySelector<HTMLElement>('.workspace-rail');
  const inFlow = rail !== null && getComputedStyle(rail).position !== 'absolute';
  return {
    window,
    page: inFlow ? rail.getBoundingClientRect().right : 0,
    controls: overlay?.visible ? overlay.getTitlebarAreaRect().right : window,
    left: span('.title-left [data-testid="nav-forward"]'),
    actions: span('.title-actions [data-testid="settings-toggle"]'),
    identity: span('.document-identity'),
    crumbCut: crumb.scrollWidth > crumb.clientWidth,
    nameCut: name.scrollWidth > name.clientWidth,
  };
});

test('a long folder name is cut short before the controls, and the name stays whole and centred', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'titlebar-identity');
  await rm(workspace, { recursive: true, force: true });
  const userData = path.join(workspace, 'user-data');
  await mkdir(userData, { recursive: true });
  const vault = path.join(workspace, 'a-folder-whose-name-is-far-too-long-for-any-title-bar-to-hold-whole');
  await mkdir(vault, { recursive: true });
  await writeFile(path.join(vault, 'note.md'), '# Note\n\nA paragraph.\n', 'utf8');

  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${userData}`, vault],
  });
  try {
    const page = await app.firstWindow();
    await page.getByTestId('tree-file').first().click();
    await expect(page.getByTestId('document-identity')).toContainText('note.md');

    for (const width of [720, 900, 1280]) {
      // The window itself, not an emulated viewport: the room the caption
      // buttons take on Windows and Linux follows the real window, and an
      // emulated one leaves it at the launch size.
      await app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setSize(w, 800), width);
      // The overlay's geometry follows the resize a moment later; wait until
      // the bar has made room for the caption buttons at the new width.
      await expect.poll(async () => {
        const m = await measure(page);
        return m.window === width && m.controls <= width && m.actions[1] <= m.controls;
      }).toBe(true);
      // The caption geometry, and the CSS env() values it feeds, settle a frame
      // or two after the window does. Wait for the bar itself to be in its
      // final shape rather than measuring the frame the resize lands on.
      await expect.poll(async () => {
        const m = await measure(page);
        return m.nameCut === false
          && (width !== 720 || m.crumbCut)
          && m.identity[0] >= m.left[1]
          && m.identity[1] <= m.actions[0];
      }).toBe(true);
      const g = await measure(page);
      // Clear of both groups.
      expect(g.identity[0]).toBeGreaterThanOrEqual(g.left[1]);
      expect(g.identity[1]).toBeLessThanOrEqual(g.actions[0]);
      // The folder gives way; the name does not.
      if (width === 720) expect(g.crumbCut).toBe(true);
      expect(g.nameCut).toBe(false);
    }

    // With room on both sides the identity is in the middle of the page, as
    // Typora centres its title over the editor: over the window when the rail
    // is closed or lies over the page, and to the rail's right while it takes
    // a column (this folder opens with the rail open). Poll the centre itself: the window width and the overlay geometry can settle in
    // different frames, and a single measure here made this test fail only on
    // the Linux runner. Measuring the settled frame also keeps the assertion
    // about the layout rather than about a transient caption reservation.
    await expect.poll(async () => {
      const m = await measure(page);
      return Math.abs((m.identity[0] + m.identity[1]) / 2 - (m.page + m.window) / 2);
    }).toBeLessThanOrEqual(1);
  } finally {
    await app.close();
  }
});

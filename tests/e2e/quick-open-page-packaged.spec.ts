/**
 * Quick Open as one page, in the packaged app: a frame sized for finding
 * (80% of the window's height, 560 to 860, under a ceiling at each width
 * step), a divider the reader drags and the sheet keeps readable on both
 * sides, a preview that is either the page rendered or the file's source,
 * both remembered, and the row under the pointer as the selected row.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { finishAnimations, packagedExecutable } from './packaged-app';

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
    find(Menu.getApplicationMenu()!.items)!.click();
  }, id);
}

async function launch(name: string, settings: object = {}): Promise<{ app: ElectronApplication; page: Page; userData: string; vault: string }> {
  const workspace = path.join(process.cwd(), 'test-results', 'quick-open-page', name);
  await rm(workspace, { recursive: true, force: true });
  const userData = path.join(workspace, 'user-data');
  const vault = path.join(workspace, 'vault');
  await mkdir(userData, { recursive: true });
  await mkdir(path.join(vault, 'works', 'jobs'), { recursive: true });
  await writeFile(path.join(userData, 'settings.json'), JSON.stringify(settings));
  await writeFile(path.join(vault, 'plan.md'), [
    '# Plan', '', 'The **kestrel** plan, with `code` and a [link](https://example.com).', '',
    '## Steps', '', '- one', '- two', '', '| a | b |', '| --- | --- |', '| 1 | 2 |', '',
  ].join('\n'), 'utf8');
  for (const name of ['alpha', 'bravo', 'charlie', 'delta', 'echo']) {
    await writeFile(path.join(vault, 'works', `${name}.md`), `# ${name}\n\nAbout ${name}.\n`, 'utf8');
  }
  await writeFile(path.join(vault, 'works', 'jobs', 'hiring.md'), '# Hiring\n\nKestrels again.\n', 'utf8');
  const app = await electron.launch({ executablePath: packagedExecutable(), args: [`--user-data-dir=${userData}`, vault] });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
  return { app, page, userData, vault };
}

const box = (page: Page, testId: string) => page.getByTestId(testId).evaluate((node) => {
  const rect = node.getBoundingClientRect();
  return { x: rect.left, y: rect.top, w: rect.width, h: Math.round(rect.height) };
});
const width = async (page: Page, testId: string) => Math.round((await box(page, testId)).w);
const stored = async (userData: string) => JSON.parse(await readFile(path.join(userData, 'settings.json'), 'utf8')) as Record<string, unknown>;

test('the frame is sized for finding: capped height and width, the same top for every width step', async () => {
  const { app, page } = await launch('frame');
  try {
    await invokeMenu(app, 'quick-open');
    const sheet = page.getByTestId('quick-open');
    await expect(sheet).toBeVisible();
    await finishAnimations(page);
    // 900 tall: 80% is 720, inside 560..860. 1400 wide at step 3: 70% is 980, under 1120.
    expect({ w: await width(page, 'quick-open'), h: (await box(page, 'quick-open')).h }).toEqual({ w: 980, h: 720 });
    await page.setViewportSize({ width: 2400, height: 1400 });
    await finishAnimations(page);
    // A large window gets air, not a bigger sheet.
    expect({ w: await width(page, 'quick-open'), h: (await box(page, 'quick-open')).h }).toEqual({ w: 1120, h: 860 });
  } finally {
    await app.close();
  }
});

test('the divider is dragged, snaps, keeps both sides readable, resets on a double-click, and is remembered', async () => {
  const { app, page, userData } = await launch('divider');
  try {
    await invokeMenu(app, 'quick-open');
    await page.getByTestId('quick-input').fill('a');
    const divider = page.getByTestId('quick-divider');
    await expect(divider).toHaveAttribute('aria-valuenow', '50');
    const body = await page.locator('.quick-body').evaluate((node) => { const r = node.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    const at = await box(page, 'quick-divider');
    const drag = async (fraction: number) => {
      const from = await box(page, 'quick-divider');
      await page.mouse.move(from.x + from.w / 2, body.y + body.h / 2);
      await page.mouse.down();
      await page.mouse.move(body.x + 14 + (body.w - 28) * fraction, body.y + body.h / 2, { steps: 6 });
      await page.mouse.up();
    };
    // The gutter is the divider: 28px wide, give or take the sub-pixel the grid's fractions leave.
    expect(Math.abs(at.w - 28)).toBeLessThan(1);
    // Near 56 settles on 56.
    await drag(0.565);
    await expect(divider).toHaveAttribute('aria-valuenow', '56');
    await expect.poll(async () => (await stored(userData)).quickOpenSplit).toBe(56);
    // Past the travel, the preview keeps 320px: at 980 wide the list stops near 64%.
    await drag(0.95);
    const far = Number(await divider.getAttribute('aria-valuenow'));
    expect(far).toBeGreaterThan(56);
    expect(far).toBeLessThanOrEqual(68);
    const preview = await page.getByTestId('quick-preview').evaluate((node) => node.getBoundingClientRect().width);
    expect(preview).toBeGreaterThanOrEqual(319);
    // A double-click is half and half.
    await divider.dblclick();
    await expect(divider).toHaveAttribute('aria-valuenow', '50');
    // From the keyboard: Option and the brackets from the box, or the arrows on the divider itself.
    await page.getByTestId('quick-input').press('Alt+BracketRight');
    await expect(divider).toHaveAttribute('aria-valuenow', '52');
    await divider.focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(divider).toHaveAttribute('aria-valuenow', '48');
    await expect.poll(async () => (await stored(userData)).quickOpenSplit).toBe(48);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  } finally {
    await app.close();
  }
  // The next launch opens on the split that was left.
  const again = await electron.launch({ executablePath: packagedExecutable(), args: [`--user-data-dir=${userData}`, path.join(path.dirname(userData), 'vault')] });
  try {
    const page = await again.firstWindow();
    await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
    await invokeMenu(again, 'quick-open');
    await expect(page.getByTestId('quick-divider')).toHaveAttribute('aria-valuenow', '48', { timeout: 15_000 });
  } finally {
    await again.close();
  }
});

test('the preview is the note rendered as the page renders it, or its source, switched with Option-E and remembered', async () => {
  const { app, page, userData } = await launch('views');
  try {
    await invokeMenu(app, 'quick-open');
    await page.getByTestId('quick-input').fill('plan');
    const preview = page.getByTestId('quick-preview');
    // Rendered: the editor's own elements, nothing written as markdown.
    const doc = preview.locator('.quick-preview-doc');
    await expect(doc.locator('h1')).toHaveText('Plan');
    await expect(doc.locator('strong')).toHaveText('kestrel');
    await expect(doc.locator('code').first()).toHaveText('code');
    await expect(doc.locator('table td').first()).toHaveText('1');
    await expect(doc).not.toContainText('**');
    await expect(doc).not.toContainText('`');
    // The reader's text size less one and their leading (Settings, 15px and 1.58 by default), with
    // headings a step above the text rather than a page above it.
    const sizes = await doc.evaluate((node) => ({ h1: parseFloat(getComputedStyle(node.querySelector('h1')!).fontSize), p: parseFloat(getComputedStyle(node.querySelector('p')!).fontSize), leading: parseFloat(getComputedStyle(node.querySelector('p')!).lineHeight) }));
    // One size under the page, so 14px against the default 15.
    expect(sizes.p).toBe(14);
    expect(sizes.leading).toBeCloseTo(14 * 1.58, 0);
    expect(sizes.h1).toBeCloseTo(19.6, 0);
    // Source: every byte, numbered.
    await page.getByTestId('quick-input').press('Alt+KeyE');
    const source = preview.locator('.quick-preview-source');
    await expect(source.locator('li').first()).toHaveText('# Plan');
    await expect(source).toContainText('The **kestrel** plan, with `code`');
    await expect.poll(async () => (await stored(userData)).quickOpenPreview).toBe('source');
    await page.keyboard.press('Escape');
    // Open again: still source.
    await invokeMenu(app, 'quick-open');
    await page.getByTestId('quick-input').fill('plan');
    await expect(preview.locator('.quick-preview-source')).toBeVisible();
    await page.getByTestId('quick-input').press('Alt+KeyE');
    await expect(preview.locator('.quick-preview-doc')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('the row under the pointer is the selected row and its note is previewed; the arrows agree', async () => {
  const { app, page } = await launch('hover');
  try {
    await invokeMenu(app, 'quick-open');
    // Every note under works/, the five and the one in jobs/.
    await page.getByTestId('quick-input').fill('works');
    const rows = page.getByTestId('quick-result');
    await expect(rows).toHaveCount(6);
    const title = page.getByTestId('quick-preview').locator('.quick-preview-doc h1');
    await rows.nth(3).hover();
    await expect(rows.nth(3)).toHaveAttribute('aria-selected', 'true');
    const name = await rows.nth(3).locator('.quick-name').textContent();
    await expect(title).toHaveText(name!);
    // The pointer rests; the arrow moves the selection, and it stays with the arrow.
    await page.getByTestId('quick-input').press('ArrowDown');
    await expect(rows.nth(4)).toHaveAttribute('aria-selected', 'true');
    await page.waitForTimeout(200);
    await expect(rows.nth(4)).toHaveAttribute('aria-selected', 'true');
    // Tab from the box switches what is searched, and the count says what is found.
    await page.getByTestId('quick-input').fill('kestrel');
    await page.getByTestId('quick-input').press('Tab');
    await page.getByTestId('quick-input').press('Tab');
    await expect(page.getByTestId('quick-tab-content')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('quick-tally')).toHaveText(/^\d+ lines? in 2 notes$/, { timeout: 15_000 });
  } finally {
    await app.close();
  }
});

test('Shift-Tab leaves the box for the sheet\'s controls, Tab walks on to the divider, and Escape comes back', async () => {
  const { app, page } = await launch('keys');
  try {
    await invokeMenu(app, 'quick-open');
    await page.getByTestId('quick-input').fill('plan');
    await page.getByTestId('quick-input').press('Shift+Tab');
    await expect(page.getByTestId('quick-tab-files')).toBeFocused();
    // Walk on until the divider has the keys, and move it.
    // The other modes, then the divider: the list's rows are walked with the arrows from the box, not with Tab.
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('quick-tab-folders')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('quick-tab-content')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('quick-divider')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('quick-divider')).toHaveAttribute('aria-valuenow', '52');
    // Escape from a control goes back to the box; from the box, it closes.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('quick-input')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('quick-open')).toHaveCount(0);
    // With focus on the sheet itself, as before the box has taken it, Escape closes it too.
    await invokeMenu(app, 'quick-open');
    await page.getByTestId('quick-open').evaluate((node) => { (node as HTMLElement).tabIndex = -1; (node as HTMLElement).focus(); });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('quick-open')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('every result says how old it is, and an empty box is never one row over nothing', async () => {
  const { app, page } = await launch('ages');
  try {
    await invokeMenu(app, 'quick-open');
    // Nothing opened yet in this vault: the notes changed lately fill the list, under their label.
    await expect(page.locator('.quick-section')).toContainText('Changed lately');
    expect(await page.getByTestId('quick-result').count()).toBeGreaterThan(5);
    await page.getByTestId('quick-input').fill('works');
    const ages = page.getByTestId('quick-result').locator('.quick-meta');
    await expect(ages).toHaveCount(6);
    for (const age of await ages.allTextContents()) expect(age).toMatch(/^(\d+m|today|yesterday|\d+d|[A-Z][a-z]{2} \d+)$/);
  } finally {
    await app.close();
  }
});

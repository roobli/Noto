/**
 * Memory in Note Info, in the packaged app.
 *
 * A folder that keeps memory (a `.noto/` folder, an `access.yaml` with an
 * agent, and reads already recorded), and one that does not. What is pinned:
 * Related lists what links to the note and what it names without linking;
 * Activity says who read it and which agent may not, and why; Properties says
 * where the note's sensitivity comes from; the timeline has a row of reads;
 * a folder without memory says so, writes nothing until asked, and keeps
 * memory once the person agrees in main's own sheet; and a folder whose memory
 * runs scripts runs none of them until the person has seen them named and
 * allowed them.
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

const made: string[] = [];
test.afterAll(() => {
  for (const directory of made) rmSync(directory, { recursive: true, force: true });
});

function scratch(name: string): string {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), `noto-e2e-${name}-`)));
  made.push(directory);
  return directory;
}

function write(root: string, rel: string, text: string): void {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text, 'utf8');
}

/** A folder that keeps memory, with one note read twice and one agent that may not read it. */
function rememberingFolder(): { root: string; note: string } {
  const root = scratch('memory');
  write(root, '目标设计说明.md', '---\nsensitivity: private\n---\n\n# 目标设计说明\n\n先看学习方案，再动手。\n');
  write(root, '学习方案.md', '# 学习方案\n\n一份计划。\n');
  write(root, 'notes.md', '# Notes\n\n见 [[目标设计说明]]。\n');
  write(root, '.noto/brain.yaml', 'kinds:\n  dated_names_are_logs: true\n');
  write(root, '.noto/access.yaml', [
    'sensitivity:', '  default: open', '  private: []', '  sealed: []', '',
    'principals:', '  claude-code:', '    keys: []', '    read: ["**"]', '    max_sensitivity: open', '    verbs: [read, search, recall]', '',
  ].join('\n'));
  const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString();
  write(root, '.noto/events/e2e/2026-11.jsonl', [
    { time: day(2), actor: 'owner', verb: 'open', path: '目标设计说明.md', session: 's1', from: 'notes.md' },
    { time: day(0), actor: 'owner', verb: 'open', path: '目标设计说明.md', session: 's2' },
    // An agent that edited the note itself and said so from its hook, three times in a row.
    { time: day(1), actor: 'claude-code', verb: 'write', path: '目标设计说明.md', session: 'cc', repeat: 3, until: day(1) },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n');
  return { root, note: path.join(root, '目标设计说明.md') };
}

/**
 * Answer main's next question as the person would, and keep what it asked: a
 * native sheet holds the input loop and no pointer in a test can reach it.
 */
async function answerSheets(app: ElectronApplication, button: number): Promise<() => Promise<{ message: string; detail: string }[]>> {
  await app.evaluate(({ dialog }, answer) => {
    const asked: { message: string; detail: string }[] = [];
    (globalThis as { askedSheets?: typeof asked }).askedSheets = asked;
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = (args.length > 1 ? args[1] : args[0]) as { message: string; detail?: string };
      asked.push({ message: options.message, detail: options.detail ?? '' });
      return { response: answer, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  }, button);
  return () => app.evaluate(() => (globalThis as { askedSheets?: { message: string; detail: string }[] }).askedSheets!);
}

async function launch(folder: string, note: string): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = scratch('user-data');
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ infoOpen: true, infoTab: 'dev.lr00rl.noto.memory:related' }));
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${userData}`, `--folder=${folder}`, `--open=${note}`],
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 760 });
  await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
  return { app, page };
}

const pane = (page: Page) => page.getByTestId('info-pane');
const tab = (page: Page, name: string) => pane(page).getByTestId('info-tab').filter({ hasText: name });

test.describe('memory in Note Info', () => {
  test('says what links here, what is named, who read it, and who may not', async () => {
    const { root, note } = rememberingFolder();
    const { app, page } = await launch(root, note);
    try {
      // The memory opens on the first question; the tab asks again when it is ready.
      const linksHere = pane(page).getByTestId('related-links-here');
      await expect(linksHere).toBeVisible({ timeout: 30_000 });
      await expect(linksHere.getByTestId('related-row')).toHaveAttribute('data-path', 'notes.md');
      await expect(pane(page).getByTestId('related-named-here').getByTestId('related-row')).toHaveAttribute('data-path', '学习方案.md');

      await expect(pane(page).locator('[data-track="dev.lr00rl.noto.memory:reads"]')).toBeVisible();

      await tab(page, 'Activity').click();
      await expect(pane(page).getByTestId('activity-reader')).toContainText('You');
      await expect(pane(page).getByTestId('activity-reader')).toContainText('twice');
      const barred = pane(page).getByTestId('activity-barred');
      await expect(barred.filter({ hasText: 'claude-code' })).toContainText('the note is private');
      await expect(barred.filter({ hasText: 'Without a key' })).toBeVisible();
      await expect(pane(page).getByTestId('activity-heat')).toContainText('Read twice, last today');
      // Its writes are named, and are not the person's reading.
      await expect(pane(page).getByTestId('activity-writer')).toContainText('claude-code');
      await expect(pane(page).getByTestId('activity-writer')).toContainText('wrote it 3 times');

      await tab(page, 'Properties').click();
      const sensitivity = pane(page).getByTestId('properties-memory').filter({ hasText: 'Sensitivity' });
      await expect(sensitivity).toContainText('private');
      await expect(sensitivity).toContainText('written in the note');

      // A press opens the note it names.
      await tab(page, 'Related').click();
      await linksHere.getByTestId('related-row').click();
      await expect(page.locator('.titlebar')).toContainText('notes.md');
    } finally {
      await app.close();
    }
  });

  test('a folder without memory writes nothing until the person agrees', async () => {
    const root = scratch('no-memory');
    write(root, 'a.md', '# A\n\nSee [[b]].\n');
    write(root, 'b.md', '# B\n');
    const { app, page } = await launch(root, path.join(root, 'a.md'));
    try {
      await expect(pane(page).getByTestId('memory-state')).toHaveAttribute('data-state', 'no-memory');
      await page.waitForTimeout(500);
      expect(existsSync(path.join(root, '.noto'))).toBe(false);

      // Main asks, saying what will be written; Cancel writes nothing.
      let asked = await answerSheets(app, 1);
      await pane(page).getByTestId('memory-keep-start').click();
      await expect.poll(async () => (await asked()).length).toBe(1);
      expect((await asked())[0]!.detail).toContain('access.yaml');
      await page.waitForTimeout(300);
      expect(existsSync(path.join(root, '.noto'))).toBe(false);
      await expect(pane(page).getByTestId('memory-state')).toHaveAttribute('data-state', 'no-memory');

      asked = await answerSheets(app, 0);
      await pane(page).getByTestId('memory-keep-start').click();
      await expect.poll(() => existsSync(path.join(root, '.noto', 'brain.yaml'))).toBe(true);
      expect(existsSync(path.join(root, '.noto', 'access.yaml'))).toBe(true);
      // Once the index is built, the tab says what it knows: b does not link here, nothing else does.
      await expect(pane(page).getByTestId('related-tab')).toBeVisible({ timeout: 30_000 });
    } finally {
      await app.close();
    }
  });

  test('a folder whose memory runs scripts runs none until the person allows them, by name', async () => {
    const { root, note } = rememberingFolder();
    const ran = path.join(scratch('script-ran'), 'ran');
    // Importing it is running it: the mark appears the moment the vault loads it.
    write(root, '.noto/scripts/10-mark.mjs', `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(ran)}, 'yes');\nexport default {};\n`);
    const { app, page } = await launch(root, note);
    try {
      await expect(pane(page).getByTestId('memory-state')).toHaveAttribute('data-state', 'untrusted');
      await page.waitForTimeout(500);
      expect(existsSync(ran)).toBe(false);

      // Cancel in main's sheet leaves it shut.
      let asked = await answerSheets(app, 1);
      await pane(page).getByTestId('memory-trust-start').click();
      await expect.poll(async () => (await asked()).length).toBe(1);
      expect((await asked())[0]!.detail).toContain('10-mark.mjs');
      await page.waitForTimeout(300);
      expect(existsSync(ran)).toBe(false);

      asked = await answerSheets(app, 0);
      await pane(page).getByTestId('memory-trust-start').click();
      await expect(pane(page).getByTestId('related-tab')).toBeVisible({ timeout: 30_000 });
      expect(existsSync(ran)).toBe(true);
    } finally {
      await app.close();
    }
  });
});

/**
 * Ask the vault, in the packaged app: a question at the top of Related is
 * answered with the folder's context pack, each note with why and an
 * excerpt; Copy as Context puts the pack on the clipboard as the Markdown an
 * agent asking through MCP is given; and the palette leads to the field.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

/** Screenshots for review, when asked for: `NOTO_ASK_SHOTS=/some/dir`. */
const SHOTS = process.env.NOTO_ASK_SHOTS ?? '';

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

function folder(): string {
  const root = scratch('ask');
  write(root, 'Ideas/Argus Index.md', '# Argus Index\n\nThe audit service, and how the names of its daily indexes carry a date.\n');
  write(root, 'Ideas/plan.md', '# Plan\n\nRoll out the new search before the end of the month.\n');
  write(root, 'Ideas/garden.md', '# Garden\n\nTomatoes want sun.\n');
  write(root, '.noto/brain.yaml', 'kinds:\n  dated_names_are_logs: true\n');
  return root;
}

async function launch(root: string): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = scratch('user-data');
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ infoOpen: true, infoTab: 'dev.lr00rl.noto.memory:related' }));
  const app = await electron.launch({ executablePath: packagedExecutable(), args: [`--user-data-dir=${userData}`, ...(SHOTS ? ['--force-device-scale-factor=2'] : []), `--folder=${root}`, `--open=${path.join(root, 'Ideas', 'plan.md')}`] });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
  return { app, page };
}

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
    find(Menu.getApplicationMenu()!.items)!.click();
  }, id);
}

test.describe('asking the vault', () => {
  test('answers a question with the notes that matter, and copies the pack as an agent gets it', async () => {
    const root = folder();
    const { app, page } = await launch(root);
    try {
      const pane = page.getByTestId('info-pane');
      await expect(pane.getByTestId('related-tab')).toBeVisible({ timeout: 30_000 });
      const field = pane.getByTestId('memory-ask-field');
      await field.fill('audit indexes');
      await field.press('Enter');
      const asked = pane.getByTestId('memory-asked');
      await expect(asked.getByTestId('memory-asked-row').first()).toContainText('Argus Index');
      await expect(asked).not.toContainText('Garden');
      if (SHOTS) {
        await page.waitForTimeout(400);
        const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
        writeFileSync(path.join(SHOTS, 'ask.png'), Buffer.from(png, 'base64'));
      }

      await asked.getByTestId('memory-copy-context').click();
      await expect(asked.getByTestId('memory-copy-context')).toHaveText('Copied');
      const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
      expect(copied).toContain('## Argus Index');
      expect(copied).toContain('Ideas/Argus Index.md');
      expect(copied).toMatch(/why: /);

      // Escape clears the answer and keeps the question.
      await field.press('Escape');
      await expect(asked).toHaveCount(0);
      await expect(field).toHaveValue('audit indexes');
    } finally {
      await app.close();
    }
  });

  test('is reached from the palette, with the field in focus', async () => {
    const root = folder();
    const { app, page } = await launch(root);
    try {
      await expect(page.getByTestId('info-pane').getByTestId('related-tab')).toBeVisible({ timeout: 30_000 });
      await invokeMenu(app, 'command-palette');
      await page.getByTestId('palette-input').fill('ask the folder');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('memory-ask-field')).toBeFocused();
    } finally {
      await app.close();
    }
  });
});

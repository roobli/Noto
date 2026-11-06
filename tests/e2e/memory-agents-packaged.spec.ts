/**
 * Settings → Memory and a folder's Privacy, in the packaged app.
 *
 * A folder that keeps memory, with a hand-written `.noto/access.yaml`. What
 * is pinned: the pane lists whoever brings no key; adding an agent asks
 * three questions and then main's own sheet, writes the policy keeping its
 * comments, and shows the key once with a setup to copy; the command line
 * Noto ships serves that key when run by Node, which is what the copied
 * setup does, and refuses it once the key is taken back; and a folder is
 * made private from its own menu.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

/** Screenshots for review, when asked for: `NOTO_AGENTS_SHOTS=/some/dir`. */
const SHOTS = process.env.NOTO_AGENTS_SHOTS ?? '';

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

const policy = (root: string) => readFileSync(path.join(root, '.noto', 'access.yaml'), 'utf8');

function folder(): string {
  const root = scratch('agents');
  write(root, 'Ideas/plan.md', '# Plan\n\nOpen to anyone.\n');
  write(root, 'Work/budget.md', '# Budget\n\nNot for every agent.\n');
  write(root, '.noto/brain.yaml', 'kinds:\n  dated_names_are_logs: true\n');
  write(root, '.noto/access.yaml', '# Mine, by hand.\nsensitivity:\n  default: open\n  private: []\n  sealed: []\n\nprincipals: {}\n');
  return root;
}

async function launch(root: string): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = scratch('user-data');
  const app = await electron.launch({ executablePath: packagedExecutable(), args: [`--user-data-dir=${userData}`, ...(SHOTS ? ['--force-device-scale-factor=2'] : []), `--folder=${root}`, `--open=${path.join(root, 'Ideas', 'plan.md')}`] });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
  return { app, page };
}

/** Answer main's next sheets as the person would; a native sheet holds the input loop and no pointer in a test reaches it. */
async function answerSheets(app: ElectronApplication, button: number): Promise<void> {
  await app.evaluate(({ dialog }, answer) => {
    dialog.showMessageBox = (async () => ({ response: answer, checkboxChecked: false })) as typeof dialog.showMessageBox;
  }, button);
}

/** The command line Noto ships, run by Node as a copied setup runs it. */
function cli(args: readonly string[], key?: string): { status: number | null; out: string } {
  const exe = packagedExecutable();
  const script = process.platform === 'darwin'
    ? path.join(exe, '..', '..', 'Resources', 'app.asar.unpacked', '.vite', 'build', 'noto-vault.js')
    : path.join(path.dirname(exe), 'resources', 'app.asar.unpacked', '.vite', 'build', 'noto-vault.js');
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, ...(key ? { NOTO_VAULT_KEY: key } : {}) } });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

test.describe('agents and privacy', () => {
  test('adds an agent with a key shown once, which the shipped server takes until it is taken back', async () => {
    const root = folder();
    const { app, page } = await launch(root);
    try {
      await page.getByTestId('settings-toggle').click();
      await page.getByTestId('pref-memory').click();
      const pane = page.getByTestId('memory-pane');
      await expect(pane.locator('[data-testid="memory-agent"][data-name="default"]')).toContainText('Any agent without a key');

      await pane.getByTestId('memory-add-agent').click();
      await pane.getByTestId('memory-add-name').fill('codex');
      await pane.getByTestId('memory-add-propose').check();
      // Cancel in main's sheet writes nothing.
      await answerSheets(app, 1);
      await pane.getByTestId('memory-add-submit').click();
      await page.waitForTimeout(300);
      expect(policy(root)).not.toContain('codex');

      await answerSheets(app, 0);
      await pane.getByTestId('memory-add-submit').click();
      const key = (await pane.getByTestId('memory-key-text').textContent())!.trim();
      expect(key.length).toBeGreaterThan(20);
      expect(policy(root)).toContain('  codex:');
      expect(policy(root)).toContain('# Mine, by hand.');
      expect(policy(root)).not.toContain(key);
      await expect(pane.locator('[data-testid="memory-agent"][data-name="codex"]')).toContainText('proposes changes');
      if (SHOTS) {
        await page.waitForTimeout(400);
        const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
        writeFileSync(path.join(SHOTS, 'memory-pane-key.png'), Buffer.from(png, 'base64'));
      }

      // What Copy Setup gives Claude Code names the shipped server, the folder and the key.
      await pane.getByTestId('memory-copy-claude').click();
      const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
      expect(copied).toContain('claude mcp add noto-');
      expect(copied).toContain(`NOTO_VAULT_KEY=${key}`);
      expect(copied).toContain('noto-vault.js');

      // The server the setup starts answers to the key, and only as codex.
      const status = cli(['status', '--root', root], key);
      expect(status.status).toBe(0);

      await answerSheets(app, 0);
      await pane.locator('[data-testid="memory-agent"][data-name="codex"]').getByTestId('memory-agent-revoke').click();
      await expect(pane.locator('[data-testid="memory-agent"][data-name="codex"]')).toContainText('Key taken back');
      // The block keeps what codex was allowed, with no key and when it was taken back.
      expect(policy(root)).toMatch(/codex:\n {4}keys: \[\]\n(?: {4}.*\n)* {4}revoked: "/);
      const refused = cli(['status', '--root', root], key);
      expect(refused.status).not.toBe(0);
      expect(refused.out).toContain('names no principal');
    } finally {
      await app.close();
    }
  });

  test('makes a folder private from its own menu, ticking the level it has', async () => {
    const root = folder();
    const { app, page } = await launch(root);
    try {
      await app.evaluate(({ Menu }) => {
        const shown: Electron.Menu[] = [];
        (globalThis as { shownMenus?: Electron.Menu[] }).shownMenus = shown;
        Menu.prototype.popup = function popup(this: Electron.Menu) { shown.push(this); };
      });
      const privacy = () => app.evaluate(() => {
        const menu = (globalThis as { shownMenus?: Electron.Menu[] }).shownMenus!.at(-1)!;
        const item = menu.items.find((entry) => entry.label === 'Privacy');
        return item?.submenu?.items.map((entry) => ({ label: entry.label, checked: entry.checked })) ?? null;
      });
      const work = page.getByTestId('tree-directory').filter({ hasText: 'Work' });
      await work.click({ button: 'right' });
      await expect.poll(privacy).not.toBeNull();
      expect((await privacy())!.find((entry) => entry.checked)?.label).toMatch(/^Open/);
      await app.evaluate(() => {
        const menu = (globalThis as { shownMenus?: Electron.Menu[] }).shownMenus!.at(-1)!;
        menu.items.find((entry) => entry.label === 'Privacy')!.submenu!.items.find((entry) => entry.label.startsWith('Private'))!.click();
      });
      await expect.poll(() => policy(root)).toContain('private: ["Work/"]');
      expect(policy(root)).toContain('# Mine, by hand.');
      await work.click({ button: 'right' });
      await expect.poll(async () => (await privacy())?.find((entry) => entry.checked)?.label ?? '').toMatch(/^Private/);
      // A file has no Privacy of its own: its folder's, or its frontmatter, says.
      await page.getByTestId('tree-file').filter({ hasText: 'plan.md' }).click({ button: 'right' });
      await expect.poll(async () => (await privacy()) === null).toBe(true);
    } finally {
      await app.close();
    }
  });
});

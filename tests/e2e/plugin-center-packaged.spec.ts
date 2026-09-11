import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

/**
 * Plugin lifecycle, driven through the Plugin Center the way a user drives it.
 *
 * This replaces the retired lifecycle spec, which reached the same behaviour
 * through build-variant test controls and CLI mode flags. Those are gone, so
 * the coverage is rebuilt against the shipping UI: nothing here touches a
 * channel a user could not reach.
 */

const root = path.resolve(__dirname, '../..');
const resultRoot = path.join(root, 'test-results/plugin-center-packaged');

interface RunningApp {
  app: ElectronApplication;
  page: Page;
  issues: string[];
}

async function launch(name: string): Promise<RunningApp & { file: string }> {
  const workspace = path.join(resultRoot, name);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const file = path.join(workspace, 'note.md');
  await writeFile(file, '# Plugins\n\nA document to attach the editor to.\n', 'utf8');

  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${file}`],
    env: { ...process.env, NTO_EVIDENCE_DIR: path.join(workspace, 'evidence') },
  });
  const page = await app.firstWindow();
  const issues: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') issues.push(message.text());
  });
  page.on('pageerror', (error) => issues.push(error.message));
  await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
  return { app, page, issues, file };
}

/**
 * Plugins live under Settings › Plugins: open the gear, then the Plugins
 * category, then a list row for the detail pane.
 */
async function openSettingsPlugins(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  if (!(await page.getByTestId('settings-panel').isVisible().catch(() => false))) {
    await page.getByTestId('settings-toggle').click();
  }
  await expect(page.getByTestId('settings-panel')).toBeVisible();
  await page.getByTestId('pref-plugins').click();
}

async function pickPlugin(page: Page, name: string) {
  // Detail is one-at-a-time; return to the list before opening another row.
  const crumb = page.getByTestId('plugins-crumb');
  if (await crumb.isVisible().catch(() => false)) {
    await crumb.click();
  }
  const row = page.locator('.plugin-row').filter({ has: page.locator('strong', { hasText: name }) });
  await row.scrollIntoViewIfNeeded();
  await row.click();
  const detail = page.locator('.plugin-detail').filter({ has: page.locator('strong', { hasText: name }) });
  await expect(detail).toBeVisible();
  return detail;
}

async function openPluginCenter(page: Page): Promise<void> {
  await openSettingsPlugins(page);
  await pickPlugin(page, 'Semantic Focus');
  await expect(page.getByTestId('renderer-plugin-state')).toBeVisible();
}

/**
 * Each plugin section offers a single primary button whose label follows the
 * lifecycle, so the flow is driven by clicking whatever it currently says.
 */
function primaryButton(page: Page, section: 'renderer-plugin-state' | 'service-state') {
  return page.getByTestId(section).locator('button.plugin-primary');
}

const rendererStatus = (page: Page) => page.getByTestId('renderer-plugin-lifecycle');

test.describe('plugin center', () => {
  test('starts every bundled plugin disabled', async () => {
    const { app, page, issues } = await launch('default-disabled');
    try {
      await openPluginCenter(page);
      // Default deny: a freshly installed plugin must not be running.
      await expect(rendererStatus(page)).toHaveText('Disabled');
      await expect(primaryButton(page, 'renderer-plugin-state')).toHaveText('Enable');
      await pickPlugin(page, 'Fixture Reader');
      await expect(page.getByTestId('filesystem-plugin-lifecycle')).toHaveText('Disabled');
      expect(issues).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('enabling a plugin leaves it idle until something activates it', async () => {
    const { app, page, issues } = await launch('enable-idle');
    try {
      await openPluginCenter(page);
      await primaryButton(page, 'renderer-plugin-state').click();

      // Enabled is not running. Activation needs an explicit trigger, which is
      // the whole point of the lifecycle split.
      await expect(rendererStatus(page)).toHaveText('Enabled, waiting for editor', { timeout: 15_000 });
      await expect(primaryButton(page, 'renderer-plugin-state')).toHaveText('Activate for this editor');
      await expect(page.getByTestId('noto-app')).toHaveAttribute('data-plugin-registrations', '0');
      expect(issues).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('activates a renderer plugin and returns it to disabled cleanly', async () => {
    const { app, page, issues } = await launch('activate-and-disable');
    try {
      await openPluginCenter(page);
      const primary = primaryButton(page, 'renderer-plugin-state');
      await primary.click();
      await expect(rendererStatus(page)).toHaveText('Enabled, waiting for editor', { timeout: 15_000 });

      await primary.click();
      await expect(rendererStatus(page)).toHaveText('Running', { timeout: 15_000 });
      // The shell mirrors main's authoritative snapshot on the root element.
      await expect(page.getByTestId('noto-app')).toHaveAttribute('data-plugin-lifecycle', 'active');
      await expect(page.getByTestId('noto-app')).not.toHaveAttribute('data-plugin-registrations', '0');

      await primary.click();
      await expect(rendererStatus(page)).toHaveText('Disabled', { timeout: 15_000 });
      // A clean teardown must leave no renderer registrations behind.
      await expect(page.getByTestId('noto-app')).toHaveAttribute('data-plugin-registrations', '0');
      expect(issues).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('runs the ported Title Shift plugin against the real document', async () => {
    const workspace = path.join(resultRoot, 'title-shift');
    await rm(workspace, { recursive: true, force: true });
    await mkdir(path.join(workspace, 'user-data'), { recursive: true });
    const file = path.join(workspace, 'headings.md');
    const original = '# One\n\nBody stays put.\n\n## Two\n';
    await writeFile(file, original, 'utf8');

    const app = await electron.launch({
      executablePath: packagedExecutable(),
      args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${file}`],
    });
    const page = await app.firstWindow();
    try {
      await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
      await page.setViewportSize({ width: 1280, height: 900 });
      await openSettingsPlugins(page);

      // Enable, then activate. The section is found by the plugin's own name.
      const section = await pickPlugin(page, 'Title Shift');
      await section.locator('button.plugin-primary').click();
      await section.locator('button.plugin-primary').click();
      await expect(page.locator('.ProseMirror')).toBeVisible();

      // Demote every heading through the command palette.
      await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+KeyK`);
      await page.getByRole('button', { name: /demote a level/i }).click();
      // The plugin's own word for what it did, in the status line.
      await expect(page.getByTestId('status-notice')).toHaveText(/Headings demoted/);

      const editor = page.locator('.ProseMirror');
      await expect(editor.locator('h2')).toHaveText('One');
      await expect(editor.locator('h3')).toHaveText('Two');

      // Saving writes the transformed headings and leaves the untouched
      // paragraph byte identical.
      await page.getByTestId('save-button').click();
      await expect(page.getByTestId('file-state')).toHaveText('Saved', { timeout: 15_000 });
      expect(await readFile(file, 'utf8')).toBe('## One\n\nBody stays put.\n\n### Two\n');
    } finally {
      await app.close();
    }
  });

  test('runs the ported Markdown Padding plugin against the real document', async () => {
    const workspace = path.join(resultRoot, 'md-padding');
    await rm(workspace, { recursive: true, force: true });
    await mkdir(path.join(workspace, 'user-data'), { recursive: true });
    const file = path.join(workspace, 'cjk.md');
    await writeFile(file, '# 标题\n\n这是中文English混排text测试。\n', 'utf8');

    const app = await electron.launch({
      executablePath: packagedExecutable(),
      args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${file}`],
    });
    const page = await app.firstWindow();
    try {
      await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
      await page.setViewportSize({ width: 1280, height: 900 });
      await openSettingsPlugins(page);

      const section = await pickPlugin(page, 'Markdown Padding');
      await section.locator('button.plugin-primary').click();
      await section.locator('button.plugin-primary').click();

      await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+KeyK`);
      await page.getByRole('button', { name: /CJK spacing/i }).click();

      await expect(page.locator('.ProseMirror p').first())
        .toHaveText('这是中文 English 混排 text 测试。');

      await page.getByTestId('save-button').click();
      await expect(page.getByTestId('file-state')).toHaveText('Saved', { timeout: 15_000 });
      // The heading needed no spacing, so it is written back unchanged.
      expect(await readFile(file, 'utf8')).toBe('# 标题\n\n这是中文 English 混排 text 测试。\n');
    } finally {
      await app.close();
    }
  });

  test('keeps plugin state across a restart, because main owns it', async () => {
    const workspace = path.join(resultRoot, 'persisted');
    await rm(workspace, { recursive: true, force: true });
    await mkdir(path.join(workspace, 'user-data'), { recursive: true });
    const file = path.join(workspace, 'note.md');
    await writeFile(file, '# Plugins\n\nBody.\n', 'utf8');

    const args = [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${file}`];
    const first = await electron.launch({ executablePath: packagedExecutable(), args });
    const firstPage = await first.firstWindow();
    await firstPage.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
    await openPluginCenter(firstPage);
    await primaryButton(firstPage, 'renderer-plugin-state').click();
    await expect(rendererStatus(firstPage)).toHaveText('Enabled, waiting for editor', { timeout: 15_000 });
    await first.close();

    const second = await electron.launch({ executablePath: packagedExecutable(), args });
    const secondPage = await second.firstWindow();
    try {
      await secondPage.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
      await openPluginCenter(secondPage);
      // Enabled persisted, and it still did not activate itself on its own.
      // Main remembered it was enabled, and the shell raised editor.ready when
      // the note's editor came up, so it is running without a button pressed.
      // Kept tight on purpose. This used to fail about one run in three under
      // a full suite's load, and the cause was a race rather than slowness:
      // the editor announced itself only if the plugin snapshots had already
      // arrived, so whenever they were second the plugin waited for ever. A
      // generous timeout would hide that coming back.
      await expect(rendererStatus(secondPage)).toHaveText('Running', { timeout: 20_000 });
    } finally {
      await second.close();
    }
  });
});

/**
 * A plugin's declared hotkey.
 *
 * The manifest declares `Mod+Shift+ArrowDown`, and the shell reads the declared
 * hotkeys rather than hard coding them. That dispatch path had no test: the
 * plugins were only ever driven through the command palette, so a plugin could
 * declare a hotkey that never fired and nothing would notice.
 */
test.describe('plugin hotkeys', () => {
  test('runs a plugin from the hotkey its manifest declares', async () => {
    const workspace = path.join(resultRoot, 'hotkey');
    await rm(workspace, { recursive: true, force: true });
    await mkdir(path.join(workspace, 'user-data'), { recursive: true });
    const file = path.join(workspace, 'headings.md');
    await writeFile(file, '# One\n\nBody stays put.\n\n## Two\n', 'utf8');

    const app = await electron.launch({
      executablePath: packagedExecutable(),
      args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${file}`],
    });
    const page = await app.firstWindow();
    try {
      await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
      await page.setViewportSize({ width: 1280, height: 900 });

      await openSettingsPlugins(page);
      const section = await pickPlugin(page, 'Title Shift');
      await section.locator('button.plugin-primary').click();
      await section.locator('button.plugin-primary').click();
      // Settings is modal, so it is dismissed rather than toggled off from
      // the title bar behind it.
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('settings-panel')).toBeHidden();

      // The declared chord, pressed in the document rather than chosen from a
      // menu. `Mod` is Command here and Control elsewhere.
      await page.locator('.ProseMirror').click();
      await page.keyboard.press(
        process.platform === 'darwin' ? 'Meta+Shift+ArrowDown' : 'Control+Shift+ArrowDown',
      );

      const editor = page.locator('.ProseMirror');
      await expect(editor.locator('h2')).toHaveText('One');
      await expect(editor.locator('h3')).toHaveText('Two');
    } finally {
      await app.close();
    }
  });
});

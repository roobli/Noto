import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

const manifest = (id: string, name: string) => JSON.stringify({
  schemaVersion: 2, id, name, version: '1.0.0', runtime: 'sandboxed',
  description: `${name} reports where it runs.`,
  activation: { startup: false, events: ['editor.ready'], hotkeys: [] },
  capabilities: ['editor.read', 'editor.transform'], lifecycle: ['activate', 'deactivate'],
  commands: [{ id: 'where.tell', title: `${name}: tell where it runs` }],
  settings: [], hotkeys: [], editorExtensions: [], uiExtensions: [],
});

// Appends whether it can see a page: none in the sandbox, present when trusted.
const MAIN = `export function activate(ctx) {
  ctx.registerCommand('where.tell', async () => {
    const markdown = await ctx.port.getMarkdown();
    await ctx.port.replaceMarkdown(markdown + '\\nruns page=' + (typeof document === 'undefined' ? 'none' : 'present') + '\\n');
  });
}
`;
const digest = createHash('sha256').update(MAIN).digest('hex');
const exists = (file: string) => access(file).then(() => true, () => false);

function serve(files: Record<string, string>): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const body = files[request.url ?? ''];
      if (body === undefined) { response.writeHead(404); response.end('not found'); return; }
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(body);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

async function launch(userData: string, file: string, origin: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    // The app fetches through the system's proxy, as it should for GitHub;
    // a machine whose proxy is a PAC file can stall on this test's local
    // server, so the test alone goes direct.
    args: [`--user-data-dir=${userData}`, `--open=${file}`, '--no-proxy-server'],
    env: { ...process.env, NOTO_PLUGIN_RAW_ORIGIN: origin },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
  await page.setViewportSize({ width: 1280, height: 900 });
  return { app, page };
}

async function openPlugins(page: Page) {
  await page.getByTestId('settings-toggle').click();
  await page.getByTestId('pref-plugins').click();
}

async function runCommand(page: Page, words: string) {
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+KeyP`);
  await page.keyboard.type(words);
  await page.keyboard.press('Enter');
}

test('plugins install from GitHub, the marketplace and a folder, are trusted on request, and uninstall', async () => {
  test.setTimeout(180_000);
  const workspace = path.join(process.cwd(), 'test-results', 'plugin-install');
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  const userData = path.join(workspace, 'user-data');
  const file = path.join(workspace, 'note.md');
  await writeFile(file, '# Note\n\nA line.\n', 'utf8');
  const localFolder = path.join(workspace, 'local-plugin');
  await mkdir(localFolder, { recursive: true });
  await writeFile(path.join(localFolder, 'manifest.json'), manifest('local.test.folder', 'From Folder'), 'utf8');
  await writeFile(path.join(localFolder, 'main.js'), MAIN, 'utf8');

  const { server, origin } = await serve({
    '/someone/where/HEAD/manifest.json': manifest('local.test.where', 'Where'),
    '/someone/where/HEAD/main.js': MAIN,
    '/market/index/HEAD/index.json': JSON.stringify({
      schemaVersion: 1,
      plugins: [{ id: 'local.test.listed', name: 'Listed', description: 'From the marketplace.', version: '1.0.0', repo: 'someone/listed', sha256: digest }],
    }),
    '/someone/listed/HEAD/manifest.json': manifest('local.test.listed', 'Listed'),
    '/someone/listed/HEAD/main.js': MAIN,
  });
  const userRoot = path.join(userData, 'plugins', 'user');
  try {
    let { app, page } = await launch(userData, file, origin);

    // From GitHub: a preview first, saying what it may do; nothing on disk yet.
    await openPlugins(page);
    await page.getByTestId('plugin-add-github').click();
    await page.getByTestId('plugin-github-url').fill('https://github.com/someone/where');
    await page.getByTestId('plugin-github-look').click();
    const preview = page.getByTestId('plugin-preview');
    // Either a preview or the reason there is none, which then fails with its words.
    await expect(preview.or(page.getByTestId('plugin-source-problem'))).toBeVisible();
    await expect(page.getByTestId('plugin-source-problem')).toHaveCount(0);
    await expect(preview).toContainText('Where');
    await expect(preview).toContainText('Can change the note in front');
    await expect(preview).toContainText('GitHub · someone/where');
    await expect(access(path.join(userRoot, 'local.test.where'))).rejects.toThrow();
    await page.getByTestId('plugin-install').click();
    await expect(page.getByTestId('plugin-restart').first()).toBeVisible();
    const record = JSON.parse(await readFile(path.join(userRoot, 'local.test.where', '.noto', 'record.json'), 'utf8'));
    expect(record).toMatchObject({ id: 'local.test.where', trust: 'sandboxed', mainDigest: digest, source: { kind: 'github', owner: 'someone', repo: 'where' } });

    // From the marketplace: the entry pins the code's digest, and the preview says it matched.
    await page.evaluate(async () => (window as unknown as { notoSettings: { write(r: unknown): Promise<unknown> } })
      .notoSettings.write({ version: 1, requestId: 'market-1', patch: { pluginMarketplace: 'market/index' } }));
    await page.getByTestId('plugin-marketplace').click();
    const market = page.getByTestId('plugin-market');
    await expect(market).toContainText('Listed');
    await market.getByRole('button', { name: /Install/ }).click();
    await expect(preview).toContainText('the code the marketplace vouched for');
    await page.getByTestId('plugin-install').click();
    // Written once main finishes the install, a moment after the click.
    await expect.poll(() => exists(path.join(userRoot, 'local.test.listed', 'main.js'))).toBe(true);

    // From a folder the reader picks: main shows the dialog, stubbed here.
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
    }, localFolder);
    await page.getByTestId('plugin-add-folder').click();
    await expect(preview).toContainText('From Folder');
    await page.getByTestId('plugin-install').click();
    // Written once main finishes the install, a moment after the click.
    await expect.poll(() => exists(path.join(userRoot, 'local.test.folder', 'main.js'))).toBe(true);
    await app.close();

    // Next start: installed, off, sandboxed. Enabled, its command sees no page.
    ({ app, page } = await launch(userData, file, origin));
    await openPlugins(page);
    // Rebuilt for each window: a locator belongs to the page it came from.
    const row = () => page.locator('.plugin-row').filter({ has: page.locator('strong', { hasText: /^Where$/ }) });
    const detail = () => page.locator('.plugin-detail').filter({ has: page.locator('strong', { hasText: /^Where$/ }) });
    const editor = () => page.locator('.canvas-slot:not([hidden]) .ProseMirror');
    await row().click();
    await expect(detail()).toContainText('Installed, sandboxed');
    await detail().locator('button.plugin-primary').click();
    await detail().locator('button.plugin-primary').click();
    await page.getByTestId('settings-close').click();
    await runCommand(page, 'Where: tell');
    await expect(editor()).toContainText('runs page=none');

    // Trusted fully, after the warning main shows (stubbed to accept).
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox;
    });
    await openPlugins(page);
    await row().click();
    // The switch turns on once main confirms, not on the click.
    await detail().getByTestId('plugin-trust').click({ force: true });
    await expect(detail().getByTestId('plugin-trust')).toBeChecked();
    await expect(detail().getByTestId('plugin-restart')).toBeVisible();
    await app.close();

    // Next start: it runs in the page itself, as a bundled plugin does.
    ({ app, page } = await launch(userData, file, origin));
    await openPlugins(page);
    await row().click();
    await expect(detail()).toContainText('Installed, trusted');
    await page.getByTestId('settings-close').click();
    await runCommand(page, 'Where: tell');
    await expect(editor()).toContainText('runs page=present');

    // And it uninstalls.
    await openPlugins(page);
    await row().click();
    await detail().getByTestId('plugin-uninstall').click();
    await detail().getByTestId('plugin-uninstall-confirm').click();
    await expect.poll(() => exists(path.join(userRoot, 'local.test.where'))).toBe(false);
    await app.close();
  } finally {
    server.close();
  }
});

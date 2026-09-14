import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

/**
 * The remote control is driven from this process over its own socket, which
 * is the only honest way to test it: the app is a separate process, and what
 * a caller does is exactly what these requests do.
 */
async function ask(
  port: number,
  route: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(token.length > 0 ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

/** The first line of the answer to a request written by hand. */
function statusLine(port: number, lines: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`${[...lines, 'Connection: close', '', ''].join('\r\n')}`);
    });
    let answer = '';
    socket.setTimeout(10_000, () => { socket.destroy(); reject(new Error('no answer')); });
    socket.on('data', (chunk) => { answer += String(chunk); });
    socket.on('error', reject);
    socket.on('close', () => resolve(answer.split('\r\n')[0]));
  });
}

async function turnOn(page: Page): Promise<{ port: number; token: string }> {
  await page.getByTestId('settings-toggle').click();
  await page.waitForSelector('[data-testid="settings-panel"]', { state: 'visible' });
  await page.locator('.pref-dialog nav button').filter({ hasText: /remote/i }).first().click();
  await page.getByTestId('setting-remote-control').click();
  await expect(page.getByTestId('remote-state')).toContainText('Listening on', { timeout: 15_000 });
  const state = await page.getByTestId('remote-state').textContent() ?? '';
  const port = Number(/:(\d+)/.exec(state)?.[1]);
  const token = await page.getByTestId('remote-token').inputValue();
  // Belt-and-suspenders: wait until the socket answers 200 with the token the
  // pane shows. The durable fix is TokenStore single-flight + live getToken;
  // this poll only covers a brief listen race, not a permanent token mismatch.
  await expect.poll(async () => (await ask(port, '/v1/status', token)).status, { timeout: 10_000 }).toBe(200);
  await page.getByTestId('settings-close').click();
  return { port, token };
}

async function launch(name: string): Promise<{ app: ElectronApplication; page: Page; vault: string; userData: string }> {
  const workspace = path.join(process.cwd(), 'test-results', 'remote-control', name);
  await rm(workspace, { recursive: true, force: true });
  const userData = path.join(workspace, 'user-data');
  await mkdir(userData, { recursive: true });
  const vault = path.join(workspace, 'vault');
  await mkdir(vault, { recursive: true });
  await writeFile(path.join(vault, 'first.md'), '# First\n\nThe first note.\n', 'utf8');
  await writeFile(path.join(vault, 'second.md'), '# Second\n\nThe second note.\n', 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${userData}`, vault],
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
  return { app, page, vault, userData };
}

test.describe('driving Noto from outside it', () => {
  test('says what is open, reads it, opens another, inserts and runs a command', async () => {
    const { app, page, vault } = await launch('drive');
    try {
      await page.getByTestId('tree-file').filter({ hasText: 'first' }).click();
      await page.locator('.canvas-slot:not([hidden]) .ProseMirror').waitFor({ state: 'visible' });
      const { port, token } = await turnOn(page);

      // The window says it is on, and the flag opens the pane that stops it.
      await expect(page.getByTestId('remote-flag')).toBeVisible();

      const status = await ask(port, '/v1/status', token);
      expect(status.status).toBe(200);
      expect(status.json).toMatchObject({ vault, note: path.join(vault, 'first.md'), dirty: false });

      expect(status.json).toMatchObject({ protocol: 1 });

      const document = await ask(port, '/v1/document', token);
      expect(document.json).toMatchObject({
        markdown: '# First\n\nThe first note.\n', source: 'editor', dirty: false,
      });

      // It says what it can do, so a caller need not read a page first.
      const commands = await ask(port, '/v1/commands', token);
      expect(commands.json.commands).toContain('save');
      expect(commands.json.insertPlaces).toEqual(['caret', 'end']);

      // A path relative to the folder that is open, which is what a caller writes.
      expect((await ask(port, '/v1/open', token, { path: 'second.md' })).status).toBe(200);
      await expect(page.locator('.canvas-slot:not([hidden]) .ProseMirror')).toContainText('The second note.');

      const opened = await ask(port, '/v1/open', token, { path: path.join(vault, 'second.md') });
      expect(opened.status).toBe(200);
      await expect(page.locator('.canvas-slot:not([hidden]) .ProseMirror')).toContainText('The second note.');

      // Inserting lands at the caret and leaves the note unsaved, which the
      // status then says, so a caller reading the file knows it is behind.
      await page.locator('.canvas-slot:not([hidden]) .ProseMirror p').first().click();
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
      expect((await ask(port, '/v1/insert', token, { text: ' Added from outside.' })).status).toBe(200);
      await expect(page.locator('.canvas-slot:not([hidden]) .ProseMirror')).toContainText('Added from outside.');
      await expect.poll(async () => (await ask(port, '/v1/status', token)).json.dirty).toBe(true);

      // While it is unsaved, reading gives the editor's own copy rather than
      // the file, which is the whole reason the source is named.
      const live = await ask(port, '/v1/document', token);
      expect(live.json).toMatchObject({ source: 'editor', dirty: true });
      expect(String(live.json.markdown)).toContain('Added from outside.');

      // And a command it allows: saving, which puts the insert on disk.
      expect((await ask(port, '/v1/command', token, { command: 'save' })).status).toBe(200);
      await expect.poll(() => readFile(path.join(vault, 'second.md'), 'utf8'))
        .toContain('Added from outside.');
      await expect.poll(async () => (await ask(port, '/v1/status', token)).json.dirty).toBe(false);

      // Appending puts a block of its own after the last one, rather than
      // joining the paragraph the caret happened to be in.
      expect((await ask(port, '/v1/insert', token, { text: 'A line of its own.', at: 'end' })).status).toBe(200);
      expect((await ask(port, '/v1/command', token, { command: 'save' })).status).toBe(200);
      await expect.poll(() => readFile(path.join(vault, 'second.md'), 'utf8'))
        .toMatch(/\n\nA line of its own\.\n$/);

      // And it can search the vault it has open.
      const found = await ask(port, '/v1/search', token, { query: 'second note' });
      expect(found.status).toBe(200);
      expect((found.json.matches as { relativePath: string }[])[0].relativePath).toBe('second.md');
    } finally {
      await app.close();
    }
  });

  test('refuses a caller without the token, a browser, and a command off its list', async () => {
    const { app, page, vault } = await launch('refuse');
    try {
      await page.getByTestId('tree-file').first().click();
      await page.locator('.canvas-slot:not([hidden]) .ProseMirror').waitFor({ state: 'visible' });
      const { port, token } = await turnOn(page);

      expect((await ask(port, '/v1/status', '')).status).toBe(401);
      expect((await ask(port, '/v1/status', 'not-the-token')).status).toBe(401);

      // A page in a browser carries an origin, and is refused for it.
      const fromPage = await fetch(`http://127.0.0.1:${port}/v1/status`, {
        headers: { authorization: `Bearer ${token}`, origin: 'https://example.com' },
      });
      expect(fromPage.status).toBe(403);

      // A name pointed at the loopback address, which is what rebinding is.
      // Written on a raw socket, since `fetch` will not let a caller set the
      // host header and that is exactly the header under test.
      expect(await statusLine(port, [
        'GET /v1/status HTTP/1.1',
        'Host: evil.example.com',
        `Authorization: Bearer ${token}`,
      ])).toContain('403');
      // The same request under the address it is actually listening on.
      expect(await statusLine(port, [
        'GET /v1/status HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        `Authorization: Bearer ${token}`,
      ])).toContain('200');

      // A menu command that is not on the remote's own list.
      const unknown = await ask(port, '/v1/command', token, { command: 'export-pdf' });
      expect(unknown.status).toBe(400);
      expect(unknown.json.code).toBe('unknown-command');
      // And a path outside the folder that is open.
      const outside = await ask(port, '/v1/open', token, { path: '/etc/hosts' });
      expect(outside.status).toBe(404);
      expect(await readFile(path.join(vault, 'first.md'), 'utf8')).toContain('The first note.');
    } finally {
      await app.close();
    }
  });

  test('is off until it is switched on, keeps its token privately, and stops when switched off', async () => {
    const { app, page, userData } = await launch('lifecycle');
    try {
      // Nothing is listening before the switch.
      await expect(page.getByTestId('remote-flag')).toHaveCount(0);
      const { port, token } = await turnOn(page);
      expect((await ask(port, '/v1/status', token)).status).toBe(200);

      // The token is on disk where only this account can read it, and beside
      // it the port, so a script can find both without opening a window. The
      // mode is only asked about where a mode means something: Windows keeps
      // its access rules elsewhere and reports every file as world readable.
      const tokenFile = path.join(userData, 'remote-token');
      const addressFile = path.join(userData, 'remote.json');
      if (process.platform !== 'win32') {
        expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
        expect((await stat(addressFile)).mode & 0o777).toBe(0o600);
      }
      expect((await readFile(tokenFile, 'utf8')).trim()).toBe(token);
      expect(JSON.parse(await readFile(addressFile, 'utf8'))).toMatchObject({ port });

      // A new token turns the old one away.
      await page.getByTestId('settings-toggle').click();
      await page.locator('.pref-dialog nav button').filter({ hasText: /remote/i }).first().click();
      await page.getByTestId('remote-regenerate').click();
      await expect.poll(() => page.getByTestId('remote-token').inputValue()).not.toBe(token);
      const fresh = await page.getByTestId('remote-token').inputValue();
      const freshPort = Number(/:(\d+)/.exec(await page.getByTestId('remote-state').textContent() ?? '')?.[1]);
      await expect.poll(async () => (await ask(freshPort, '/v1/status', token)).status).toBe(401);
      expect((await ask(freshPort, '/v1/status', fresh)).status).toBe(200);

      // Switched off, the socket is gone.
      await page.getByTestId('setting-remote-control').click();
      await expect(page.getByTestId('remote-state')).toContainText('Not listening', { timeout: 15_000 });
      await page.getByTestId('settings-close').click();
      await expect(page.getByTestId('remote-flag')).toHaveCount(0);
      // The file that said where it was listening goes with it, so nothing is
      // left pointing at a port with nothing on it.
      await expect.poll(async () => {
        try {
          await stat(path.join(userData, 'remote.json'));
          return 'there';
        } catch {
          return 'gone';
        }
      }, { timeout: 15_000 }).toBe('gone');
      await expect.poll(async () => {
        try {
          await ask(freshPort, '/v1/status', fresh);
          return 'answered';
        } catch {
          return 'gone';
        }
      }, { timeout: 15_000 }).toBe('gone');
    } finally {
      await app.close();
    }
  });
});

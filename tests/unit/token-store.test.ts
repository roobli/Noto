import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TokenStore } from '../../src/main/remote/token-store';

const made: string[] = [];
afterEach(async () => { for (const folder of made.splice(0)) await rm(folder, { recursive: true, force: true }); });

async function folder(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noto-token-'));
  made.push(root);
  return root;
}

describe("the remote control's token", () => {
  it('is written once and read back after that', async () => {
    const file = path.join(await folder(), 'remote-token');
    const store = new TokenStore(file);
    const first = await store.current();
    expect(first).toHaveLength(43);
    await expect(store.current()).resolves.toBe(first);
    expect((await readFile(file, 'utf8')).trim()).toBe(first);
  });

  it('is readable by its owner and nobody else', async () => {
    const file = path.join(await folder(), 'remote-token');
    await new TokenStore(file).current();
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('is the same token for the life of the store, whatever the file says after', async () => {
    // The socket takes the token it started with, so a second reader must be
    // handed that one and not a fresh one, however the file looks by then.
    const file = path.join(await folder(), 'remote-token');
    const store = new TokenStore(file);
    const first = await store.current();
    await chmod(file, 0o644);
    await expect(store.current()).resolves.toBe(first);
    await writeFile(file, 'something else entirely\n', 'utf8');
    await expect(store.current()).resolves.toBe(first);
  });

  it('is replaced when the file it was in could be read by anyone', async () => {
    const file = path.join(await folder(), 'remote-token');
    await writeFile(file, 'a-token-somebody-else-could-read\n', 'utf8');
    await chmod(file, 0o644);
    const token = await new TokenStore(file).current();
    expect(token).not.toBe('a-token-somebody-else-could-read');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });


  it('hands the same token to concurrent first readers, not two regenerates', async () => {
    // Turning the control on asks from the socket and the preferences pane at
    // once; both must see one token or the socket keeps A and the pane shows B.
    const file = path.join(await folder(), 'remote-token');
    const store = new TokenStore(file);
    const [a, b, c] = await Promise.all([store.current(), store.current(), store.current()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect((await readFile(file, 'utf8')).trim()).toBe(a);
    expect(store.peek()).toBe(a);
  });

  it('is replaced on request, and the old one stops being the token', async () => {
    const store = new TokenStore(path.join(await folder(), 'remote-token'));
    const first = await store.current();
    const second = await store.regenerate();
    expect(second).not.toBe(first);
    await expect(store.current()).resolves.toBe(second);
  });
});

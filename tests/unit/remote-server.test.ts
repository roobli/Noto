import { afterEach, describe, expect, it } from 'vitest';
import { newToken, startRemoteServer, type RunningRemote } from '../../src/main/remote/server';
import type { RemoteDeps } from '../../src/main/remote/remote-control';

const running: RunningRemote[] = [];
afterEach(async () => { for (const server of running.splice(0)) await server.stop(); });

const token = newToken();
const deps: Omit<RemoteDeps, 'port'> = {
  getToken: () => token,
  status: () => ({ version: '1.0.0', vault: '/vault', note: null, dirty: false }),
  readCurrent: async () => null,
  open: async () => ({ opened: true }),
  insert: () => ({ inserted: true }),
  run: () => ({ ran: true }),
  search: async () => ({ matches: [], truncated: false, timedOut: false, invalidPattern: false }),
};

async function start(): Promise<RunningRemote> {
  // Port zero: the operating system picks a free one, so a test never fights
  // the running app for the real port.
  const server = await startRemoteServer({ port: 0, deps });
  running.push(server);
  return server;
}

describe('the remote control socket', () => {
  it('answers a request that carries the token', async () => {
    const server = await start();
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ vault: '/vault' });
  });

  it('refuses one that does not', async () => {
    const server = await start();
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/status`);
    expect(response.status).toBe(401);
  });

  it('listens on the loopback interface and nowhere else', async () => {
    const server = await start();
    // The address it bound to, read back from the socket.
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('gives back a token nobody is going to guess', () => {
    expect(newToken()).toHaveLength(43);
    expect(newToken()).not.toBe(newToken());
  });

  it('stops listening when it is stopped', async () => {
    const server = await start();
    const port = server.port;
    await server.stop();
    running.splice(running.indexOf(server), 1);
    await expect(fetch(`http://127.0.0.1:${port}/v1/status`, {
      headers: { authorization: `Bearer ${token}` },
    })).rejects.toThrow();
  });
});

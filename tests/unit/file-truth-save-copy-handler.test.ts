/**
 * Where "Save a copy" writes is decided in main, never by the renderer.
 *
 * The save-copy channel used to take a `destinationPath` from the renderer and
 * write the document there. A renderer that had been talked into it (a
 * malicious note exploiting the editor, say) could then write anywhere the user
 * can: a shell profile, a LaunchAgent. Now main runs the dialog, remembers the
 * answer behind a one-time token, and the save-copy request carries only the
 * token.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (event: unknown, value: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (event: unknown, value: unknown) => Promise<unknown>) => handlers.set(channel, handler) },
}));

import { registerFileTruthHandlers } from '../../src/main/file-truth/v1/register-file-truth-handlers';
import { CopyDestinations } from '../../src/main/file-truth/v1/copy-destinations';
import { FILE_TRUTH_CHANNELS } from '../../src/shared/file-truth/v1/contracts';
import { isFileTruthSaveCopyRequestV1 } from '../../src/shared/file-truth/v1/validate';
import { isWorkspaceSaveAsResultV1 } from '../../src/shared/workspace/v1/validate';

const frame = { url: 'noto://bundle/index.html' };
const window = { webContents: { mainFrame: frame } };
const event = { sender: window.webContents, senderFrame: frame };

const fingerprint = { version: 1, object: { scheme: 'noto-file-object-v1', basis: 'inode', opaqueId: 'dev:1' },
  byteLength: 4, mtimeNanoseconds: '1', contentSha256: 'a'.repeat(64) };
const saveToken = { version: 1, documentRevisionId: `noto-rev-v3:${'b'.repeat(64)}`, editorRevision: 0, fingerprint };
const candidate = {
  version: 3,
  saveToken,
  transaction: {
    version: 3, documentId: `noto-doc-v3:${'b'.repeat(64)}`, revisionId: saveToken.documentRevisionId,
    mode: 'blocks', envelope: { lineEnding: 'lf', hasFinalNewline: true },
    units: [{ origin: null, markdown: 'Text.' }],
  },
};

function setup() {
  handlers.clear();
  const destinations = new CopyDestinations();
  const written: string[] = [];
  const store = {
    saveCopy: vi.fn(async (_candidate: unknown, destination: string) => {
      written.push(destination);
      return { status: 'copy-saved' };
    }),
  };
  registerFileTruthHandlers({
    session: {
      currentPath: '/vault/a.md',
      activeStore: () => store as never,
      storeForDocument: () => store as never,
      takeCopyDestination: (token: string) => destinations.take(token),
    },
    getWindow: () => window as never,
    logger: { log: vi.fn() } as never,
  });
  const saveCopy = (value: unknown) => handlers.get(FILE_TRUTH_CHANNELS.saveCopy)!(event, value) as Promise<{
    ok: boolean; error?: { code: string; message: string };
  }>;
  return { destinations, written, store, saveCopy };
}

describe('the save-copy handler', () => {
  beforeEach(() => handlers.clear());

  it('writes to the place main chose, named by its token', async () => {
    const { destinations, written, saveCopy } = setup();
    const token = destinations.issue('/Users/me/Desktop/a copy.md');
    const reply = await saveCopy({ version: 1, requestId: 'ft-copy-1', destinationToken: token, candidate });
    expect(reply.ok).toBe(true);
    expect(written).toEqual(['/Users/me/Desktop/a copy.md']);
  });

  it('refuses a raw path from the renderer, and writes nothing', async () => {
    const { written, store, saveCopy } = setup();
    const reply = await saveCopy({
      version: 1, requestId: 'ft-copy-2', destinationPath: '/Users/me/.zshrc', candidate,
    });
    expect(reply).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(store.saveCopy).not.toHaveBeenCalled();
    expect(written).toEqual([]);
  });

  it('refuses a token main never issued', async () => {
    const { written, saveCopy } = setup();
    const reply = await saveCopy({ version: 1, requestId: 'ft-copy-3', destinationToken: 'f'.repeat(32), candidate });
    expect(reply.ok).toBe(false);
    expect(reply.error?.message).toMatch(/COPY_DESTINATION_UNKNOWN/);
    expect(written).toEqual([]);
  });

  it('takes a token once', async () => {
    const { destinations, written, saveCopy } = setup();
    const token = destinations.issue('/vault/a copy.md');
    expect((await saveCopy({ version: 1, requestId: 'ft-copy-4', destinationToken: token, candidate })).ok).toBe(true);
    expect((await saveCopy({ version: 1, requestId: 'ft-copy-5', destinationToken: token, candidate })).ok).toBe(false);
    expect(written).toEqual(['/vault/a copy.md']);
  });
});

describe('CopyDestinations', () => {
  it('issues unguessable tokens and forgets them once taken', () => {
    const destinations = new CopyDestinations();
    const a = destinations.issue('/a.md');
    const b = destinations.issue('/b.md');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(destinations.take(b)).toBe('/b.md');
    expect(destinations.take(b)).toBeNull();
    expect(destinations.take(a)).toBe('/a.md');
  });

  it('lets a token lapse', () => {
    let now = 0;
    const destinations = new CopyDestinations(() => now);
    const token = destinations.issue('/a.md');
    now += 10 * 60 * 1000 + 1;
    expect(destinations.take(token)).toBeNull();
  });

  it('keeps only the newest few outstanding', () => {
    const destinations = new CopyDestinations();
    const first = destinations.issue('/first.md');
    for (let i = 0; i < 16; i += 1) destinations.issue(`/${i}.md`);
    expect(destinations.take(first)).toBeNull();
  });
});

describe('the boundary', () => {
  it('has no field for a destination path any more', () => {
    expect(isFileTruthSaveCopyRequestV1({
      version: 1, requestId: 'ft-copy-6', destinationPath: '/x.md', candidate,
    })).toBe(false);
    expect(isFileTruthSaveCopyRequestV1({
      version: 1, requestId: 'ft-copy-7', destinationToken: '0'.repeat(32), candidate,
    })).toBe(true);
  });

  it('hands the renderer a token with the chosen path', () => {
    expect(isWorkspaceSaveAsResultV1({
      ok: true, requestId: 'r-1', value: { version: 1, path: '/a.md', token: '0'.repeat(32) },
    }, 'r-1')).toBe(true);
    expect(isWorkspaceSaveAsResultV1({
      ok: true, requestId: 'r-2', value: { version: 1, path: null, token: null },
    }, 'r-2')).toBe(true);
    expect(isWorkspaceSaveAsResultV1({
      ok: true, requestId: 'r-3', value: { version: 1, path: '/a.md', token: null },
    }, 'r-3')).toBe(false);
  });
});

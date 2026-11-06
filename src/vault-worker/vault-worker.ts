/**
 * The open folder's memory, on a thread of its own.
 *
 * `@roobli/vault` keeps its index in SQLite through `node:sqlite`, whose calls
 * are synchronous, and building the index for a folder of eight thousand
 * notes the first time takes seconds. On main's own thread that would freeze
 * the window's menus and every channel for as long, so the vault lives here
 * and main asks it things by message (`src/main/workspace/memory-host.ts`).
 * One folder at a time; requests are answered in the order they came.
 */

import { parentPort } from 'node:worker_threads';
import { about, initVault, Vault } from '@roobli/vault';

export type MemoryRequest =
  | { readonly id: number; readonly kind: 'open'; readonly root: string }
  | { readonly id: number; readonly kind: 'keep'; readonly root: string }
  | { readonly id: number; readonly kind: 'about'; readonly rel: string }
  | { readonly id: number; readonly kind: 'refresh'; readonly paths: readonly string[] | null }
  | { readonly id: number; readonly kind: 'close' };

export type MemoryAnswer =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: string; readonly unknown?: boolean };

let vault: Vault | null = null;
// One request at a time: a refresh in the middle of an answer would read a half-built index.
let queue: Promise<void> = Promise.resolve();

async function handle(request: MemoryRequest): Promise<unknown> {
  switch (request.kind) {
    case 'open': {
      vault?.close();
      vault = null;
      // The owner: the person at the window may read every note of their own folder.
      vault = await Vault.open(request.root, { owner: true });
      return { notes: (vault.status() as { notes?: number }).notes ?? null };
    }
    case 'keep': {
      // What `noto-vault init` makes, and nothing that is already there.
      const made = initVault(request.root);
      vault?.close();
      vault = await Vault.open(request.root, { owner: true });
      return { made };
    }
    case 'about':
      if (!vault) throw new Error('The memory is not open.');
      return about(vault, request.rel);
    case 'refresh':
      if (!vault) return null;
      return vault.refresh(request.paths ? { paths: request.paths } : {});
    case 'close':
      vault?.close();
      vault = null;
      return null;
  }
}

parentPort?.on('message', (request: MemoryRequest) => {
  queue = queue.then(async () => {
    let answer: MemoryAnswer;
    try {
      answer = { id: request.id, ok: true, value: await handle(request) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The vault says so when a reference names no note it holds.
      answer = { id: request.id, ok: false, error: message, unknown: /no note|not found|unknown note/i.test(message) };
    }
    parentPort!.postMessage(answer);
  });
});

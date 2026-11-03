/// <reference lib="webworker" />
/**
 * The worker a sandboxed plugin runs in.
 *
 * It has no page, no app API (the preload exposes nothing to workers) and no
 * network: the bundle's `connect-src 'none'` is this worker's policy too, and
 * its `script-src 'self'` lets it import only the app's own addresses, among
 * them the plugin's pinned code. What the plugin may do to the note it asks
 * the editor for, one message at a time, and the editor checks each request
 * against the capabilities its manifest declares.
 */
import { activateOf, errorText, type FromWorker, type PortMethod, type ToWorker } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const post = (message: FromWorker) => self.postMessage(message);
const commands = new Map<string, () => unknown>();
const hotkeys = new Map<string, () => unknown>();
const disposers: (() => unknown)[] = [];
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
let nextCall = 0;
let active = false;

function call(method: PortMethod, args: readonly unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    nextCall += 1;
    pending.set(nextCall, { resolve, reject });
    post({ type: 'port', callId: nextCall, method, args });
  });
}

async function activate(pluginId: string, settings: Readonly<Record<string, boolean>>, url: string): Promise<void> {
  if (active) return;
  active = true;
  try {
    const module = await import(/* @vite-ignore */ url) as Record<string, unknown>;
    const start = activateOf(module);
    if (!start) throw new Error('The plugin exports no activate function.');
    const context = Object.freeze({
      pluginId,
      settings: Object.freeze({ ...settings }),
      port: Object.freeze({
        getMarkdown: () => call('getMarkdown', []) as Promise<string>,
        replaceMarkdown: (markdown: string) => call('replaceMarkdown', [markdown]) as Promise<boolean>,
        setSemanticFocus: (enabled: boolean) => call('setSemanticFocus', [enabled]) as Promise<void>,
      }),
      registerCommand(id: string, execute: () => unknown) {
        commands.set(id, execute);
        post({ type: 'register', kind: 'command', key: id });
        return () => { commands.delete(id); };
      },
      registerHotkey(keys: string, execute: () => unknown) {
        hotkeys.set(keys, execute);
        post({ type: 'register', kind: 'hotkey', key: keys });
        return () => { hotkeys.delete(keys); };
      },
      registerDisposer(disposer: () => unknown) {
        if (typeof disposer === 'function') disposers.push(disposer);
      },
      notice(message: unknown) {
        post({ type: 'notice', message: String(message).slice(0, 200) });
      },
    });
    const disposer = await start(context);
    if (typeof disposer === 'function') disposers.push(disposer as () => unknown);
    post({ type: 'ready' });
  } catch (error) {
    post({ type: 'failed', message: errorText(error) });
  }
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  switch (message.type) {
    case 'activate':
      void activate(message.pluginId, message.settings, message.url);
      return;
    case 'run': {
      const execute = (message.kind === 'command' ? commands : hotkeys).get(message.key);
      void Promise.resolve()
        .then(() => execute?.())
        .then(() => post({ type: 'done', callId: message.callId }))
        .catch((error: unknown) => post({ type: 'done', callId: message.callId, error: errorText(error) }));
      return;
    }
    case 'reply': {
      const waiting = pending.get(message.callId);
      pending.delete(message.callId);
      if (message.error !== undefined) waiting?.reject(new Error(message.error));
      else waiting?.resolve(message.value);
      return;
    }
    case 'deactivate':
      void (async () => {
        for (const dispose of disposers.splice(0).reverse()) {
          try { await dispose(); } catch { /* the editor ends the worker either way */ }
        }
        post({ type: 'deactivated' });
      })();
      return;
  }
};

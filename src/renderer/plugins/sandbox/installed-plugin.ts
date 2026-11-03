import type { NotoEditorPort } from '../../editor/noto/NotoEditorPort';
import type { RendererPluginContribution, RendererPluginContributionContext, RendererPluginDisposer } from '../RendererPluginHost';
import { activateOf, addedWebAddress, errorText, isFromWorker, portArguments, type PortMethod, type ToWorker } from './protocol';

/** How long a plugin may take to start, or to finish a command, before it is given up on. */
const ACTIVATION_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 10_000;
/** A plugin asking for the note faster than this is looping, not working. */
const PORT_CALLS_PER_SECOND = 40;
const REPLACES_PER_SECOND = 5;
const NOTICES_PER_SECOND = 2;
/** Past this many messages of any kind in a second, the worker is ended. */
const MESSAGES_PER_SECOND = 200;

function notice(name: string, message: string): void {
  // Named, so a plugin cannot speak as Noto.
  window.dispatchEvent(new CustomEvent('noto:notice', { detail: `${name}: ${message}` }));
}

/** A budget of `limit` uses per second. */
function rateLimit(limit: number): () => boolean {
  let windowStart = 0;
  let used = 0;
  return () => {
    const now = performance.now();
    if (now - windowStart >= 1000) { windowStart = now; used = 0; }
    used += 1;
    return used <= limit;
  };
}

function callPort(port: NotoEditorPort, method: PortMethod, args: readonly unknown[]): unknown {
  if (method === 'getMarkdown') return port.getMarkdown();
  if (method === 'replaceMarkdown') {
    const next = args[0] as string;
    const added = addedWebAddress(port.getMarkdown(), next);
    if (added) throw new Error(`PLUGIN_NETWORK_DENIED: a sandboxed plugin cannot add a web address (${added.slice(0, 60)})`);
    return port.replaceMarkdown(next);
  }
  port.setSemanticFocus(args[0] as boolean);
  return undefined;
}

/**
 * A plugin the reader installed, run sandboxed: its code in a worker of its
 * own, everything it does to the note asked for over messages, each checked
 * here and then by the host against what the manifest declares.
 */
export function sandboxedPlugin(url: string, name: string): RendererPluginContribution {
  return {
    activate(context: RendererPluginContributionContext): Promise<RendererPluginDisposer> {
      const worker = new Worker(new URL('./plugin.worker.ts', import.meta.url), {
        type: 'module',
        name: `noto-plugin:${context.pluginId}`,
      });
      const send = (message: ToWorker) => worker.postMessage(message);
      const runs = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: number }>();
      let nextRun = 0;
      const portBudget = rateLimit(PORT_CALLS_PER_SECOND);
      const replaceBudget = rateLimit(REPLACES_PER_SECOND);
      const noticeBudget = rateLimit(NOTICES_PER_SECOND);
      const messageBudget = rateLimit(MESSAGES_PER_SECOND);
      // A worker that stopped answering is ended, and stays ended: what it
      // was running cannot be trusted to stop on its own.
      let stopped: string | null = null;
      const stop = (reason: string) => {
        stopped = reason;
        worker.terminate();
        for (const waiting of runs.values()) { window.clearTimeout(waiting.timer); waiting.reject(new Error(reason)); }
        runs.clear();
      };
      const run = (kind: 'command' | 'hotkey', key: string) => new Promise<void>((resolve, reject) => {
        if (stopped) { reject(new Error(stopped)); return; }
        nextRun += 1;
        const callId = nextRun;
        const timer = window.setTimeout(() => {
          runs.delete(callId);
          reject(new Error(`${name} did not finish in ${COMMAND_TIMEOUT_MS / 1000} seconds.`));
          stop(`${name} stopped answering and was ended. Turn it off and on to start it again.`);
        }, COMMAND_TIMEOUT_MS);
        runs.set(callId, { resolve, reject, timer });
        send({ type: 'run', kind, key, callId });
      });

      return new Promise<RendererPluginDisposer>((resolve, reject) => {
        let settled = false;
        const fail = (error: Error) => {
          worker.terminate();
          if (!settled) { settled = true; window.clearTimeout(started); reject(error); }
        };
        const started = window.setTimeout(
          () => fail(new Error(`${name} did not start in ${ACTIVATION_TIMEOUT_MS / 1000} seconds.`)),
          ACTIVATION_TIMEOUT_MS,
        );
        context.signal.addEventListener('abort', () => worker.terminate(), { once: true });
        worker.onerror = (event) => { event.preventDefault(); fail(new Error(event.message || `${name} stopped with an error.`)); };
        worker.onmessageerror = () => fail(new Error(`${name} sent a message the editor cannot read.`));
        worker.onmessage = (event: MessageEvent<unknown>) => {
          if (!messageBudget()) {
            const reason = `${name} sent too many messages and was ended.`;
            stop(reason);
            fail(new Error(reason));
            return;
          }
          const message = event.data;
          if (!isFromWorker(message)) { fail(new Error(`${name} sent a message the editor does not accept.`)); return; }
          try {
            switch (message.type) {
              case 'register':
                // The host refuses a command or key the manifest does not
                // declare, which fails the plugin rather than the editor.
                if (message.kind === 'command') context.registerCommand(message.key, () => run('command', message.key));
                else context.registerHotkey(message.key, () => run('hotkey', message.key));
                return;
              case 'port': {
                const args = portArguments(message.method, message.args);
                if (args === null) { send({ type: 'reply', callId: message.callId, error: 'Bad arguments.' }); return; }
                if (!portBudget() || (message.method === 'replaceMarkdown' && !replaceBudget())) {
                  send({ type: 'reply', callId: message.callId, error: 'Too many calls.' });
                  return;
                }
                try {
                  send({ type: 'reply', callId: message.callId, value: callPort(context.port, message.method, args) });
                } catch (error) {
                  send({ type: 'reply', callId: message.callId, error: errorText(error) });
                }
                return;
              }
              case 'notice':
                if (noticeBudget()) { context.onCommand(); notice(name, message.message); }
                return;
              case 'done': {
                const waiting = runs.get(message.callId);
                if (!waiting) return;
                runs.delete(message.callId);
                window.clearTimeout(waiting.timer);
                if (message.error !== undefined) waiting.reject(new Error(message.error));
                else waiting.resolve();
                return;
              }
              case 'ready':
                if (settled) return;
                settled = true;
                window.clearTimeout(started);
                resolve(() => {
                  send({ type: 'deactivate' });
                  // A plugin's own clean-up gets a moment; then the worker,
                  // and everything still running in it, is ended.
                  window.setTimeout(() => worker.terminate(), 500);
                });
                return;
              case 'failed':
                fail(new Error(message.message));
                return;
              case 'deactivated':
                worker.terminate();
                return;
            }
          } catch (error) {
            fail(error instanceof Error ? error : new Error(errorText(error)));
          }
        };
        send({ type: 'activate', pluginId: context.pluginId, settings: context.settings, url });
      });
    },
  };
}

/**
 * A plugin the reader trusted fully: its module imported into the editor's
 * own page and started with the same context a bundled plugin gets. It can
 * do anything the app can, which Plugin Center says before the switch is on.
 */
export function trustedModulePlugin(url: string, name: string): RendererPluginContribution {
  return {
    async activate(context: RendererPluginContributionContext) {
      const module = await import(/* @vite-ignore */ url) as Record<string, unknown>;
      const start = activateOf(module);
      if (!start) throw new Error(`${name} exports no activate function.`);
      // The context a bundled plugin gets, so one module runs in either mode.
      const disposer = await start({
        pluginId: context.pluginId,
        settings: context.settings,
        signal: context.signal,
        port: context.port,
        registerCommand: (id: string, execute: () => unknown) => context.registerCommand(id, async () => { await execute(); }),
        registerHotkey: (keys: string, execute: () => unknown) => context.registerHotkey(keys, async () => { await execute(); }),
        registerDisposer: (dispose: RendererPluginDisposer) => context.registerDisposer(dispose),
        notice: (message: unknown) => { context.onCommand(); notice(name, String(message).slice(0, 200)); },
      });
      return typeof disposer === 'function' ? disposer as RendererPluginDisposer : undefined;
    },
  };
}

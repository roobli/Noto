/**
 * The messages between a sandboxed plugin's worker and the editor.
 *
 * Everything the worker sends is untrusted: it is checked here before the
 * editor acts on it, and what it asks for is gated again by the host against
 * the capabilities the plugin's manifest declares.
 */

export type PortMethod = 'getMarkdown' | 'replaceMarkdown' | 'setSemanticFocus';

export type ToWorker =
  | { readonly type: 'activate'; readonly pluginId: string; readonly settings: Readonly<Record<string, boolean>>; readonly url: string }
  | { readonly type: 'run'; readonly kind: 'command' | 'hotkey'; readonly key: string; readonly callId: number }
  | { readonly type: 'reply'; readonly callId: number; readonly value?: unknown; readonly error?: string }
  | { readonly type: 'deactivate' };

export type FromWorker =
  | { readonly type: 'register'; readonly kind: 'command' | 'hotkey'; readonly key: string }
  | { readonly type: 'port'; readonly callId: number; readonly method: PortMethod; readonly args: readonly unknown[] }
  | { readonly type: 'notice'; readonly message: string }
  | { readonly type: 'done'; readonly callId: number; readonly error?: string }
  | { readonly type: 'ready' }
  | { readonly type: 'failed'; readonly message: string }
  | { readonly type: 'deactivated' };

const PORT_METHODS: readonly string[] = ['getMarkdown', 'replaceMarkdown', 'setSemanticFocus'];
/** The largest note a plugin may hand back, which is far past any real one. */
export const MAX_MARKDOWN_CHARS = 4 * 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isCallId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const isShortText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;

export function isFromWorker(value: unknown): value is FromWorker {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case 'register':
      return (value.kind === 'command' || value.kind === 'hotkey') && isShortText(value.key, 128) && value.key.length > 0;
    case 'port':
      return isCallId(value.callId) && typeof value.method === 'string' && PORT_METHODS.includes(value.method)
        && Array.isArray(value.args) && value.args.length <= 1;
    case 'notice':
      return isShortText(value.message, 2000);
    case 'done':
      return isCallId(value.callId) && (value.error === undefined || isShortText(value.error, 2000));
    case 'failed':
      return isShortText(value.message, 2000);
    case 'ready':
    case 'deactivated':
      return true;
    default:
      return false;
  }
}

/** The arguments a port method takes, or null when the worker sent something else. */
export function portArguments(method: PortMethod, args: readonly unknown[]): readonly unknown[] | null {
  if (method === 'getMarkdown') return args.length === 0 ? [] : null;
  if (method === 'replaceMarkdown') {
    const [markdown] = args;
    return typeof markdown === 'string' && markdown.length <= MAX_MARKDOWN_CHARS ? [markdown] : null;
  }
  const [enabled] = args;
  return typeof enabled === 'boolean' ? [enabled] : null;
}

/** The function a plugin module exposes to be started, in any of the shapes a module may take. */
export function activateOf(module: Record<string, unknown>): ((context: unknown) => unknown) | null {
  if (typeof module.activate === 'function') return module.activate as (context: unknown) => unknown;
  const fallback = module.default;
  if (typeof fallback === 'function') return fallback as (context: unknown) => unknown;
  if (isRecord(fallback) && typeof fallback.activate === 'function') {
    return (fallback.activate as (context: unknown) => unknown).bind(fallback);
  }
  return null;
}

export function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/*
 * Web addresses, written any way a browser would still load them.
 *
 * The worker has no network, but the note does: an image or an embedded page
 * in it is fetched as soon as it is drawn, so a plugin that could add one
 * could send the note away in its address. A sandboxed plugin may change the
 * note's text and may not add a web address to it. Before comparing, the
 * text is read as a browser reads an attribute: character references
 * decoded and backslashes taken as slashes. A tab or line break inside the
 * `://` is dropped, as a browser drops it there; anywhere else it ends the
 * address, so a change on the line after a link is not taken for a new one.
 * An address split anywhere past its slashes still shows as a new `//...`.
 */
const NAMED_REFERENCES: Readonly<Record<string, string>> = {
  colon: ':', sol: '/', bsol: '\\', tab: '', newline: '', period: '.', lpar: '(', rpar: ')',
};
const WEB_ADDRESS = /(?:[a-z][a-z0-9+.-]*:)?\/\/[^\s"'<>()[\]`{}|^]+/gi;

function asBrowserReads(text: string): string {
  return text
    .replace(/&#x([0-9a-f]{1,6});?/gi, (_, hex: string) => String.fromCodePoint(Math.min(Number.parseInt(hex, 16), 0x10ffff)))
    .replace(/&#([0-9]{1,7});?/g, (_, decimal: string) => String.fromCodePoint(Math.min(Number.parseInt(decimal, 10), 0x10ffff)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => NAMED_REFERENCES[name.toLowerCase()] ?? whole)
    .replace(/\\/g, '/')
    .replace(/([:/])[\t\n\r]+(?=[/\t\n\r])/g, '$1')
    .replace(/([:/])[\t\n\r]+(?=\/)/g, '$1')
    .replace(/[\t\n\r]/g, ' ')
    .toLowerCase();
}

/** A web address the new text has that the old did not, or null. */
export function addedWebAddress(before: string, after: string): string | null {
  const known = new Set(asBrowserReads(before).match(WEB_ADDRESS) ?? []);
  for (const address of asBrowserReads(after).match(WEB_ADDRESS) ?? []) {
    if (!known.has(address)) return address;
  }
  return null;
}

/**
 * Driving Noto from outside it, over the loopback interface.
 *
 * The author asked for a remote control: a way for a script, or an agent
 * working alongside them, to ask what note is open, read it, open another,
 * put text in, and save. It is built in rather than offered as a plugin
 * because it needs the workspace itself, which is exactly what the plugin
 * tier is built to keep a plugin away from.
 *
 * Everything about the shape of it is a consequence of that power:
 *
 *  - It is off until it is switched on, and the window says while it is on.
 *  - It listens on 127.0.0.1 and nowhere else.
 *  - Every request carries a token, compared in constant time.
 *  - A request from a page in a browser is refused twice over: one carrying
 *    an `Origin` header is not ours, and the `Host` header must name the
 *    loopback address itself, which is what stops a site whose name has been
 *    pointed at 127.0.0.1 from talking to it under its own name.
 *  - Opening a note is confined to the folder that is open, by main, with the
 *    same check every other path in the app goes through.
 *  - The commands it may run are a list written here, not whatever the menu
 *    happens to carry.
 *
 * This file is the decisions. The socket is next door, so the rules can be
 * tested without one.
 */

import { timingSafeEqual } from 'node:crypto';
import type { SearchFlags } from '../../shared/search/pattern';

/** The commands a remote caller may run, and nothing else. */
export const REMOTE_COMMANDS = [
  'save',
  'save-as',
  'find',
  'search-content',
  'quick-open',
  'source-code-mode',
  'toggle-sidebar',
  'toggle-outline',
  'toggle-read-only',
  'reload-from-disk',
  'new-file',
  'shortcuts',
] as const;

export type RemoteCommand = (typeof REMOTE_COMMANDS)[number];

/** The most text one insert may carry: a paragraph is a few hundred bytes. */
export const MAX_INSERT_BYTES = 256 * 1024;
/** And the most any request body may be, which is the same by a wide margin. */
export const MAX_BODY_BYTES = 1024 * 1024;

export interface RemoteRequest {
  readonly method: string;
  readonly path: string;
  /** Lower-cased header names, as node gives them. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
}

export interface RemoteReply {
  readonly status: number;
  readonly body: unknown;
}

/** The protocol's own version, so a caller can tell what it is talking to. */
export const REMOTE_PROTOCOL = 1;

export interface RemoteStatus {
  readonly version: string;
  readonly vault: string | null;
  readonly note: string | null;
  readonly dirty: boolean;
}

/** Where a note's text came from, which matters while there are unsaved changes. */
export type TextSource = 'editor' | 'disk';

export interface RemoteDocument {
  readonly path: string;
  readonly markdown: string;
  readonly source: TextSource;
  readonly dirty: boolean;
}

/** Where inserted text goes. The caret is where a person is; the end is where a log grows. */
export const INSERT_PLACES = ['caret', 'end'] as const;

export type InsertPlace = (typeof INSERT_PLACES)[number];

export interface RemoteMatchLine {
  readonly line: string;
  readonly lineNumber: number;
  readonly column: number;
  readonly length: number;
}

export interface RemoteMatch {
  readonly path: string;
  readonly relativePath: string;
  readonly occurrences: number;
  readonly lines: readonly RemoteMatchLine[];
}

export interface RemoteDeps {
  /**
   * The token the socket accepts right now.
   *
   * A function rather than a string so the listening socket and the preferences
   * pane always check the same value TokenStore holds — a snapshot taken at
   * listen time could disagree with a concurrent first `current()` that minted
   * a second token for the UI.
   */
  readonly getToken: () => string;
  /** The port it is listening on, so the `Host` header can be checked against it. */
  readonly port: number;
  readonly status: () => RemoteStatus;
  /**
   * The note in front, from the editor when there is one and from the disk
   * otherwise. Null when no note is open.
   */
  readonly readCurrent: () => Promise<RemoteDocument | null>;
  /** Open a path; main resolves it and refuses anything outside the folder. */
  readonly open: (target: string) => Promise<{ opened: boolean; code?: string; reason?: string }>;
  /** Put text where the caller asked for it. */
  readonly insert: (text: string, at: InsertPlace) => { inserted: boolean; reason?: string };
  readonly run: (command: RemoteCommand) => { ran: boolean; reason?: string };
  /** Search the vault, the same search the rail does. */
  readonly search: (query: string, flags: SearchFlags) => Promise<{
    matches: readonly RemoteMatch[];
    truncated: boolean;
    timedOut: boolean;
    invalidPattern: boolean;
  }>;
}

const ok = (body: unknown): RemoteReply => ({ status: 200, body });

/**
 * A refusal a program can branch on.
 *
 * The sentence is for a person reading a log; the code is for the caller,
 * which should never have to match on English. An early version answered a
 * failed open with the operating system's own `ENOENT`, which is neither.
 */
const refuse = (status: number, code: string, error: string): RemoteReply =>
  ({ status, body: { error, code } });

/** Constant time, and false for a length that does not match rather than throwing. */
export function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/** The bearer token a request carries, or null when it carries none. */
export function bearerOf(headers: Readonly<Record<string, string | undefined>>): string | null {
  const header = headers.authorization ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * Whether the request came from a page in a browser.
 *
 * A page cannot suppress its `Origin` header, so one that carries an origin
 * is not a script on this machine and has no business driving an editor. A
 * navigation is refused for the same reason. `Sec-Fetch-Mode: cors` is not
 * tested, because the fetch built into Node sends exactly that, and refusing
 * it would refuse the callers this exists for.
 */
export function looksLikeBrowser(headers: Readonly<Record<string, string | undefined>>): boolean {
  if (typeof headers.origin === 'string' && headers.origin.length > 0) return true;
  const mode = headers['sec-fetch-mode'];
  return mode === 'navigate' || mode === 'websocket';
}

/**
 * Whether the `Host` header names this socket rather than some name pointed
 * at it.
 *
 * The attack this answers is rebinding: a page at a name the attacker owns,
 * resolved to 127.0.0.1, talking to whatever is listening. The browser sends
 * that name as the host, and this is where it stops. `localhost` is allowed
 * beside the address because a script written by hand usually says that, and
 * because it is the one name a browser cannot be made to resolve elsewhere.
 */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (typeof host !== 'string' || host.length === 0) return false;
  const [name, given] = host.split(':');
  if (name !== '127.0.0.1' && name !== 'localhost') return false;
  return given === undefined || given === String(port);
}

function parseBody(body: string): Record<string, unknown> | null {
  if (body.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** Answer one request. Every refusal says which rule refused it. */
export async function handleRemote(request: RemoteRequest, deps: RemoteDeps): Promise<RemoteReply> {
  if (looksLikeBrowser(request.headers)) {
    return refuse(403, 'browser', 'A browser cannot drive this editor.');
  }
  if (!hostAllowed(request.headers.host, deps.port)) {
    return refuse(403, 'host', 'That request did not come to the loopback address.');
  }

  const given = bearerOf(request.headers);
  if (given === null || !tokenMatches(given, deps.getToken())) {
    return refuse(401, 'unauthorized', 'Bad or missing token.');
  }
  if (Buffer.byteLength(request.body, 'utf8') > MAX_BODY_BYTES) {
    return refuse(413, 'too-large', 'That request is too large.');
  }

  const path = request.path.split('?')[0].replace(/\/+$/, '') || '/';
  // HEAD is GET without the body, which is what a caller checking that
  // something is listening reaches for first.
  const reading = request.method === 'GET' || request.method === 'HEAD';

  if (reading && path === '/v1/status') return ok({ protocol: REMOTE_PROTOCOL, ...deps.status() });

  // What there is, said by the thing itself, so a caller need not read a page
  // to find out what it may ask for.
  if (reading && path === '/v1/commands') {
    return ok({
      protocol: REMOTE_PROTOCOL,
      commands: REMOTE_COMMANDS,
      routes: [
        { method: 'GET', path: '/v1/status' },
        { method: 'GET', path: '/v1/commands' },
        { method: 'GET', path: '/v1/document' },
        { method: 'POST', path: '/v1/open', body: { path: 'a note, absolute or relative to the folder' } },
        { method: 'POST', path: '/v1/insert', body: { text: 'the text', at: INSERT_PLACES } },
        { method: 'POST', path: '/v1/command', body: { command: 'one of commands' } },
        { method: 'POST', path: '/v1/search', body: { query: 'what to look for' } },
      ],
      insertPlaces: INSERT_PLACES,
    });
  }

  if (reading && path === '/v1/document') {
    const current = await deps.readCurrent();
    return current === null ? refuse(404, 'no-document', 'No note is open.') : ok(current);
  }

  if (request.method !== 'POST') return refuse(404, 'no-route', 'No such request.');

  const body = parseBody(request.body);
  if (body === null) return refuse(400, 'bad-body', 'That body is not a JSON object.');

  if (path === '/v1/open') {
    const target = body.path;
    if (typeof target !== 'string' || target.length === 0) {
      return refuse(400, 'bad-path', 'Give a path to open.');
    }
    const outcome = await deps.open(target);
    return outcome.opened
      ? ok({ opened: true })
      : refuse(404, outcome.code ?? 'open-failed', outcome.reason ?? 'That note could not be opened.');
  }

  if (path === '/v1/insert') {
    const text = body.text;
    if (typeof text !== 'string') return refuse(400, 'bad-text', 'Give the text to insert.');
    if (Buffer.byteLength(text, 'utf8') > MAX_INSERT_BYTES) {
      return refuse(413, 'too-large', 'That text is too long to insert.');
    }
    const at = body.at ?? 'caret';
    if (typeof at !== 'string' || !INSERT_PLACES.includes(at as InsertPlace)) {
      return refuse(400, 'bad-place', `Insert at one of: ${INSERT_PLACES.join(', ')}.`);
    }
    const outcome = deps.insert(text, at as InsertPlace);
    return outcome.inserted
      ? ok({ inserted: true, at })
      : refuse(409, 'no-document', outcome.reason ?? 'Nothing to insert into.');
  }

  if (path === '/v1/command') {
    const command = body.command;
    if (typeof command !== 'string') return refuse(400, 'bad-command', 'Give a command to run.');
    if (!REMOTE_COMMANDS.includes(command as RemoteCommand)) {
      return refuse(400, 'unknown-command', `That command is not one this accepts: ${REMOTE_COMMANDS.join(', ')}.`);
    }
    const outcome = deps.run(command as RemoteCommand);
    return outcome.ran ? ok({ ran: true }) : refuse(409, 'no-window', outcome.reason ?? 'That command did nothing.');
  }

  if (path === '/v1/search') {
    const query = body.query;
    if (typeof query !== 'string' || query.trim().length === 0) {
      return refuse(400, 'bad-query', 'Give something to search for.');
    }
    const flags = {
      caseSensitive: body.caseSensitive === true,
      wholeWord: body.wholeWord === true,
      regex: body.regex === true,
    };
    const found = await deps.search(query, flags);
    if (found.invalidPattern) return refuse(400, 'bad-pattern', 'That expression does not parse.');
    return ok(found);
  }

  return refuse(404, 'no-route', 'No such request.');
}

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { net, protocol, session } from 'electron';
import { ASSET_HOST } from '../../shared/assets/v1/contracts';
import type { StructuredLogger } from '../logger';
import { serveAsset } from './serve-asset';

export const RENDERER_ORIGIN = 'noto://bundle';

/* `img-src` names where a picture may come from: the bundle and data URLs as
   before, the asset origin main serves local images from, and the web over
   TLS. The web is allowed here and gated in the renderer, where the setting
   lives: a policy header is fixed for the life of the page, and a preference
   that only took effect after a restart would read as broken. Plain `http:`
   is not allowed; the renderer asks for those pictures over `https:` instead,
   which is what the browser would do on its own and leaves nothing for a
   network in between to alter. `connect-src` stays `'none'`, so a note can
   show a picture and still cannot fetch anything. */
/* worker-src is deliberate and narrow: the main editor parses large opens in a
   classic module Worker bundled with the page. default-src is 'none', so without
   this the worker would be blocked. Diagram frames and the plugin sandbox keep
   workers refused — only this page policy allows them, and only from 'self'. */
const productionCsp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' noto://asset data: blob: https:",
  "font-src 'self'",
  // Web pages a note embeds, which the editor draws only in a sandboxed
  // frame and only once the reader has allowed it (`webEmbeds`, or a press on
  // the page's card). The page itself stays locked to the app.
  "frame-src 'self' https:",
  "connect-src 'none'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ');

/*
 * The sandbox worker's policy: the page's, with sandboxed plugin code added
 * to where scripts may come from. A dedicated worker takes its policy from
 * its own script's response, so this reaches the worker and nothing else.
 */
const sandboxWorkerCsp = productionCsp.replace("script-src 'self'", "script-src 'self' noto://plugin-code");

/* The diagram frame's policy. `diagram.html` draws mermaid diagrams, which
   means an SVG full of inline styles, so styles are the one thing allowed
   here that the page is refused. The frame is sandboxed by the page that
   holds it, so it has no origin and no bridge; its scripts are the bundle's
   own, named by scheme as well as by `'self'` because a sandboxed document
   has no self to speak of. */
const diagramCsp = [
  "default-src 'none'",
  "script-src 'self' noto://bundle",
  "style-src 'self' noto://bundle 'unsafe-inline'",
  "img-src data:",
  "font-src 'self' noto://bundle",
  "connect-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self' noto://bundle",
  "form-action 'none'",
].join('; ');

export function registerNotoScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'noto',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        // The diagram frame is sandboxed to no origin, and a module script is
        // always a cross-origin request from there. Without this the scheme
        // refuses such requests outright, whatever the response says.
        corsEnabled: true,
        stream: true,
      },
    },
    {
      scheme: 'noto-plugin',
      privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
      stream: true,
      },
    },
  ]);
}

export interface AssetRoots {
  /** The folders images may be read from right now. Asked per request, since they change. */
  readonly roots: () => readonly string[];
}

const notFound = () => new Response('Not found', { status: 404 });

/**
 * The code of a plugin the reader installed, served only while the file on
 * disk is still exactly the code with the digest in the address.
 *
 * Two addresses, by trust, so the page's own policy decides where code may
 * run. A fully trusted plugin's code is at
 * `noto://bundle/plugins/<id>/<sha256>/main.js`, on the page's origin, which
 * the page imports under `script-src 'self'`. A sandboxed plugin's code is
 * at `noto://plugin-code/<id>/<sha256>/main.js`, another origin, which only
 * the sandbox worker's policy allows: markup that somehow got a script tag
 * into the page still could not run it there with the app's reach. The
 * requests carry no fetch metadata to tell a worker's import from a page's,
 * so the origin is the line.
 */
export type PluginCodeSource = (pluginId: string, digest: string, trust: 'sandboxed' | 'full') => Promise<Buffer | null>;

const TRUSTED_CODE_PATH = /^\/plugins\/([a-z0-9]+(?:[.-][a-z0-9]+)+)\/([0-9a-f]{64})\/main\.js$/;
const SANDBOXED_CODE_PATH = /^\/([a-z0-9]+(?:[.-][a-z0-9]+)+)\/([0-9a-f]{64})\/main\.js$/;
/** The sandbox worker's own script, the one response that may import sandboxed code. */
const SANDBOX_WORKER_PATH = /^\/assets\/plugin\.worker-[\w-]+\.js$/;

const pluginCodeResponse = (code: Buffer, headers: Record<string, string> = {}) => new Response(new Uint8Array(code), {
  headers: {
    'Content-Type': 'text/javascript; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  },
});

export async function installNotoProtocol(
  rendererRoot: string,
  logger: StructuredLogger,
  assets: AssetRoots,
  pluginCode?: PluginCodeSource,
): Promise<void> {
  const root = path.resolve(rendererRoot);
  await protocol.handle('noto', async (request) => {
    const url = new URL(request.url);
    if (url.hostname === ASSET_HOST) return serveAsset(url, assets.roots(), logger);
    if (url.hostname === 'bundle' && url.pathname.startsWith('/plugins/')) {
      const match = TRUSTED_CODE_PATH.exec(url.pathname);
      const code = match && pluginCode ? await pluginCode(match[1]!, match[2]!, 'full') : null;
      if (!code) {
        logger.log('plugin_code_refused', { trust: 'full' });
        return notFound();
      }
      return pluginCodeResponse(code);
    }
    if (url.hostname === 'plugin-code') {
      const match = SANDBOXED_CODE_PATH.exec(url.pathname);
      const code = match && pluginCode ? await pluginCode(match[1]!, match[2]!, 'sandboxed') : null;
      if (!code) {
        logger.log('plugin_code_refused', { trust: 'sandboxed' });
        return notFound();
      }
      // Read by the sandbox worker, which runs on the page's origin.
      return pluginCodeResponse(code, { 'Access-Control-Allow-Origin': 'noto://bundle' });
    }
    if (url.hostname !== 'bundle') return notFound();
    const relativePath = decodeURIComponent(url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    const candidate = path.resolve(root, relativePath);
    const relative = path.relative(root, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      logger.log('protocol_traversal_denied', { pathname: url.pathname });
      return notFound();
    }
    const served = await net.fetch(pathToFileURL(candidate).toString());
    // A worker's policy is the one on its own script's response, and the
    // response hook below does not reach a worker served from this scheme:
    // without the header here the sandbox worker had no policy at all and
    // could reach the network. Its policy goes on the response itself.
    if (SANDBOX_WORKER_PATH.test(url.pathname)) {
      const headers = new Headers(served.headers);
      headers.set('Content-Security-Policy', sandboxWorkerCsp);
      headers.set('Content-Type', 'text/javascript; charset=utf-8');
      return new Response(served.body, { status: served.status, headers });
    }
    return served;
  });

  const appSession = session.defaultSession;
  appSession.setPermissionCheckHandler(() => false);
  appSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  // Nothing the window shows saves a file by downloading it: the app writes
  // files itself. A page embedded in a note is sandboxed without downloads
  // already; this holds for anything else in the window too.
  appSession.on('will-download', (event, item) => {
    event.preventDefault();
    logger.log('download_denied', { url: item.getURL().slice(0, 512) });
  });
  appSession.webRequest.onHeadersReceived({ urls: ['noto://bundle/*'] }, (details, callback) => {
    const pathname = new URL(details.url).pathname;
    const policy = pathname === '/diagram.html' ? diagramCsp
      : SANDBOX_WORKER_PATH.test(pathname) ? sandboxWorkerCsp
        : productionCsp;
    const headers: Record<string, string[]> = {
      ...details.responseHeaders,
      'Content-Security-Policy': [policy],
    };
    // The diagram frame has no origin to be allowed by name, and a module
    // script is the one thing it fetches under cross-origin rules. Scripts
    // only: the page, its styles and its fonts are never asked for that way,
    // and nothing else should be readable across an origin, now or later.
    // A plugin's code is the page's own, never anyone else's to read.
    if (details.resourceType === 'script' && !pathname.startsWith('/plugins/')) headers['Access-Control-Allow-Origin'] = ['*'];
    callback({ responseHeaders: headers });
  });
}

export function isAllowedRendererUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'noto:' && url.hostname === 'bundle';
  } catch {
    return false;
  }
}

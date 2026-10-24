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
  "frame-src 'self'",
  "connect-src 'none'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ');

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

export async function installNotoProtocol(
  rendererRoot: string,
  logger: StructuredLogger,
  assets: AssetRoots,
): Promise<void> {
  const root = path.resolve(rendererRoot);
  await protocol.handle('noto', async (request) => {
    const url = new URL(request.url);
    if (url.hostname === ASSET_HOST) return serveAsset(url, assets.roots(), logger);
    if (url.hostname !== 'bundle') return notFound();
    const relativePath = decodeURIComponent(url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    const candidate = path.resolve(root, relativePath);
    const relative = path.relative(root, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      logger.log('protocol_traversal_denied', { pathname: url.pathname });
      return notFound();
    }
    return net.fetch(pathToFileURL(candidate).toString());
  });

  const appSession = session.defaultSession;
  appSession.setPermissionCheckHandler(() => false);
  appSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  appSession.webRequest.onHeadersReceived({ urls: ['noto://bundle/*'] }, (details, callback) => {
    const policy = new URL(details.url).pathname === '/diagram.html' ? diagramCsp : productionCsp;
    const headers: Record<string, string[]> = {
      ...details.responseHeaders,
      'Content-Security-Policy': [policy],
    };
    // The diagram frame has no origin to be allowed by name, and a module
    // script is the one thing it fetches under cross-origin rules. Scripts
    // only: the page, its styles and its fonts are never asked for that way,
    // and nothing else should be readable across an origin, now or later.
    if (details.resourceType === 'script') headers['Access-Control-Allow-Origin'] = ['*'];
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

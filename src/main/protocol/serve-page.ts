/**
 * Answering a `noto-page:` request: a local web page, or a file it names.
 *
 * Only inside the folder the session has open, by real path, as pictures are
 * (`asset-guard.ts`), and read through a handle checked to still be that path
 * (`asset-read.ts`). Every response carries the page policy, so a page and
 * whatever it loads are held to it, and `nosniff`, so a file is only what its
 * extension says.
 */

import path from 'node:path';
import { Readable } from 'node:stream';
import { fromPageUrl } from '../../shared/assets/v1/page';
import type { StructuredLogger } from '../logger';
import { isInside } from '../workspace/file-tree';
import { nodeAssetFs, openResolvedAsset, type AssetFs } from './asset-read';

/*
 * What a local page may do, as it would opened from disk in a browser: run
 * its own scripts, inline or beside it, and load scripts, styles, fonts,
 * pictures and media from beside it or from the web. It may not frame the
 * app, post a form anywhere, or be framed by anything but the app. The frame
 * that holds it has no origin of its own (no `allow-same-origin`), and a
 * sandboxed document has no self to speak of, so the page scheme is named
 * beside `'self'`; nothing of the app's is ever on it.
 */
export const PAGE_CSP = [
  // The response holds the page to an opaque origin itself, whatever frames it.
  'sandbox allow-scripts',
  "default-src 'self' noto-page: https: data: blob:",
  "script-src 'self' noto-page: 'unsafe-inline' 'unsafe-eval' https: blob:",
  "style-src 'self' noto-page: 'unsafe-inline' https:",
  "img-src 'self' noto-page: https: data: blob:",
  "font-src 'self' noto-page: https: data:",
  "media-src 'self' noto-page: https: data: blob:",
  // Not 'self': a page may not read the folder's other files by script, as a
  // browser opening it from disk will not let it either.
  "connect-src https:",
  "frame-src 'self' noto-page: https:",
  "worker-src 'self' noto-page: blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors noto://bundle",
].join('; ');

const TYPES = new Map<string, string>([
  ['.html', 'text/html; charset=utf-8'], ['.htm', 'text/html; charset=utf-8'], ['.xhtml', 'application/xhtml+xml; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'], ['.mjs', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.map', 'application/json; charset=utf-8'], ['.txt', 'text/plain; charset=utf-8'],
  ['.csv', 'text/csv; charset=utf-8'], ['.md', 'text/plain; charset=utf-8'], ['.xml', 'application/xml; charset=utf-8'],
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.gif', 'image/gif'],
  ['.webp', 'image/webp'], ['.avif', 'image/avif'], ['.ico', 'image/x-icon'], ['.bmp', 'image/bmp'],
  ['.woff', 'font/woff'], ['.woff2', 'font/woff2'], ['.ttf', 'font/ttf'], ['.otf', 'font/otf'],
  ['.mp4', 'video/mp4'], ['.webm', 'video/webm'], ['.mp3', 'audio/mpeg'], ['.wav', 'audio/wav'], ['.ogg', 'audio/ogg'],
  ['.wasm', 'application/wasm'],
]);

const refused = () => new Response('Not found', { status: 404, headers: { 'Content-Security-Policy': PAGE_CSP } });

/** A folder pages are served from, by the id its addresses use. */
export interface PageRoot {
  readonly id: string;
  readonly root: string;
}

/** The real path of a page file to serve, or null. The folder must be one the session serves pages from. */
export async function resolvePagePath(url: URL, roots: readonly PageRoot[], realpath: (target: string) => Promise<string>): Promise<string | null> {
  const asked = fromPageUrl(url);
  const served = asked ? roots.find((candidate) => candidate.id === asked.rootId) : undefined;
  if (!asked || !served || !path.isAbsolute(served.root)) return null;
  const root = path.resolve(served.root);
  const target = path.resolve(root, asked.relative);
  if (!isInside(root, target) || target === root) return null;
  try {
    const [realRoot, real] = await Promise.all([realpath(root), realpath(target)]);
    return isInside(realRoot, real) && real !== realRoot ? real : null;
  } catch {
    return null;
  }
}

export async function servePage(
  url: URL,
  roots: readonly PageRoot[],
  logger: Pick<StructuredLogger, 'log'>,
  fs: AssetFs = nodeAssetFs,
): Promise<Response> {
  const real = await resolvePagePath(url, roots, fs.realpath);
  const type = real ? TYPES.get(path.extname(real).toLowerCase()) : undefined;
  const handle = real && type ? await openResolvedAsset(real, fs) : null;
  if (!handle || !type) {
    logger.log('page_file_refused', { roots: roots.length });
    return refused();
  }
  const body = Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array>;
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': type,
      'Content-Security-Policy': PAGE_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

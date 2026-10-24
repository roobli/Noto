/**
 * Answering a `noto://asset/` request with a local picture.
 *
 * The guard decides whether the path may be served, and the file is then read
 * through a handle that is checked to still be that path (`asset-read.ts`),
 * rather than fetched again by name. Fetching by name was a second walk of the
 * path, which a link swapped in after the guard could redirect.
 *
 * The path is not logged: a refusal is a note naming a file outside the
 * folder, which is ordinary, and the file's name is the reader's business.
 */

import { Readable } from 'node:stream';
import { fromAssetUrl } from '../../shared/assets/v1/contracts';
import type { StructuredLogger } from '../logger';
import { mediaTypeFor } from '../workspace/inline-images';
import { resolveAssetPath } from './asset-guard';
import { nodeAssetFs, openResolvedAsset, type AssetFs } from './asset-read';

const notFound = () => new Response('Not found', { status: 404 });

export async function serveAsset(
  url: URL,
  roots: readonly string[],
  logger: Pick<StructuredLogger, 'log'>,
  fs: AssetFs = nodeAssetFs,
): Promise<Response> {
  const requested = fromAssetUrl(url);
  const real = requested ? await resolveAssetPath(requested, { roots, realpath: fs.realpath }) : null;
  const media = real ? mediaTypeFor(real) : null;
  const handle = real && media ? await openResolvedAsset(real, fs) : null;
  if (!handle || !media) {
    logger.log('asset_refused', { roots: roots.length });
    return notFound();
  }
  // The stream closes the handle when it ends or fails.
  const body = Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array>;
  return new Response(body, { status: 200, headers: { 'Content-Type': media } });
}

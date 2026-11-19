/**
 * A local web page, served to the window as a page of its own.
 *
 * A note's folder holds `.html` files people made to be opened: an
 * interactive map, a prototype with its `app.js` and `styles.css` beside it,
 * a page saved from a browser with its `_files` folder. The viewer shows one
 * in a frame, the way a browser would open the file, so its scripts run and
 * its relative files load. It does that without reaching the app:
 *
 * - The page is served at `noto-page://page/<root id>/<path>` from main, only from
 *   a folder the session serves pages from, after links are followed, the
 *   same containment pictures get (`asset-guard.ts`). The id is a random
 *   name for that folder, so the address tells the page nothing of where the
 *   folder is on disk.
 * - The frame is sandboxed with scripts but without `allow-same-origin`, and
 *   the response says so too, so the page has an opaque origin: it cannot
 *   read the app's pages, storage or bridge.
 * - The scheme is its own and is not CORS-enabled, so nothing the page loads
 *   can be read back by its script: a picture taints a canvas, a stylesheet
 *   keeps its rules, a file cannot be fetched. On the app's own scheme a
 *   cross-origin read was answered whatever the response said, which let a
 *   page read any file beside it and send it out. The cost is a module
 *   script (`type="module"`) and a web font beside the page, which a browser
 *   fetches with CORS and so cannot load here; such a page opens in the
 *   browser from the viewer's bar.
 * - Only the page frame, and documents of its own folder inside it, may ask
 *   for its files (`pageRequestAllowed`); a web page the page frames, or one
 *   a note embeds, may not.
 *
 * The path inside the folder follows as ordinary segments, so the page's
 * relative references resolve against its own folder as they do on disk.
 */

import { PAGE_FRAME_NAME } from '../../embed-frame';

export const PAGE_SCHEME = 'noto-page';
export const PAGE_HOST = 'page';
export const PAGE_ORIGIN = `${PAGE_SCHEME}://${PAGE_HOST}`;

/** File extensions served as a page. */
const PAGE_EXTENSIONS = /\.(html?|xhtml)$/i;

export function isPageFile(name: string): boolean {
  return PAGE_EXTENSIONS.test(name);
}

const ROOT_ID = /^[0-9a-f]{32}$/;

/** The address of the file at `relative` (`/` separated) inside the folder named `rootId`. */
export function toPageUrl(rootId: string, relative: string): string {
  const segments = relative.split(/[\\/]/).filter((part) => part.length > 0).map(encodeURIComponent).join('/');
  return `${PAGE_ORIGIN}/${rootId}/${segments}`;
}

/** The folder id and the path inside it a page address names, or null. */
export function fromPageUrl(url: URL): { readonly rootId: string; readonly relative: string } | null {
  if (url.protocol !== `${PAGE_SCHEME}:` || url.hostname !== PAGE_HOST) return null;
  const [rootId, ...rest] = url.pathname.slice(1).split('/');
  if (!rootId || !ROOT_ID.test(rootId) || rest.length === 0) return null;
  try {
    const parts = rest.map((part) => decodeURIComponent(part));
    if (parts.some((part) => part === '' || part === '.' || part === '..' || /[\\/\0]/.test(part))) return null;
    return { rootId, relative: parts.join('/') };
  } catch {
    return null;
  }
}

/** What the request gate needs of a frame: its name, its address and the frame it is in. */
export interface PageFrameLike {
  readonly name: string;
  readonly url: string;
  readonly parent: PageFrameLike | null;
}

const isPageAddress = (url: string) => url.startsWith(`${PAGE_ORIGIN}/`);

/**
 * Whether a request for a page file may be answered, given the frame that
 * makes it.
 *
 * Only from inside the viewer's page frame, the frame directly under the
 * window that the viewer names. Within it, a file is answered to a document
 * of the folder's own (`noto-page:`), and a frame navigation is answered
 * when it is the page frame itself or a frame inside a page document. A web
 * page inside the page frame (an `https:` frame the page makes) and an embed
 * in a note are refused whatever they ask: the policy on the page keeps the
 * page's own script from reading files by fetch, and nothing must hand that
 * reach to a frame with no such policy.
 */
export function pageRequestAllowed(resourceType: string, frame: PageFrameLike | null | undefined): boolean {
  if (!frame) return false;
  let top = frame;
  while (top.parent !== null && top.parent.parent !== null) top = top.parent;
  if (top.parent === null || top.name !== PAGE_FRAME_NAME) return false;
  if (resourceType === 'subFrame') return frame === top || (frame.parent !== null && isPageAddress(frame.parent.url));
  return isPageAddress(frame.url);
}

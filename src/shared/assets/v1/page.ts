/**
 * A local web page, served to the window as a page of its own.
 *
 * A note's folder holds `.html` files people made to be opened: an
 * interactive map, a prototype with its `app.js` and `styles.css` beside it,
 * a page saved from a browser with its `_files` folder. The viewer shows one
 * in a frame, the way a browser would open the file, so its scripts run and
 * its relative files load. It does that without reaching the app:
 *
 * - The page is served at `noto://page/<root>/<path>` from main, which serves
 *   only files inside the folder the session has open, after links are
 *   followed, the same containment pictures get (`asset-guard.ts`).
 * - The frame is sandboxed with scripts but without `allow-same-origin`, so
 *   the page has an opaque origin: it cannot read the app's pages, storage or
 *   bridge, nor other files by fetch, only the files its own markup names.
 * - Its responses carry a policy that lets it reach the web for its scripts,
 *   styles, fonts and pictures, as it would in a browser, and nothing that
 *   frames the app or submits a form.
 *
 * The folder is encoded as one segment and the path inside it follows as
 * ordinary segments, so the page's relative references resolve against its
 * own folder as they do on disk.
 */

export const PAGE_HOST = 'page';
export const PAGE_ORIGIN = `noto://${PAGE_HOST}`;

/** File extensions served as a page. */
const PAGE_EXTENSIONS = /\.(html?|xhtml)$/i;

export function isPageFile(name: string): boolean {
  return PAGE_EXTENSIONS.test(name);
}

function segments(relative: string): string {
  return relative.split(/[\\/]/).filter((part) => part.length > 0).map(encodeURIComponent).join('/');
}

/** The address of `file`, a path inside `root`, both absolute. */
export function toPageUrl(root: string, file: string): string {
  const normalizedRoot = root.replace(/[\\/]+$/, '');
  const relative = file.slice(normalizedRoot.length);
  return `${PAGE_ORIGIN}/${encodeURIComponent(normalizedRoot)}/${segments(relative)}`;
}

/** The root and the path inside it a page address names, or null. */
export function fromPageUrl(url: URL): { readonly root: string; readonly relative: string } | null {
  if (url.protocol !== 'noto:' || url.hostname !== PAGE_HOST) return null;
  const [encodedRoot, ...rest] = url.pathname.slice(1).split('/');
  if (!encodedRoot || rest.length === 0) return null;
  try {
    const root = decodeURIComponent(encodedRoot);
    const parts = rest.map((part) => decodeURIComponent(part));
    if (parts.some((part) => part === '' || part === '.' || part === '..' || /[\\/\0]/.test(part))) return null;
    return { root, relative: parts.join('/') };
  } catch {
    return null;
  }
}

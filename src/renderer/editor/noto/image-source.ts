/**
 * What an image node's `src` means, and what to put in the `<img>`.
 *
 * Markdown names images four ways in the author's vault: a web URL, which is
 * five and a half thousand of them; a path relative to the note, which often
 * climbs to a sibling assets folder; an absolute path; and, rarely, a
 * `file:` URL. A relative path is resolved against the note's own folder and
 * a local path becomes an asset URL that main checks before serving, so the
 * arithmetic here decides only what to ask for, never what is allowed.
 *
 * Pure, so it can be tested with paths from both operating systems without a
 * document open.
 */

import { toAssetUrl } from '../../../shared/assets/v1/contracts';

export interface ImageContext {
  /** The folder the note is in, or null when it has none. */
  readonly documentDir: string | null;
  /** Whether web images may be fetched. Off shows their name instead. */
  readonly remote: boolean;
  /**
   * Whether a web page a note embeds with `<iframe>` loads by itself. Off
   * shows a card naming the page, with a button that loads that one.
   */
  readonly embeds?: boolean;
}

export type ImageSource =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'remote-off'; readonly url: string }
  | { readonly kind: 'unresolved'; readonly reason: 'empty' | 'scheme' | 'no-document' };

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_ROOT = /^[A-Za-z]:[\\/]/;

export function resolveImageSource(rawSrc: string, context: ImageContext): ImageSource {
  const src = rawSrc.trim();
  if (src.length === 0) return { kind: 'unresolved', reason: 'empty' };

  const scheme = SCHEME.exec(src)?.[0].toLowerCase();
  if (scheme === 'data:' || scheme === 'blob:') return { kind: 'url', url: src };
  if (scheme === 'https:' || scheme === 'http:') {
    // Plain http is asked for over TLS. The policy does not allow it, the
    // browser would upgrade it anyway, and a picture that only exists in the
    // clear is shown as not found rather than fetched where anyone on the
    // network can swap it.
    const url = scheme === 'http:' ? `https:${src.slice(scheme.length)}` : src;
    return context.remote ? { kind: 'url', url } : { kind: 'remote-off', url };
  }
  if (scheme === 'file:') {
    const filePath = pathFromFileUrl(src);
    return filePath ? { kind: 'url', url: toAssetUrl(normalisePath(filePath)) } : { kind: 'unresolved', reason: 'scheme' };
  }
  if (scheme && !WINDOWS_ROOT.test(src)) return { kind: 'unresolved', reason: 'scheme' };

  // `%20` in a markdown path means a space in the filename, which is what
  // Typora does with it too. A stray percent sign is left as it is.
  const decoded = safeDecode(src);
  if (isAbsolutePath(decoded)) return { kind: 'url', url: toAssetUrl(normalisePath(decoded)) };
  if (context.documentDir === null) return { kind: 'unresolved', reason: 'no-document' };
  return { kind: 'url', url: toAssetUrl(joinPath(context.documentDir, decoded)) };
}

/** The last segment of the source, for a placeholder to show. */
export function imageName(rawSrc: string): string {
  const src = safeDecode(rawSrc.trim()).replace(/[?#].*$/, '');
  const segments = src.split(/[\\/]/).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? src;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || WINDOWS_ROOT.test(value);
}

function pathFromFileUrl(src: string): string | null {
  try {
    const url = new URL(src);
    const decoded = decodeURIComponent(url.pathname);
    // `file:///C:/x` carries the drive after a slash that is not part of the path.
    return /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded;
  } catch {
    return null;
  }
}

/**
 * Join a relative path onto a folder, resolving `.` and `..` textually.
 *
 * Textually, because this runs in the renderer, which has no filesystem: the
 * result is a name to ask main for, and main resolves the real thing. The
 * separator follows the folder, so a Windows note produces a Windows path.
 */
export function joinPath(dir: string, relative: string): string {
  const windows = WINDOWS_ROOT.test(dir);
  const drive = windows ? dir.slice(0, 2) : '';
  const separator = windows ? '\\' : '/';
  const kept: string[] = [];
  for (const segment of [...dir.slice(drive.length).split(/[\\/]/), ...relative.split(/[\\/]/)]) {
    if (segment.length === 0 || segment === '.') continue;
    if (segment === '..') {
      kept.pop();
      continue;
    }
    kept.push(segment);
  }
  return `${drive}${separator}${kept.join(separator)}`;
}

const normalisePath = (absolute: string): string => joinPath(absolute, '');

/** The folder a document path is in, cut at its own separator, or null for none. */
export function documentDirOf(documentPath: string | null): string | null {
  if (!documentPath) return null;
  const cut = Math.max(documentPath.lastIndexOf('/'), documentPath.lastIndexOf('\\'));
  return cut > 0 ? documentPath.slice(0, cut) : null;
}

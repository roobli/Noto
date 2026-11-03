import { EMBED_FRAME_NAME } from '../../shared/embed-frame';
import { isAllowedRendererUrl } from '../protocol/register-app-protocol';

/** What a navigation check needs of a frame: its name and the frame it is in. */
export interface FrameLike {
  readonly name: string;
  readonly parent: FrameLike | null;
}

/** Schemes a page inside an embed may move to: the web, and the blank and data documents pages build their own frames from. */
const EMBED_SCHEMES = new Set(['https:', 'about:', 'data:', 'blob:']);

/**
 * Whether a frame of the editor window may go to `url`.
 *
 * The window itself, and every frame the app draws for itself (a diagram),
 * stays on the app's own pages. A frame the editor drew for a note's embedded
 * page, and any frame that page makes inside it, may follow the web, and
 * nothing else: never the app's own pages, which share the app's origin and
 * would hand the sandboxed page that origin. The embed is told apart by the
 * name the editor gave it, on the frame directly under the window, so a
 * diagram that learned to follow a link still cannot leave the app.
 */
export function frameNavigationAllowed(url: string, isMainFrame: boolean, frame: FrameLike | null): boolean {
  if (isMainFrame || frame === null) return isAllowedRendererUrl(url);
  let top = frame;
  while (top.parent !== null && top.parent.parent !== null) top = top.parent;
  if (top.name !== EMBED_FRAME_NAME) return isAllowedRendererUrl(url);
  try {
    return EMBED_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

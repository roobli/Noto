/**
 * What a drag in the file tree works out without a window: how fast the tree
 * scrolls when the pointer is held at its top or bottom edge, whether a drop
 * on a folder would move anything, and the words that say where it would go.
 *
 * A long move is the hard case. A note dragged from the bottom of a folder of
 * hundreds to one near the top has to cross more rail than is on screen, so
 * holding the pointer at an edge scrolls toward it: slowly where the band
 * begins, faster deeper in, fastest past the edge, so the pointer's distance
 * from the edge is the speed control. A closed folder held over opens
 * (`SPRING_MS`), and the destination is said in words at the foot of the
 * rail, since the folder's own row may be scrolled away by then.
 */

/** The band at each edge, in pixels, that scrolls the tree while a row is dragged. */
export const EDGE_BAND = 44;
/** The most the tree moves in a frame, at the edge and past it: about a thousand pixels a second. */
export const EDGE_MAX = 17;
/** The least, where the band begins, so the first moment of scroll is visible at all. */
const EDGE_MIN = 1.5;
/** How long the pointer rests in a band before the tree moves, so passing through one does nothing. */
export const EDGE_DELAY_MS = 140;
/** How long a closed folder is held over before it opens for the drop. */
export const SPRING_MS = 650;

/**
 * Pixels to scroll this frame for a pointer at `y`, in a scroller from `top`
 * to `bottom`: negative is up, zero is no scroll. The band narrows in a short
 * tree so the middle always stays still. Eased, so the speed is under the
 * person's control near the band and only runs at the edge.
 */
export function edgeSpeed(y: number, top: number, bottom: number, band = EDGE_BAND, max = EDGE_MAX): number {
  const height = bottom - top;
  if (height <= 0) return 0;
  const width = Math.min(band, height / 4);
  const intoTop = (top + width - y) / width;
  const intoBottom = (y - (bottom - width)) / width;
  const depth = Math.max(intoTop, intoBottom);
  if (depth <= 0) return 0;
  const speed = EDGE_MIN + (max - EDGE_MIN) * Math.min(1, depth) ** 2;
  return intoTop > intoBottom ? -speed : speed;
}

/** How a strength of scroll shows at the edge, 0 to 1, from a speed `edgeSpeed` gave. */
export function edgeStrength(speed: number, max = EDGE_MAX): number {
  return Math.min(1, Math.abs(speed) / max);
}

export type DropVerdict = 'move' | 'here' | 'into-itself';

const separatorOf = (path: string) => (path.includes('\\') && !path.includes('/') ? '\\' : '/');
const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf(separatorOf(path))));

/**
 * Whether dropping what is dragged on `folder` would move it, leave it where
 * it is, or put a folder inside itself. Several rows move if any of them
 * would, and none does if one is a folder the drop is inside.
 */
export function dropVerdict(dragged: string | readonly string[], folder: string): DropVerdict {
  const sources = typeof dragged === 'string' ? [dragged] : dragged;
  const into = (source: string) => folder === source || folder.startsWith(`${source}${separatorOf(source)}`);
  if (sources.some(into)) return 'into-itself';
  if (sources.every((source) => parentOf(source) === folder)) return 'here';
  return 'move';
}

/**
 * The rows a drag carries: the one picked up, or every chosen row when it is
 * one of them, without the rows inside a chosen folder, which go with it.
 */
export function carried(picked: string, chosen: ReadonlySet<string>): string[] {
  if (!chosen.has(picked) || chosen.size < 2) return [picked];
  const all = [...chosen];
  return all.filter((path) => !all.some((other) => other !== path && path.startsWith(`${other}${separatorOf(other)}`)));
}

/** The rows from `from` to `to` in the order they are drawn, both ends included, for a Shift-click. */
export function rangeOf(order: readonly string[], from: string, to: string): string[] {
  const start = order.indexOf(from);
  const end = order.indexOf(to);
  if (start < 0 || end < 0) return [to];
  return order.slice(Math.min(start, end), Math.max(start, end) + 1);
}

/** A folder as the rail names it: its path under the open folder, `Ideas / Drafts`, or the open folder's name. */
export function folderWords(folder: string, root: string, rootName: string): string {
  if (folder === root) return rootName;
  const separator = separatorOf(root);
  const prefix = root.endsWith(separator) ? root : `${root}${separator}`;
  return folder.startsWith(prefix) ? folder.slice(prefix.length).split(separator).join(' / ') : folder;
}

const nameOf = (path: string) => path.slice(path.lastIndexOf(separatorOf(path)) + 1).replace(/\.(md|markdown|mdown|mkd)$/i, '');

/**
 * What the foot of the rail says while `source` is dragged over `folder`, or
 * over no folder at all. While the tree scrolls under the pointer, rows of
 * one folder after another pass beneath it, so none is offered: `scrolling`
 * says which way, and the words say how to choose again.
 */
export function dropWords(dragged: string | readonly string[], folder: string | null, root: string, rootName: string, scrolling: -1 | 0 | 1 = 0): string {
  const sources = typeof dragged === 'string' ? [dragged] : dragged;
  const name = sources.length === 1 ? nameOf(sources[0]!) : `${sources.length} items`;
  const quoted = sources.length === 1 ? `"${name}"` : name;
  // Short: the rail may be narrow, and the chevron at the edge already says which way.
  if (scrolling !== 0) return `Scrolling ${scrolling < 0 ? 'up' : 'down'}…`;
  if (folder === null) return 'Drop on a folder · hold at an edge to scroll';
  const verdict = dropVerdict(sources, folder);
  if (verdict === 'into-itself') return 'A folder cannot go inside itself';
  if (verdict === 'here') return `${sources.length === 1 ? quoted : 'They'} ${sources.length === 1 ? 'is' : 'are'} already in ${folderWords(folder, root, rootName)}`;
  return `Move ${quoted} to ${folderWords(folder, root, rootName)}`;
}

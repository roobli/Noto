/**
 * Fitting a deep tree into a narrow rail, without scrolling sideways.
 *
 * The rail used to scroll left and right so a long name could be read, with
 * the twisty and glyph pinned while the names slid under them. In a 1000px
 * window a note six folders down then started 186px into a 248px rail, and
 * scrolling to it put names under icons. Instead the rail never scrolls
 * sideways: the step per level gives up width when the open tree is deep, and
 * a name that still does not fit loses its middle, never its end.
 *
 * Pure, so the rules are tested apart from the component: the tree passes in
 * its width, depths and a way to measure text.
 */

/** The step per level at rest: a level's 10px margin and its 20px indent (noto-editor.scss). */
export const TREE_STEP_MAX = 30;
/** The tightest step: the margin that keeps a stem under its folder's twisty, and a 4px arm. */
export const TREE_STEP_MIN = 14;
/** The part of a step that never shrinks, so a level's stem stays under its folder's twisty. */
export const TREE_STEP_MARGIN = 10;
/**
 * From a row's left edge to where its name starts: the row's 6px padding, the
 * 5px twisty, a 4px gap, the 15px glyph and a 4px gap. Mirrors the row's CSS,
 * where a comment points back here.
 */
export const TREE_NAME_INSET = 34;
/** Kept after a name: the row's right padding and a little air. */
export const TREE_NAME_END = 10;
/** What a git mark or a lock after the name takes. */
export const TREE_MARK_WIDTH = 18;

/**
 * The step per level for a rail this wide whose deepest drawn row is this
 * deep: 30px, as it always was, until the deepest name would have less than
 * half the rail; then only as much less as gives it that half, and never
 * under 14px.
 */
export function treeStep(width: number, deepest: number): number {
  if (!(width > 0) || deepest <= 0) return TREE_STEP_MAX;
  const nameRoom = Math.max(110, width * 0.5);
  const step = Math.floor((width - TREE_NAME_INSET - TREE_NAME_END - nameRoom) / deepest);
  return Math.max(TREE_STEP_MIN, Math.min(TREE_STEP_MAX, step));
}

/** The width a name has on a row this deep, with this many marks after it. */
export function nameRoom(width: number, depth: number, step: number, marks = 0): number {
  return Math.floor(width - depth * step - TREE_NAME_INSET - TREE_NAME_END - marks * TREE_MARK_WIDTH);
}

/** The extensions of the notes Noto opens, which the tree may leave off a row. */
const NOTE_EXTENSION = /\.(?:md|markdown|mdown|mkd)$/i;

/** A row's name as the tree shows it: a note without its extension when asked, anything else as it is. */
export function treeLabel(name: string, kind: 'file' | 'directory', noteExtensions: boolean): string {
  if (noteExtensions || kind !== 'file') return name;
  const bare = name.replace(NOTE_EXTENSION, '');
  return bare.length > 0 ? bare : name;
}

const SEPARATORS = new Set(['_', '-', ' ', '.']);

/**
 * For each name, the longest start ending at a separator that it shares with
 * at least one sibling: `duckdb_ext_` for `duckdb_ext_httpfs` beside
 * `duckdb_ext_icu`. Empty where no sibling shares one.
 *
 * Sorted once, since the longest start a name shares with any other is the
 * one it shares with a neighbour in sorted order, so a folder of a thousand
 * notes costs a sort and not a million comparisons.
 */
export function sharedStarts(names: readonly string[]): string[] {
  const order = names.map((name, index) => ({ name, index })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const common = (a: string, b: string): number => {
    let length = 0;
    while (length < a.length && length < b.length && a[length] === b[length]) length++;
    return length;
  };
  const shared = new Array<string>(names.length).fill('');
  for (let at = 0; at < order.length; at++) {
    const { name, index } = order[at]!;
    const reach = Math.max(
      at > 0 ? common(name, order[at - 1]!.name) : 0,
      at + 1 < order.length ? common(name, order[at + 1]!.name) : 0,
    );
    // Back to the last separator inside the common start, and never the whole name.
    let end = Math.min(reach, name.length - 1);
    while (end > 0 && !SEPARATORS.has(name[end - 1]!)) end--;
    // A start of separators alone (the dot of two dotfiles) says nothing, and dropping it would lose the dot.
    const start = name.slice(0, end);
    shared[index] = [...start].some((char) => !SEPARATORS.has(char)) ? start : '';
  }
  return shared;
}

export interface FittedName {
  readonly text: string;
  readonly cut: boolean;
}

const ELLIPSIS = '…';

/**
 * The largest k from `low` to `high` for which `fits(k)` holds, when it holds
 * up to some k and fails after it, as a width does as text grows; `low - 1`
 * when it never holds. A search rather than a scan, so a long name costs a
 * handful of measurements, not one a character.
 */
function largest(low: number, high: number, fits: (k: number) => boolean): number {
  let found = low - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (fits(middle)) { found = middle; low = middle + 1; } else high = middle - 1;
  }
  return found;
}

/**
 * A name cut to a width, keeping its end.
 *
 * Siblings in a vault tend to share their start (`project_docs_`, `2026_11_`)
 * and differ at the end, so a start shared with a sibling goes first, cut back
 * to one of its own separators or dropped whole. Otherwise the name keeps a
 * short head, about a third of the room, and as much of its end as fits. A
 * room too small for either is cut at the end, as a last resort.
 */
export function fitName(name: string, room: number, shared: string, measure: (text: string) => number): FittedName {
  if (measure(name) <= room) return { text: name, cut: false };
  if (shared.length > 0 && shared.length < name.length) {
    const rest = name.slice(shared.length);
    const heads = [''];
    for (let index = 0; index < shared.length - 1; index++) if (SEPARATORS.has(shared[index]!)) heads.push(shared.slice(0, index + 1));
    for (let at = heads.length - 1; at >= 0; at--) {
      const text = `${heads[at]}${ELLIPSIS}${rest}`;
      if (measure(text) <= room) return { text, cut: true };
    }
    // Still too wide: what tells the siblings apart comes right after the
    // shared start (`httpfs`, `icu`, `parquet`), so that stays and the end goes.
    const restChars = Array.from(rest);
    const keep = largest(2, restChars.length - 1, (k) => measure(`${ELLIPSIS}${restChars.slice(0, k).join('')}${ELLIPSIS}`) <= room);
    if (keep >= 2) return { text: `${ELLIPSIS}${restChars.slice(0, keep).join('')}${ELLIPSIS}`, cut: true };
  }
  const chars = Array.from(name);
  const head = Math.max(0, largest(1, chars.length - 2, (k) => measure(chars.slice(0, k).join('')) <= room * 0.34));
  const start = chars.slice(0, head).join('');
  const tail = Math.max(0, largest(1, chars.length - head - 1, (k) => measure(`${start}${ELLIPSIS}${chars.slice(chars.length - k).join('')}`) <= room));
  if (head >= 1 && tail >= 2) return { text: `${start}${ELLIPSIS}${chars.slice(chars.length - tail).join('')}`, cut: true };
  const end = Math.max(1, largest(1, chars.length - 1, (k) => measure(`${chars.slice(0, k).join('')}${ELLIPSIS}`) <= room));
  return { text: `${chars.slice(0, end).join('')}${ELLIPSIS}`, cut: true };
}

/**
 * A row's name fitted to its room: whole when it fits. A note that does not
 * fit gives up its extension first, since once the name is cut the extension
 * is what says least; then it is cut as `fitName` cuts.
 */
export function fitLabel(label: string, kind: 'file' | 'directory', room: number, shared: string, measure: (text: string) => number): FittedName {
  if (measure(label) <= room) return { text: label, cut: false };
  const bare = kind === 'file' ? label.replace(NOTE_EXTENSION, '') : label;
  const name = bare.length > 0 ? bare : label;
  if (name !== label && measure(name) <= room) return { text: name, cut: true };
  return { text: fitName(name, room, shared.length < name.length ? shared : '', measure).text, cut: true };
}

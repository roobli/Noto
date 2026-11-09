/**
 * Walking the file tree from the keyboard (daily-use audit, finding 17: the
 * arrows, Enter and F2 did nothing there).
 *
 * The keys are the ones a tree has on every desktop and in the WAI-ARIA tree
 * pattern: Up and Down to the row above and below, Right to open a folder or
 * step into it, Left to close it or step out to its folder, Home and End to
 * the first and last row, F2 to rename, and a letter to the next row whose
 * name starts with what was typed. Enter and Space are the rows' own, as
 * buttons: a note opens, a folder opens or closes.
 *
 * Worked out on the rows in the order the page draws them, which is the
 * order the eye reads, so nothing here has to know how the tree is nested.
 */

export interface TreeRowView {
  readonly path: string;
  readonly kind: 'file' | 'directory';
  /** 0 for the folder's own row, 1 for what hangs from it, and so on. */
  readonly depth: number;
  /** Open, for a folder; undefined for a note. */
  readonly open?: boolean;
  /** The name as the row shows it, for typing to find a row. */
  readonly label: string;
}

export type TreeMove =
  | { readonly kind: 'focus'; readonly index: number }
  | { readonly kind: 'expand'; readonly path: string }
  | { readonly kind: 'collapse'; readonly path: string }
  | { readonly kind: 'rename'; readonly path: string }
  | { readonly kind: 'none' };

const NONE: TreeMove = { kind: 'none' };

/** What a key does at `at`, the row that has the keys. */
export function treeMove(rows: readonly TreeRowView[], at: number, key: string, typed = ''): TreeMove {
  if (rows.length === 0) return NONE;
  const here = rows[Math.max(0, Math.min(at, rows.length - 1))]!;
  switch (key) {
    case 'ArrowDown': return at < rows.length - 1 ? { kind: 'focus', index: at + 1 } : NONE;
    case 'ArrowUp': return at > 0 ? { kind: 'focus', index: at - 1 } : NONE;
    case 'Home': return { kind: 'focus', index: 0 };
    case 'End': return { kind: 'focus', index: rows.length - 1 };
    case 'ArrowRight':
      if (here.kind !== 'directory') return NONE;
      if (!here.open) return { kind: 'expand', path: here.path };
      // Open: step into it, when it holds anything drawn below.
      return rows[at + 1] && rows[at + 1]!.depth > here.depth ? { kind: 'focus', index: at + 1 } : NONE;
    case 'ArrowLeft': {
      if (here.kind === 'directory' && here.open && here.depth > 0) return { kind: 'collapse', path: here.path };
      for (let index = at - 1; index >= 0; index -= 1) {
        if (rows[index]!.depth < here.depth) return { kind: 'focus', index };
      }
      return NONE;
    }
    case 'F2': return here.depth > 0 ? { kind: 'rename', path: here.path } : NONE;
    default: break;
  }
  if (typed.length === 0) return NONE;
  // Typing finds the next row whose name starts with what was typed, from
  // the row after this one round to this one, so repeating a letter cycles.
  const wanted = typed.toLocaleLowerCase();
  const first = typed.length > 1 ? at : at + 1;
  for (let step = 0; step < rows.length; step += 1) {
    const index = (first + step) % rows.length;
    if (rows[index]!.label.toLocaleLowerCase().startsWith(wanted)) return { kind: 'focus', index };
  }
  return NONE;
}

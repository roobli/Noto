/**
 * The changed notes of a folder as a tree, for the Changes page.
 *
 * Only what changed is in it, so a folder holding one changed note four
 * levels down is not four rows of folders: a chain of folders that each hold
 * only the next is drawn as one row, `a / b / c`, as code editors draw it.
 */

import type { GitChange } from '../../slots';

export interface ChangeFile {
  readonly kind: 'file';
  /** Absolute, for opening. */
  readonly path: string;
  readonly name: string;
  readonly change: GitChange;
}

export interface ChangeFolder {
  readonly kind: 'folder';
  /** Relative to the folder root, `/`-joined; the key a fold is kept under. */
  readonly key: string;
  /** One name, or a chain of them joined by ` / `. */
  readonly name: string;
  readonly children: readonly ChangeNode[];
}

export type ChangeNode = ChangeFile | ChangeFolder;

export interface ChangeCounts {
  readonly modified: number;
  readonly new: number;
  readonly deleted: number;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

interface Building {
  folders: Map<string, Building>;
  files: ChangeFile[];
}

/** The tree of changed notes under `root`, folders first, names in natural order. */
export function changeTree(root: string, files: ReadonlyArray<readonly [string, GitChange]>): readonly ChangeNode[] {
  const base = root.replace(/[\\/]+$/, '');
  const top: Building = { folders: new Map(), files: [] };
  for (const [path, change] of files) {
    if (!path.startsWith(`${base}/`) && !path.startsWith(`${base}\\`)) continue;
    const parts = path.slice(base.length + 1).split(/[\\/]/).filter(Boolean);
    const name = parts.pop();
    if (!name) continue;
    let at = top;
    for (const part of parts) {
      let next = at.folders.get(part);
      if (!next) { next = { folders: new Map(), files: [] }; at.folders.set(part, next); }
      at = next;
    }
    at.files.push({ kind: 'file', path, name, change });
  }
  const finish = (node: Building, prefix: string): ChangeNode[] => {
    const folders = [...node.folders].sort(([left], [right]) => collator.compare(left, right)).map(([name, child]): ChangeFolder => {
      let label = name;
      let key = prefix ? `${prefix}/${name}` : name;
      let inner = child;
      // Fold a chain of single folders into one row.
      while (inner.files.length === 0 && inner.folders.size === 1) {
        const [nextName, nextChild] = [...inner.folders][0]!;
        label = `${label} / ${nextName}`;
        key = `${key}/${nextName}`;
        inner = nextChild;
      }
      return { kind: 'folder', key, name: label, children: finish(inner, key) };
    });
    const leaves = [...node.files].sort((left, right) => collator.compare(left.name, right.name));
    return [...folders, ...leaves];
  };
  return finish(top, '');
}

export function changeCounts(files: ReadonlyArray<readonly [string, GitChange]>): ChangeCounts {
  const counts = { modified: 0, new: 0, deleted: 0 };
  for (const [, change] of files) counts[change] += 1;
  return counts;
}

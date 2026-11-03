/**
 * The menu on a row of the file tree.
 *
 * Built here rather than inside the session so it can be read back in a test:
 * a native menu holds the input loop until somebody dismisses it, and no
 * automated pointer can reach one, so the only way to know what a row offers
 * is to build the template and look at it. The editor's own context menu is
 * kept apart for the same reason.
 *
 * Every action takes the path it was built with. Nothing here reads the path
 * again or resolves it: by the time this is called the caller has already
 * resolved it through any symlink and checked it against the open folder.
 */

import type { MenuItemConstructorOptions } from 'electron';

export interface TreeRowActions {
  readonly open: (target: string) => void;
  readonly newNote: (directory: string) => void;
  readonly newFolder: (directory: string) => void;
  /** Asks the renderer for a name, which is where the row and the caret are. */
  readonly rename: (target: string) => void;
  readonly duplicate: (target: string) => void;
  /** Asks for a folder, then moves the row into it. */
  readonly move: (target: string) => void;
  readonly trash: (target: string, kind: 'file' | 'directory') => void;
  readonly reveal: (target: string) => void;
  readonly copyPath: (target: string) => void;
}

/** What the system calls the file manager, which differs on each of them. */
export function revealLabel(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'Reveal in Finder';
  if (platform === 'win32') return 'Reveal in File Explorer';
  return 'Reveal in File Manager';
}

/** What the system calls its trash, which differs on each of them. */
export function trashLabel(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'Move to Trash';
  if (platform === 'win32') return 'Move to Recycle Bin';
  return 'Move to Rubbish Bin';
}

export function buildTreeRowMenu(
  target: string,
  kind: 'file' | 'directory',
  actions: TreeRowActions,
  platform: NodeJS.Platform = process.platform,
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];
  // A folder opens by being expanded, which the row already does on a click.
  if (kind === 'file') {
    items.push({ id: 'tree-open', label: 'Open', click: () => actions.open(target) });
  } else {
    // Where the reader pressed. The File menu's New Note goes beside the note
    // in front, which is not always the folder they are pointing at.
    items.push({ id: 'tree-new-note', label: 'New Note Here', click: () => actions.newNote(target) });
  }
  if (kind === 'directory') {
    items.push({ id: 'tree-new-folder', label: 'New Folder Here', click: () => actions.newFolder(target) });
  }
  items.push({ type: 'separator' });
  items.push({ id: 'tree-rename', label: 'Rename…', click: () => actions.rename(target) });
  items.push({ id: 'tree-duplicate', label: 'Duplicate', click: () => actions.duplicate(target) });
  items.push({ id: 'tree-move', label: 'Move to…', click: () => actions.move(target) });
  items.push({ type: 'separator' });
  items.push({ id: 'tree-reveal', label: revealLabel(platform), click: () => actions.reveal(target) });
  items.push({ id: 'tree-copy-path', label: 'Copy Path', click: () => actions.copyPath(target) });
  items.push({ type: 'separator' });
  // Last, and alone below a rule. It is the one action here with no undo, so
  // it is the hardest to hit by accident and the furthest from Open.
  items.push({
    id: 'tree-trash',
    label: trashLabel(platform),
    click: () => actions.trash(target, kind),
  });
  return items;
}

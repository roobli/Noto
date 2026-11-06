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
  /** Open the note and show its info beside it: history, properties. */
  readonly info: (target: string) => void;
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
  /**
   * For a folder of a folder that keeps memory: how private it is now, and
   * how to change it. Absent elsewhere, and the menu has no Privacy.
   */
  readonly privacy?: { readonly level: 'open' | 'private' | 'sealed'; readonly set: (level: 'open' | 'private' | 'sealed') => void };
}

/** What each level means, said where it is chosen. */
const PRIVACY: readonly { readonly level: 'open' | 'private' | 'sealed'; readonly label: string }[] = [
  { level: 'open', label: 'Open: agents with a key may read it' },
  { level: 'private', label: 'Private: only agents allowed private notes' },
  { level: 'sealed', label: 'Sealed: no agent, ever' },
];

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
    items.push({ id: 'tree-info', label: 'Get Info', click: () => actions.info(target) });
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
  if (kind === 'directory' && actions.privacy) {
    const { level, set } = actions.privacy;
    items.push({
      id: 'tree-privacy',
      label: 'Privacy',
      submenu: PRIVACY.map((entry) => ({
        id: `tree-privacy-${entry.level}`, label: entry.label, type: 'radio' as const, checked: entry.level === level,
        click: () => { if (entry.level !== level) set(entry.level); },
      })),
    });
  }
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

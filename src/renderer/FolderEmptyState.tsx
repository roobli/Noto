/**
 * The page when a folder is open and no note is.
 *
 * It used to say "Open a folder or a file" to somebody whose folder was
 * already open (daily-use audit, finding 9). Now it offers what that person
 * came to do: go back to a note they had open lately in this folder, open the
 * folder's own index note, start a new one, or find one. The folder's name is
 * the heading, so the page also says where they are.
 */

import type { RecentFileV1, WorkspaceIndexEntryV1 } from '../shared/workspace/v1/contracts';

/** The names a folder's own index note goes by, the first found wins. */
const INDEX_NAMES = ['00_索引.md', 'readme.md', 'index.md', '_index.md'];

/** How many recent notes the page lists. */
const RECENT_SHOWN = 6;

/** Where `file` sits under `root`, with forward slashes; null when outside. Case is ignored on Windows paths. */
function insideFolder(file: string, root: string): string | null {
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(root);
  const norm = (value: string) => { const slashed = value.split('\\').join('/'); return windows ? slashed.toLowerCase() : slashed; };
  const base = norm(root).replace(/\/+$/, '');
  const relative = file.split('\\').join('/').slice(base.length + 1);
  return norm(file).startsWith(`${base}/`) ? relative : null;
}

/** The folder's index note at its top level, if it has one. */
export function folderIndexNote(entries: readonly WorkspaceIndexEntryV1[]): WorkspaceIndexEntryV1 | null {
  for (const name of INDEX_NAMES) {
    const found = entries.find((entry) => entry.relativePath.toLowerCase() === name);
    if (found) return found;
  }
  return null;
}

/** Recent notes inside the folder, newest first, each with where it sits. */
export function recentInside(recent: readonly RecentFileV1[], root: string, limit = RECENT_SHOWN) {
  const out: { readonly path: string; readonly name: string; readonly where: string }[] = [];
  for (const file of [...recent].sort((a, b) => b.openedAt - a.openedAt)) {
    const relative = insideFolder(file.path, root);
    if (relative === null || !/\.(md|markdown)$/i.test(file.path)) continue;
    out.push({ path: file.path, name: file.name.replace(/\.(md|markdown)$/i, ''), where: relative.split('/').slice(0, -1).join('/') });
    if (out.length >= limit) break;
  }
  return out;
}

export function FolderEmptyState({
  name, root, recent, entries, onOpen, onNewNote, onQuickOpen, onOpenFolder, quickOpenKey, newNoteKey,
}: {
  readonly name: string;
  readonly root: string;
  readonly recent: readonly RecentFileV1[];
  readonly entries: readonly WorkspaceIndexEntryV1[];
  readonly onOpen: (filePath: string) => void;
  readonly onNewNote: () => void;
  readonly onQuickOpen: () => void;
  readonly onOpenFolder: () => void;
  readonly quickOpenKey: string;
  readonly newNoteKey: string;
}) {
  const index = folderIndexNote(entries);
  const lately = recentInside(recent, root);
  return (
    <section className="empty-state" data-testid="empty-state" aria-labelledby="empty-folder-name">
      <h1 id="empty-folder-name" className="empty-folder-name">{name}</h1>
      <p className="empty-lead">No note is open.</p>
      <div className="empty-actions">
        <button type="button" className="primary" data-testid="empty-new-note" onClick={onNewNote}>
          New Note <kbd>{newNoteKey}</kbd>
        </button>
        <button type="button" data-testid="empty-quick-open" onClick={onQuickOpen}>
          Find a Note <kbd>{quickOpenKey}</kbd>
        </button>
        {index && (
          <button type="button" data-testid="empty-index-note" title={index.relativePath} onClick={() => onOpen(index.path)}>
            Open {index.name.replace(/\.(md|markdown)$/i, '')}
          </button>
        )}
      </div>
      {lately.length > 0 && (
        <nav className="recent-list" data-testid="empty-recent" aria-label="Notes opened lately in this folder">
          <span className="recent-label">Opened lately</span>
          {lately.map((file) => (
            <button key={file.path} type="button" className="recent-row" title={file.where || name}
              onClick={() => onOpen(file.path)}>
              {file.name}
              {file.where && <span className="recent-where">{file.where}</span>}
            </button>
          ))}
        </nav>
      )}
      <button type="button" className="empty-other-folder" data-testid="empty-open-folder" onClick={onOpenFolder}>
        Open Another Folder…
      </button>
    </section>
  );
}

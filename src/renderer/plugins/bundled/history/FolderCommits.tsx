/**
 * Recent commits, History's section of a folder's info: the newest commits
 * that changed anything under the folder, each with the notes it changed
 * there, which open on a press. It asks again when the git marks move, since
 * a commit moves them, a moment after they settle.
 */

import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { FolderHistory, RailPageHost } from '../../slots';
import { plural, when } from './model';

/** Waits for a burst of saves to settle before git is asked again. */
const SETTLE_MS = 400;

const NOT_OK: Record<string, string> = {
  'not-git': 'This folder is not in git, so it has no commits.',
  slow: 'Git took too long to answer. It is asked again when something changes.',
  unavailable: 'Git could not be read here.',
  outside: 'This folder is not in the open folder any more.',
};

/** The files a commit changed there beyond the notes it names: "and 3 more files". */
export function moreFiles(named: number, files: number): string {
  const rest = files - named;
  if (rest <= 0) return '';
  return named === 0 ? plural(rest, 'file') : `and ${plural(rest, 'more file', 'more files')}`;
}

function FolderCommits({ folder, host }: { readonly folder: string; readonly host: RailPageHost }) {
  const [history, setHistory] = useState<FolderHistory | null | undefined>(undefined);
  const [serial, setSerial] = useState(0);
  useEffect(() => {
    if (!host.git) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = host.git.subscribe(() => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => setSerial((current) => current + 1), SETTLE_MS);
    });
    return () => { stop(); if (timer !== null) clearTimeout(timer); };
  }, [host]);
  useEffect(() => {
    let live = true;
    void host.git?.folder(folder).then((answer) => { if (live) setHistory(answer); }, () => { if (live) setHistory(null); });
    return () => { live = false; };
  }, [host, folder, serial]);

  if (!host.git || history === undefined) return null;
  const heading = <h3 className="folder-heading"><span>Recent commits</span></h3>;
  if (history === null || history.state !== 'ok') {
    const state = history?.state ?? 'unavailable';
    return (
      <div className="folder-group" data-testid="folder-commits" data-state={state}>
        {heading}
        <p className="folder-plain">{NOT_OK[state] ?? NOT_OK.unavailable}</p>
      </div>
    );
  }
  if (history.commits.length === 0) {
    return (
      <div className="folder-group" data-testid="folder-commits" data-state="empty">
        {heading}
        <p className="folder-plain">Nothing here has been committed yet.</p>
      </div>
    );
  }
  const base = folder.replace(/[\\/]+$/, '');
  return (
    <div className="folder-group" data-testid="folder-commits" data-state="ok">
      {heading}
      <ul className="folder-commits">
        {history.commits.map((commit) => (
          <li key={commit.hash} className="folder-commit" data-testid="folder-commit">
            <span className="history-subject" title={commit.subject}>{commit.subject || '(no message)'}</span>
            <span className="history-meta">{when(commit.time)} · {commit.author}</span>
            {commit.files > 0 && (
              <span className="folder-commit-notes">
                {commit.notes.map((note) => (
                  <button key={note} type="button" className="folder-note-link" data-testid="folder-commit-note" data-path={note} title={note}
                    onClick={() => host.openNote(`${base}/${note}`)}>
                    {note.split('/').pop()!.replace(/\.(md|markdown|mdown|mkd)$/i, '')}
                  </button>
                ))}
                {moreFiles(commit.notes.length, commit.files) && <span className="folder-more">{moreFiles(commit.notes.length, commit.files)}</span>}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function mountFolderCommits(element: HTMLElement, folder: string, host: RailPageHost): () => void {
  const root = createRoot(element);
  root.render(<FolderCommits folder={folder} host={host} />);
  return () => root.unmount();
}

/**
 * What the folder's memory says about one folder, as two sections of its
 * info: how many notes and broken links, and the warmest notes with a bar
 * each, first; then, below the recent commits, the notes read most and those
 * nothing links to or from. Each asks the index for itself: a folder's read
 * is a few queries by its prefix that never open a note, so sharing one is
 * not worth a cache to keep in step. Both ask again when the memory changes.
 */

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { FolderMemoryAnswer, FolderNote, RailPageHost } from '../../slots';
import { absolute, folderSummary, nameOf, readWhy, warmthShare } from './model';

const NOT_OK: Record<string, string> = {
  'no-memory': 'The open folder does not keep memory, so how its notes are read and linked is not known.',
  untrusted: 'The folder’s memory runs scripts from its .noto/scripts folder, and Noto runs them only once you allow it.',
  opening: 'Reading the folder’s notes. The first time, for a big folder, this takes a little while.',
  unavailable: 'The folder’s memory could not be read. Noto tries again in a little while.',
  outside: 'This folder is not in the open folder any more.',
};

/** The answer for the folder, read again whenever the memory changes. */
function useFolderMemory(folder: string, host: RailPageHost): FolderMemoryAnswer | null | undefined {
  const [answer, setAnswer] = useState<FolderMemoryAnswer | null | undefined>(undefined);
  const [serial, setSerial] = useState(0);
  useEffect(() => host.vault?.subscribe(() => setSerial((current) => current + 1)), [host]);
  useEffect(() => {
    const vault = host.vault;
    if (!vault) return undefined;
    let live = true;
    vault.folder(folder).then((next) => { if (live) setAnswer(next); }, () => { if (live) setAnswer(null); });
    return () => { live = false; };
  }, [host, folder, serial]);
  return answer;
}

function NoteRow({ host, note, why, share, testId }: {
  readonly host: RailPageHost; readonly note: FolderNote; readonly why: string; readonly share?: number; readonly testId: string;
}) {
  const target = absolute(host.folder(), note.path);
  return (
    <li>
      <button type="button" className="memory-row folder-row" data-testid={testId} data-path={note.path} title={note.path}
        disabled={target === null} onClick={() => { if (target) host.openNote(target); }}>
        <span className="memory-title">{note.title || nameOf(note.path)}</span>
        {why && <span className="memory-why">{why}</span>}
        {share !== undefined && (
          <span className="folder-bar" aria-hidden="true" style={{ '--share': `${share}` } as CSSProperties} />
        )}
      </button>
    </li>
  );
}

function Group({ title, count, testId, children }: {
  readonly title: string; readonly count?: number; readonly testId: string; readonly children: ReactNode;
}) {
  return (
    <section className="folder-group" aria-label={title} data-testid={testId}>
      <h3 className="folder-heading">
        <span>{title}</span>
        {count !== undefined && <span className="memory-count">{count.toLocaleString('en')}</span>}
      </h3>
      <ul className="memory-list">{children}</ul>
    </section>
  );
}

/** The section at the top: what the folder holds, and its warmest notes. */
function Warmth({ folder, host }: { readonly folder: string; readonly host: RailPageHost }) {
  const answer = useFolderMemory(folder, host);
  const [busy, setBusy] = useState(false);
  if (!host.vault || answer === undefined) return null;
  if (answer === null || answer.state !== 'ok' || !answer.memory) {
    const state = answer?.state ?? 'unavailable';
    // Memory is kept for the whole of the open folder, which is not this one when it is inside it.
    const whole = host.folder() !== null && folder.replace(/[\\/]+$/, '') === host.folder()!.replace(/[\\/]+$/, '');
    const act = state === 'no-memory'
      ? { label: whole ? 'Keep Memory for This Folder…' : 'Keep Memory for the Open Folder…', run: () => host.vault!.keep() }
      : state === 'untrusted' ? { label: 'Review Scripts…', run: () => host.vault!.trust() } : null;
    return (
      <div className="folder-group" data-testid="folder-memory-state" data-state={state}>
        <p className="folder-plain">{NOT_OK[state] ?? NOT_OK.unavailable}</p>
        {act && (
          <button type="button" className="info-button folder-act" disabled={busy}
            onClick={() => { setBusy(true); void act.run().finally(() => setBusy(false)); }}>{act.label}</button>
        )}
      </div>
    );
  }
  const memory = answer.memory;
  const top = memory.warmest[0]?.heat ?? 0;
  return (
    <div data-testid="folder-warmth">
      <p className="folder-summary" data-testid="folder-summary">{folderSummary(memory)}</p>
      {memory.warmest.length > 0 && (
        <Group title="Warmest" testId="folder-warmest">
          {memory.warmest.map((note) => (
            <NoteRow key={note.path} host={host} note={note} why="" share={warmthShare(note.heat, top)} testId="folder-warm-note" />
          ))}
        </Group>
      )}
    </div>
  );
}

/** The section below the commits: the notes read most, and those nothing leads to or from. */
function Reach({ folder, host }: { readonly folder: string; readonly host: RailPageHost }) {
  const answer = useFolderMemory(folder, host);
  if (!host.vault || answer?.state !== 'ok' || !answer.memory) return null;
  const memory = answer.memory;
  if (memory.mostRead.length === 0 && memory.orphans.count === 0) return null;
  return (
    <div data-testid="folder-reach">
      {memory.mostRead.length > 0 && (
        <Group title="Read most" testId="folder-most-read">
          {memory.mostRead.map((note) => <NoteRow key={note.path} host={host} note={note} why={readWhy(note)} testId="folder-read-note" />)}
        </Group>
      )}
      {memory.orphans.count > 0 && (
        <Group title="Linked to nothing" count={memory.orphans.count} testId="folder-orphans">
          {memory.orphans.items.map((note) => <NoteRow key={note.path} host={host} note={note} why="" testId="folder-orphan-note" />)}
          {memory.orphans.count > memory.orphans.items.length && (
            <li className="memory-more">and {(memory.orphans.count - memory.orphans.items.length).toLocaleString('en')} more</li>
          )}
        </Group>
      )}
    </div>
  );
}

function mount(Component: typeof Warmth, element: HTMLElement, folder: string, host: RailPageHost): () => void {
  const root = createRoot(element);
  root.render(<Component folder={folder} host={host} />);
  return () => root.unmount();
}

export const mountFolderWarmth = (element: HTMLElement, folder: string, host: RailPageHost) => mount(Warmth, element, folder, host);
export const mountFolderReach = (element: HTMLElement, folder: string, host: RailPageHost) => mount(Reach, element, folder, host);

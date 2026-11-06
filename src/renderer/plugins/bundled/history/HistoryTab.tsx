/**
 * History: every commit that touched the note in front, newest first,
 * following renames.
 *
 * A press on a commit opens what it changed in the diff view, over the page,
 * and the view's bar steps to the commit before or after, compares the
 * version with the note as it stands, or takes the version back. Taking it
 * back is an edit like any other: the text goes into the editor in one step
 * that Undo reverses, and nothing is written until the note is saved. Shift
 * with a press compares any two versions. A script's commit (only text
 * between tool markers) and a sweep across the folder are drawn quieter, so
 * the person's own changes are the ones that stand out.
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { DiffAction, DiffRequest, InfoTabHost, InfoTabView, NoteCommit, NoteHistory } from '../../slots';
import { commitDetail, lines, plural, when } from './model';

/** Commits drawn at first, and added with each step further back. */
const PAGE = 30;
/** Past this, the tab says it is reading. Quicker than this, nothing flickers. */
const PATIENCE_MS = 150;

type Selection = { readonly kind: 'uncommitted' } | { readonly kind: 'commit'; readonly hash: string; readonly against?: string };

function useNote(host: InfoTabHost): string | null {
  const [note, setNote] = useState(() => host.note());
  useEffect(() => host.onNote(() => setNote(host.note())), [host]);
  return note;
}

/** The note's history, read again when git says something changed. */
function useHistory(host: InfoTabHost, note: string | null): { history: NoteHistory | null; waiting: boolean; retry: () => void } {
  const [history, setHistory] = useState<NoteHistory | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setHistory(null);
    if (note === null || !host.git) return undefined;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Reads may overlap (a save while the first is out); only the latest is drawn.
    let latest = 0;
    const read = () => {
      const mine = ++latest;
      const patience = setTimeout(() => { if (live && mine === latest) setWaiting(true); }, PATIENCE_MS);
      const settle = (next: NoteHistory | null) => {
        clearTimeout(patience);
        if (!live || mine !== latest) return;
        setWaiting(false);
        setHistory(next ?? { state: 'unavailable', commits: [], more: false, uncommitted: null, file: null });
      };
      host.git!.history(note).then(settle, () => settle(null));
    };
    read();
    // A save or a commit changes the marks; the history follows, once they settle.
    const stop = host.git.subscribe(() => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(read, 300);
    });
    return () => {
      live = false;
      if (timer !== null) clearTimeout(timer);
      stop();
    };
  }, [host, note, attempt]);
  return { history, waiting, retry: () => setAttempt((count) => count + 1) };
}

function HistoryTab({ host, onReveal }: { readonly host: InfoTabHost; readonly onReveal: (reveal: (key: string) => void) => void }) {
  const note = useNote(host);
  const { history, waiting, retry } = useHistory(host, note);
  const [shown, setShown] = useState(PAGE);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [located, setLocated] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const versions = useRef(new Map<string, Promise<string | null>>());
  /** Bumped by every press: a version that arrives after the next press, or another note, is dropped. */
  const asked = useRef(0);
  const stillWanted = (mine: number) => mine === asked.current && host.note() === note;
  const listRef = useRef<HTMLOListElement>(null);
  const commits = history?.commits ?? [];

  useEffect(() => {
    setShown(PAGE);
    setSelected(null);
    setStatus('');
    versions.current.clear();
  }, [note]);
  // Closing the diff is the plugin's to do when it goes, and the tab's when the note does.
  useEffect(() => () => host.showDiff(null), [host, note]);

  const version = useCallback((commit: NoteCommit): Promise<string | null> => {
    if (commit.change === 'deleted') return Promise.resolve('');
    let pending = versions.current.get(commit.hash);
    if (!pending) {
      pending = host.git ? host.git.version(note!, commit.hash, commit.path) : Promise.resolve(null);
      versions.current.set(commit.hash, pending);
    }
    return pending;
  }, [host, note]);

  const subjectOf = (commit: NoteCommit) => commit.subject || '(no message)';

  const open = useCallback(async (index: number) => {
    const commit = commits[index];
    if (!commit || note === null) return;
    const mine = ++asked.current;
    const parent = commits[index + 1] ?? null;
    // The newest thousand are read; the one before the oldest of them is not known.
    const unread = !parent && Boolean(history?.more);
    const [after, before] = await Promise.all([version(commit), parent ? version(parent) : Promise.resolve('')]);
    if (!stillWanted(mine)) return;
    if (after === null || before === null) {
      setStatus('That version could not be read from git.');
      return;
    }
    setSelected({ kind: 'commit', hash: commit.hash });
    const actions: DiffAction[] = [
      {
        id: 'older', label: 'Older', title: 'The commit before this one ([)',
        unavailable: parent ? undefined : unread ? 'Older commits are not read: the newest 1,000 are.' : 'This is the first commit of the note.',
        run: () => { void open(index + 1); },
      },
      {
        id: 'newer', label: 'Newer', title: 'The commit after this one (])',
        unavailable: index > 0 ? undefined : 'This is the latest commit.',
        run: () => { void open(index - 1); },
      },
      {
        id: 'now', label: 'Compare with Now', title: 'This version against the note as it stands',
        run: () => {
          const current = host.noteText();
          if (current === null) {
            setStatus('The note is still opening; try again in a moment.');
            return;
          }
          host.showDiff({
            title: `${subjectOf(commit)}, against now`,
            detail: `${when(commit.time)} · ${commit.author} · ${commit.hash.slice(0, 7)}`,
            before: { label: when(commit.time), text: after },
            after: { label: 'Now', text: current },
            actions: [restore(commit, after), copyText(after), copyId(commit)],
            onClose: () => setSelected(null),
          });
        },
      },
      restore(commit, after),
      copyText(after),
      copyId(commit),
    ];
    const request: DiffRequest = {
      title: subjectOf(commit),
      detail: `${when(commit.time)} · ${commit.author} · ${commit.hash.slice(0, 7)}${commit.from ? ` · moved from ${commit.from}` : ''}`,
      before: { label: parent ? when(parent.time) : unread ? 'Older commits not read' : 'Before', text: before },
      after: { label: when(commit.time), text: after },
      actions,
      keys: { '[': 'older', ']': 'newer' },
      onClose: () => setSelected((current) => (current?.kind === 'commit' && current.hash === commit.hash ? null : current)),
    };
    host.showDiff(request);
    // The pointer and the keys stay with the list, so the next press is another commit.
  }, [commits, history, host, note, version]);

  const restore = (commit: NoteCommit, text: string): DiffAction => ({
    id: 'restore', label: 'Restore This Version',
    title: 'Put this version in the editor. Undo takes it back; nothing is saved until you save.',
    unavailable: commit.change === 'deleted' ? 'The note did not exist in this commit.' : undefined,
    run: () => {
      if (host.replaceNoteText(text)) {
        host.showDiff(null);
        setSelected(null);
        setStatus(`Restored the version from ${when(commit.time)}. Undo takes it back; save to keep it.`);
      } else {
        setStatus('This note cannot be changed here.');
      }
    },
  });
  const copyText = (text: string): DiffAction => ({
    id: 'copy', label: 'Copy Text', title: 'Copy this version of the note',
    run: () => { host.copy(text); setStatus('Copied the version.'); },
  });
  const copyId = (commit: NoteCommit): DiffAction => ({
    id: 'copy-id', label: 'Copy Commit ID', title: commit.hash,
    run: () => { host.copy(commit.hash); setStatus(`Copied ${commit.hash.slice(0, 7)}.`); },
  });

  /** Two versions against each other, the older first. */
  const compare = useCallback(async (first: number, second: number) => {
    const older = commits[Math.max(first, second)]!;
    const newer = commits[Math.min(first, second)]!;
    const mine = ++asked.current;
    const [before, after] = await Promise.all([version(older), version(newer)]);
    if (!stillWanted(mine)) return;
    if (before === null || after === null) {
      setStatus('That version could not be read from git.');
      return;
    }
    setSelected({ kind: 'commit', hash: newer.hash, against: older.hash });
    host.showDiff({
      title: `${when(older.time)} to ${when(newer.time)}`,
      detail: `${older.hash.slice(0, 7)} to ${newer.hash.slice(0, 7)} · ${plural(Math.abs(first - second), 'commit')} apart`,
      before: { label: when(older.time), text: before },
      after: { label: when(newer.time), text: after },
      onClose: () => setSelected(null),
    });
  }, [commits, host, version]);

  const openUncommitted = useCallback(async () => {
    const current = host.noteText();
    if (current === null || note === null) return;
    const mine = ++asked.current;
    const head = commits[0];
    const before = head ? await version(head) : '';
    if (!stillWanted(mine)) return;
    if (before === null) {
      setStatus('The last commit could not be read from git.');
      return;
    }
    setSelected({ kind: 'uncommitted' });
    host.showDiff({
      title: 'Changes not committed',
      detail: head ? `Since ${when(head.time)} · ${head.hash.slice(0, 7)}` : 'The note has not been committed yet',
      before: { label: head ? 'Last commit' : 'Not committed', text: before },
      after: { label: 'Now', text: current },
      onClose: () => setSelected(null),
    });
  }, [commits, host, note, version]);

  const press = (index: number, shift: boolean) => {
    const anchor = selected?.kind === 'commit' ? commits.findIndex((commit) => commit.hash === selected.hash) : -1;
    if (shift && anchor >= 0 && anchor !== index) void compare(anchor, index);
    else void open(index);
  };

  // A mark on the timeline shows its commit here, reading further back if it has to.
  useEffect(() => {
    onReveal((key) => {
      const index = key === 'uncommitted' ? -1 : commits.findIndex((commit) => commit.hash === key);
      if (index >= shown) setShown(Math.ceil((index + 1) / PAGE) * PAGE);
      setLocated(key);
      requestAnimationFrame(() => {
        const row = listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
        row?.scrollIntoView({ block: 'nearest' });
        row?.focus();
      });
    });
  }, [commits, onReveal, shown]);
  useEffect(() => {
    if (located === null) return undefined;
    const timer = setTimeout(() => setLocated(null), 1600);
    return () => clearTimeout(timer);
  }, [located]);

  const walk = (event: KeyboardEvent<HTMLOListElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('.history-row') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    event.preventDefault();
    rows[Math.max(0, Math.min(rows.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  };

  if (note === null) return null;
  if (!host.git) return <p className="info-note">History needs to read git, which this plugin has not been allowed.</p>;
  if (history === null) return waiting ? <p className="info-note" data-testid="history-waiting">Reading the history…</p> : null;

  const facts = history.file;
  const fileLine = facts ? `Created ${when(facts.created)}, last changed ${when(facts.modified)}.` : '';
  if (history.state === 'not-git') {
    return <p className="info-note" data-testid="history-state" data-state="not-git">This folder is not in git, so the note has no history. {fileLine}</p>;
  }
  if (history.state === 'outside') {
    return <p className="info-note" data-testid="history-state" data-state="outside">This note is not in the open folder, so its history is not read.</p>;
  }
  if (history.state === 'slow' || history.state === 'unavailable') {
    return (
      <div className="info-note" data-testid="history-state" data-state={history.state}>
        <p>{history.state === 'slow' ? 'Git took too long to answer.' : 'The history could not be read from git.'}</p>
        <button type="button" className="info-button" onClick={retry}>Try Again</button>
      </div>
    );
  }

  const stopKey = selected?.kind === 'uncommitted' ? 'uncommitted'
    : selected?.kind === 'commit' ? selected.hash
      : history.uncommitted ? 'uncommitted' : commits[0]?.hash ?? '';
  const isCurrent = (key: string) => (selected?.kind === 'uncommitted' ? key === 'uncommitted'
    : selected?.kind === 'commit' && (selected.hash === key || selected.against === key));

  return (
    <div className="history-tab" data-testid="history-tab">
      {status && <p className="info-status" role="status" data-testid="history-status">{status}</p>}
      <ol ref={listRef} className="history-list" aria-label="Commits" onKeyDown={walk}>
        {history.uncommitted && (
          <li>
            <button type="button" className={`history-row is-pending${located === 'uncommitted' ? ' is-located' : ''}`}
              data-key="uncommitted" data-testid="history-uncommitted" aria-current={isCurrent('uncommitted') ? 'true' : undefined}
              tabIndex={stopKey === 'uncommitted' ? 0 : -1}
              onClick={() => { void openUncommitted(); }}>
              <span className="history-subject">{history.state === 'untracked' ? 'Not committed yet' : 'Changes not committed'}</span>
              <span className="history-meta">{lines(history.uncommitted.added, history.uncommitted.removed)}</span>
            </button>
          </li>
        )}
        {commits.slice(0, shown).map((commit, index) => (
          <li key={commit.hash}>
            <button
              type="button"
              className={`history-row${commit.tooling || commit.sweeping ? ' is-faint' : ''}${located === commit.hash ? ' is-located' : ''}`}
              data-key={commit.hash}
              data-testid="history-commit"
              aria-current={isCurrent(commit.hash) ? 'true' : undefined}
              tabIndex={stopKey === commit.hash ? 0 : -1}
              title={`${commit.hash.slice(0, 7)}. Shift-click another commit to compare the two.`}
              onClick={(event) => press(index, event.shiftKey)}
            >
              <span className="history-subject">{subjectOf(commit)}</span>
              <span className="history-meta">{commitDetail(commit)}</span>
              {commit.from && <span className="history-moved" data-testid="history-moved">Moved from {commit.from}</span>}
            </button>
          </li>
        ))}
      </ol>
      {history.state === 'untracked' && !history.uncommitted && <p className="info-note">This note has not been committed yet.</p>}
      {commits.length > shown && (
        <button type="button" className="info-button history-more" data-testid="history-more" onClick={() => setShown((count) => count + PAGE)}>
          Show {Math.min(PAGE, commits.length - shown)} earlier
        </button>
      )}
      {history.more && commits.length <= shown && <p className="info-note">Showing the newest {commits.length.toLocaleString('en')} commits.</p>}
    </div>
  );
}

export function mountHistory(element: HTMLElement, host: InfoTabHost): InfoTabView {
  const root = createRoot(element);
  let reveal: ((key: string) => void) | null = null;
  let waiting: string | null = null;
  root.render(<HistoryTab host={host} onReveal={(next) => {
    reveal = next;
    if (waiting !== null) { const key = waiting; waiting = null; next(key); }
  }} />);
  return {
    reveal: (key) => { if (reveal) reveal(key); else waiting = key; },
    dispose: () => root.unmount(),
  };
}

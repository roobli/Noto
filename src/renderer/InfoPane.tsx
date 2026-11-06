/**
 * The info pane: everything about the note in front, beside the page.
 *
 * The shell draws the frame and plugins fill it (`plugins/slots.ts`): at the
 * head, the note's name, its folder and what git says about it; under that a
 * timeline, one row per track on one axis, so commits and reads line up; then
 * a row of tabs, each a plugin's page about the note. It follows the note in
 * front once switching has paused (`ShellState.SETTLE_MS`), so walking through
 * tabs costs nothing.
 *
 * Get Info on a folder turns the pane to the folder until a note is chosen:
 * its name at the head, then a column of sections plugins add (recent
 * commits, the warmest notes), without the timeline or the tabs.
 *
 * The timeline is the pane's one ornament and the one place colour carries
 * meaning: the accent marks what happened, a hollow mark what has not been
 * committed yet, and faint marks a script's work. Everything else is the
 * rail's own type and rules.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent } from 'react';
import type {
  Disposer,
  FolderSectionEntry,
  GitSnapshot,
  InfoMark,
  InfoRegistry,
  InfoTabEntry,
  InfoTabView,
  InfoTrack,
  InfoTrackEntry,
  ShellState,
} from './plugins/slots';

export const INFO_MIN = 240;
export const INFO_MAX = 640;

/** The widest the pane may be in a window this wide: the page keeps the rest. */
export function infoWidthMax(windowWidth: number): number {
  return Math.max(INFO_MIN, Math.min(INFO_MAX, Math.floor(windowWidth * 0.4)));
}

export function clampInfoWidth(value: number, windowWidth: number): number {
  return Math.round(Math.min(infoWidthMax(windowWidth), Math.max(INFO_MIN, value)));
}

/**
 * What git says about the note, in the words the head uses. The marks name
 * only notes that differ from the last commit, so a note with no mark is
 * committed only if it has commits at all: one git ignores has neither.
 * `committed` is whether its history has a commit, or null before it is known.
 */
export function gitStateOf(snapshot: GitSnapshot | null, note: string, committed: boolean | null = null): string {
  if (!snapshot || snapshot.root === null || !snapshot.repository) return 'Not in git';
  // Git names notes from where the folder really is; the window may have opened it through a link.
  const real = snapshot.realRoot && snapshot.realRoot !== snapshot.root && note.startsWith(snapshot.root)
    ? snapshot.realRoot + note.slice(snapshot.root.length)
    : note;
  const change = snapshot.files.find(([file]) => file === real || file === note)?.[1];
  if (change === 'modified') return 'Uncommitted changes';
  if (change === 'new' || committed === false) return 'Not committed yet';
  return 'Committed';
}

const DAY = 24 * 60 * 60 * 1000;
/** The shortest stretch the timeline draws, so a note from this week does not stretch one day across it. */
const MIN_SPAN = 14 * DAY;

const dateFormat = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });
const yearFormat = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' });

export function shortDate(at: number, now = Date.now()): string {
  return new Date(at).getFullYear() === new Date(now).getFullYear() ? dateFormat.format(at) : yearFormat.format(at);
}

/** One column of a track: the marks that fall in it, drawn as one. */
interface Column {
  readonly index: number;
  readonly marks: readonly InfoMark[];
  readonly total: number;
}

/** Marks gathered into columns across the span. Pure, for the test. */
export function columnsOf(marks: readonly InfoMark[], start: number, end: number, count: number): Column[] {
  const span = Math.max(1, end - start);
  const columns = new Map<number, InfoMark[]>();
  for (const mark of marks) {
    const index = Math.min(count - 1, Math.max(0, Math.floor(((mark.at - start) / span) * count)));
    const list = columns.get(index) ?? [];
    list.push(mark);
    columns.set(index, list);
  }
  return [...columns.entries()].sort(([a], [b]) => a - b).map(([index, list]) => ({
    index,
    marks: list.sort((a, b) => b.at - a.at),
    total: list.reduce((sum, mark) => sum + (mark.value ?? 1), 0),
  }));
}

interface Loaded {
  readonly entry: InfoTrackEntry;
  readonly track: InfoTrack;
}

/** The tracks for a note, each loaded on its own and again when it says to. */
function useTracks(entries: readonly InfoTrackEntry[], note: string | null): readonly Loaded[] {
  const [loaded, setLoaded] = useState<ReadonlyMap<string, InfoTrack | null>>(new Map());
  useEffect(() => {
    setLoaded(new Map());
    if (note === null) return undefined;
    const stops: (() => void)[] = [];
    for (const entry of entries) {
      let controller: AbortController | null = null;
      const load = () => {
        controller?.abort();
        const own = new AbortController();
        controller = own;
        entry.track.load(note, own.signal).then((track) => {
          if (own.signal.aborted) return;
          setLoaded((current) => new Map(current).set(entry.key, track));
        }, () => { /* A track that cannot load is left out. */ });
      };
      load();
      const stop = entry.track.changes?.(load);
      stops.push(() => { controller?.abort(); stop?.(); });
    }
    return () => { for (const stop of stops) stop(); };
  }, [entries, note]);
  return entries.flatMap((entry) => {
    const track = loaded.get(entry.key);
    return track && (track.marks.length > 0 || track.pending) ? [{ entry, track }] : [];
  });
}

/**
 * The timeline: one row per track, oldest at the left, today at the right.
 * Marks closer than a column are one mark, said as how many; a press brings
 * the track's tab forward at the newest of them. The keys walk the marks.
 */
function Timeline({ tracks, width, onPick }: {
  readonly tracks: readonly Loaded[];
  readonly width: number;
  readonly onPick: (entry: InfoTrackEntry, key: string) => void;
}) {
  const now = Date.now();
  const end = now;
  const earliest = Math.min(...tracks.flatMap(({ track }) => track.marks.map((mark) => mark.at)), now);
  const start = Math.min(earliest, end - MIN_SPAN);
  // Nine pixels a column, a dot and its gap, across what the pane's padding
  // and the tracks' names leave. Something not yet committed has the last
  // column to itself, so a commit from today never sits under its ring.
  const count = Math.max(12, Math.floor(Math.max(80, width - 32 - 56) / 9));
  const pending = tracks.some(({ track }) => track.pending);
  const rows = tracks.map(({ entry, track }) => ({ entry, track, columns: columnsOf(track.marks, start, end, pending ? count - 1 : count) }));
  const buttons = useRef<HTMLButtonElement[]>([]);
  buttons.current = [];

  const walk = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = buttons.current;
    const at = list.indexOf(event.target as HTMLButtonElement);
    if (at < 0) return;
    let next = at;
    if (event.key === 'ArrowRight') next = Math.min(list.length - 1, at + 1);
    else if (event.key === 'ArrowLeft') next = Math.max(0, at - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = list.length - 1;
    else return;
    event.preventDefault();
    list[next]?.focus();
  };

  let first = true;
  const summary = tracks.map(({ track }) => track.summary).filter(Boolean).join(' · ');
  return (
    <div className="info-timeline" data-testid="info-timeline">
      <div className="info-tracks" role="group" aria-label="Timeline" onKeyDown={walk}>
        {rows.map(({ entry, track, columns }) => {
          const most = Math.max(1, ...columns.map((column) => column.total));
          return (
            <div key={entry.key} className={`info-track is-${track.kind}`} data-testid="info-track" data-track={entry.key}>
              <span className="info-track-name">{entry.track.title}</span>
              <div className="info-track-marks">
                {columns.map((column) => {
                  const newest = column.marks[0]!;
                  const many = column.marks.length > 1;
                  const label = track.kind === 'amounts'
                    ? `${shortDate(newest.at, now)}: ${column.total} ${entry.track.title.toLowerCase()}`
                    : many
                      ? `${column.marks.length} ${entry.track.title.toLowerCase()}, ${shortDate(column.marks[column.marks.length - 1]!.at, now)} to ${shortDate(newest.at, now)}`
                      : newest.label;
                  const faint = column.marks.every((mark) => mark.faint);
                  const style = {
                    '--x': `${((column.index + 0.5) / count) * 100}%`,
                    '--h': `${Math.max(0.18, column.total / most)}`,
                  } as CSSProperties;
                  const tab = first ? 0 : -1;
                  first = false;
                  return (
                    <button
                      key={column.index}
                      ref={(element) => { if (element) buttons.current.push(element); }}
                      type="button"
                      className={`info-mark${faint ? ' is-faint' : ''}${many ? ' is-many' : ''}`}
                      style={style}
                      tabIndex={tab}
                      aria-label={label}
                      title={label}
                      data-testid="info-mark"
                      onClick={() => onPick(entry, newest.key)}
                    />
                  );
                })}
                {track.pending && (
                  <button
                    type="button"
                    className="info-mark is-pending"
                    style={{ '--x': `${((count - 0.5) / count) * 100}%` } as CSSProperties}
                    tabIndex={-1}
                    aria-label={track.pending.label}
                    title={track.pending.label}
                    data-testid="info-mark-pending"
                    ref={(element) => { if (element) buttons.current.push(element); }}
                    onClick={() => onPick(entry, track.pending!.key)}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="info-axis" aria-hidden="true">
        <span>{shortDate(start, now)}</span>
        <span>Today</span>
      </div>
      {summary && <p className="info-summary" data-testid="info-summary">{summary}</p>}
    </div>
  );
}

/** One tab's page, mounted once and kept while the pane is open, so it keeps its place. */
function TabPanel({ entry, active, views }: {
  readonly entry: InfoTabEntry;
  readonly active: boolean;
  readonly views: Map<string, InfoTabView>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    let view: InfoTabView | null = null;
    try {
      view = entry.tab.mount(element, entry.host);
      views.set(entry.key, view);
    } catch (error) {
      element.textContent = `${entry.tab.title} could not open: ${(error as Error).message}`;
    }
    return () => {
      views.delete(entry.key);
      try { view?.dispose(); } catch { /* One tab's fault is not the pane's. */ }
    };
  }, [entry, views]);
  return (
    <div
      ref={ref}
      id={`info-panel-${entry.key}`}
      className="info-panel"
      role="tabpanel"
      aria-label={entry.tab.title}
      hidden={!active}
      data-testid="info-panel"
      data-tab={entry.key}
    />
  );
}

/** One plugin's section of a folder's info, mounted for that folder alone. */
function FolderSection({ entry, folder }: { readonly entry: FolderSectionEntry; readonly folder: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    let dispose: Disposer | null = null;
    try {
      dispose = entry.section.mount(element, folder, entry.host);
    } catch (error) {
      element.textContent = `${entry.section.title} could not open: ${(error as Error).message}`;
    }
    return () => {
      try { dispose?.(); } catch { /* One section's fault is not the pane's. */ }
      element.replaceChildren();
    };
  }, [entry, folder]);
  return (
    <section className="folder-section" aria-label={entry.section.title} data-testid="folder-section" data-key={entry.key}>
      <div ref={ref} className="folder-section-body" />
    </section>
  );
}

export interface InfoPaneProps {
  readonly registry: InfoRegistry;
  readonly state: ShellState;
  readonly width: number;
  readonly tab: string;
  /** A tab to bring forward and a key to reveal in it, from a timeline mark or a plugin. */
  readonly reveal: { readonly key: string; readonly reveal?: string; readonly serial: number } | null;
  readonly onTab: (key: string) => void;
  readonly onResize: (width: number) => void;
  readonly onClose: () => void;
  /** The folder the pane is about instead of the note, by its path on disk, or null. */
  readonly folderInfo?: string | null;
  /** Turn back to the note in front. */
  readonly onLeaveFolder?: () => void;
}

/**
 * Whether the note has a commit, from its history: the same read the History
 * tab and the timeline make, which main walks once and keeps until HEAD moves.
 * Asked again when the marks change, since a commit changes both.
 */
function useCommitted(state: InfoPaneProps['state'], note: string | null): boolean | null {
  const [committed, setCommitted] = useState<boolean | null>(null);
  useEffect(() => {
    setCommitted(null);
    if (note === null) return undefined;
    let live = true;
    let latest = 0;
    const read = () => {
      const mine = ++latest;
      state.git.history(note).then((history) => {
        // Only these two say: a slow or failed read is no news either way.
        if (live && mine === latest) setCommitted(history?.state === 'ok' ? true : history?.state === 'untracked' ? false : null);
      }, () => {});
    };
    read();
    const stop = state.git.subscribe(read);
    return () => { live = false; stop(); };
  }, [state, note]);
  return committed;
}

export function InfoPane({ registry, state, width, tab, reveal, onTab, onResize, onClose, folderInfo = null, onLeaveFolder }: InfoPaneProps) {
  const tabs = useSyncExternalStore(useCallback((listener: () => void) => registry.subscribe(listener), [registry]), () => registry.tabs());
  const sections = useSyncExternalStore(useCallback((listener: () => void) => registry.subscribe(listener), [registry]), () => registry.sections());
  const trackEntries = useSyncExternalStore(useCallback((listener: () => void) => registry.subscribe(listener), [registry]), () => registry.tracks());
  const note = useSyncExternalStore(useCallback((listener: () => void) => state.onSettledNote(listener), [state]), () => state.settledNote());
  const snapshot = useSyncExternalStore(useCallback((listener: () => void) => state.git.subscribe(listener), [state]), () => state.git.current());
  const folder = useSyncExternalStore(useCallback((listener: () => void) => state.host.subscribe(listener), [state]), () => state.host.folder());
  const tracks = useTracks(trackEntries, note);
  const committed = useCommitted(state, note);
  const views = useMemo(() => new Map<string, InfoTabView>(), []);
  const active = tabs.find((entry) => entry.key === tab) ?? tabs[0] ?? null;
  // Tabs are mounted the first time they are shown, and kept.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (active && !opened.has(active.key)) setOpened((current) => new Set(current).add(active.key));
  }, [active, opened]);

  // A reveal waits for its tab to be mounted, which may be this very render.
  useEffect(() => {
    if (!reveal?.reveal) return undefined;
    const frame = requestAnimationFrame(() => views.get(reveal.key)?.reveal?.(reveal.reveal!));
    return () => cancelAnimationFrame(frame);
  }, [reveal, views, opened]);

  const paneRef = useRef<HTMLElement>(null);
  const startResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const pane = paneRef.current;
    const shell = pane?.closest<HTMLElement>('.app-shell');
    if (!pane) return;
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = pane.getBoundingClientRect().width;
    let latest = startWidth;
    let frame: number | null = null;
    handle.setPointerCapture(event.pointerId);
    shell?.classList.add('is-resizing-rail');
    const apply = () => {
      frame = null;
      shell?.style.setProperty('--shell-info', `${latest}px`);
    };
    const move = (moveEvent: PointerEvent) => {
      // The pane grows to the left, against the pointer.
      latest = clampInfoWidth(startWidth - (moveEvent.clientX - startX), window.innerWidth);
      if (frame === null) frame = requestAnimationFrame(apply);
    };
    const finish = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      apply();
      shell?.classList.remove('is-resizing-rail');
      handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      onResize(latest);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }, [onResize]);

  const nudge = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 8;
    if (event.key === 'ArrowLeft') { event.preventDefault(); onResize(clampInfoWidth(width + step, window.innerWidth)); }
    if (event.key === 'ArrowRight') { event.preventDefault(); onResize(clampInfoWidth(width - step, window.innerWidth)); }
  };

  const tabKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (tabs.length === 0 || !active) return;
    const at = tabs.findIndex((entry) => entry.key === active.key);
    let next = at;
    if (event.key === 'ArrowRight') next = (at + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (at - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    onTab(tabs[next]!.key);
    paneRef.current?.querySelector<HTMLElement>(`[data-tab-key="${CSS.escape(tabs[next]!.key)}"]`)?.focus();
  };

  const name = note ? note.split(/[\\/]/).pop()!.replace(/\.(md|markdown|mdown|mkd)$/i, '') : '';
  const where = note && folder && note.startsWith(folder)
    ? note.slice(folder.length).replace(/^[\\/]+/, '').split(/[\\/]/).slice(0, -1).join(' / ')
    : '';
  // A folder's place in the open one; the open folder itself is named and has none.
  const folderName = folderInfo ? folderInfo.replace(/[\\/]+$/, '').split(/[\\/]/).pop()! : '';
  const folderWhere = folderInfo && folder && folderInfo.startsWith(folder)
    ? folderInfo.slice(folder.length).replace(/^[\\/]+/, '').split(/[\\/]/).slice(0, -1).join(' / ')
    : '';

  if (folderInfo !== null) {
    return (
      <aside ref={paneRef} className="info-pane is-folder" aria-label="Folder info" data-testid="info-pane" data-folder={folderInfo}>
        <div
          className="info-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Info pane width"
          aria-valuenow={width}
          aria-valuemin={INFO_MIN}
          aria-valuemax={INFO_MAX}
          tabIndex={0}
          data-testid="info-resize"
          onPointerDown={startResize}
          onKeyDown={nudge}
        />
        <header className="info-head">
          <div className="info-identity">
            <h2 className="info-title" data-testid="info-title" title={folderInfo}>
              <svg className="info-title-glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5v7.25c0 .41.34.75.75.75h9.5c.41 0 .75-.34.75-.75V6.25a.75.75 0 0 0-.75-.75H8L6.5 3.75H3.25a.75.75 0 0 0-.75.75Z" /></svg>
              {folderName}
            </h2>
            <p className="info-where" data-testid="info-where">
              {folderWhere && <span className="info-folder">{folderWhere}</span>}
              <span className="info-state">Folder</span>
            </p>
          </div>
          <button type="button" className="icon-button info-close" aria-label="Close folder info" title="Close" data-testid="info-close" onClick={onClose}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.25 4.25 11.75 11.75M11.75 4.25 4.25 11.75" /></svg>
          </button>
        </header>
        {note !== null && onLeaveFolder && (
          <button type="button" className="info-back" data-testid="info-back" onClick={onLeaveFolder}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.75 4.25 6 8l3.75 3.75" /></svg>
            <span>Back to {name}</span>
          </button>
        )}
        {sections.length === 0 && (
          <p className="info-empty" data-testid="info-empty">Nothing adds to a folder&apos;s info. History and Memory come with Noto and can be turned on in Settings, under Plugins.</p>
        )}
        <div className="folder-sections">
          {sections.map((entry) => <FolderSection key={entry.key} entry={entry} folder={folderInfo} />)}
        </div>
      </aside>
    );
  }

  return (
    <aside ref={paneRef} className="info-pane" aria-label="Note info" data-testid="info-pane">
      <div
        className="info-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Info pane width"
        aria-valuenow={width}
        aria-valuemin={INFO_MIN}
        aria-valuemax={INFO_MAX}
        tabIndex={0}
        data-testid="info-resize"
        onPointerDown={startResize}
        onKeyDown={nudge}
      />
      <header className="info-head">
        <div className="info-identity">
          <h2 className="info-title" data-testid="info-title" title={note ?? undefined}>{note ? name : 'Note info'}</h2>
          {note && (
            <p className="info-where" data-testid="info-where">
              {where && <span className="info-folder">{where}</span>}
              <span className="info-state" data-testid="info-state">{gitStateOf(snapshot, note, committed)}</span>
            </p>
          )}
        </div>
        <button type="button" className="icon-button info-close" aria-label="Close note info" title="Close" data-testid="info-close" onClick={onClose}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.25 4.25 11.75 11.75M11.75 4.25 4.25 11.75" /></svg>
        </button>
      </header>
      {note === null && <p className="info-empty" data-testid="info-empty">Open a note to see its history and details here.</p>}
      {note !== null && tabs.length === 0 && (
        <p className="info-empty" data-testid="info-empty">Nothing adds to this pane. History comes with Noto and can be turned on in Settings, under Plugins.</p>
      )}
      {note !== null && tabs.length > 0 && (
        <>
          {tracks.length > 0 && (
            <Timeline
              tracks={tracks}
              width={width}
              onPick={(entry, key) => {
                if (entry.tabKey) {
                  onTab(entry.tabKey);
                  requestAnimationFrame(() => views.get(entry.tabKey!)?.reveal?.(key));
                }
              }}
            />
          )}
          <div className="info-tabs" role="tablist" aria-label="Note info" onKeyDown={tabKeys}>
            {tabs.map((entry) => {
              const selected = entry.key === active?.key;
              return (
                <button
                  key={entry.key}
                  type="button"
                  role="tab"
                  className="info-tab"
                  aria-selected={selected}
                  aria-controls={opened.has(entry.key) ? `info-panel-${entry.key}` : undefined}
                  tabIndex={selected ? 0 : -1}
                  data-tab-key={entry.key}
                  data-testid="info-tab"
                  onClick={() => onTab(entry.key)}
                >
                  {entry.tab.title}
                </button>
              );
            })}
          </div>
          <div className="info-panels">
            {tabs.filter((entry) => opened.has(entry.key) || entry.key === active?.key).map((entry) => (
              <TabPanel key={entry.key} entry={entry} active={entry.key === active?.key} views={views} />
            ))}
          </div>
        </>
      )}
    </aside>
  );
}

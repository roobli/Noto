/**
 * Browse the vault by tag.
 *
 * Two panes in one sheet, as Quick Open has a list and a preview: the tags on
 * the left, most used first, and on the right the notes that carry the tag
 * the cursor is on, so walking the tags shows what each one gathers without
 * opening anything. Most of a large vault's tags are used once, so those sit
 * under their own heading after the ones that join several notes.
 *
 * The keys: Up and Down walk the pane that has them, Right or Tab goes to the
 * notes, Left or Shift-Tab back to the tags, Enter on a tag goes to its notes
 * and Enter on a note opens it, Escape clears the filter, then closes. Opened
 * on a tag (from a chip above a note), it starts in that tag's notes.
 *
 * It was drawn on a background token the theme never defined, so the page
 * showed through its rows; it now sits on the page colour, as the other
 * sheets do.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceTagNoteV1, WorkspaceTagSummaryV1 } from '../shared/workspace/v1/contracts';
import { isComposing } from './ime';
import { SheetWidthHint, stepSheetWidth, type SheetWidthControl } from './sheet-width';

export type TagBrowserView =
  | { readonly kind: 'tags' }
  | { readonly kind: 'notes'; readonly tag: string };

export interface TagBrowserProps {
  readonly open: boolean;
  /** Where it starts: the whole list, or one tag's notes. */
  readonly view: TagBrowserView;
  readonly tags: readonly WorkspaceTagSummaryV1[];
  readonly loading: boolean;
  readonly truncated: boolean;
  /** The notes that carry a tag; asked for as the cursor reaches it. */
  readonly loadNotes: (tag: string) => Promise<readonly WorkspaceTagNoteV1[]>;
  readonly onOpenNote: (path: string) => void;
  readonly onClose: () => void;
  /** The width all the sheets share, which ⌘[ and ⌘] step. */
  readonly sheet?: SheetWidthControl;
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function folderOf(relativePath: string): string {
  const cut = relativePath.lastIndexOf('/');
  return cut > 0 ? relativePath.slice(0, cut) : '';
}

/** Tags that join several notes first, by how many, then by name; the ones used once after, by name. */
export function orderTags(tags: readonly WorkspaceTagSummaryV1[], query: string): { shared: WorkspaceTagSummaryV1[]; once: WorkspaceTagSummaryV1[] } {
  const wanted = query.trim().toLocaleLowerCase();
  const kept = wanted.length === 0 ? [...tags] : tags.filter((entry) => entry.tag.toLocaleLowerCase().includes(wanted));
  // A filter puts the tags that begin with it first, within each group.
  const starts = (entry: WorkspaceTagSummaryV1) => (wanted.length > 0 && entry.tag.toLocaleLowerCase().startsWith(wanted) ? 0 : 1);
  kept.sort((a, b) => starts(a) - starts(b) || b.count - a.count || collator.compare(a.tag, b.tag));
  return { shared: kept.filter((entry) => entry.count > 1), once: kept.filter((entry) => entry.count <= 1) };
}

function Marked({ text, query }: { readonly text: string; readonly query: string }) {
  const wanted = query.trim().toLocaleLowerCase();
  const at = wanted.length === 0 ? -1 : text.toLocaleLowerCase().indexOf(wanted);
  if (at < 0) return <>{text}</>;
  return <>{text.slice(0, at)}<mark className="tag-browser-hit">{text.slice(at, at + wanted.length)}</mark>{text.slice(at + wanted.length)}</>;
}

export function TagBrowser({ open, view, tags, loading, truncated, loadNotes, onOpenNote, onClose, sheet }: TagBrowserProps) {
  const [query, setQuery] = useState('');
  const [activeTag, setActiveTag] = useState(0);
  const [activeNote, setActiveNote] = useState(0);
  const [pane, setPane] = useState<'tags' | 'notes'>('tags');
  const [notes, setNotes] = useState<{ readonly tag: string; readonly notes: readonly WorkspaceTagNoteV1[]; readonly failed?: boolean } | null>(null);
  const cache = useRef(new Map<string, readonly WorkspaceTagNoteV1[]>());
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const notesRef = useRef<HTMLDivElement>(null);

  const ordered = useMemo(() => orderTags(tags, query), [tags, query]);
  const rows = useMemo(() => [...ordered.shared, ...ordered.once], [ordered]);
  const current = rows[Math.min(activeTag, rows.length - 1)] ?? null;

  // Opening: the filter cleared, and the cursor on the tag asked for.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    cache.current.clear();
    setNotes(null);
    setActiveNote(0);
    setPane(view.kind === 'notes' ? 'notes' : 'tags');
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open, view]);
  useEffect(() => {
    if (!open || view.kind !== 'notes' || rows.length === 0) return;
    const at = rows.findIndex((entry) => entry.tag.toLocaleLowerCase() === view.tag.toLocaleLowerCase());
    if (at >= 0) setActiveTag(at);
  }, [open, view, tags]);
  useEffect(() => { setActiveTag((at) => (rows.length === 0 ? 0 : Math.min(at, rows.length - 1))); }, [rows.length]);
  useEffect(() => { if (query.length > 0) setActiveTag(0); }, [query]);

  // The notes of the tag under the cursor, after a short pause so holding an arrow reads only where it stops.
  useEffect(() => {
    if (!open || !current) return;
    const tag = current.tag;
    const known = cache.current.get(tag.toLocaleLowerCase());
    if (known) { setNotes({ tag, notes: known }); setActiveNote(0); return; }
    let live = true;
    const timer = window.setTimeout(() => {
      loadNotes(tag).then((found) => {
        cache.current.set(tag.toLocaleLowerCase(), found);
        if (live) { setNotes({ tag, notes: found }); setActiveNote(0); }
      }, () => {
        // Not cached, so the next visit to the tag asks again.
        if (live) { setNotes({ tag, notes: [], failed: true }); setActiveNote(0); }
      });
    }, 70);
    return () => { live = false; window.clearTimeout(timer); };
  }, [open, current?.tag, loadNotes]);

  const shown = notes && current && notes.tag === current.tag ? notes.notes : null;

  useEffect(() => {
    const list = pane === 'tags' ? listRef.current : notesRef.current;
    list?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [pane, activeTag, activeNote]);

  if (!open) return null;

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (isComposing(event)) return;
    if (stepSheetWidth(event, sheet)) return;
    const step = (count: number, set: (update: (at: number) => number) => void, by: number) => {
      if (count > 0) set((at) => (at + by + count) % count);
    };
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        if (query.length > 0) setQuery('');
        else onClose();
        return;
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        const by = event.key === 'ArrowDown' ? 1 : -1;
        if (pane === 'tags') step(rows.length, setActiveTag, by);
        else step(shown?.length ?? 0, setActiveNote, by);
        return;
      }
      case 'ArrowRight':
        if ((event.target as HTMLInputElement).selectionStart !== query.length) return;
        if (shown && shown.length > 0) { event.preventDefault(); setPane('notes'); }
        return;
      case 'ArrowLeft':
        if (pane === 'notes') { event.preventDefault(); setPane('tags'); }
        return;
      case 'Tab':
        event.preventDefault();
        setPane(event.shiftKey || pane === 'notes' ? 'tags' : shown && shown.length > 0 ? 'notes' : 'tags');
        return;
      case 'Enter': {
        event.preventDefault();
        if (pane === 'tags') {
          if (shown && shown.length === 1) onOpenNote(shown[0]!.path);
          else if (shown && shown.length > 0) setPane('notes');
          return;
        }
        const note = shown?.[activeNote];
        if (note) onOpenNote(note.path);
        return;
      }
      default:
    }
  };

  const tagRow = (entry: WorkspaceTagSummaryV1, index: number) => (
    <button
      type="button"
      key={entry.tag.toLocaleLowerCase()}
      id={`tag-browser-tag-${index}`}
      role="option"
      aria-selected={index === activeTag}
      className={index === activeTag ? (pane === 'tags' ? 'tag-browser-row is-active' : 'tag-browser-row is-active is-resting') : 'tag-browser-row'}
      data-testid="tag-browser-tag"
      data-tag={entry.tag}
      onMouseMove={() => { if (index !== activeTag) setActiveTag(index); }}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => { setActiveTag(index); setPane('notes'); inputRef.current?.focus(); }}
    >
      <span className="tag-browser-name"><span className="tag-browser-hash" aria-hidden="true">#</span><Marked text={entry.tag} query={query} /></span>
      <span className="tag-browser-count">{entry.count}</span>
    </button>
  );

  return (
    <div className="tag-browser-scrim" data-testid="tag-browser" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="tag-browser" data-sheet-width={sheet?.width} role="dialog" aria-modal="true" aria-label="Browse tags" onKeyDown={onKeyDown}>
        <div className="tag-browser-bar">
          <input
            ref={inputRef}
            className="tag-browser-input"
            data-testid="tag-browser-input"
            value={query}
            placeholder="Filter tags"
            aria-label="Filter tags"
            role="combobox"
            aria-expanded="true"
            aria-controls={pane === 'notes' ? 'tag-browser-note-list' : 'tag-browser-tags'}
            aria-activedescendant={pane === 'notes' && shown && shown.length > 0
              ? `tag-browser-note-${Math.min(activeNote, shown.length - 1)}`
              : current ? `tag-browser-tag-${Math.min(activeTag, rows.length - 1)}` : undefined}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="tag-browser-panes">
          <div className="tag-browser-list" id="tag-browser-tags" role="listbox" aria-label="Tags" data-testid="tag-browser-list" ref={listRef}>
            {loading && <p className="tag-browser-empty">Reading tags…</p>}
            {!loading && rows.length === 0 && (
              <p className="tag-browser-empty" data-testid="tag-browser-empty">
                {tags.length === 0 ? 'No tags in this vault yet.' : 'No tag has those letters.'}
              </p>
            )}
            {!loading && ordered.shared.map((entry, index) => tagRow(entry, index))}
            {!loading && ordered.once.length > 0 && (
              <p className="tag-browser-group" role="presentation">Used once · {ordered.once.length}</p>
            )}
            {!loading && ordered.once.map((entry, index) => tagRow(entry, ordered.shared.length + index))}
          </div>
          <div className={pane === 'notes' ? 'tag-browser-notes is-focused' : 'tag-browser-notes'} role="listbox"
            id="tag-browser-note-list" aria-label={current ? `Notes tagged ${current.tag}` : 'Notes'} data-testid="tag-browser-notes" ref={notesRef}>
            {current && (
              <p className="tag-browser-notes-head">
                <strong>#{current.tag}</strong>
                <span>{current.count} {current.count === 1 ? 'note' : 'notes'}</span>
              </p>
            )}
            {current && shown === null && <p className="tag-browser-empty">Reading notes…</p>}
            {current && notes?.tag === current.tag && notes.failed === true && (
              <p className="tag-browser-empty" role="alert">The notes with this tag could not be read. Move off the tag and back to try again.</p>
            )}
            {shown?.map((note, index) => {
              const folder = folderOf(note.relativePath);
              const active = pane === 'notes' && index === activeNote;
              return (
                <button
                  type="button"
                  key={note.path}
                  id={`tag-browser-note-${index}`}
                  role="option"
                  aria-selected={active}
                  className={active ? 'tag-browser-row tag-browser-note is-active' : 'tag-browser-row tag-browser-note'}
                  data-testid="tag-browser-note"
                  data-path={note.path}
                  onMouseMove={() => { if (pane !== 'notes' || index !== activeNote) { setPane('notes'); setActiveNote(index); } }}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onOpenNote(note.path)}
                >
                  <span className="tag-browser-name">{note.title}</span>
                  {folder.length > 0 && <span className="tag-browser-folder" title={folder}><bdi>{folder}</bdi></span>}
                </button>
              );
            })}
          </div>
        </div>
        <footer className="tag-browser-footer">
          <span>{tags.length.toLocaleString()} {tags.length === 1 ? 'tag' : 'tags'}{truncated ? ' · partial index' : ''}</span>
          <span><kbd>↑</kbd> <kbd>↓</kbd> move</span>
          <span><kbd>→</kbd> notes</span>
          <span><kbd>↩</kbd> open</span>
          <span className="sheet-foot-end"><SheetWidthHint control={sheet} /><span><kbd>esc</kbd> close</span></span>
        </footer>
      </section>
    </div>
  );
}

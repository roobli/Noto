/**
 * Browse the vault by tag.
 *
 * Opens either on a tag (from a chip) or on the whole list (from Go >
 * Browse Tags). Choosing a note opens it; choosing a tag drills into its
 * notes. Escape and the scrim close it, the same way quick open does.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  WorkspaceTagNoteV1,
  WorkspaceTagSummaryV1,
} from '../shared/workspace/v1/contracts';
import { isComposing } from './ime';

export type TagBrowserView =
  | { readonly kind: 'tags' }
  | { readonly kind: 'notes'; readonly tag: string };

export interface TagBrowserProps {
  readonly open: boolean;
  readonly view: TagBrowserView;
  readonly tags: readonly WorkspaceTagSummaryV1[];
  readonly notes: readonly WorkspaceTagNoteV1[];
  readonly loading: boolean;
  readonly truncated: boolean;
  readonly onOpenTag: (tag: string) => void;
  readonly onOpenNote: (path: string) => void;
  readonly onBack: () => void;
  readonly onClose: () => void;
}

function folderOf(relativePath: string): string {
  const cut = relativePath.lastIndexOf('/');
  return cut > 0 ? relativePath.slice(0, cut) : '';
}

export function TagBrowser({
  open, view, tags, notes, loading, truncated, onOpenTag, onOpenNote, onBack, onClose,
}: TagBrowserProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open, view]);

  const filteredTags = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return tags;
    return tags.filter((entry) => entry.tag.toLowerCase().includes(q));
  }, [tags, query]);

  const filteredNotes = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return notes;
    return notes.filter((note) =>
      note.title.toLowerCase().includes(q) || note.relativePath.toLowerCase().includes(q));
  }, [notes, query]);

  const rows = view.kind === 'tags' ? filteredTags : filteredNotes;
  const count = rows.length;

  useEffect(() => {
    setActive((current) => (count === 0 ? 0 : Math.min(current, count - 1)));
  }, [count]);

  if (!open) return null;

  const choose = (index: number): void => {
    if (view.kind === 'tags') {
      const entry = filteredTags[index];
      if (entry) onOpenTag(entry.tag);
      return;
    }
    const note = filteredNotes[index];
    if (note) onOpenNote(note.path);
  };

  return (
    <div className="tag-browser-scrim" data-testid="tag-browser" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className="tag-browser" role="dialog" aria-label="Browse tags">
        <div className="tag-browser-bar">
          {view.kind === 'notes' && (
            <button type="button" className="tag-browser-back" data-testid="tag-browser-back"
              onClick={onBack} aria-label="All tags">←</button>
          )}
          <input
            ref={inputRef}
            className="tag-browser-input"
            data-testid="tag-browser-input"
            value={query}
            placeholder={view.kind === 'tags' ? 'Filter tags…' : `Filter notes tagged ${view.tag}…`}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // A press the input method is composing with is the input method's.
              if (isComposing(event)) return;
              if (event.key === 'Escape') {
                event.preventDefault();
                if (view.kind === 'notes' && query.length === 0) onBack();
                else if (query.length > 0) setQuery('');
                else onClose();
                return;
              }
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                if (count > 0) setActive((current) => (current + 1) % count);
                return;
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                if (count > 0) setActive((current) => (current - 1 + count) % count);
                return;
              }
              if (event.key === 'Enter') {
                event.preventDefault();
                choose(active);
              }
            }}
          />
        </div>
        <div className="tag-browser-list" data-testid="tag-browser-list">
          {loading && <p className="tag-browser-empty">Reading tags…</p>}
          {!loading && count === 0 && (
            <p className="tag-browser-empty" data-testid="tag-browser-empty">
              {view.kind === 'tags' ? 'No tags in this vault yet.' : 'No notes carry this tag.'}
            </p>
          )}
          {!loading && view.kind === 'tags' && filteredTags.map((entry, index) => (
            <button
              type="button"
              key={entry.tag.toLowerCase()}
              className={index === active ? 'tag-browser-row is-active' : 'tag-browser-row'}
              data-testid="tag-browser-tag"
              data-tag={entry.tag}
              onMouseEnter={() => setActive(index)}
              onClick={() => onOpenTag(entry.tag)}
            >
              <span className="tag-browser-name">{entry.tag}</span>
              <span className="tag-browser-count">{entry.count}</span>
            </button>
          ))}
          {!loading && view.kind === 'notes' && filteredNotes.map((note, index) => {
            const folder = folderOf(note.relativePath);
            return (
              <button
                type="button"
                key={note.path}
                className={index === active ? 'tag-browser-row is-active' : 'tag-browser-row'}
                data-testid="tag-browser-note"
                data-path={note.path}
                onMouseEnter={() => setActive(index)}
                onClick={() => onOpenNote(note.path)}
              >
                <span className="tag-browser-name">{note.title}</span>
                {folder.length > 0 && <span className="tag-browser-folder">{folder}</span>}
              </button>
            );
          })}
        </div>
        <footer className="tag-browser-footer">
          {view.kind === 'notes'
            ? <span>Tagged <strong>{view.tag}</strong></span>
            : <span>{tags.length} tag{tags.length === 1 ? '' : 's'}</span>}
          {truncated && <span>Partial index</span>}
          <span><kbd>enter</kbd> open · <kbd>esc</kbd> close</span>
        </footer>
      </div>
    </div>
  );
}

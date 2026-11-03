/**
 * Search across the vault, in the rail, staying open.
 *
 * Typora's sidebar search: a field where the tabs were, the three switches
 * the find bar has, and under them every note that matches with the lines it
 * matched on. Clicking a line opens the note at that line and the list stays,
 * so a reader working through twelve notes that mention a term reads them one
 * after another without typing the term twelve times. Quick open is the other
 * thing, a way to jump; this is a way to read through.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceContentMatchV1 } from '../shared/workspace/v1/contracts';
import { PLAIN_FLAGS, type SearchFlags } from '../shared/search/pattern';
import { isComposing } from './ime';

export interface ContentResult {
  readonly matches: readonly WorkspaceContentMatchV1[];
  readonly truncated: boolean;
  readonly timedOut: boolean;
  readonly invalidPattern: boolean;
}

export interface RailSearchProps {
  readonly onSearch: (query: string, flags: SearchFlags) => Promise<ContentResult | null>;
  /** Open a note at the first line the query matches on. */
  readonly onOpenMatch: (path: string, query: string) => void;
  /** The note in front, so its row reads as the one being looked at. */
  readonly currentPath: string | null;
  /** Escape in the field, or the close button: back to the files. */
  readonly onClose: () => void;
}

/** Typing pauses this long before the vault is read; a keystroke a second is not a search each. */
const SETTLE_MS = 160;

const EMPTY: ContentResult = { matches: [], truncated: false, timedOut: false, invalidPattern: false };

export function RailSearch({ onSearch, onOpenMatch, currentPath, onClose }: RailSearchProps) {
  const [query, setQuery] = useState('');
  const [flags, setFlags] = useState<SearchFlags>(PLAIN_FLAGS);
  const [result, setResult] = useState<ContentResult>(EMPTY);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const latest = useRef(0);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) { setResult(EMPTY); setSearching(false); return; }
    const ticket = latest.current + 1;
    latest.current = ticket;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void onSearch(trimmed, flags).then((found) => {
        // A reply to an older query is thrown away: results have to belong
        // to what is in the field, not to what was in it a moment ago.
        if (latest.current !== ticket) return;
        setResult(found ?? EMPTY);
        setSearching(false);
      });
    }, SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [query, flags, onSearch]);

  const toggle = useCallback((key: keyof SearchFlags) => {
    setFlags((current) => ({ ...current, [key]: !current[key] }));
  }, []);

  const trimmed = query.trim();
  const status = trimmed.length === 0
    ? 'Type to search inside every note.'
    : result.invalidPattern
      ? 'That expression does not parse.'
      : searching && result.matches.length === 0
        ? 'Searching…'
        : result.matches.length === 0
          ? result.timedOut ? 'That search took too long. Try a longer query.' : 'No note contains that.'
          : null;

  return (
    <div className="rail-search-panel" data-testid="search-panel">
      <div className="rail-search-field">
        <input
          ref={inputRef}
          type="search"
          className="rail-search-input"
          data-testid="search-input"
          placeholder="Search in notes"
          aria-label="Search inside every note"
          value={query}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // A press the input method is composing with is the input method's.
            if (isComposing(event)) return;
            if (event.key === 'Escape') { event.preventDefault(); onClose(); }
            if (event.key === 'Enter' && result.matches.length > 0) {
              event.preventDefault();
              onOpenMatch(result.matches[0].path, trimmed);
            }
          }}
        />
        <div className="find-toggles">
          <button type="button" data-testid="search-case"
            className={flags.caseSensitive ? 'find-toggle find-toggle-on' : 'find-toggle'}
            aria-pressed={flags.caseSensitive} title="Match case"
            onClick={() => toggle('caseSensitive')}>Aa</button>
          <button type="button" data-testid="search-word"
            className={flags.wholeWord ? 'find-toggle find-toggle-on' : 'find-toggle'}
            aria-pressed={flags.wholeWord} title="Whole word"
            onClick={() => toggle('wholeWord')}>ab</button>
          <button type="button" data-testid="search-regex"
            className={flags.regex ? 'find-toggle find-toggle-on' : 'find-toggle'}
            aria-pressed={flags.regex} title="Regular expression"
            onClick={() => toggle('regex')}>.*</button>
        </div>
      </div>

      {status !== null
        ? <p className="rail-empty" data-testid="search-status" aria-live="polite">{status}</p>
        : (
          <div className="rail-search-results" role="list" data-testid="search-results">
            {result.matches.map((match) => {
              const folder = match.relativePath.slice(0, Math.max(0, match.relativePath.length - match.name.length - 1));
              return (
                <div
                  key={match.path}
                  role="listitem"
                  className={match.path === currentPath ? 'rail-hit is-current' : 'rail-hit'}
                  data-testid="search-hit"
                >
                  <button type="button" className="rail-hit-file" title={match.relativePath}
                    onClick={() => onOpenMatch(match.path, trimmed)}>
                    <span className="rail-hit-name">{match.name.replace(/\.md$/i, '')}</span>
                    {folder.length > 0 && <span className="rail-hit-folder">{folder}</span>}
                    <span className="rail-hit-count">{match.occurrences}</span>
                  </button>
                  {match.lines.map((line) => (
                    <button
                      type="button"
                      className="rail-hit-line"
                      key={line.lineNumber}
                      data-testid="search-line"
                      title={`Line ${line.lineNumber}`}
                      onClick={() => onOpenMatch(match.path, trimmed)}
                    >
                      <span className="rail-hit-text">
                        {line.line.slice(0, line.column)}
                        <mark className="quick-hit">{line.line.slice(line.column, line.column + line.length)}</mark>
                        {line.line.slice(line.column + line.length)}
                      </span>
                    </button>
                  ))}
                </div>
              );
            })}
            {(result.truncated || result.timedOut) && (
              <p className="rail-empty">
                {result.timedOut ? 'Stopped early: the vault is large. A longer query is faster.' : 'The first sixty notes are shown.'}
              </p>
            )}
          </div>
        )}
    </div>
  );
}

/**
 * The find and replace bar.
 *
 * Sits over the document rather than pushing it down, so the line you were
 * reading does not move the moment you press the shortcut. Replace is hidden
 * until asked for, because finding is the common case and a two row bar covers
 * more of the text than it needs to.
 */

import { useEffect, useRef, useState } from 'react';
import type { SearchOptions } from './editor/noto/search';
import { isComposing } from './ime';

export interface FindBarProps {
  readonly open: boolean;
  readonly showReplace: boolean;
  /** A query to start from, when the bar was opened by something that already
   *  knows what is being looked for. Empty means the reader will type it. */
  readonly initialQuery?: string;
  /** Reports the query as it is typed, so matches highlight while typing. */
  readonly onSearch: (options: SearchOptions) => { matches: number; active: number };
  readonly onGo: (direction: 'forward' | 'backward') => { matches: number; active: number };
  readonly onReplace: (replacement: string, scope: 'one' | 'all') => number;
  readonly onClose: () => void;
}

const NO_RESULTS = { matches: 0, active: -1 };

export function FindBar({ open, showReplace, initialQuery, onSearch, onGo, onReplace, onClose }: FindBarProps) {
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [results, setResults] = useState(NO_RESULTS);
  const inputRef = useRef<HTMLInputElement>(null);

  const options: SearchOptions = { query, caseSensitive, wholeWord, regex };

  // Re-run whenever the query or a modifier changes, so the count is never
  // stale relative to what the fields say.
  useEffect(() => {
    if (!open) return;
    setResults(query.length === 0 ? NO_RESULTS : onSearch(options));
  }, [open, query, caseSensitive, wholeWord, regex]);

  /*
   * Adopt a query the bar was opened with.
   *
   * Setting the state is all that is needed: the effect above already searches
   * whenever the query changes, so a content-search result and a typed query
   * reach the editor by exactly the same path. Calling the editor's search
   * directly instead would leave this bar showing an empty field beside
   * highlighted text, which is what it did.
   */
  useEffect(() => {
    if (open && initialQuery) setQuery(initialQuery);
  }, [open, initialQuery]);

  useEffect(() => {
    if (!open) return;
    // Select the existing query so a second press of the shortcut replaces it.
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open, showReplace]);

  if (!open) return null;

  const go = (direction: 'forward' | 'backward') => setResults(onGo(direction));

  const onKeyDown = (event: React.KeyboardEvent) => {
    // A press the input method is composing with is the input method's.
    if (isComposing(event)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      go(event.shiftKey ? 'backward' : 'forward');
    }
  };

  const status = query.length === 0
    ? ''
    : results.matches === 0
      ? 'No results'
      : `${results.active + 1} of ${results.matches}`;

  return (
    <div className="find-bar" data-testid="find-bar" role="search" onKeyDown={onKeyDown}>
      <div className="find-row">
        <input
          ref={inputRef}
          className="find-input"
          data-testid="find-input"
          type="text"
          placeholder="Find"
          aria-label="Find"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className="find-status" data-testid="find-status" aria-live="polite">{status}</span>
        <div className="find-toggles">
          <button type="button" data-testid="find-case"
            className={caseSensitive ? 'find-toggle find-toggle-on' : 'find-toggle'}
            aria-pressed={caseSensitive} title="Match case"
            onClick={() => setCaseSensitive((value) => !value)}>Aa</button>
          <button type="button" data-testid="find-word"
            className={wholeWord ? 'find-toggle find-toggle-on' : 'find-toggle'}
            aria-pressed={wholeWord} title="Whole word"
            onClick={() => setWholeWord((value) => !value)}>ab</button>
          <button type="button" data-testid="find-regex"
            className={regex ? 'find-toggle find-toggle-on' : 'find-toggle'}
            aria-pressed={regex} title="Regular expression"
            onClick={() => setRegex((value) => !value)}>.*</button>
        </div>
        <button type="button" className="find-step" data-testid="find-previous"
          title="Previous match" onClick={() => go('backward')}>Previous</button>
        <button type="button" className="find-step" data-testid="find-next"
          title="Next match" onClick={() => go('forward')}>Next</button>
        <button type="button" className="find-close" data-testid="find-close"
          title="Close" onClick={onClose}>Done</button>
      </div>

      {showReplace && (
        <div className="find-row">
          <input
            className="find-input"
            data-testid="replace-input"
            type="text"
            placeholder="Replace with"
            aria-label="Replace with"
            value={replacement}
            onChange={(event) => setReplacement(event.target.value)}
          />
          <button type="button" className="find-step" data-testid="replace-one"
            disabled={results.matches === 0}
            onClick={() => { onReplace(replacement, 'one'); setResults(onSearch(options)); }}>
            Replace
          </button>
          <button type="button" className="find-step" data-testid="replace-all"
            disabled={results.matches === 0}
            onClick={() => { onReplace(replacement, 'all'); setResults(onSearch(options)); }}>
            Replace all
          </button>
        </div>
      )}
    </div>
  );
}

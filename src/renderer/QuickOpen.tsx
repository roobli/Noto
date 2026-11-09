/**
 * Quick open.
 *
 * One surface doing the job of two plugins from the author's Typora set:
 * `fuzzy-search` finds a note and opens it, `note-assistant` finds a note and
 * links to it. They are the same search with different endings, so they are one
 * palette here and the ending is a modifier: Enter opens, Alt+Enter inserts a
 * `[[wiki link]]` at the caret. Two palettes with two shortcuts and two result
 * lists would be two things to learn for one question, which is "which note".
 *
 * Ranking happens here rather than in main. Main sends the index once per
 * folder; every keystroke after that is arithmetic over an array already in
 * this process, so typing never waits on a round trip.
 *
 * An empty query is not an empty list. It shows what frecency says you are
 * most likely to want, which is what lets this stand in for navigating the tree
 * rather than being a thing you resort to when the tree fails.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  WorkspaceContentMatchV1, WorkspaceIndexEntryV1,
} from '../shared/workspace/v1/contracts';
import {
  contentDebounceMs, isPathQuery, matchPositions, rankCandidates, type ScoreKeys,
} from '../shared/search/v1/fuzzy';
import { searchBoost, type FrecencyStoreV1 } from '../shared/search/v1/frecency';
import { pathContext } from './quick-open-path';
import { foldersOf, withinScope } from './quick-open-folders';
import { completeQuery, parseQuery, removeToken, type Completion } from './quick-open-query';
import { isComposing } from './ime';
import { QuickPreview, type PreviewTarget, type PreviewValue } from './QuickPreview';
import { readableHit } from './quick-preview';
import { quickActions, type QuickAction } from './quick-open-make';

/**
 * How many results are drawn: enough to fill the panel on a tall window, so it
 * is as tall as the window allows rather than a strip of twelve rows high on
 * the page. Beyond this nobody is reading, they are retyping.
 */
const LIMIT = 30;

interface Candidate extends ScoreKeys {
  readonly entry: WorkspaceIndexEntryV1;
}

/**
 * The three things quick open searches, in the order its tabs are cycled.
 *
 * The author's own has exactly these: files by name, folders, and the text
 * inside notes. Folders are here because a vault of seven thousand notes is
 * searched a corner at a time, and choosing one narrows the other two.
 */
export const QUICK_TABS = ['files', 'folders', 'content'] as const;

export type QuickOpenMode = (typeof QUICK_TABS)[number];

export const QUICK_TAB_LABELS: Record<QuickOpenMode, string> = {
  files: 'Files',
  folders: 'Folders',
  content: 'In notes',
};

/** How wide the palette is drawn, which the reader sets with the bracket keys. */
export type QuickWidth = 'default' | 'wide';

export interface QuickOpenProps {
  readonly open: boolean;
  /** Chords switched off in the Shortcuts pane; its width keys are two of them. */
  readonly disabledShortcuts?: readonly string[];
  readonly mode: QuickOpenMode;
  readonly onMode: (mode: QuickOpenMode) => void;
  /** Runs a content search. Replies for superseded queries are dropped by the
   *  caller, so this only ever has to answer the last one asked. */
  readonly onSearchContent: (query: string, scope: string) => Promise<{
    matches: readonly WorkspaceContentMatchV1[];
    truncated: boolean;
    timedOut: boolean;
  } | null>;
  /** Opens a note and puts the query's first match on screen. */
  readonly onOpenMatch: (path: string, query: string) => void;
  readonly entries: readonly WorkspaceIndexEntryV1[];
  readonly frecency: FrecencyStoreV1;
  readonly truncated: boolean;
  /** Null when no document is open, which is when linking makes no sense. */
  readonly canInsertLink: boolean;
  /**
   * Opened by typing `[[`, so choosing a note writes a link rather than
   * opening it, and the footer says so.
   */
  readonly linking?: boolean;
  readonly onOpenFile: (path: string) => void;
  readonly onInsertLink: (entry: WorkspaceIndexEntryV1) => void;
  readonly onClose: () => void;
  /** How wide it is drawn, and how to remember a change. */
  readonly width: QuickWidth;
  readonly onWidth: (width: QuickWidth) => void;
  /**
   * Reads the note in front of the list for the preview beside it: its
   * opening, or the lines around `line`. Without it there is no preview.
   */
  readonly onPreview?: (path: string, line: number | null) => Promise<PreviewValue | null>;
  /**
   * Makes the note or folder an action row offers, in `scope`, relative to
   * the open folder. Resolves with its path once it is made, or with what to
   * say when it was not. Without it nothing is offered to make.
   */
  readonly onMake?: (action: Exclude<QuickAction, { kind: 'open-path' }>, scope: string) =>
    Promise<{ readonly made: string } | { readonly refused: string }>;
  /** The open folder's name, for "in …" on a row that makes something at its top. */
  readonly folderName?: string;
}

/** The mark at the head of an action row: what it makes, or that it opens from elsewhere. */
function ActionGlyph({ kind }: { kind: QuickAction['kind'] }) {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      {kind === 'new-folder' ? (
        <>
          <path d="M1.75 4.25a1 1 0 0 1 1-1h3.1l1.5 1.5h5.9a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z" />
          <path d="M8 7.25v3.5M6.25 9h3.5" />
        </>
      ) : kind === 'new-note' ? (
        <>
          <path d="M3.75 1.75h5.5l3 3v9.5h-8.5z" />
          <path d="M8 7.5v4M6 9.5h4" />
        </>
      ) : (
        <>
          <path d="M3.75 1.75h5.5l3 3v9.5h-8.5z" />
          <path d="M6.5 10.5l3.5-3.5M7.25 7h2.75v2.75" />
        </>
      )}
    </svg>
  );
}

const ACTION_VERBS: Record<QuickAction['kind'], string> = {
  'open-path': 'Open file',
  'new-note': 'New note',
  'new-folder': 'New folder',
};

/** What the preview says beside an action row, since there is nothing yet to show. */
const ACTION_HINTS: Record<QuickAction['kind'], string> = {
  'open-path': 'Opened from where it is. A note outside the open folder is not listed in the tree.',
  'new-note': 'Made empty and opened, ready to write.',
  'new-folder': 'Made, and Quick Open moves into it to name its first note.',
};

/** Previews kept while the palette is open, so a note walked back to shows at once. */
const PREVIEWS_KEPT = 60;
/** A pause before reading, so holding an arrow key down reads only where it stops. */
const PREVIEW_DELAY_MS = 60;
/** How long a note's preview is shown from memory before it is read again. */
const PREVIEW_FRESH_MS = 3000;

/** The name with the matched characters marked, so a fuzzy hit shows its work. */
function Highlighted({ text, query }: { text: string; query: string }) {
  const positions = useMemo(() => new Set(matchPositions(text, query) ?? []), [text, query]);
  if (positions.size === 0) return <>{text}</>;
  return (
    <>
      {[...text].map((character, index) => (
        positions.has(index)
          // eslint-disable-next-line react/no-array-index-key -- position is the identity here
          ? <mark key={index} className="quick-hit">{character}</mark>
          // eslint-disable-next-line react/no-array-index-key
          : <span key={index}>{character}</span>
      ))}
    </>
  );
}

export function QuickOpen({
  open, disabledShortcuts = [], mode, onMode, onSearchContent, onOpenMatch,
  entries, frecency, truncated, canInsertLink, linking = false, onOpenFile, onInsertLink, onClose,
  width, onWidth, onPreview, onMake, folderName = '',
}: QuickOpenProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  /** Why the last thing asked to be made was not, until the box changes. */
  const [notice, setNotice] = useState<string | null>(null);
  const making = useRef(false);
  /** The folder the other two tabs are narrowed to, or the whole vault. */
  const [scope, setScope] = useState('');
  /** Where the caret is in the box, which is what the completion is for. */
  const [caret, setCaret] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelected(0);
    setScope('');
    queueMicrotask(() => inputRef.current?.focus({ preventScroll: true }));
  }, [open]);

  /*
   * The box is a small language: `type:` says what to search and `scope:`
   * says where, and what is left is what to look for. The tab is the default
   * and the token is the statement, so a query that says `type:content`
   * searches contents whichever tab is showing.
   */
  const parsed = useMemo(() => parseQuery(query), [query]);
  const effectiveMode: QuickOpenMode = parsed.type === null
    ? mode
    : parsed.type === 'file' ? 'files' : parsed.type === 'folder' ? 'folders' : 'content';
  const effectiveScope = parsed.scope ?? scope;
  const terms = parsed.terms;

  const [content, setContent] = useState<{
    matches: readonly WorkspaceContentMatchV1[]; truncated: boolean; timedOut: boolean;
  }>({ matches: [], truncated: false, timedOut: false });
  const [searching, setSearching] = useState(false);

  /*
   * The scan is debounced and superseded.
   *
   * A reply for a query the reader has already typed past is worse than no
   * reply: it replaces what they are looking at with an answer to a question
   * they have moved on from. The effect's own cleanup marks the request stale,
   * so only the last one asked is ever shown.
   */
  useEffect(() => {
    if (!open || effectiveMode !== 'content') return;
    const trimmed = terms.trim();
    if (trimmed.length === 0) {
      setContent({ matches: [], truncated: false, timedOut: false });
      setSearching(false);
      return;
    }
    let current = true;
    setSearching(true);
    const timer = setTimeout(() => {
      void onSearchContent(trimmed, effectiveScope).then((reply) => {
        if (!current) return;
        setSearching(false);
        if (reply) setContent(reply);
      });
    }, contentDebounceMs(trimmed));
    return () => { current = false; clearTimeout(timer); };
  }, [open, effectiveMode, terms, effectiveScope, onSearchContent]);

  useEffect(() => { setSelected(0); }, [effectiveMode]);

  const candidates = useMemo<Candidate[]>(() => withinScope(entries, effectiveScope).map((entry) => ({
    entry,
    nameKey: entry.name.toLowerCase(),
    pathKey: entry.relativePath.toLowerCase(),
  })), [entries, effectiveScope]);

  /** The folders tab's own rows, ranked by the same fuzzy match. */
  const folders = useMemo(() => foldersOf(entries), [entries]);
  const folderResults = useMemo(() => {
    const within = folders.filter((folder) => folder.relativePath !== effectiveScope
      && (effectiveScope.length === 0 || folder.relativePath.startsWith(`${effectiveScope}/`)));
    const trimmed = terms.trim();
    if (trimmed.length === 0) return within.slice(0, LIMIT);
    return rankCandidates(
      within.map((folder) => ({
        folder,
        nameKey: folder.name.toLowerCase(),
        pathKey: folder.relativePath.toLowerCase(),
      })),
      trimmed,
      () => ({ pathQuery: isPathQuery(trimmed), frecencyBoost: 0 }),
      LIMIT,
    ).map((scored) => scored.folder);
  }, [folders, terms, effectiveScope]);

  const results = useMemo(() => {
    const now = Date.now();
    const trimmed = terms.trim();
    if (trimmed.length === 0) {
      // No query, so nothing is being matched: order by history alone and take
      // the same number the ranked list would have shown.
      const recent = [...candidates]
        .map((candidate) => ({
          candidate,
          score: searchBoost(frecency, candidate.entry.path, now),
        }))
        .filter((scored) => scored.score > 0)
        .sort((a, b) => b.score - a.score
          || a.candidate.pathKey.localeCompare(b.candidate.pathKey))
        .map((scored) => scored.candidate);
      if (effectiveScope.length === 0) return recent.slice(0, LIMIT);
      // Inside a folder the folder is what was asked for: its notes, the ones
      // opened lately first and then the rest, nearest the folder first. The
      // history alone left a folder nobody had opened a note from looking
      // empty while its placeholder counted the notes in it.
      const seen = new Set(recent.map((candidate) => candidate.entry.path));
      const depth = (candidate: Candidate) => candidate.pathKey.split('/').length;
      const rest = candidates
        .filter((candidate) => !seen.has(candidate.entry.path))
        .sort((a, b) => depth(a) - depth(b) || a.pathKey.localeCompare(b.pathKey));
      return [...recent, ...rest].slice(0, LIMIT);
    }
    const pathQuery = isPathQuery(trimmed);
    return rankCandidates(
      candidates,
      trimmed,
      (candidate) => ({
        pathQuery,
        frecencyBoost: searchBoost(frecency, candidate.entry.path, now),
      }),
      LIMIT,
    );
  }, [candidates, frecency, terms, effectiveScope]);

  useEffect(() => { setSelected(0); setNotice(null); }, [query]);

  /*
   * What can be done with what was typed besides opening a match: open a
   * note by its path from anywhere on the disk, or make the note or folder
   * it names here. Drawn after the matches, so Enter on a query that matched
   * still opens the match, and the only rows when nothing did.
   */
  const actions = useMemo<QuickAction[]>(() => (effectiveMode === 'content' || linking
    ? []
    : quickActions({
      terms,
      mode: effectiveMode,
      scope: effectiveScope,
      notes: candidates.map((candidate) => candidate.entry),
      folders,
      canMake: onMake !== undefined,
    })), [effectiveMode, linking, terms, effectiveScope, candidates, folders, onMake]);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [selected, results]);

  const choose = useCallback((candidate: Candidate | undefined, asLink: boolean) => {
    if (!candidate) return;
    if ((asLink || linking) && canInsertLink) onInsertLink(candidate.entry);
    else onOpenFile(candidate.entry.path);
    onClose();
  }, [canInsertLink, linking, onClose, onInsertLink, onOpenFile]);

  const chooseMatch = useCallback((match: WorkspaceContentMatchV1 | undefined) => {
    if (!match) return;
    onOpenMatch(match.path, terms.trim());
    onClose();
  }, [onClose, onOpenMatch, terms]);

  const baseCount = effectiveMode === 'content'
    ? content.matches.length
    : effectiveMode === 'folders' ? folderResults.length : results.length;
  const rowCount = baseCount + actions.length;

  /*
   * What the token under the caret could become.
   *
   * Offered rather than applied: a box that rewrites what is being typed is
   * a box people stop trusting. Tab takes the first one, and does its usual
   * job of moving along the tabs when there is nothing to take.
   */
  const completions = useMemo(
    () => completeQuery(query, caret, folders),
    [query, caret, folders],
  );

  const takeCompletion = useCallback((completion: Completion | undefined) => {
    if (!completion) return false;
    setQuery(completion.insert);
    queueMicrotask(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(completion.cursor, completion.cursor);
      setCaret(completion.cursor);
    });
    return true;
  }, []);

  /** Narrow to a folder and go back to looking for notes inside it. */
  const enterFolder = useCallback((folder: { relativePath: string } | undefined) => {
    if (!folder) return;
    setScope(folder.relativePath);
    setQuery('');
    setSelected(0);
    onMode('files');
    inputRef.current?.focus();
  }, [onMode]);

  const runAction = useCallback(async (action: QuickAction | undefined) => {
    if (!action || making.current) return;
    if (action.kind === 'open-path') {
      onOpenFile(action.path);
      onClose();
      return;
    }
    if (!onMake) return;
    making.current = true;
    const outcome = await onMake(action, effectiveScope).finally(() => { making.current = false; });
    if ('refused' in outcome) { setNotice(outcome.refused); return; }
    // A note made is opened as a note found is. A folder made is where the
    // next note goes, so the palette moves into it and waits for that name.
    if (action.kind === 'new-note') {
      onOpenFile(outcome.made);
      onClose();
      return;
    }
    enterFolder({ relativePath: effectiveScope.length > 0 ? `${effectiveScope}/${action.name}` : action.name });
  }, [effectiveScope, enterFolder, onClose, onMake, onOpenFile]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    // A press the input method is composing with is the input method's: Enter
    // there commits the letters typed, and must not open the first result.
    if (isComposing(event)) return;
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
    // Tab switches what is being searched without leaving the box, which is
    // where the thought "it is in a note, I just cannot remember which" turns
    // into "search inside them then".
    if (event.key === 'Tab') {
      event.preventDefault();
      // Finishing what is being typed comes first; the tabs are what Tab
      // does when there is nothing to finish.
      if (takeCompletion(completions.candidates[0])) return;
      const step = event.shiftKey ? -1 : 1;
      const at = QUICK_TABS.indexOf(effectiveMode);
      // A written `type:` outranks the tab, so cycling takes it out rather
      // than leaving the box saying one thing and the tabs another.
      setQuery((current) => removeToken(current, 'type'));
      onMode(QUICK_TABS[(at + step + QUICK_TABS.length) % QUICK_TABS.length]);
      return;
    }
    // The width, on the same keys the author's own palette uses, and the same
    // keys the document's own column uses one level out.
    if ((event.metaKey || event.ctrlKey) && (event.key === '[' || event.key === ']')
      && !disabledShortcuts.includes(event.key === ']' ? 'Mod+]' : 'Mod+[')) {
      event.preventDefault();
      onWidth(event.key === ']' ? 'wide' : 'default');
      return;
    }
    // Backspace on an empty box steps back out of the folder, which is the
    // way out of a scope that does not need a control of its own.
    if ((event.key === 'Backspace' || event.key === 'ArrowLeft') && query.length === 0 && scope.length > 0) {
      event.preventDefault();
      setScope((current) => current.split('/').slice(0, -1).join('/'));
      return;
    }
    if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'n')) {
      event.preventDefault();
      setSelected((current) => (rowCount === 0 ? 0 : (current + 1) % rowCount));
      return;
    }
    if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'p')) {
      event.preventDefault();
      setSelected((current) => (rowCount === 0 ? 0 : (current - 1 + rowCount) % rowCount));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      // A half-written operator is finished rather than searched for.
      if (/^(?:type|scope):/i.test(query.slice(0, caret).split(/\s/).at(-1) ?? '')
        && takeCompletion(completions.candidates[0])) return;
      // Shift makes the note that was typed whatever matched it, as Obsidian's switcher does.
      if (event.shiftKey && effectiveMode === 'files') { void runAction(actions.find((action) => action.kind === 'new-note')); return; }
      if (selected >= baseCount) { void runAction(actions[selected - baseCount]); return; }
      if (effectiveMode === 'content') chooseMatch(content.matches[selected]);
      else if (effectiveMode === 'folders') enterFolder(folderResults[selected]);
      else choose(results[selected], event.altKey);
    }
  };

  // The note in front of the list, for the preview: the selected file, or the selected match at its line.
  const previewTarget: PreviewTarget | null = effectiveMode === 'files'
    ? (results[selected] ? { ...results[selected]!.entry, line: null } : null)
    : effectiveMode === 'content' && content.matches[selected]
      ? { path: content.matches[selected]!.path, name: content.matches[selected]!.name, relativePath: content.matches[selected]!.relativePath, line: content.matches[selected]!.lines[0]?.lineNumber ?? null }
      : null;
  const previewKey = previewTarget ? `${previewTarget.path}\n${previewTarget.line ?? ''}` : '';
  const previews = useRef(new Map<string, { readonly value: PreviewValue; readonly at: number }>());
  const [preview, setPreview] = useState<{ key: string; value: PreviewValue | null } | null>(null);
  useEffect(() => {
    if (!open) { previews.current.clear(); return undefined; }
    if (!onPreview || !previewTarget) return undefined;
    // A note walked back to shows what was read of it at once; read more than
    // a few seconds ago, it is read again behind that, so a note changed while
    // the palette is open shows its new text. A read that failed is not kept.
    const kept = previews.current.get(previewKey);
    if (kept) setPreview({ key: previewKey, value: kept.value });
    if (kept && Date.now() - kept.at < PREVIEW_FRESH_MS) return undefined;
    let live = true;
    const timer = setTimeout(() => {
      void onPreview(previewTarget.path, previewTarget.line).then((value) => value, () => null).then((value) => {
        previews.current.delete(previewKey);
        if (value !== null) {
          if (previews.current.size >= PREVIEWS_KEPT) previews.current.delete(previews.current.keys().next().value!);
          previews.current.set(previewKey, { value, at: Date.now() });
        }
        if (live) setPreview({ key: previewKey, value });
      });
    }, PREVIEW_DELAY_MS);
    return () => { live = false; clearTimeout(timer); };
    // The key says everything about the target that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, previewKey, onPreview]);

  if (!open) return null;

  // The new note's name and folder show at once; its text follows a read later, from the cache when walked back to.
  const previewValue = preview?.key === previewKey ? preview.value : undefined;
  const previewShown = onPreview !== undefined;

  /** Where a row that makes something puts it: the folder narrowed to, or the open one. */
  const makingIn = effectiveScope.length > 0 ? effectiveScope : folderName;
  const selectedAction = selected >= baseCount ? actions[selected - baseCount] : undefined;
  const selectedMakes = selectedAction !== undefined && selectedAction.kind !== 'open-path';
  const actionRows = actions.length === 0 ? null : (
    <div className="quick-actions" role="group" aria-label="Open or make">
      {actions.map((action, at) => {
        const index = baseCount + at;
        return (
          <button
            key={action.kind}
            id={`quick-result-${index}`}
            type="button"
            role="option"
            aria-selected={index === selected}
            className={index === selected ? 'quick-result quick-action is-selected' : 'quick-result quick-action'}
            data-testid="quick-action"
            data-kind={action.kind}
            onMouseMove={() => setSelected(index)}
            onClick={() => void runAction(action)}
          >
            <span className="quick-action-glyph" aria-hidden="true"><ActionGlyph kind={action.kind} /></span>
            <span className="quick-name">
              {ACTION_VERBS[action.kind]}
              {action.kind !== 'open-path' && (
                <span className="quick-action-name">{action.kind === 'new-note' ? action.file : action.name}</span>
              )}
            </span>
            <span className="quick-path">{action.kind === 'open-path' ? action.path : makingIn ? `in ${makingIn}` : 'in the open folder'}</span>
          </button>
        );
      })}
    </div>
  );
  const noticeRow = notice === null ? null : <p className="quick-notice" role="status" data-testid="quick-notice">{notice}</p>;

  return (
    <div className="quick-scrim" data-testid="quick-open-scrim" onClick={onClose}>
      <section
        className={previewShown ? 'quick-open has-preview' : 'quick-open'}
        data-width={width}
        role="dialog"
        aria-modal="true"
        aria-label="Quick open"
        data-testid="quick-open"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="quick-input-row">
        {/* The three tabs, as the author's own palette has them: what is being
            searched is a thing you point at, not a mode you have to remember
            you are in. Tab cycles them from the box, so the hand never leaves
            it, and the tabs themselves never take the focus. */}
        <div className="quick-tabs" role="tablist" aria-label="What to search">
          {QUICK_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              tabIndex={-1}
              aria-selected={tab === effectiveMode}
              className={tab === effectiveMode ? 'quick-tab is-current' : 'quick-tab'}
              data-testid={`quick-tab-${tab}`}
              title="Tab"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => { setQuery((current) => removeToken(current, 'type')); onMode(tab); }}
            >
              {QUICK_TAB_LABELS[tab]}
            </button>
          ))}
        </div>
        {effectiveScope.length > 0 && (
          <button
            type="button"
            className="quick-scope"
            data-testid="quick-scope"
            title="Backspace on an empty box steps back out"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              // Whichever put the scope there is what is taken away: the
              // written token, or the folder that was chosen.
              if (parsed.scope !== null) setQuery((current) => removeToken(current, 'scope'));
              else setScope((current) => current.split('/').slice(0, -1).join('/'));
              inputRef.current?.focus();
            }}
          >
            {effectiveScope}
          </button>
        )}
        <input
          ref={inputRef}
          type="text"
          className="quick-input"
          data-testid="quick-input"
          spellCheck={false}
          placeholder={entries.length === 0 && !onMake
            ? 'Open a folder to search it'
            : effectiveMode === 'files' && !linking && onMake && candidates.length === 0
              ? 'Name a note to make it here, or paste a path to open one'
            : linking
              ? `Link to one of ${candidates.length} notes`
              : effectiveMode === 'content'
                ? `Search inside ${candidates.length} notes`
                : effectiveMode === 'folders'
                  ? `Search ${folders.length} folders`
                  : `Search ${candidates.length} notes`}
          aria-label="Search notes"
          role="combobox"
          aria-expanded
          aria-controls="quick-open-results"
          aria-activedescendant={selected < rowCount ? `quick-result-${selected}` : undefined}
          value={query}
          onChange={(event) => { setQuery(event.target.value); setCaret(event.target.selectionStart ?? event.target.value.length); }}
          onSelect={(event) => setCaret((event.target as HTMLInputElement).selectionStart ?? 0)}
          onKeyDown={onKeyDown}
        />
        </div>

        {completions.candidates.length > 0 && (
          <div className="quick-complete" data-testid="quick-complete">
            {completions.candidates.map((completion, index) => (
              <button
                key={completion.label}
                type="button"
                className={index === 0 ? 'quick-complete-row is-first' : 'quick-complete-row'}
                data-testid="quick-complete-row"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => takeCompletion(completion)}
              >
                <span className="quick-complete-label">{completion.label}</span>
                {completion.hint !== undefined && <span className="quick-complete-hint">{completion.hint}</span>}
              </button>
            ))}
          </div>
        )}

        <div className="quick-body">
        <div className="quick-results" id="quick-open-results" role="listbox" ref={listRef}>
          {effectiveMode === 'folders' ? (<>
            {noticeRow}
            {folderResults.length === 0 && actionRows === null
              ? (
                <p className="quick-empty">
                  {folders.length === 0
                    ? 'Every note in this folder is at its top level.'
                    : 'No folder matches that.'}
                </p>
              )
              : folderResults.map((folder, index) => (
                <button
                  key={folder.relativePath}
                  id={`quick-result-${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === selected}
                  className={index === selected ? 'quick-result is-selected' : 'quick-result'}
                  data-testid="quick-folder"
                  title={folder.relativePath}
                  onMouseMove={() => setSelected(index)}
                  onClick={() => enterFolder(folder)}
                >
                  <span className="quick-name">
                    <Highlighted text={folder.name} query={terms.trim()} />
                    <span className="quick-count">{folder.notes}</span>
                  </span>
                  <span className="quick-path">
                    <Highlighted text={folder.relativePath} query={terms.trim()} />
                  </span>
                </button>
              ))}
            {actionRows}
          </>) : effectiveMode === 'content' ? (
            content.matches.length === 0
              ? (
                <p className="quick-empty">
                  {terms.trim().length === 0
                    ? 'Type to search inside every note in this folder.'
                    : searching
                      ? 'Searching…'
                      : content.timedOut
                        ? 'That search took too long. Try a longer query.'
                        : 'No note contains that.'}
                </p>
              )
              : content.matches.map((match, index) => (
                <button
                  key={match.path}
                  id={`quick-result-${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === selected}
                  className={index === selected ? 'quick-result is-selected' : 'quick-result'}
                  data-testid="quick-match"
                  title={match.relativePath}
                  onMouseMove={() => setSelected(index)}
                  onClick={() => chooseMatch(match)}
                >
                  <span className="quick-name">
                    {match.name}
                    <span className="quick-count">{match.occurrences}</span>
                  </span>
                  {match.lines.map((line) => {
                    // Read as the page reads it: escaped paths in their own letters, links by their words, a table by its cells.
                    const shown = readableHit(line.line, line.column, line.length);
                    return (
                      <span className="quick-line" key={line.lineNumber}>
                        <span className="quick-line-number">{line.lineNumber}</span>
                        <span className="quick-line-text">
                          {shown.at < 0 ? shown.text : (
                            <>
                              {shown.text.slice(0, shown.at)}
                              <mark className="quick-hit">{shown.text.slice(shown.at, shown.at + shown.length)}</mark>
                              {shown.text.slice(shown.at + shown.length)}
                            </>
                          )}
                        </span>
                      </span>
                    );
                  })}
                  <span className="quick-path">{pathContext(match.relativePath)}</span>
                </button>
              ))
          ) : (<>
            {noticeRow}
            {results.length === 0 && actionRows === null
            ? (
              <p className="quick-empty">
                {entries.length === 0 && !onMake
                  ? 'No folder is open, so there is nothing to search yet.'
                  : terms.trim().length === 0
                    ? effectiveScope.length > 0 || entries.length === 0
                      ? onMake ? 'No notes here yet. Type a name to make the first one.' : 'No notes in this folder.'
                      : 'Nothing opened yet. Type to search.'
                    : 'No note matches that.'}
              </p>
            )
            : results.map((candidate, index) => (
              <button
                key={candidate.entry.path}
                id={`quick-result-${index}`}
                type="button"
                role="option"
                aria-selected={index === selected}
                className={index === selected ? 'quick-result is-selected' : 'quick-result'}
                data-testid="quick-result"
                title={candidate.entry.relativePath}
                // Selecting on hover rather than on click, so the keyboard and
                // the pointer never disagree about which row is next.
                onMouseMove={() => setSelected(index)}
                onClick={(event) => choose(candidate, event.altKey)}
              >
                <span className="quick-name">
                  <Highlighted text={candidate.entry.name} query={terms.trim()} />
                </span>
                <span className="quick-path">
                  <Highlighted text={pathContext(candidate.entry.relativePath)} query={terms.trim()} />
                </span>
              </button>
            ))}
            {actionRows}
          </>)}
        </div>

        {previewShown && (previewTarget
          ? <QuickPreview target={previewTarget} value={previewValue} query={effectiveMode === 'content' ? terms : ''} />
          : (
            <aside className="quick-preview is-blank" data-testid="quick-preview">
              <p className="quick-preview-empty">
                {selected >= baseCount && actions[selected - baseCount]
                  ? ACTION_HINTS[actions[selected - baseCount]!.kind]
                  : effectiveMode === 'folders' ? 'Enter searches inside the folder.' : 'The note you land on is shown here.'}
              </p>
            </aside>
          ))}
        </div>

        <footer className="quick-hints">
          {/* While the brackets are waiting to be filled, Enter puts the link
              in; saying it opens the note as well would be two answers to
              one key, and only one of them true. */}
          {/* Enter's word is the selected row's: a row that makes something is not one that opens. */}
          {selectedMakes
            ? <span><kbd>↩</kbd> make it</span>
            : <>
              {!linking && effectiveMode !== 'folders' && <span><kbd>↩</kbd> open</span>}
              {effectiveMode === 'files' && canInsertLink && !linking && selected < baseCount && <span><kbd>⌥↩</kbd> insert link</span>}
              {effectiveMode === 'folders' && <span><kbd>↩</kbd> search inside it</span>}
            </>}
          {actions.some((action) => action.kind === 'new-note') && <span data-testid="quick-hint-new"><kbd>⇧↩</kbd> new note</span>}
          {linking && <span data-testid="quick-linking"><kbd>↩</kbd> insert the link</span>}
          {!linking && completions.candidates.length === 0 && (
            <span><kbd>tab</kbd> {QUICK_TAB_LABELS[QUICK_TABS[(QUICK_TABS.indexOf(effectiveMode) + 1) % QUICK_TABS.length]].toLowerCase()}</span>
          )}
          {completions.candidates.length > 0 && <span><kbd>tab</kbd> finish this</span>}
          {scope.length > 0 && <span><kbd>⌫</kbd> leave the folder</span>}
          <span><kbd>{'⌘[ ⌘]'}</kbd> width</span>
          <span><kbd>esc</kbd> close</span>
          {effectiveMode === 'content' && content.truncated && (
            <span className="quick-truncated">Showing the first {content.matches.length}.</span>
          )}
          {effectiveMode === 'files' && truncated && (
            <span className="quick-truncated">
              Index is partial: this folder is larger than the ceiling.
            </span>
          )}
        </footer>
      </section>
    </div>
  );
}

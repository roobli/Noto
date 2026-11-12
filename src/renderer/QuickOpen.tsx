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

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  WorkspaceContentMatchV1, WorkspaceIndexEntryV1,
} from '../shared/workspace/v1/contracts';
import {
  contentDebounceMs, isPathQuery, matchPositions, rankCandidates, type ScoreKeys,
} from '../shared/search/v1/fuzzy';
import { searchBoost, type FrecencyStoreV1 } from '../shared/search/v1/frecency';
import { pathTail } from './quick-open-path';
import { foldersOf, withinScope } from './quick-open-folders';
import { completeQuery, parseQuery, removeToken, type Completion } from './quick-open-query';
import { isComposing } from './ime';
import { changedWords, folderWords, QuickPreview, type PreviewTarget, type PreviewValue } from './QuickPreview';
import { readableHit } from './quick-preview';
import { quickActions, type QuickAction } from './quick-open-make';
import { SheetWidthHint, stepSheetWidth, type SheetWidthControl } from './sheet-width';
import { QUICK_SPLIT_MAX, QUICK_SPLIT_MIN, type QuickOpenPreviewV1 } from '../shared/settings/v1/contracts';

/**
 * How many results are drawn: enough to fill the panel on a tall window, so it
 * is as tall as the window allows rather than a strip of twelve rows high on
 * the page. Beyond this nobody is reading, they are retyping.
 */
const LIMIT = 30;
/** Opened notes enough to fill the list with nothing typed; fewer, and the notes changed lately follow. */
const RECENT_FLOOR = 12;
/** The gutter between the list and the preview, which is the divider. */
const GUTTER = 28;

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
  files: 'Names',
  folders: 'Folders',
  content: 'Text',
};

/** The preview keeps this much width, and the list this much, whatever the divider and the width step. */
const PREVIEW_FLOOR = 320;
const LIST_FLOOR = 300;
/** Where the divider settles when it is dragged close: half, and the two the author used to choose from. */
const SPLIT_SNAPS = [50, 56, 62];

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
  /** How wide it is drawn, the step all the sheets share, and how to change it. */
  readonly sheet?: SheetWidthControl;
  /** The list's share of the body, in percent, and how to keep a new one. */
  readonly split?: number;
  readonly onSplit?: (split: number) => void;
  /** Rendered or source, and how to keep a change. */
  readonly previewView?: QuickOpenPreviewV1;
  readonly onPreviewView?: (view: QuickOpenPreviewV1) => void;
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

const stripExtension = (name: string) => name.replace(/\.(md|markdown|mdown|mkd|txt)$/i, '');

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
  sheet, onPreview, onMake, folderName = '',
  split = 50, onSplit, previewView = 'rendered', onPreviewView,
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
  const bodyRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  /** The divider while it is dragged, which is drawn but not kept until the press lets go. */
  const [liveSplit, setLiveSplit] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  /** Where the pointer last was, so only a real move of it chooses a row, not a list scrolled under it. */
  const pointer = useRef({ x: -1, y: -1 });

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
      if (effectiveScope.length === 0) {
        if (recent.length >= RECENT_FLOOR) return recent.slice(0, LIMIT);
        // Too little history to fill a screen: the notes changed most lately follow.
        const seen = new Set(recent.map((candidate) => candidate.entry.path));
        const changed = candidates
          .filter((candidate) => !seen.has(candidate.entry.path) && typeof candidate.entry.modified === 'number')
          .sort((a, b) => (b.entry.modified ?? 0) - (a.entry.modified ?? 0));
        return [...recent, ...changed].slice(0, LIMIT);
      }
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

  /*
   * The row under the pointer is the selected row, as the keys' row is: one
   * answer to which note Enter opens and the preview shows. Only a real move
   * of the pointer counts, so a list scrolled under a resting pointer while
   * the arrows walk it does not snatch the selection back.
   */
  const hoverRow = useCallback((index: number) => (event: React.MouseEvent) => {
    const moved = Math.abs(event.clientX - pointer.current.x) + Math.abs(event.clientY - pointer.current.y) > 1;
    pointer.current = { x: event.clientX, y: event.clientY };
    if (moved) setSelected(index);
  }, []);

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

  const cycleMode = useCallback((step: 1 | -1) => {
    const at = QUICK_TABS.indexOf(effectiveMode);
    // A written `type:` outranks the tab, so cycling takes it out rather
    // than leaving the box saying one thing and the tabs another.
    setQuery((current) => removeToken(current, 'type'));
    onMode(QUICK_TABS[(at + step + QUICK_TABS.length) % QUICK_TABS.length]);
  }, [effectiveMode, onMode]);

  /*
   * The divider's travel at this width: QUICK_SPLIT_MIN..MAX, narrowed so
   * the preview keeps PREVIEW_FLOOR and the list LIST_FLOOR. At the
   * narrowest width step the two floors meet and it stays where it is.
   */
  const splitRange = useCallback((): readonly [number, number] => {
    const body = bodyRef.current;
    if (!body) return [QUICK_SPLIT_MIN, QUICK_SPLIT_MAX];
    const usable = body.getBoundingClientRect().width - GUTTER;
    if (usable <= 0) return [QUICK_SPLIT_MIN, QUICK_SPLIT_MAX];
    const low = Math.max(QUICK_SPLIT_MIN, Math.ceil((LIST_FLOOR / usable) * 100));
    const high = Math.min(QUICK_SPLIT_MAX, Math.floor(((usable - PREVIEW_FLOOR) / usable) * 100));
    return high >= low ? [low, high] : [50, 50];
  }, []);
  const clampSplit = useCallback((value: number, snap: boolean): number => {
    const [low, high] = splitRange();
    let next = Math.max(low, Math.min(high, Math.round(value)));
    if (snap) for (const at of SPLIT_SNAPS) if (at >= low && at <= high && Math.abs(next - at) <= 1) next = at;
    return next;
  }, [splitRange]);
  // The divider stays inside its travel when the width step changes under it.
  useEffect(() => {
    if (!open || !onSplit) return;
    const fitted = clampSplit(split, false);
    if (fitted !== split) onSplit(fitted);
  }, [open, sheet?.width, split, clampSplit, onSplit]);
  const moveSplit = useCallback((by: number) => {
    const next = clampSplit(split + by, false);
    if (next !== split) onSplit?.(next);
  }, [clampSplit, onSplit, split]);

  const onDividerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !bodyRef.current) return;
    event.preventDefault();
    const divider = event.currentTarget;
    divider.setPointerCapture(event.pointerId);
    setDragging(true);
    const box = bodyRef.current.getBoundingClientRect();
    const at = (clientX: number) => clampSplit(((clientX - box.left - GUTTER / 2) / (box.width - GUTTER)) * 100, true);
    let last = split;
    const move = (moveEvent: PointerEvent) => { last = at(moveEvent.clientX); setLiveSplit(last); };
    const end = () => {
      divider.removeEventListener('pointermove', move);
      divider.removeEventListener('pointerup', end);
      divider.removeEventListener('pointercancel', end);
      divider.removeEventListener('lostpointercapture', end);
      setDragging(false);
      setLiveSplit(null);
      if (last !== split) onSplit?.(last);
    };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', end);
    divider.addEventListener('pointercancel', end);
    divider.addEventListener('lostpointercapture', end);
  };
  const onDividerKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); moveSplit(event.key === 'ArrowRight' ? 2 : -2); }
    if (event.key === 'Home' || event.key === 'Enter') { event.preventDefault(); onSplit?.(clampSplit(50, false)); }
    if (event.key === 'Escape') { event.preventDefault(); inputRef.current?.focus(); }
  };

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
    // into "search inside them then". Shift-Tab leaves the box for the
    // sheet's controls (the current mode, then Tab on to the others and the
    // divider), and Escape from any of them comes back to the box.
    if (event.key === 'Tab' && event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      sectionRef.current?.querySelector<HTMLElement>('.quick-tab.is-current')?.focus();
      return;
    }
    if (event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      // Finishing what is being typed comes first; the tabs are what Tab
      // does when there is nothing to finish.
      if (takeCompletion(completions.candidates[0])) return;
      cycleMode(1);
      return;
    }
    // Rendered or source. Option and a key, because the menu bar answers
    // Command and a letter before the box would hear it.
    if (event.altKey && !event.metaKey && !event.ctrlKey && event.code === 'KeyE') {
      event.preventDefault();
      onPreviewView?.(previewView === 'source' ? 'rendered' : 'source');
      return;
    }
    // The divider, from the keyboard: Option and the brackets move it.
    if (event.altKey && !event.metaKey && !event.ctrlKey && (event.code === 'BracketLeft' || event.code === 'BracketRight')) {
      event.preventDefault();
      moveSplit(event.code === 'BracketRight' ? 2 : -2);
      return;
    }
    // The width, on the same keys the author's own palette uses, and the same
    // keys the document's own column uses one level out.
    if (stepSheetWidth(event, sheet)) return;
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

  const shownSplit = liveSplit ?? split;
  /**
   * How old a note is, said short, so every row has the same right edge. With
   * nothing typed the list is what was opened lately, and the age is when it
   * was opened; a search's results say when each note last changed.
   */
  const ageOf = (entry: WorkspaceIndexEntryV1): string | null => {
    const opened = frecency[entry.path]?.lastOpenedAt;
    const when = terms.trim().length === 0 && typeof opened === 'number' && opened > 0 ? opened : entry.modified ?? opened;
    return typeof when === 'number' && when > 0 ? changedWords(when) : null;
  };
  /** Of an empty query's rows, how many were opened here; the rest are the notes changed lately. */
  const openedCount = terms.trim().length === 0 ? results.filter((candidate) => (frecency[candidate.entry.path]?.lastOpenedAt ?? 0) > 0).length : 0;
  /** How many matched, in this mode, out of how many there are to search. */
  const total = candidates.length.toLocaleString('en');
  const count = (value: number, more = false) => <b>{value.toLocaleString('en')}{more ? '+' : ''}</b>;
  const lines = content.matches.reduce((sum, match) => sum + match.occurrences, 0);
  const tally = effectiveMode === 'content'
    ? (terms.trim().length === 0 ? <>{total} notes</>
      : searching ? <>searching {total}…</>
      : <>{count(lines)} {lines === 1 ? 'line' : 'lines'} in {count(content.matches.length, content.truncated)} {content.matches.length === 1 ? 'note' : 'notes'}</>)
    : effectiveMode === 'folders'
      ? (terms.trim().length === 0 ? <>{folders.length.toLocaleString('en')} folders</> : <>{count(folderResults.length)} of {folders.length.toLocaleString('en')}</>)
      : terms.trim().length === 0 ? <>{total} notes</>
      : <>{count(results.length, results.length >= LIMIT)} of {total}</>;

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
                tabIndex={-1}
            aria-selected={index === selected}
            className={index === selected ? 'quick-result quick-action is-selected' : 'quick-result quick-action'}
            data-testid="quick-action"
            data-kind={action.kind}
            onMouseMove={hoverRow(index)}
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
        data-sheet-width={sheet?.width}
        role="dialog"
        aria-modal="true"
        aria-label="Quick open"
        data-testid="quick-open"
        ref={sectionRef}
        onClick={(event) => event.stopPropagation()}
        // Escape from one of the sheet's controls (a mode button, the divider)
        // comes back to the box; from the box it closes (onKeyDown), and from
        // anywhere else, such as the sheet before the box has taken focus, too.
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || event.target === inputRef.current || isComposing(event)) return;
          event.preventDefault();
          const control = event.target instanceof Element && event.target.closest('.quick-tabs, .quick-divider');
          if (control) inputRef.current?.focus();
          else onClose();
        }}
      >
        <div className="quick-input-row">
          <svg className="quick-glass" viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <circle cx="7" cy="7" r="4.6" />
            <path d="M10.4 10.4 14 14" />
          </svg>
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
                ? 'Link to a note: type its name'
                : effectiveMode === 'content'
                  ? 'Find a line inside your notes'
                  : effectiveMode === 'folders'
                    ? 'Find a folder'
                    : 'Find a note by name, or a line inside one'}
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
          {/* How many matched, out of how many: the first question a search answers. */}
          <span className="quick-tally" data-testid="quick-tally" aria-live="polite">{tally}</span>
          {/* What is searched, a thing you point at. Tab from the box cycles it,
              so the hand never leaves the keys; the buttons are real buttons too. */}
          <div className="quick-tabs" role="tablist" aria-label="What to search">
            {QUICK_TABS.map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={tab === effectiveMode}
                className={tab === effectiveMode ? 'quick-tab is-current' : 'quick-tab'}
                data-testid={`quick-tab-${tab}`}
                title={`${QUICK_TAB_LABELS[tab]} (Tab from the box)`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => { setQuery((current) => removeToken(current, 'type')); onMode(tab); inputRef.current?.focus(); }}
              >
                {QUICK_TAB_LABELS[tab]}
              </button>
            ))}
          </div>
        </div>
        {effectiveMode === 'content' && searching && <div className="quick-searching" aria-hidden="true" />}

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

        <div
          className={dragging ? 'quick-body is-dividing' : 'quick-body'}
          ref={bodyRef}
          style={previewShown ? { gridTemplateColumns: `minmax(0, ${shownSplit}fr) ${GUTTER}px minmax(0, ${100 - shownSplit}fr)` } : undefined}
        >
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
                tabIndex={-1}
                  aria-selected={index === selected}
                  className={index === selected ? 'quick-result is-selected' : 'quick-result'}
                  data-testid="quick-folder"
                  title={folder.relativePath}
                  onMouseMove={hoverRow(index)}
                  onClick={() => enterFolder(folder)}
                >
                  <span className="quick-name">
                    <Highlighted text={folder.name} query={terms.trim()} />
                  </span>
                  <span className="quick-meta">{folder.notes} {folder.notes === 1 ? 'note' : 'notes'}</span>
                  <span className="quick-path" title={folder.relativePath}>{pathTail(folder.relativePath, true)}</span>
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
                        : <>No note contains <b>{terms.trim()}</b>.</>}
                </p>
              )
              : content.matches.map((match, index) => (
                <button
                  key={match.path}
                  id={`quick-result-${index}`}
                  type="button"
                  role="option"
                tabIndex={-1}
                  aria-selected={index === selected}
                  className={index === selected ? 'quick-result is-selected' : 'quick-result'}
                  data-testid="quick-match"
                  title={match.relativePath}
                  onMouseMove={hoverRow(index)}
                  onClick={() => chooseMatch(match)}
                >
                  <span className="quick-name">{stripExtension(match.name)}</span>
                  <span className="quick-meta">{match.occurrences} {match.occurrences === 1 ? 'line' : 'lines'}</span>
                  <span className="quick-lines">
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
                  </span>
                  <span className="quick-path" title={match.relativePath}>{pathTail(match.relativePath)}</span>
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
                    : <>No note is named <b>{terms.trim()}</b>.<span className="quick-empty-also">{onMake ? <><kbd>⇧↩</kbd> makes it here · </> : null}<kbd>tab</kbd> looks inside notes</span></>}
              </p>
            )
            : results.map((candidate, index) => (
              <Fragment key={candidate.entry.path}>
              {terms.trim().length === 0 && effectiveScope.length === 0 && index === 0 && openedCount > 0 && (
                <p className="quick-section" role="presentation">Opened lately<span>{openedCount}</span></p>
              )}
              {terms.trim().length === 0 && effectiveScope.length === 0 && index === openedCount && index < results.length && (
                <p className="quick-section" role="presentation">Changed lately<span>{results.length - openedCount}</span></p>
              )}
              <button
                id={`quick-result-${index}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={index === selected}
                className={index === selected ? 'quick-result is-selected' : 'quick-result'}
                data-testid="quick-result"
                title={candidate.entry.relativePath}
                // Selecting on hover rather than on click, so the keyboard and
                // the pointer never disagree about which row is next.
                onMouseMove={hoverRow(index)}
                onClick={(event) => choose(candidate, event.altKey)}
              >
                <span className="quick-name">
                  <Highlighted text={stripExtension(candidate.entry.name)} query={terms.trim()} />
                </span>
                {ageOf(candidate.entry) && <span className="quick-meta">{ageOf(candidate.entry)}</span>}
                <span className="quick-path" title={candidate.entry.relativePath}>{pathTail(candidate.entry.relativePath)}</span>
              </button>
              </Fragment>
            ))}
            {actionRows}
          </>)}
        </div>

        {previewShown && (
          // The divider: drag it, or focus it and use the arrows; a double-click is half and half.
          <div
            className="quick-divider"
            data-testid="quick-divider"
            role="separator"
            aria-orientation="vertical"
            aria-label="Divide the list and the preview"
            aria-valuenow={shownSplit}
            aria-valuemin={QUICK_SPLIT_MIN}
            aria-valuemax={QUICK_SPLIT_MAX}
            tabIndex={0}
            title="Drag to divide · double-click for half and half"
            onPointerDown={onDividerDown}
            onDoubleClick={() => onSplit?.(clampSplit(50, false))}
            onKeyDown={onDividerKey}
          >
            <span className="quick-divider-badge" aria-hidden="true">{shownSplit} / {100 - shownSplit}</span>
          </div>
        )}
        {previewShown && (previewTarget
          ? <QuickPreview target={previewTarget} value={previewValue} query={effectiveMode === 'content' ? terms : ''} view={previewView} />
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
          {rowCount > 0 && <span><kbd>↑</kbd> <kbd>↓</kbd> choose</span>}
          {selectedMakes
            ? <span><kbd>↩</kbd> make it</span>
            : <>
              {!linking && effectiveMode !== 'folders' && <span><kbd>↩</kbd> open</span>}
              {effectiveMode === 'files' && canInsertLink && !linking && selected < baseCount && rowCount > 0 && <span><kbd>⌥↩</kbd> link to it</span>}
              {effectiveMode === 'folders' && <span><kbd>↩</kbd> search inside it</span>}
            </>}
          {actions.some((action) => action.kind === 'new-note') && <span data-testid="quick-hint-new"><kbd>⇧↩</kbd> new note</span>}
          {linking && <span data-testid="quick-linking"><kbd>↩</kbd> insert the link</span>}
          {!linking && completions.candidates.length === 0 && (
            <span><kbd>tab</kbd> {QUICK_TAB_LABELS[QUICK_TABS[(QUICK_TABS.indexOf(effectiveMode) + 1) % QUICK_TABS.length]].toLowerCase()}</span>
          )}
          {completions.candidates.length > 0 && <span><kbd>tab</kbd> finish this</span>}
          {scope.length > 0 && <span><kbd>⌫</kbd> leave the folder</span>}
          {previewShown && <span><kbd>⌥E</kbd> {previewView === 'source' ? 'rendered' : 'source'}</span>}
          <span className="sheet-foot-end"><SheetWidthHint control={sheet} /><span><kbd>esc</kbd> close</span></span>
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

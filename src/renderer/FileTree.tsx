/**
 * The workspace folder sidebar.
 *
 * Children are fetched when a folder is expanded rather than up front, because
 * a notes folder can hold thousands of files and reading all of them to draw a
 * tree nobody has opened would stall the first paint.
 *
 * Expansion state lives here rather than in main. Which folders a user has
 * twirled open is a view detail, and keeping it local means expanding does not
 * cost a round trip once the children have been read.
 */

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { SensitivityV1, WorkspaceEntryV1, WorkspaceGitChangeV1 } from '../shared/workspace/v1/contracts';
import { branchToCurrentFile, sizeTreeGuides, startTreeGuides } from './tree-guides';
import { EDGE_DELAY_MS, SPRING_MS, carried, dropVerdict, dropWords, edgeSpeed, edgeStrength, rangeOf } from './tree-drag';
import { isComposing } from './ime';
import { treeMove, type TreeRowView } from './tree-keys';
import { TREE_STEP_MARGIN, fitLabel, nameRoom, sharedStarts, treeLabel, treeStep, type FittedName } from './tree-fit';

export interface FileTreeProps {
  readonly root: string | null;
  readonly rootName: string | null;
  /** Path of the document in front, so the tree can show where you are. */
  readonly activePath: string | null;
  readonly list: (directory: string) => Promise<readonly WorkspaceEntryV1[]>;
  readonly onOpenFile: (filePath: string) => void;
  /**
   * A press of the right button on a row: main draws the menu for it. `also`
   * are the other rows chosen with it, when it is one of several, and the menu
   * is for all of them.
   */
  readonly onRowMenu: (rowPath: string, kind: 'file' | 'directory', also?: readonly string[]) => void;
  readonly onChooseFolder: () => void;
  /**
   * A row dragged onto a folder. Absent while no folder is open, in which
   * case the rows are not draggable at all.
   */
  readonly onMoveEntry?: (source: string, destination: string) => void | Promise<void>;
  /**
   * The folder's own actions, drawn on the folder's own row.
   *
   * They used to live in a bar along the bottom of the rail, which spent an
   * edge of the window restating a name the first row of the tree already
   * gives. An action belongs on the thing it acts on.
   */
  readonly vaultMenu?: ReactNode;
  /**
   * The row wearing a name field, and what will be done with what is typed.
   *
   * Driven from outside because main is what starts a rename, from the row
   * menu, and the tree is what has the row to put the field on. A note that
   * was just made is renamed on its own row, like any other.
   */
  readonly editing?: { readonly path: string; readonly intent: 'rename' | 'new-folder' | 'new-note' } | null;
  /** The typed name, or null when the reader gave up. */
  readonly onEditingDone?: (name: string | null) => void;
  /** Refreshed listings, so a folder changed on disk is read again. */
  readonly reloadToken?: number;
  /** The folders whose listings the change may have touched, when main knew them; all are read again otherwise. */
  readonly reloadOnly?: readonly string[] | null;
  /**
   * Bumped to shut every folder except the ones holding the current note.
   *
   * Typora's Collapse All shuts the lot, which after an afternoon of looking
   * through folders also shuts away the note you found. Keeping its branch
   * open is what the reader was tidying towards.
   */
  readonly collapseToken?: number;
  /**
   * Which notes differ from the last commit, when the folder is in a git
   * repository; null when it is not. See `TreeGitMarks`.
   */
  readonly gitMarks?: TreeGitMarks | null;
  /**
   * Which folders `.noto/access.yaml` makes private or sealed by name, when
   * the folder keeps memory; null when it does not. See `TreePrivacyMarks`.
   */
  readonly privacyMarks?: TreePrivacyMarks | null;
  /**
   * How the folders you are in stay in sight as the tree scrolls: each on a
   * row of its own (`stack`), or folded into one row of names (`trail`).
   */
  readonly heldFolders?: 'stack' | 'trail';
  /** Whether a note's row shows its `.md`. */
  readonly noteExtensions?: boolean;
  /**
   * A folder to focus the rail on, asked for from its row's menu. The token
   * tells one ask from the next, so asking for the same folder twice works.
   */
  readonly focusRequest?: { readonly path: string; readonly token: number } | null;
  /** F2 on a row: name it again where it sits, as Rename in its menu does. */
  readonly onRename?: (rowPath: string) => void;
}

/**
 * The locks the tree draws: on a folder given a level by a pattern of its
 * own, and on the vault's own row when every note is private by default. A
 * folder inside a locked one is not locked again; it sits under the lock.
 */
export interface TreePrivacyMarks {
  readonly vault: SensitivityV1;
  readonly folders: ReadonlyMap<string, SensitivityV1>;
}

const PRIVACY_WORDS: Readonly<Record<'private' | 'sealed', string>> = {
  private: 'Private: only agents allowed private notes read it',
  sealed: 'Sealed: no agent reads it',
};

/**
 * A small lock after a folder's name. Private is drawn open in the body,
 * sealed solid, so the two differ in shape and not only in weight; both in
 * the muted tier, since a lock is a fact about the folder and not a call to
 * act. The words ride along hidden, as the git mark's do.
 */
export function PrivacyMark({ level }: { level: 'private' | 'sealed' }) {
  return (
    <span className={`tree-privacy tree-privacy-${level}`} data-testid="tree-privacy-mark" data-privacy={level}>
      <LockGlyph level={level} />
      <span className="tree-git-words">, {level === 'private' ? 'Private' : 'Sealed'}</span>
    </span>
  );
}

/** The lock itself, the same wherever privacy is shown: the tree, and the status line. */
export function LockGlyph({ level }: { level: 'private' | 'sealed' }) {
  return (
    <svg className={`lock-glyph lock-glyph-${level}`} viewBox="0 0 8 10" aria-hidden="true">
      <path d="M2 4.5V3a2 2 0 0 1 4 0v1.5" />
      <rect className="lock-glyph-body" x="0.75" y="4.5" width="6.5" height="4.75" rx="1" />
    </svg>
  );
}

/** The git marks keyed for lookup by row path. */
export interface TreeGitMarks {
  readonly files: ReadonlyMap<string, WorkspaceGitChangeV1>;
  readonly folders: ReadonlySet<string>;
}

/** What a mark means, said once for the hover and the screen reader alike. */
const GIT_WORDS: Readonly<Record<WorkspaceGitChangeV1 | 'folder', string>> = {
  modified: 'Changed',
  new: 'New',
  deleted: 'Deleted',
  folder: 'Contains changes',
};

/**
 * One quiet mark at the end of a row.
 *
 * A filled dot for a note that differs from the last commit, a plus for one
 * the commit does not have, a ring in the muted tier for a folder holding a
 * change, so a folder says "look inside" without competing with the notes
 * that actually changed. Three shapes, so colour is never the only way to
 * tell. A deleted note has no row; its folders carry the ring. The words
 * travel with the mark as hidden text, so the row reads "edited.md, Changed".
 */
export function GitMark({ kind }: { kind: WorkspaceGitChangeV1 | 'folder' }) {
  return (
    <span className={`tree-git tree-git-${kind}`} data-testid="tree-git-mark" data-git={kind}>
      {kind === 'new' && (
        <svg viewBox="0 0 7 7" aria-hidden="true"><path d="M3.5 0.75v5.5M0.75 3.5h5.5" /></svg>
      )}
      <span className="tree-git-words">, {GIT_WORDS[kind]}</span>
    </span>
  );
}

/**
 * The name field that sits in a row while it is being renamed or created.
 *
 * A field on the row rather than a dialog, because the row is where the reader
 * is looking and the neighbouring names are usually the reason they are
 * renaming this one. Escape gives up, Enter commits, and clicking away commits
 * too, which is what every file manager does and what a reader who has typed a
 * name and moved on expects.
 *
 * The extension is left out of the initial selection for a file, so typing
 * replaces the name and keeps the `.md` that makes it a note.
 */
function NameField({ initial, onDone }: {
  initial: string;
  onDone: (name: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const settled = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    const dot = initial.lastIndexOf('.');
    if (dot > 0) input.setSelectionRange(0, dot);
    else input.select();
  }, [initial]);

  const finish = (name: string | null) => {
    if (settled.current) return;
    settled.current = true;
    onDone(name);
  };

  return (
    <input
      ref={inputRef}
      className="tree-name-field"
      data-testid="tree-name-field"
      defaultValue={initial}
      spellCheck={false}
      aria-label="Name"
      onClick={(event) => event.stopPropagation()}
      onBlur={(event) => finish(event.currentTarget.value.trim() || null)}
      onKeyDown={(event) => {
        event.stopPropagation();
        // A press the input method is composing with is the input method's:
        // Enter there commits the letters, not the name.
        if (isComposing(event)) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(event.currentTarget.value.trim() || null);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          finish(null);
        }
      }}
    />
  );
}

/** The row a folder being made is named on, one level under the folder it goes in. */
function NewFolderRow({ depth, onDone }: { depth: number; onDone: (name: string | null) => void }) {
  return (
    <div className="tree-level" style={{ '--tree-depth': depth } as React.CSSProperties}>
      <div className="tree-node">
        <div className="tree-row tree-directory" data-depth={depth} data-testid="tree-new-folder">
          <span className="tree-leading">
            <span className="tree-twisty tree-twisty-blank" aria-hidden="true" />
            <FolderGlyph />
          </span>
          <NameField initial="New Folder" onDone={onDone} />
        </div>
      </div>
    </div>
  );
}

/** The height of one row, which the sticky offsets are multiples of. */
export const TREE_ROW_HEIGHT = 32;

/** True when `target` is inside `folder`, at any depth. */
function isUnder(folder: string, target: string): boolean {
  // A root that ends in its separator (`/`, `C:\\`) is its own prefix.
  if (folder.endsWith('/') || folder.endsWith('\\')) return target.length > folder.length && target.startsWith(folder);
  return target.startsWith(`${folder}/`) || target.startsWith(`${folder}\\`);
}

/** The last part of a path. */
function baseName(target: string): string {
  return target.split(/[\\/]/).filter(Boolean).at(-1) ?? target;
}

/** The folder a path is in. */
function parentOf(target: string): string {
  const cut = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'));
  return cut > 0 ? target.slice(0, cut) : target;
}

/** How long a rest on a cut name takes to show it whole: long enough that passing over rows shows nothing. */
const PEEK_MS = 300;

/** The folders between the root and a path under it, outermost first. */
function foldersBetween(root: string, target: string | null): string[] {
  if (target === null) return [];
  const separator = root.includes('\\') ? '\\' : '/';
  const prefix = root.endsWith(separator) ? root : `${root}${separator}`;
  if (!target.startsWith(prefix)) return [];
  const folders: string[] = [];
  for (let index = target.indexOf(separator, prefix.length); index !== -1; index = target.indexOf(separator, index + 1)) {
    folders.push(target.slice(0, index));
  }
  return folders;
}

export function FileTree({
  root, rootName, activePath, list, onOpenFile, onRowMenu, onChooseFolder, onMoveEntry, vaultMenu,
  editing = null, onEditingDone, reloadToken = 0, reloadOnly = null, collapseToken = 0, gitMarks = null, privacyMarks = null,
  heldFolders = 'stack', noteExtensions = true, focusRequest = null, onRename,
}: FileTreeProps) {
  const [children, setChildren] = useState<ReadonlyMap<string, readonly WorkspaceEntryV1[]>>(new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState<string | null>(null);
  // Which row is being dragged and which folder is under it. Declared here,
  // with every other hook, because the tree returns early while no folder is
  // open and React needs the same hooks on every render.
  /** The rows in the air: the one picked up, or every chosen row when it was one of them. */
  const [dragging, setDragging] = useState<readonly string[] | null>(null);
  /** Rows chosen with Command or Shift, to drag, move or trash together. */
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  /** Where a Shift-click's range begins: the row chosen or opened last. */
  const anchorRef = useRef<string | null>(null);
  /** The folder a drop would land in: the one under the pointer, or the folder of the note under it. */
  const [over, setOver] = useState<string | null>(null);
  /** Which way the tree is scrolling under a held drag, so no row is offered while rows pass beneath it. */
  const [edgeScrolling, setEdgeScrolling] = useState<-1 | 0 | 1>(0);
  /** A closed folder held over, filling its line until it opens. */
  const [springing, setSpringing] = useState<string | null>(null);
  /** Folders opened for the drag, shut again afterwards unless the drop went into them. */
  const springOpened = useRef(new Set<string>());
  const edgeUp = useRef<HTMLDivElement>(null);
  const edgeDown = useRef<HTMLDivElement>(null);
  /** The folder the rail is focused on, drawn as its root; null for the whole open folder. */
  const [focus, setFocus] = useState<string | null>(null);
  /** Which way focus last went, so the tree slides in from that side; null until it first moves. */
  const [focusWay, setFocusWay] = useState<'in' | 'out' | null>(null);
  /** The tree's inner width, which the step per level and every cut name are worked out from. */
  const [treeWidth, setTreeWidth] = useState(0);
  /** The rows' face, read off a row, so names are measured in what draws them. */
  const [nameFont, setNameFont] = useState('');
  /** For the trail: the open folders above what is in view, outermost first. */
  const [trail, setTrail] = useState<readonly string[]>([]);
  /** A cut name shown whole over the page, and where its row is. */
  const [peek, setPeek] = useState<{ readonly text: string; readonly left: number; readonly top: number; readonly height: number } | null>(null);
  const peekRow = useRef<HTMLElement | null>(null);
  const peekTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(peekTimer.current), []);
  /** Widths and fitted names in the current face, kept across renders: a drag redraws the tree on every move. */
  const measureCache = useRef<{ font: string; context: CanvasRenderingContext2D | null; widths: Map<string, number>; fits: Map<string, FittedName> }>(
    { font: '', context: null, widths: new Map(), fits: new Map() },
  );
  /** Each listing's labels and shared starts, worked out once per listing rather than on every render. */
  const sharedCache = useRef(new WeakMap<readonly WorkspaceEntryV1[], { readonly extensions: boolean; readonly labels: readonly string[]; readonly starts: readonly string[] }>());
  /** Set only by a focus the reader asked for, so the tree takes the keys then and never on a change from disk. */
  const refocus = useRef(false);

  /** The file last scrolled into view, so a tree change never scrolls the rail again. */
  const shownRef = useRef<string | null>(null);
  const activeRef = useRef(activePath);
  activeRef.current = activePath;

  // Collapse: every folder shut at once but the ones the current note is in,
  // which a tree of seven thousand notes needs after an afternoon of opening
  // things. The note's row is brought back into view, since the folders that
  // shut above it move it. The first render is not one, so the token is
  // compared rather than acted on.
  const collapsedAt = useRef(collapseToken);
  useEffect(() => {
    if (collapsedAt.current === collapseToken) return;
    collapsedAt.current = collapseToken;
    setExpanded(new Set(root ? foldersBetween(root, activeRef.current) : []));
    shownRef.current = null;
  }, [collapseToken, root]);
  const bodyRef = useRef<HTMLElement>(null);
  /**
   * The one row Tab reaches, as a tree has one stop rather than one per row:
   * the row last walked to, else the note in front. The arrows go from there.
   */
  const [tabStop, setTabStop] = useState<string | null>(null);
  const rowTabStop = tabStop ?? activePath;
  const typedRef = useRef({ text: '', at: 0 });
  // A tree keeps one row on the Tab path. When the row it would be is not
  // drawn (the note in front sits in a closed folder), the first row is.
  useLayoutEffect(() => {
    const rows = bodyRef.current?.querySelectorAll<HTMLElement>('.tree-row[role="treeitem"][data-path]');
    if (!rows || rows.length === 0) return;
    if (![...rows].some((row) => row.tabIndex === 0)) rows[0]!.tabIndex = 0;
  });

  /*
   * The tree's width and its rows' face, which the step per level and every
   * cut name follow. Read when the rail is resized, when the tree is drawn
   * anew under a focus, and whenever the tree changes, since the face can only
   * be read once a row exists to read it from.
   */
  const readMeasure = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return;
    setTreeWidth(body.clientWidth);
    const name = body.querySelector<HTMLElement>('.tree-file .tree-name, .tree-directory:not(.tree-vault-row) .tree-name');
    if (!name) return;
    const font = getComputedStyle(name).font;
    setNameFont((current) => (current === font ? current : font));
  }, []);
  useLayoutEffect(() => {
    const scroller = bodyRef.current?.closest<HTMLElement>('.rail-view');
    if (!scroller) return undefined;
    readMeasure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => readMeasure());
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [root, focus, readMeasure]);

  /** The latest listing asked for per folder, so an older answer arriving late is dropped. */
  const loadSeqRef = useRef(new Map<string, number>());
  const load = useCallback(async (directory: string) => {
    const seq = (loadSeqRef.current.get(directory) ?? 0) + 1;
    loadSeqRef.current.set(directory, seq);
    try {
      const entries = await list(directory);
      if (loadSeqRef.current.get(directory) !== seq) return;
      setChildren((current) => new Map(current).set(directory, entries));
      setFailed(null);
    } catch {
      setFailed('That folder could not be read.');
    }
  }, [list]);

  // A new root replaces everything, so stale children from the previous folder
  // can never be shown under it.
  useEffect(() => {
    setChildren(new Map());
    setExpanded(new Set());
    setSelected(new Set());
    anchorRef.current = null;
    setFailed(null);
    setFocus(null);
    setFocusWay(null);
    setTrail([]);
    childrenRef.current = new Map();
    if (root) void load(root);
  }, [root, load]);

  /*
   * The tree opens to the current file. A note opened from the command line,
   * from quick open or through a link is otherwise somewhere under a closed
   * folder, and a branch cannot light up to a row that is not there. Each
   * folder between the root and the file is expanded and loaded. A folder the
   * reader closes afterwards stays closed: this runs when the file changes,
   * not when the tree does.
   */
  const childrenRef = useRef(children);
  childrenRef.current = children;

  /*
   * Read every open folder again when something moved.
   *
   * The tree holds a listing per folder. Main follows the folder on disk and
   * bumps the token on any structural change, from Noto or from anything
   * else, and on Refresh Folder. Every listing already on screen is then
   * suspect, and re-reading only the folder that changed would leave a moved
   * file showing in its old place.
   */
  useEffect(() => {
    if (reloadToken === 0) return;
    // Only what changed when main said what that was: an agent writing notes all afternoon should not
    // have every folder ever opened read again each time.
    const only = reloadOnly === null ? null : new Set(reloadOnly);
    for (const directory of [...childrenRef.current.keys()]) if (only === null || only.has(directory)) void load(directory);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken]);
  useEffect(() => {
    if (!root || !activePath) return;
    const ancestors = foldersBetween(root, activePath);
    if (ancestors.length === 0) return;
    setExpanded((current) => {
      if (ancestors.every((directory) => current.has(directory))) return current;
      const next = new Set(current);
      for (const directory of ancestors) next.add(directory);
      return next;
    });
    for (const directory of ancestors) {
      if (!childrenRef.current.has(directory)) void load(directory);
    }
  }, [root, activePath, load]);

  /*
   * Focus: a folder made the rail's root, for a stretch of work deep in one
   * place. The tree then starts there with its full steps, and the bar above
   * it leads back up. The note in front is brought into view if it is inside.
   */
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const focusOn = useCallback((folder: string | null) => {
    const current = focusRef.current;
    if (folder === current) return;
    setFocusWay(folder !== null && (current === null || isUnder(current, folder)) ? 'in' : 'out');
    if (folder !== null) {
      setExpanded((open) => (open.has(folder) ? open : new Set(open).add(folder)));
      if (!childrenRef.current.has(folder)) void load(folder);
    }
    setSelected(new Set());
    setTrail([]);
    setPeek(null);
    shownRef.current = null;
    refocus.current = true;
    setFocus(folder);
  }, [load]);

  // Asked for from a folder's row menu.
  const focusAsked = useRef(focusRequest?.token ?? 0);
  useEffect(() => {
    if (!focusRequest || focusRequest.token === focusAsked.current) return;
    focusAsked.current = focusRequest.token;
    if (root && isUnder(root, focusRequest.path)) focusOn(focusRequest.path);
  }, [focusRequest, root, focusOn]);

  /*
   * A focused folder that went, or one of the folders above it (moved,
   * renamed, trashed, or gone with a checkout), gives the whole open folder
   * back. Quietly: the reader may be typing, and the keys stay where they are.
   */
  useEffect(() => {
    if (focus === null || !root) return;
    const gone = !isUnder(root, focus) || [...foldersBetween(root, focus), focus].some((folder) => {
      const listing = children.get(parentOf(folder));
      return listing !== undefined && !listing.some((entry) => entry.path === folder && entry.kind === 'directory');
    });
    if (!gone) return;
    setFocusWay('out');
    setTrail([]);
    setPeek(null);
    shownRef.current = null;
    setFocus(null);
  }, [children, focus, root]);

  // A focus the reader asked for starts the tree from its top and keeps the keys on the tree, so Esc leads back out.
  // Before the effect below, which then brings the note in front into view when it is inside.
  useLayoutEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    const scroller = bodyRef.current?.closest<HTMLElement>('.rail-view');
    if (scroller) scroller.scrollTop = 0;
    bodyRef.current?.focus({ preventScroll: true });
  }, [focus]);

  // A row named from elsewhere (a page in the rail, say) can be under closed
  // folders; they open so its name field is there to type in.
  const editingPath = editing?.path ?? null;
  useEffect(() => {
    if (!root || !editingPath) return;
    const ancestors = foldersBetween(root, editingPath);
    if (ancestors.length === 0) return;
    setExpanded((current) => {
      if (ancestors.every((directory) => current.has(directory))) return current;
      const next = new Set(current);
      for (const directory of ancestors) next.add(directory);
      return next;
    });
    for (const directory of ancestors) {
      if (!childrenRef.current.has(directory)) void load(directory);
    }
  }, [root, editingPath, load]);

  /*
   * Which rows are stuck to the top.
   *
   * The path to the current file is sticky: each of its open ancestors holds
   * a row below its parent while the contents scroll past, and the file's own
   * row holds beneath them, which is the rule in the author's Typora theme.
   * Other open folders scroll like anything else, so the top of the rail
   * always reads as "where the file you are in lives" and never as a stack of
   * every folder you happened to open. That much is the stylesheet's. What it
   * cannot do is tell a row that is stuck from one merely resting in place,
   * and only the stuck one should carry the rule that separates it from the
   * rows sliding under it.
   *
   * A stuck row is one the browser has displaced from the top of its own
   * node, so the test is the distance between the two, read on scroll and
   * once per frame at most. Not an intersection observer: a row resting on
   * its sticky line at scroll zero looks the same to an observer as one that
   * has scrolled up to it, and only the second is stuck.
   */
  useEffect(() => {
    const body = bodyRef.current;
    const scroller = body?.closest('.rail-view');
    if (!body || !scroller) return;
    let frame = 0;
    const mark = () => {
      frame = 0;
      // The mark is set by hand, so React never takes it off. A row that has
      // left the path, because another note was opened or its folder closed,
      // kept it and went on drawing a held row's band and lit elbow where the
      // branch no longer runs.
      for (const stale of body.querySelectorAll<HTMLElement>('[data-stuck]')) {
        if (!stale.matches('.tree-directory.tree-on-path[aria-expanded="true"], .tree-node-active')) {
          stale.removeAttribute('data-stuck');
        }
      }
      // An ancestor's row is stuck when it sits below the top of its own node.
      for (const row of body.querySelectorAll<HTMLElement>('.tree-directory.tree-on-path[aria-expanded="true"]')) {
        const node = row.parentElement;
        if (!node) continue;
        row.toggleAttribute('data-stuck', row.getBoundingClientRect().top - node.getBoundingClientRect().top > 0.5);
      }
      // The current file's node is the sticky thing, since a leaf's row fills
      // its node and would have no room to hold. It is stuck when it sits
      // below where its previous sibling ends, or below the top of its level.
      for (const node of body.querySelectorAll<HTMLElement>('.tree-node-active')) {
        const previous = node.previousElementSibling;
        const resting = previous
          ? previous.getBoundingClientRect().bottom
          : node.parentElement?.getBoundingClientRect().top ?? 0;
        node.toggleAttribute('data-stuck', node.getBoundingClientRect().top - resting > 0.5);
      }
      // A held row is where the level under it begins, so the stems are
      // measured in the same frame the holding is.
      startTreeGuides(body);
      // The trail: every open folder whose row has gone up under it while its
      // contents are still in view, outermost first, as the DOM orders them.
      if (heldFolders === 'trail') {
        const bar = body.parentElement?.querySelector<HTMLElement>('.tree-focusbar')?.offsetHeight ?? 0;
        const line = scroller.getBoundingClientRect().top + bar;
        const held: string[] = [];
        for (const row of body.querySelectorAll<HTMLElement>('.tree-directory[aria-expanded="true"][data-path]')) {
          const box = row.parentElement?.getBoundingClientRect();
          if (box && box.top < line + TREE_ROW_HEIGHT / 2 && box.bottom > line + TREE_ROW_HEIGHT) held.push(row.dataset.path!);
        }
        setTrail((current) => (current.length === held.length && current.every((path, index) => path === held[index]) ? current : held));
      }
    };
    const onScroll = () => {
      // A name shown whole belongs to a row that has just moved.
      window.clearTimeout(peekTimer.current);
      peekRow.current = null;
      setPeek(null);
      if (frame === 0) frame = requestAnimationFrame(mark);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    mark();
    // Bring the current file into view the first time its row exists, and
    // only then: a folder opening elsewhere must not move the rail.
    if (activePath !== null && shownRef.current !== activePath) {
      const node = body.querySelector<HTMLElement>('.tree-node-active');
      if (node) {
        shownRef.current = activePath;
        const rect = node.getBoundingClientRect();
        const view = scroller.getBoundingClientRect();
        if (rect.bottom > view.bottom || rect.top < view.top) {
          scroller.scrollTop += rect.top - view.top - view.height / 2;
          mark();
        }
      }
    }
    // Light the branch, and stop each quiet stem at the corner that finishes
    // it. Read once per change of the tree, not per scroll: the stems do not
    // move when the rail does.
    sizeTreeGuides(body, { litChild: branchToCurrentFile });
    readMeasure();
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [children, expanded, root, activePath, focus, heldFolders, readMeasure]);

  /*
   * Hold a dragged row at the top or bottom of the rail and the tree scrolls
   * toward it, faster the nearer the edge and fastest past it, after a short
   * rest so passing through the band does nothing (`tree-drag.ts`). The pointer
   * is read from every dragover in the window, since past the edge it is over
   * the rail's header or footer, not a row. Frames run only while a row is in
   * the air; at rest the tree costs nothing. The edge says it is moving with a
   * tint and a chevron as strong as the scroll.
   */
  useEffect(() => {
    if (dragging === null) return undefined;
    const scroller = bodyRef.current?.closest<HTMLElement>('.rail-view');
    if (!scroller) return undefined;
    let pointer: { x: number; y: number } | null = null;
    let since: number | null = null;
    let frame = 0;
    let way: -1 | 0 | 1 = 0;
    const going = (next: -1 | 0 | 1) => { if (next !== way) { way = next; setEdgeScrolling(next); } };
    const track = (event: DragEvent) => { pointer = { x: event.clientX, y: event.clientY }; };
    // Out of the window there is no pointer to scroll for, and an old one would keep the tree running.
    const gone = (event: DragEvent) => { if (event.relatedTarget === null) pointer = null; };
    const show = (up: number, down: number) => {
      edgeUp.current?.style.setProperty('--edge', String(up));
      edgeDown.current?.style.setProperty('--edge', String(down));
    };
    const step = (time: number) => {
      frame = requestAnimationFrame(step);
      const box = scroller.getBoundingClientRect();
      // Beside the rail, not over the page: a row dragged toward the editor is not asking the tree to move.
      const at = pointer !== null && pointer.x >= box.left - 32 && pointer.x <= box.right + 32 ? pointer : null;
      const speed = at ? edgeSpeed(at.y, box.top, box.bottom) : 0;
      if (speed === 0) { since = null; show(0, 0); going(0); return; }
      since ??= time;
      if (time - since < EDGE_DELAY_MS) return;
      const before = scroller.scrollTop;
      scroller.scrollTop = before + speed;
      // At the end of the list nothing moves, and the rows there can be chosen again.
      const moved = scroller.scrollTop !== before;
      const strength = moved ? 0.35 + 0.65 * edgeStrength(speed) : 0;
      show(speed < 0 ? strength : 0, speed > 0 ? strength : 0);
      going(moved ? (speed < 0 ? -1 : 1) : 0);
    };
    document.addEventListener('dragover', track, true);
    document.addEventListener('dragleave', gone, true);
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('dragover', track, true);
      document.removeEventListener('dragleave', gone, true);
      show(0, 0);
      setEdgeScrolling(0);
    };
  }, [dragging]);

  // A chosen row that went (moved, trashed) or that a folder shut over is let go: nothing is moved or trashed out of sight.
  useEffect(() => {
    if (selected.size === 0 || !root) return;
    const shown = new Set<string>();
    const walk = (directory: string) => {
      for (const entry of children.get(directory) ?? []) {
        shown.add(entry.path);
        if (entry.kind === 'directory' && expanded.has(entry.path)) walk(entry.path);
      }
    };
    walk(root);
    const kept = [...selected].filter((path) => shown.has(path));
    if (kept.length !== selected.size) setSelected(new Set(kept));
  }, [children, expanded, root, selected]);

  // A closed folder held over opens, once its line has filled, so a drop can go deep without letting go.
  useEffect(() => {
    if (dragging === null || over === null || over === root || expanded.has(over) || dropVerdict(dragging, over) !== 'move') {
      setSpringing(null);
      return undefined;
    }
    const folder = over;
    setSpringing(folder);
    const timer = setTimeout(() => {
      springOpened.current.add(folder);
      setExpanded((current) => new Set(current).add(folder));
      if (!childrenRef.current.has(folder)) void load(folder);
      setSpringing(null);
    }, SPRING_MS);
    return () => clearTimeout(timer);
  }, [dragging, over, expanded, root, load]);

  if (!root) {
    return (
      <div className="tree-root is-empty" data-testid="file-tree">
        <p className="rail-empty">No folder open yet.</p>
        <button type="button" className="tree-choose" data-testid="choose-folder"
          onClick={onChooseFolder}>Open a folder…</button>
      </div>
    );
  }

  /** The folder the tree is drawn from: the focused one, or the open folder (also for the one render after the open folder changes). */
  const top = focus !== null && isUnder(root, focus) ? focus : root;

  /** How deep the deepest drawn row is, counting the first level as one. */
  const deepest = (() => {
    let most = 1;
    const walk = (directory: string, depth: number) => {
      if (depth > most) most = depth;
      for (const entry of children.get(directory) ?? []) {
        if (entry.kind === 'directory' && expanded.has(entry.path)) walk(entry.path, depth + 1);
      }
    };
    walk(top, 1);
    return most;
  })();
  const step = treeStep(treeWidth, deepest);

  const cache = measureCache.current;
  if (cache.font !== nameFont) {
    cache.font = nameFont;
    cache.widths = new Map();
    cache.fits = new Map();
  }
  const measure = (text: string): number => {
    let width = cache.widths.get(text);
    if (width === undefined) {
      cache.context ??= document.createElement('canvas').getContext('2d');
      if (!cache.context) return 0;
      cache.context.font = nameFont;
      width = cache.context.measureText(text).width;
      if (cache.widths.size > 20000) cache.widths.clear();
      cache.widths.set(text, width);
    }
    return width;
  };
  /** A row's name cut to the room it has at its depth, after any marks; whole until the tree has measured. */
  const fitted = (label: string, kind: 'file' | 'directory', depth: number, shared: string, marks: number): FittedName => {
    if (!nameFont || treeWidth <= 0) return { text: label, cut: false };
    const room = nameRoom(treeWidth, depth, step, marks);
    // Most names fit, and their width is already known: only cut ones are worked out and kept.
    if (measure(label) <= room) return { text: label, cut: false };
    const key = `${kind}\u0000${room}\u0000${shared}\u0000${label}`;
    let fit = cache.fits.get(key);
    if (!fit) {
      fit = fitLabel(label, kind, room, shared, measure);
      if (cache.fits.size > 4000) cache.fits.clear();
      cache.fits.set(key, fit);
    }
    return fit;
  };
  const namesOf = (entries: readonly WorkspaceEntryV1[]): { readonly labels: readonly string[]; readonly starts: readonly string[] } => {
    const known = sharedCache.current.get(entries);
    if (known && known.extensions === noteExtensions) return known;
    const labels = entries.map((entry) => treeLabel(entry.name, entry.kind === 'directory' ? 'directory' : 'file', noteExtensions));
    const made = { extensions: noteExtensions, labels, starts: sharedStarts(labels) };
    sharedCache.current.set(entries, made);
    return made;
  };

  /** Scroll a folder's row back to just under the trail, where its contents begin. */
  const jumpTo = (folder: string) => {
    const body = bodyRef.current;
    const scroller = body?.closest<HTMLElement>('.rail-view');
    const row = body?.querySelector<HTMLElement>(`.tree-row[data-path="${CSS.escape(folder)}"]`);
    if (!body || !scroller || !row) return;
    const bar = body.parentElement?.querySelector<HTMLElement>('.tree-focusbar')?.offsetHeight ?? 0;
    const by = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - bar - TREE_ROW_HEIGHT;
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    scroller.scrollBy({ top: by, behavior: smooth ? 'smooth' : 'auto' });
  };

  /**
   * A press on a pinned row brings that row back to where it lives rather
   * than acting on it.
   *
   * A pinned row covers the rows scrolled under it, so a press near the top of
   * the rail lands on a held folder far more often than it is meant for one.
   * Collapsing the folder there threw every row under the pointer somewhere
   * else, and the next press opened a note nobody pointed at. Scrolling the
   * row's own place back under it leaves it exactly where it was drawn, now
   * as an ordinary row, so a second press does what a press on it always does.
   */
  const revealPinned = (row: HTMLElement): boolean => {
    if (!row.hasAttribute('data-stuck')) return false;
    const node = row.parentElement;
    const scroller = bodyRef.current?.closest<HTMLElement>('.rail-view');
    if (!node || !scroller) return false;
    const by = node.getBoundingClientRect().top - row.getBoundingClientRect().top;
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    scroller.scrollBy({ top: by, behavior: smooth ? 'smooth' : 'auto' });
    return true;
  };

  const toggle = (directory: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(directory)) {
        next.delete(directory);
      } else {
        next.add(directory);
        if (!children.has(directory)) void load(directory);
      }
      return next;
    });
  };

  /**
   * One level of the tree.
   *
   * Every level is its own `.tree-level` element and every entry its own
   * `.tree-node`, rather than a flat list indented by inline padding. The
   * structure is what draws the connector lines: the level carries the vertical
   * stem, and `:last-child` is what tells a node to end that stem with a
   * rounded corner instead of a tee. A flat list cannot express "last sibling"
   * and so cannot be given a tree's shape in CSS.
   *
   * Depth starts at one under the folder's own row, so the first level hangs
   * from the folder the way every deeper level hangs from its parent.
   */
  const renderLevel = (directory: string, depth: number): ReactNode => {
    const entries = children.get(directory);
    if (!entries || entries.length === 0) {
      // Drawn as a level with one row in it rather than as a loose paragraph,
      // so it sits exactly where the first file would have sat, with the same
      // arm reaching it. A message at the parent's own indent reads as a
      // sibling of the folder rather than as its contents.
      return (
        <div className="tree-level" style={{ '--tree-depth': depth } as React.CSSProperties}>
          <div className="tree-node">
            <p className={entries ? 'tree-row tree-empty' : 'tree-row tree-loading'} {...dropProps(directory)}>
              {entries ? 'Nothing here.' : 'Reading…'}
            </p>
          </div>
        </div>
      );
    }

    const { labels, starts } = namesOf(entries);
    return (
      <div className="tree-level" role="group" style={{ '--tree-depth': depth } as React.CSSProperties}>
        {entries.map((entry, index) => {
          const label = labels[index]!;
          if (entry.kind === 'directory') {
            const isOpen = expanded.has(entry.path);
            // On the path to the current file, which is what earns a row its
            // place at the top of the rail while its contents scroll.
            const onPath = activePath !== null
              && (activePath.startsWith(`${entry.path}/`) || activePath.startsWith(`${entry.path}\\`));
            const holdsChanges = gitMarks?.folders.has(entry.path) ?? false;
            const own = privacyMarks?.folders.get(entry.path);
            const lock = own === 'private' || own === 'sealed' ? own : null;
            const name = fitted(label, 'directory', depth, starts[index]!, (lock ? 1 : 0) + (holdsChanges ? 1 : 0));
            return (
              <div className="tree-node" key={entry.path}>
                <button
                  type="button"
                  className={`${onPath ? 'tree-row tree-directory tree-on-path' : 'tree-row tree-directory'}${dropClass(entry.path)}${springClass(entry.path)}${draggedClass(entry.path)}${selectedClass(entry.path)}`}
                  data-testid="tree-directory"
                  data-path={entry.path}
                  role="treeitem"
                  aria-level={depth}
                  tabIndex={entry.path === rowTabStop ? 0 : -1}
                  aria-selected={selected.has(entry.path) || undefined}
                  data-depth={depth}
                  data-label={label}
                  data-cut={name.cut || undefined}
                  title={name.cut ? undefined : [entry.name, ...(lock ? [PRIVACY_WORDS[lock]] : []), ...(holdsChanges ? [GIT_WORDS.folder] : [])].join(', ')}
                  aria-label={name.cut ? [entry.name, ...(lock ? [PRIVACY_WORDS[lock]] : []), ...(holdsChanges ? [GIT_WORDS.folder] : [])].join(', ') : undefined}
                  aria-expanded={isOpen}
                  style={springing === entry.path ? { '--spring-ms': `${SPRING_MS}ms` } as React.CSSProperties : undefined}
                  {...dragProps(entry.path)}
                  {...dropProps(entry.path)}
                  onClick={(event) => {
                    // Option-click makes the folder the rail's root.
                    if (event.altKey) { event.preventDefault(); focusOn(entry.path); return; }
                    if (!choose(event, entry.path) && !revealPinned(event.currentTarget)) toggle(entry.path);
                  }}
                  onContextMenu={(event) => menuFor(event, entry.path, 'directory')}
                >
                  <span className="tree-leading">
                    <span className={isOpen ? 'tree-twisty tree-twisty-open' : 'tree-twisty'} aria-hidden="true" />
                    <FolderGlyph />
                  </span>
                  {editing && editing.intent !== 'new-folder' && editing.path === entry.path
                    ? <NameField initial={entry.name} onDone={commitEdit} />
                    : <span className="tree-name">{name.text}</span>}
                  {lock && <PrivacyMark level={lock} />}
                  {holdsChanges && <GitMark kind="folder" />}
                  {dropClass(entry.path) && <span className="tree-drop-ring" aria-hidden="true" />}
                </button>
                {editing?.intent === 'new-folder' && editing.path === entry.path && (
                  <NewFolderRow depth={depth + 1} onDone={commitEdit} />
                )}
                {isOpen && renderLevel(entry.path, depth + 1)}
              </div>
            );
          }

          const isActive = entry.path === activePath;
          const change = gitMarks?.files.get(entry.path);
          const name = fitted(label, 'file', depth, starts[index]!, change ? 1 : 0);
          return (
            <div className={isActive ? 'tree-node tree-node-active' : 'tree-node'} key={entry.path}>
              <button
                type="button"
                className={`${isActive ? 'tree-row tree-file tree-file-active' : 'tree-row tree-file'}${draggedClass(entry.path)}${selectedClass(entry.path)}`}
                aria-selected={selected.has(entry.path) || undefined}
                data-testid="tree-file"
                data-path={entry.path}
                role="treeitem"
                aria-level={depth}
                tabIndex={entry.path === rowTabStop ? 0 : -1}
                data-depth={depth}
                data-label={label}
                data-cut={name.cut || undefined}
                title={name.cut ? undefined : change ? `${entry.name}, ${GIT_WORDS[change]}` : entry.name}
                aria-label={name.cut ? (change ? `${entry.name}, ${GIT_WORDS[change]}` : entry.name) : undefined}
                aria-current={isActive ? 'true' : undefined}
                {...dragProps(entry.path)}
                {...dropProps(directory)}
                onClick={(event) => { if (!choose(event, entry.path) && !revealPinned(event.currentTarget)) onOpenFile(entry.path); }}
                onContextMenu={(event) => menuFor(event, entry.path, 'file')}
              >
                <span className="tree-leading">
                  <span className="tree-twisty tree-twisty-blank" aria-hidden="true" />
                  <FileGlyph />
                </span>
                {editing && editing.intent !== 'new-folder' && editing.path === entry.path
                  ? <NameField initial={entry.name} onDone={commitEdit} />
                  : <span className="tree-name">{name.text}</span>}
                {change && <GitMark kind={change} />}
              </button>
            </div>
          );
        })}
      </div>
    );
  };

  /**
   * Dragging a row onto a folder moves it, which is how a vault is tidied in
   * every file manager and in Typora's own sidebar.
   *
   * The path travels in the drag as text, and the folder under the pointer is
   * held in state so it can be drawn as the one that will take the drop. Main
   * checks everything: this only says what was dragged onto what. The two
   * pieces of state are declared at the top, with the other hooks.
   */
  /** The drag carries a small pill of the row's glyph and name, not a picture of the row and its guides. */
  const liftImage = (event: React.DragEvent, count: number) => {
    const row = event.currentTarget as HTMLElement;
    const pill = document.createElement('div');
    pill.className = 'tree-drag-pill';
    const glyph = row.querySelector('.tree-glyph');
    if (glyph) pill.append(glyph.cloneNode(true));
    const name = document.createElement('span');
    name.textContent = row.dataset.label ?? row.querySelector('.tree-name')?.textContent ?? '';
    pill.append(name);
    if (count > 1) {
      const more = document.createElement('b');
      more.className = 'tree-drag-count';
      more.textContent = `+${count - 1}`;
      pill.append(more);
    }
    document.body.append(pill);
    try { event.dataTransfer.setDragImage(pill, 14, 14); } catch { /* A drag made in a test has no picture to set. */ }
    setTimeout(() => pill.remove(), 0);
  };

  /** The drag is over. Folders opened for it shut again, but the one it went into and those around it. */
  const finishDrag = (destination: string | null) => {
    const opened = springOpened.current;
    springOpened.current = new Set();
    setDragging(null);
    setOver(null);
    setSpringing(null);
    if (opened.size === 0) return;
    setExpanded((current) => {
      const next = new Set(current);
      for (const folder of opened) {
        const into = destination !== null && (destination === folder || destination.startsWith(`${folder}/`) || destination.startsWith(`${folder}\\`));
        if (!into) next.delete(folder);
      }
      return next;
    });
  };

  const dragProps = (path: string) => (onMoveEntry === undefined ? {} : {
    draggable: true,
    onDragStart: (event: React.DragEvent) => {
      const moving = carried(path, selected);
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', moving.join('\n'));
      liftImage(event, moving.length);
      window.clearTimeout(peekTimer.current);
      peekRow.current = null;
      setPeek(null);
      springOpened.current = new Set();
      setDragging(moving);
    },
    onDragEnd: () => finishDrag(null),
  });

  /**
   * A drop on a folder's row goes into the folder; one on a note's row goes
   * into the note's folder, which lights up, as Finder's list does. The rows
   * are where the pointer is, so the target is as tall as the folder is long.
   */
  const dropProps = (folder: string) => (onMoveEntry === undefined ? {} : {
    onDragOver: (event: React.DragEvent) => {
      // Only our own rows; a file dragged in from the Finder is not this.
      if (dragging === null) return;
      // Rows are passing under the pointer: none is the one meant, and letting go does nothing.
      if (edgeScrolling !== 0) { setOver(null); return; }
      setOver(folder);
      if (dropVerdict(dragging, folder) !== 'move') return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    },
    onDragLeave: (event: React.DragEvent) => {
      // Between two rows the next one says where the pointer is; only leaving the tree clears it.
      const next = event.relatedTarget as Node | null;
      if (next && bodyRef.current?.contains(next)) return;
      setOver((current) => (current === folder ? null : current));
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      const sources = dragging ?? event.dataTransfer.getData('text/plain').split('\n').filter(Boolean);
      finishDrag(folder);
      if (dropVerdict(sources, folder) !== 'move') return;
      // One after another, so each is checked against where the one before landed; main follows their links in one pass.
      void (async () => {
        for (const source of sources) if (dropVerdict(source, folder) === 'move') await onMoveEntry(source, folder);
      })();
      setSelected(new Set());
    },
  });

  const dropClass = (folder: string) => (over === folder && dragging !== null && dropVerdict(dragging, folder) === 'move' ? ' is-drop-target' : '');
  const springClass = (folder: string) => (springing === folder ? ' is-springing' : '');
  const draggedClass = (path: string) => (dragging?.includes(path) ? ' is-dragged' : '');
  const selectedClass = (path: string) => (selected.has(path) ? ' is-selected' : '');

  /**
   * Command-click chooses a row or lets it go, and Shift-click chooses the rows
   * between it and the last one chosen, in the order they are drawn, as in
   * Finder. Neither opens anything. A plain click lets the choice go and does
   * what it always did. The note in front counts as chosen when a choice
   * begins, since it is the row the reader is on. True when the click was a
   * choice and nothing else should happen.
   */
  /** The rows as the page draws them, for the keys (`tree-keys.ts`). */
  const visibleRows = (): HTMLElement[] => Array.from(
    bodyRef.current?.querySelectorAll<HTMLElement>('.tree-row[role="treeitem"][data-path]') ?? [],
  );
  const rowView = (row: HTMLElement): TreeRowView => ({
    path: row.dataset.path!,
    kind: row.classList.contains('tree-directory') ? 'directory' : 'file',
    depth: Number(row.dataset.depth ?? 1),
    open: row.classList.contains('tree-directory') ? row.getAttribute('aria-expanded') === 'true' : undefined,
    label: row.dataset.label ?? row.textContent ?? '',
  });
  const walkTree = (event: React.KeyboardEvent) => {
    if (isComposing(event.nativeEvent) || event.metaKey || event.ctrlKey || event.altKey) return;
    const row = (event.target as Element).closest<HTMLElement>('.tree-row[role="treeitem"]');
    if (!row) return;
    const rows = visibleRows();
    const at = rows.indexOf(row);
    if (at < 0) return;
    let typed = '';
    if (event.key.length === 1 && event.key !== ' ') {
      const now = Date.now();
      const held = typedRef.current;
      typed = now - held.at < 700 ? held.text + event.key : event.key;
      typedRef.current = { text: typed, at: now };
    }
    const move = treeMove(rows.map(rowView), at, event.key, typed);
    if (move.kind === 'none') return;
    event.preventDefault();
    if (move.kind === 'focus') {
      const next = rows[move.index]!;
      setTabStop(next.dataset.path!);
      next.focus();
      next.scrollIntoView({ block: 'nearest' });
    } else if (move.kind === 'expand' || move.kind === 'collapse') {
      toggle(move.path);
    } else {
      onRename?.(move.path);
    }
  };

  const choose = (event: React.MouseEvent, path: string): boolean => {
    if (event.metaKey || event.ctrlKey) {
      setSelected((current) => {
        const next = new Set(current);
        if (next.size === 0 && activePath && activePath !== path) next.add(activePath);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      anchorRef.current = path;
      return true;
    }
    if (event.shiftKey) {
      const from = anchorRef.current ?? activePath;
      const order = Array.from(bodyRef.current?.querySelectorAll<HTMLElement>('.tree-row[data-path]') ?? []).map((row) => row.dataset.path!);
      if (from) {
        setSelected(new Set(rangeOf(order, from, path)));
        return true;
      }
    }
    if (selected.size > 0) setSelected(new Set());
    anchorRef.current = path;
    return false;
  };

  /** What the right button is pressed on: the row, and the rows chosen with it when it is one of them. */
  const menuFor = (event: React.MouseEvent, path: string, kind: 'file' | 'directory') => {
    event.preventDefault();
    const also = selected.has(path) && selected.size > 1 ? [...selected].filter((other) => other !== path) : undefined;
    onRowMenu(path, kind, also);
  };

  const commitEdit = (name: string | null) => onEditingDone?.(name);

  const vaultName = rootName ?? root.split(/[\\/]/).filter(Boolean).at(-1) ?? root;
  const vaultLock = privacyMarks?.vault === 'private' || privacyMarks?.vault === 'sealed' ? privacyMarks.vault : null;

  const topLock = focus === null
    ? vaultLock
    : ((own) => (own === 'private' || own === 'sealed' ? own : null))(privacyMarks?.folders.get(focus));
  const upFrom = focus === null ? null : parentOf(focus);
  const goUp = () => focusOn(upFrom === null || upFrom === root ? null : upFrom);
  const rootStyle = {
    '--tree-indent-now': `${step - TREE_STEP_MARGIN}px`,
    '--tree-held-top': focus === null ? '0px' : 'var(--tree-focusbar)',
  } as React.CSSProperties;

  return (
    <div className={`tree-root${heldFolders === 'trail' ? ' is-trail' : ''}${focus !== null ? ' is-focused' : ''}`}
      data-testid="file-tree" style={rootStyle}>
      {dragging !== null && <div ref={edgeUp} className="tree-edge tree-edge-up" aria-hidden="true" />}
      {failed && <p role="alert" className="tree-error">{failed}</p>}
      {focus !== null && (
        <div className="tree-focusbar" data-testid="tree-focusbar">
          <button type="button" className="tree-focus-button" data-testid="tree-focus-up"
            title="Up one folder (⌘↑)" aria-label="Up one folder" onClick={goUp}><UpGlyph /></button>
          <TreePath parts={[root, ...foldersBetween(root, focus)]} name={(part) => (part === root ? vaultName : baseName(part))}
            onPick={(part) => focusOn(part === root ? null : part)} trailing testId="tree-focus-path" />
          <button type="button" className="tree-focus-button" data-testid="tree-focus-close"
            title={`Show all of ${vaultName} (Esc)`} aria-label={`Show all of ${vaultName}`}
            onClick={() => focusOn(null)}><CloseGlyph /></button>
        </div>
      )}
      {heldFolders === 'trail' && (
        <div className="tree-trail" data-testid="tree-trail" data-on={trail.length > 0 || undefined}
          aria-hidden={trail.length === 0 || undefined}>
          <TreePath parts={trail} name={baseName} onPick={jumpTo} strongLast testId="tree-trail-path" />
          {trail.length > 0 && (
            <button type="button" className="tree-focus-button" data-testid="tree-trail-focus"
              title={`Focus on ${baseName(trail[trail.length - 1]!)}`} aria-label={`Focus on ${baseName(trail[trail.length - 1]!)}`}
              onClick={() => focusOn(trail[trail.length - 1]!)}><FocusGlyph /></button>
          )}
        </div>
      )}
      {/* Keyed on the folder it is drawn from, so a change of focus draws it
          anew and slides it in from the side the focus went. */}
      <nav className="tree-body" ref={bodyRef} key={top} data-way={focusWay ?? undefined} tabIndex={-1}
        role="tree" aria-label={`Files in ${focus === null ? vaultName : baseName(focus)}`}
        onFocus={(event) => {
          const row = (event.target as Element).closest<HTMLElement>('.tree-row[role="treeitem"]');
          if (row?.dataset.path && row.dataset.path !== tabStop) setTabStop(row.dataset.path);
        }}
        onKeyDown={(event) => {
          if ((event.target as Element).closest('.tree-name-field')) return;
          if (event.key === 'Escape' && selected.size > 0) { event.preventDefault(); setSelected(new Set()); return; }
          if (event.key === 'Escape' && focus !== null) { event.preventDefault(); focusOn(null); return; }
          if (event.key === 'ArrowUp' && (event.metaKey || event.ctrlKey) && focus !== null) { event.preventDefault(); goUp(); return; }
          walkTree(event);
        }}
        onPointerOver={(event) => {
          const row = (event.target as Element).closest<HTMLElement>('.tree-row');
          if (row === peekRow.current) return;
          peekRow.current = row;
          window.clearTimeout(peekTimer.current);
          setPeek(null);
          if (!row || row.dataset.cut === undefined || dragging !== null) return;
          peekTimer.current = window.setTimeout(() => {
            const shown = row.querySelector<HTMLElement>('.tree-name');
            if (!shown || !row.isConnected) return;
            const text = shown.getBoundingClientRect();
            const line = row.getBoundingClientRect();
            setPeek({ text: row.dataset.label ?? shown.textContent ?? '', left: text.left, top: line.top, height: line.height });
          }, PEEK_MS);
        }}
        // A press puts the whole name away; it comes back only after the pointer leaves the row and returns.
        onPointerDown={() => { window.clearTimeout(peekTimer.current); setPeek(null); }}
        onPointerLeave={() => { peekRow.current = null; window.clearTimeout(peekTimer.current); setPeek(null); }}>
        {/* The folder itself is the first row, and the first level hangs from
            it: a tree whose lines begin one level down reads as a list with a
            tree inside it. Under a focus, the focused folder stands there. */}
        <div className="tree-node tree-vault">
          {/* No twisty column here, unlike every other row. The root cannot be
              collapsed, so the column would be permanently blank, and the guide
              line that descends from this row is drawn down the middle of that
              column: it would hang from empty space beside the folder rather
              than from the folder. Dropping the column puts the icon where the
              line starts. */}
          <div className={`tree-row tree-directory tree-vault-row${focus !== null ? ' is-focus-root' : ''}${dropClass(top)}`}
            data-testid="tree-vault" data-focus-root={focus ?? undefined}
            data-depth={0} title={topLock ? `${top}, ${PRIVACY_WORDS[topLock]}` : top} {...dropProps(top)}
            onContextMenu={(event) => { event.preventDefault(); onRowMenu(top, 'directory'); }}>
            <FolderGlyph />
            <span className="tree-name">{focus === null ? vaultName : baseName(focus)}</span>
            {topLock && <PrivacyMark level={topLock} />}
            {focus === null && vaultMenu}
            {dropClass(top) && <span className="tree-drop-ring" aria-hidden="true" />}
          </div>
          {/* A folder made at the top: the vault's own row is not one of the
              rows the level draws, so the field would have had nowhere to go. */}
          {editing?.intent === 'new-folder' && editing.path === top && (
            <NewFolderRow depth={1} onDone={commitEdit} />
          )}
          {renderLevel(top, 1)}
        </div>
      </nav>
      {dragging !== null && (
        <div className="tree-drop-chip" role="status" data-testid="tree-drop-chip"
          data-verdict={edgeScrolling !== 0 ? 'scrolling' : over === null ? 'none' : dropVerdict(dragging, over)}>
          {dropWords(dragging, over, root, vaultName, edgeScrolling)}
        </div>
      )}
      {dragging === null && selected.size > 1 && (
        <div className="tree-drop-chip is-choice" role="status" data-testid="tree-choice-chip">
          {selected.size} chosen · drag to move · Esc to let go
        </div>
      )}
      {dragging !== null && <div ref={edgeDown} className="tree-edge tree-edge-down" aria-hidden="true" />}
      {/* Over the page, so the rail's edge cannot cut it: set where the cut name stands, in its own face. */}
      {peek && createPortal(
        <div className="tree-peek" data-testid="tree-peek" aria-hidden="true"
          style={{ left: peek.left - 7, top: peek.top, height: peek.height, maxWidth: `calc(100vw - ${Math.round(peek.left + 9)}px)` }}>
          {peek.text}
        </div>,
        document.body,
      )}
    </div>
  );
}

/**
 * A path in one row, outermost first. When it does not fit, its outer parts
 * fold into one "…" that still leads to the last of them, so the folders
 * nearest the reader stay readable.
 */
function TreePath({ parts, name, onPick, strongLast = false, trailing = false, testId }: {
  readonly parts: readonly string[];
  readonly name: (part: string) => string;
  readonly onPick: (part: string) => void;
  readonly strongLast?: boolean;
  /** A separator after the last part, for a path that leads on to the row below it. */
  readonly trailing?: boolean;
  readonly testId: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const sig = parts.join('\n');
  const [fold, setFold] = useState({ sig, count: 0 });
  const folded = fold.sig === sig ? fold.count : 0;
  // One more part folds on each pass until the row fits or only the last is left.
  useLayoutEffect(() => {
    const element = box.current;
    if (element && element.scrollWidth > element.clientWidth + 1 && parts.length - folded > 1) setFold({ sig, count: folded + 1 });
  });
  // A wider rail may fit what was folded: start over when the width changes.
  useLayoutEffect(() => {
    const element = box.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      setFold({ sig: '', count: 0 });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const last = parts[parts.length - 1];
  return (
    <div className="tree-path" ref={box} data-testid={testId}>
      {folded > 0 && (
        <>
          <button type="button" className="tree-path-part" data-folded=""
            title={parts.slice(0, folded).map(name).join(' / ')} onClick={() => onPick(parts[folded - 1]!)}>…</button>
          <span className="tree-path-sep" aria-hidden="true">/</span>
        </>
      )}
      {parts.slice(folded).map((part, index) => (
        <Fragment key={part}>
          {index > 0 && <span className="tree-path-sep" aria-hidden="true">/</span>}
          <button type="button" className={strongLast && part === last ? 'tree-path-part is-last' : 'tree-path-part'}
            title={name(part)} onClick={() => onPick(part)}>{name(part)}</button>
        </Fragment>
      ))}
      {trailing && parts.length > 0 && <span className="tree-path-sep" aria-hidden="true">/</span>}
    </div>
  );
}

/** Corner brackets round a point: a folder brought into focus. */
function FocusGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3" />
      <circle cx="8" cy="8" r="1.7" fill="currentColor" stroke="none" />
    </svg>
  );
}

function UpGlyph() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3.6M4.2 7.2 8 3.4l3.8 3.8" /></svg>;
}

function CloseGlyph() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>;
}

/*
 * The glyphs that make a row of names read as files rather than as an
 * outline. Drawn inline, so they inherit the row's colour and need no asset.
 * A folder is the same solid shape open or shut, as Typora's is: the twisty
 * says which. A lifted flap drawn in the panel colour came out at 15px as a
 * pale stripe across the lower half, a two-tone smudge beside the name.
 */
export function FolderGlyph() {
  return (
    <svg className="tree-glyph tree-glyph-folder" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M1.5 4.25a1 1 0 0 1 1-1h3.2l1.4 1.5h6.4a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />
    </svg>
  );
}

export function FileGlyph() {
  return (
    <svg className="tree-glyph" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.25 1.75h5l3 3v9.5h-8z" />
      <path d="M9.25 1.75v3h3" />
      {/* The lines of text, which is what makes it a document rather than a
          blank sheet and is how the theme's icon font draws it. */}
      <path d="M6.25 8h4M6.25 10.5h4" />
    </svg>
  );
}

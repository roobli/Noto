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

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { WorkspaceEntryV1, WorkspaceGitChangeV1 } from '../shared/workspace/v1/contracts';
import { branchToCurrentFile, sizeTreeGuides, startTreeGuides } from './tree-guides';

export interface FileTreeProps {
  readonly root: string | null;
  readonly rootName: string | null;
  /** Path of the document in front, so the tree can show where you are. */
  readonly activePath: string | null;
  readonly list: (directory: string) => Promise<readonly WorkspaceEntryV1[]>;
  readonly onOpenFile: (filePath: string) => void;
  /** A press of the right button on a row: main draws the menu for it. */
  readonly onRowMenu: (rowPath: string, kind: 'file' | 'directory') => void;
  readonly onChooseFolder: () => void;
  /**
   * A row dragged onto a folder. Absent while no folder is open, in which
   * case the rows are not draggable at all.
   */
  readonly onMoveEntry?: (source: string, destination: string) => void;
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
  /** Bumped to shut every folder, which is Typora's Collapse All. */
  readonly collapseToken?: number;
  /**
   * Which notes differ from the last commit, when the folder is in a git
   * repository; null when it is not. See `TreeGitMarks`.
   */
  readonly gitMarks?: TreeGitMarks | null;
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
function GitMark({ kind }: { kind: WorkspaceGitChangeV1 | 'folder' }) {
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

/** The height of one row, which the sticky offsets are multiples of. */
export const TREE_ROW_HEIGHT = 32;

export function FileTree({
  root, rootName, activePath, list, onOpenFile, onRowMenu, onChooseFolder, onMoveEntry, vaultMenu,
  editing = null, onEditingDone, reloadToken = 0, collapseToken = 0, gitMarks = null,
}: FileTreeProps) {
  const [children, setChildren] = useState<ReadonlyMap<string, readonly WorkspaceEntryV1[]>>(new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState<string | null>(null);
  // Which row is being dragged and which folder is under it. Declared here,
  // with every other hook, because the tree returns early while no folder is
  // open and React needs the same hooks on every render.
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  // Collapse All: every folder shut at once, which a tree of seven thousand
  // notes needs after an afternoon of opening things. The first render is not
  // one, so the token is compared rather than acted on.
  const collapsedAt = useRef(collapseToken);
  useEffect(() => {
    if (collapsedAt.current === collapseToken) return;
    collapsedAt.current = collapseToken;
    setExpanded(new Set());
  }, [collapseToken]);
  const bodyRef = useRef<HTMLElement>(null);

  /*
   * The tree scrolls sideways for long names. In the narrow-window overlay the
   * pane is much smaller, so an offset chosen at desktop width would leave the
   * twisty and glyph column off-screen and the rows would read as bare words.
   */
  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 900px)');
    const reset = () => {
      if (!narrow.matches) return;
      const scroller = bodyRef.current?.closest<HTMLElement>('.rail-view');
      if (scroller) scroller.scrollLeft = 0;
    };
    reset();
    narrow.addEventListener('change', reset);
    return () => narrow.removeEventListener('change', reset);
  }, []);

  const load = useCallback(async (directory: string) => {
    try {
      const entries = await list(directory);
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
    setFailed(null);
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
   * The tree holds a listing per folder and nothing on disk tells it when one
   * went stale. After a rename, a duplicate or a trash, every listing already
   * on screen is suspect, and re-reading only the folder that changed would
   * leave a moved file showing in its old place.
   */
  useEffect(() => {
    if (reloadToken === 0) return;
    for (const directory of [...childrenRef.current.keys()]) void load(directory);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken]);
  useEffect(() => {
    if (!root || !activePath) return;
    const separator = root.includes('\\') ? '\\' : '/';
    const prefix = root.endsWith(separator) ? root : `${root}${separator}`;
    if (!activePath.startsWith(prefix)) return;
    const ancestors: string[] = [];
    for (let index = activePath.indexOf(separator, prefix.length); index !== -1; index = activePath.indexOf(separator, index + 1)) {
      ancestors.push(activePath.slice(0, index));
    }
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

  /** The file last scrolled into view, so a tree change never scrolls the rail again. */
  const shownRef = useRef<string | null>(null);

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
    };
    const onScroll = () => { if (frame === 0) frame = requestAnimationFrame(mark); };
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
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [children, expanded, root, activePath]);

  if (!root) {
    return (
      <div className="tree-root is-empty" data-testid="file-tree">
        <p className="rail-empty">No folder open yet.</p>
        <button type="button" className="tree-choose" data-testid="choose-folder"
          onClick={onChooseFolder}>Open a folder…</button>
      </div>
    );
  }

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
            <p className={entries ? 'tree-row tree-empty' : 'tree-row tree-loading'}>
              {entries ? 'Nothing here.' : 'Reading…'}
            </p>
          </div>
        </div>
      );
    }

    return (
      <div className="tree-level" style={{ '--tree-depth': depth } as React.CSSProperties}>
        {entries.map((entry) => {
          if (entry.kind === 'directory') {
            const isOpen = expanded.has(entry.path);
            // On the path to the current file, which is what earns a row its
            // place at the top of the rail while its contents scroll.
            const onPath = activePath !== null
              && (activePath.startsWith(`${entry.path}/`) || activePath.startsWith(`${entry.path}\\`));
            const holdsChanges = gitMarks?.folders.has(entry.path) ?? false;
            return (
              <div className="tree-node" key={entry.path}>
                <button
                  type="button"
                  className={`${onPath ? 'tree-row tree-directory tree-on-path' : 'tree-row tree-directory'}${dropClass(entry.path)}`}
                  data-testid="tree-directory"
                  data-depth={depth}
                  title={holdsChanges ? `${entry.name}, ${GIT_WORDS.folder}` : entry.name}
                  aria-expanded={isOpen}
                  {...dragProps(entry.path)}
                  {...dropProps(entry.path)}
                  onClick={() => toggle(entry.path)}
                  onContextMenu={(event) => { event.preventDefault(); onRowMenu(entry.path, 'directory'); }}
                >
                  <span className="tree-leading">
                    <span className={isOpen ? 'tree-twisty tree-twisty-open' : 'tree-twisty'} aria-hidden="true" />
                    <FolderGlyph open={isOpen} />
                  </span>
                  {editing && editing.intent !== 'new-folder' && editing.path === entry.path
                    ? <NameField initial={entry.name} onDone={commitEdit} />
                    : <span className="tree-name">{entry.name}</span>}
                  {holdsChanges && <GitMark kind="folder" />}
                </button>
                {editing?.intent === 'new-folder' && editing.path === entry.path && (
                  <div className="tree-level" style={{ '--tree-depth': depth + 1 } as React.CSSProperties}>
                    <div className="tree-node">
                      <div className="tree-row tree-directory" data-depth={depth + 1}>
                        <span className="tree-leading">
                          <span className="tree-twisty tree-twisty-blank" aria-hidden="true" />
                          <FolderGlyph open={false} />
                        </span>
                        <NameField initial="New Folder" onDone={commitEdit} />
                      </div>
                    </div>
                  </div>
                )}
                {isOpen && renderLevel(entry.path, depth + 1)}
              </div>
            );
          }

          const isActive = entry.path === activePath;
          const change = gitMarks?.files.get(entry.path);
          return (
            <div className={isActive ? 'tree-node tree-node-active' : 'tree-node'} key={entry.path}>
              <button
                type="button"
                className={isActive ? 'tree-row tree-file tree-file-active' : 'tree-row tree-file'}
                data-testid="tree-file"
                data-path={entry.path}
                title={change ? `${entry.name}, ${GIT_WORDS[change]}` : entry.name}
                aria-current={isActive ? 'true' : undefined}
                {...dragProps(entry.path)}
                onClick={() => onOpenFile(entry.path)}
                onContextMenu={(event) => { event.preventDefault(); onRowMenu(entry.path, 'file'); }}
              >
                <span className="tree-leading">
                  <span className="tree-twisty tree-twisty-blank" aria-hidden="true" />
                  <FileGlyph />
                </span>
                {editing && editing.intent !== 'new-folder' && editing.path === entry.path
                  ? <NameField initial={entry.name} onDone={commitEdit} />
                  : <span className="tree-name">{entry.name}</span>}
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
  const dragProps = (path: string) => (onMoveEntry === undefined ? {} : {
    draggable: true,
    onDragStart: (event: React.DragEvent) => {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', path);
      setDragging(path);
    },
    onDragEnd: () => { setDragging(null); setOver(null); },
  });

  const dropProps = (folder: string) => (onMoveEntry === undefined ? {} : {
    onDragOver: (event: React.DragEvent) => {
      // Only our own rows; a file dragged in from the Finder is not this.
      if (dragging === null || dragging === folder) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setOver(folder);
    },
    onDragLeave: () => setOver((current) => (current === folder ? null : current)),
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      const source = dragging ?? event.dataTransfer.getData('text/plain');
      setDragging(null);
      setOver(null);
      if (source && source !== folder) onMoveEntry(source, folder);
    },
  });

  const dropClass = (folder: string) => (over === folder ? ' is-drop-target' : '');

  const commitEdit = (name: string | null) => onEditingDone?.(name);

  const vaultName = rootName ?? root.split(/[\\/]/).filter(Boolean).at(-1) ?? root;

  return (
    <div className="tree-root" data-testid="file-tree">
      {failed && <p role="alert" className="tree-error">{failed}</p>}
      <nav className="tree-body" ref={bodyRef}>
        {/* The folder itself is the first row, and the first level hangs from
            it: a tree whose lines begin one level down reads as a list with a
            tree inside it. */}
        <div className="tree-node tree-vault">
          {/* No twisty column here, unlike every other row. The root cannot be
              collapsed, so the column would be permanently blank, and the guide
              line that descends from this row is drawn down the middle of that
              column: it would hang from empty space beside the folder rather
              than from the folder. Dropping the column puts the icon where the
              line starts. */}
          <div className={`tree-row tree-directory tree-vault-row${dropClass(root)}`} data-testid="tree-vault"
            data-depth={0} title={root} {...dropProps(root)}>
            <FolderGlyph open />
            <span className="tree-name">{vaultName}</span>
            {vaultMenu}
          </div>
          {renderLevel(root, 1)}
        </div>
      </nav>
    </div>
  );
}

/*
 * The glyphs that make a row of names read as files rather than as an
 * outline. Drawn inline in the title bar's stroke style, so they inherit the
 * row's colour and need no asset; a folder shows a lifted flap when it is
 * open, which repeats what the twisty says in a second place so the eye can
 * take either.
 */
function FolderGlyph({ open }: { open: boolean }) {
  return (
    <svg className="tree-glyph tree-glyph-folder" viewBox="0 0 16 16" aria-hidden="true">
      {/* Filled, as the theme's icon font draws it. The open state shows as
          the flap lifted, not as a rule across the middle. */}
      <path d="M1.5 4.25a1 1 0 0 1 1-1h3.2l1.4 1.5h6.4a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />
      {open && <path className="tree-glyph-flap" d="M1.5 7h13v5.25a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />}
    </svg>
  );
}

function FileGlyph() {
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

/**
 * Workspace: opening, switching and remembering documents.
 *
 * The file-truth contract owns one open document. This one owns which document
 * that is, which is what lets the app open a file from a menu instead of a
 * command line flag.
 *
 * Opens can start in either process: the renderer asks when the user clicks,
 * and main pushes when the user goes through the application menu, the dock, or
 * a file association. Both paths end in the same event, `documentOpened`, so
 * the renderer has one way to adopt a document. An open the renderer asked for
 * also gets a reply, but the reply only names the note: the document itself
 * crosses IPC once, on the event.
 */

import type { FileTruthOpenReplyV1 } from '../../file-truth/v1/contracts';

export const NOTO_WORKSPACE_VERSION = 1 as const;

export const WORKSPACE_CHANNELS = {
  openDialog: 'noto:v1:workspace:open-dialog',
  openPath: 'noto:v1:workspace:open-path',
  saveAsDialog: 'noto:v1:workspace:save-as-dialog',
  recent: 'noto:v1:workspace:recent',
  documentOpened: 'noto:v1:workspace:document-opened',
  /** A non-Markdown file opened in the read-only code viewer, or null to clear. */
  codeViewChanged: 'noto:v1:workspace:code-view-changed',
  documentClosed: 'noto:v1:workspace:document-closed',
  tabsChanged: 'noto:v1:workspace:tabs-changed',
  activateTab: 'noto:v1:workspace:activate-tab',
  closeTab: 'noto:v1:workspace:close-tab',
  openFolder: 'noto:v1:workspace:open-folder',
  listFolder: 'noto:v1:workspace:list-folder',
  folderChanged: 'noto:v1:workspace:folder-changed',
  /** The folder open right now, for a renderer that has just subscribed:
   *  a folder named on the command line opens before the page can listen. */
  folder: 'noto:v1:workspace:folder',
  menuCommand: 'noto:v1:workspace:menu-command',
  pasteText: 'noto:v1:workspace:paste-text',
  noteLinks: 'noto:v1:workspace:note-links',
  /** Says whether the remote control is listening, so the window can show it. */
  remoteChanged: 'noto:v1:workspace:remote-changed',
  /** The renderer saying whether the note in front has unsaved changes. */
  dirtyChanged: 'noto:v1:workspace:dirty-changed',
  /** Every loaded note with unsaved changes, so closing and quitting can ask first. */
  unsavedChanged: 'noto:v1:workspace:unsaved-changed',
  /** Main asking the window for the note's text as the editor holds it. */
  documentText: 'noto:v1:workspace:document-text',
  documentTextReply: 'noto:v1:workspace:document-text-reply',
  /** Main asking the window what its plugins add to a right click at a point. */
  contextItems: 'noto:v1:workspace:context-items',
  contextItemsReply: 'noto:v1:workspace:context-items-reply',
  /** One of those items, chosen: the editor command it names. */
  contextCommand: 'noto:v1:workspace:context-command',
  /** The whole openable file list for the current folder, sent once per
   *  folder so ranking can happen in the renderer without a round trip. */
  fileIndex: 'noto:v1:workspace:file-index',
  recentFolders: 'noto:v1:workspace:recent-folders',
  openRecentFolder: 'noto:v1:workspace:open-recent-folder',
  reveal: 'noto:v1:workspace:reveal',
  openExternal: 'noto:v1:workspace:open-external',
  newFile: 'noto:v1:workspace:new-file',
  treeMenu: 'noto:v1:workspace:tree-menu',
  searchContent: 'noto:v1:workspace:search-content',
  /** Tags from every note's frontmatter, and the notes that share one. */
  tagIndex: 'noto:v1:workspace:tag-index',
  notesByTag: 'noto:v1:workspace:notes-by-tag',
  /** Rename, duplicate, trash or make a folder. See `WorkspaceEntryActionV1`. */
  manageEntry: 'noto:v1:workspace:manage-entry',
  /** Push: something in the tree moved, so a listing on screen is stale. */
  treeChanged: 'noto:v1:workspace:tree-changed',
  /** Push: the reader chose Rename, so the row should offer a field. */
  renameRow: 'noto:v1:workspace:rename-row',
  /** The renderer hands over the drawn document so main can write or print it. */
  exportRendered: 'noto:v1:workspace:export-rendered',
  /** The git marks for the open folder as they stand, for a renderer that has just subscribed. */
  gitMarks: 'noto:v1:workspace:git-marks',
  /** Push: which notes differ from the last commit changed. See `WorkspaceGitMarksV1`. */
  gitMarksChanged: 'noto:v1:workspace:git-marks-changed',
  /** Push: the note in front's blocks against HEAD. See `WorkspaceGitBlocksV1`. */
  gitBlocksChanged: 'noto:v1:workspace:git-blocks-changed',
  /** One note's commits, following renames. See `WorkspaceNoteHistoryReplyV1`. */
  noteHistory: 'noto:v1:workspace:note-history',
  /** Which of a note's commits changed one passage of it. See `WorkspaceNotePassageReplyV1`. */
  notePassage: 'noto:v1:workspace:note-passage',
  /** The newest commits that changed anything under a folder. See `WorkspaceFolderHistoryReplyV1`. */
  folderHistory: 'noto:v1:workspace:folder-history',
  /** Push: after a move, the links that named the old place were written again. See `WorkspaceLinksFollowedV1`. */
  linksFollowed: 'noto:v1:workspace:links-followed',
  /** Take back the links written after the last move. See `WorkspaceUndoLinksReplyV1`. */
  undoLinks: 'noto:v1:workspace:undo-links',
  /** Push: Get Info was chosen on a folder in the tree, so the info pane turns to it. */
  showFolderInfo: 'noto:v1:workspace:show-folder-info',
  focusFolder: 'noto:v1:workspace:focus-folder',
  /** One note's text as one of its commits had it. */
  noteVersion: 'noto:v1:workspace:note-version',
  notePreview: 'noto:v1:workspace:note-preview',
  /** What the folder's memory knows about one note. See `WorkspaceNoteMemoryReplyV1`. */
  noteMemory: 'noto:v1:workspace:note-memory',
  /** Begin keeping memory for the open folder, as `noto-vault init` would, once main has asked the person. */
  keepMemory: 'noto:v1:workspace:keep-memory',
  /** Let the open folder's memory run its scripts, once main has asked the person, naming them. */
  trustMemory: 'noto:v1:workspace:trust-memory',
  /** The agents the open folder's memory names, and adding one or taking its key back. See `WorkspaceAgentActionV1`. */
  memoryAgents: 'noto:v1:workspace:memory-agents',
  /** Privacy as the window draws it: the tree's locks, and the note in front's own. See `WorkspaceMemoryPrivacyReplyV1`. */
  memoryPrivacy: 'noto:v1:workspace:memory-privacy',
  /** The open folder's memory itself: its index, the read record, and turning it off. See `WorkspaceMemoryFolderActionV1`. */
  memoryFolder: 'noto:v1:workspace:memory-folder',
  /** A question of the folder's memory in words, answered with its context pack. See `WorkspaceMemoryAskReplyV1`. */
  memoryAsk: 'noto:v1:workspace:memory-ask',
  /** What the folder's memory knows about one folder in it: warmth, reads, notes linked to nothing, broken links. */
  folderMemory: 'noto:v1:workspace:folder-memory',
  /** Review: the folder-wide queue of what agents proposed and what the tools found. See `WorkspaceReviewActionV1`. */
  memoryReview: 'noto:v1:workspace:memory-review',
  /** Push: the folder's memory opened or changed, so what was asked of it may be asked again. */
  memoryChanged: 'noto:v1:workspace:memory-changed',
} as const;

/** One entry in the workspace tree. */
export interface WorkspaceEntryV1 {
  readonly name: string;
  readonly path: string;
  readonly kind: 'file' | 'directory';
  /** When the file was last written, in milliseconds. */
  readonly modifiedMs: number;
}

export interface WorkspaceFolderRequestV1 extends WorkspaceRequestV1 {
  /** The directory to list. Main confines it to the chosen root. */
  readonly path: string;
}

export interface WorkspaceFolderReplyV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly entries: readonly WorkspaceEntryV1[];
}

/** The chosen folder, or null when there is none. */
export interface WorkspaceFolderEventV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly root: string | null;
  readonly name: string | null;
  /**
   * Whether the reader asked for this folder, rather than it arriving with a
   * note opened on its own. Only a folder that was asked for shows the tree;
   * the other kind would open the rail against the reader's own setting.
   */
  readonly chosen: boolean;
}

/**
 * One open document.
 *
 * Carries the document id as well as the path because the renderer keys its
 * editors on the id: a tab has to be matched to the editor already holding that
 * document, or switching tabs would rebuild it and lose the user's history.
 */
export interface WorkspaceTabV1 {
  readonly path: string;
  readonly name: string;
  readonly documentId: string;
  readonly active: boolean;
  /**
   * A counter that rises each time this document is brought forward.
   *
   * Not a clock: nothing here needs to know when, only which came after which,
   * and a counter cannot be made to go backwards by the machine's clock moving.
   * The list itself stays in the order the documents were opened, because that
   * is the order the neighbour is chosen from when one is closed.
   */
  readonly activatedAt: number;
}

export interface WorkspaceTabsEventV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly tabs: readonly WorkspaceTabV1[];
}

/** Sent when the last document closes, so the renderer returns to empty. */
export interface WorkspaceClosedEventV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
}

export interface WorkspaceRequestV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly requestId: string;
}

export interface WorkspaceOpenPathRequestV1 extends WorkspaceRequestV1 {
  readonly path: string;
  /** The note this one was reached from, by a link; recorded for the vault's memory. */
  readonly from?: string;
}

/** Activating or closing a tab, both identified by path. */
export interface WorkspaceTabRequestV1 extends WorkspaceRequestV1 {
  readonly path: string;
  /**
   * A note the renderer let go to stay under its loaded limit, not one the
   * reader closed, so Reopen Closed File does not offer it.
   */
  readonly release?: boolean;
}

export interface RecentFileV1 {
  readonly path: string;
  readonly name: string;
  /** Epoch milliseconds of the last open, used only for ordering. */
  readonly openedAt: number;
}

export interface WorkspaceRecentReplyV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly files: readonly RecentFileV1[];
}

/** `null` means the user dismissed the dialog, which is not a failure. */
/** A non-Markdown file shown in the read-only code viewer. */
export interface WorkspaceCodeViewV1 {
  readonly path: string;
  readonly name: string;
  /** Prism / fence language id; empty string means plain text. */
  readonly language: string;
  /** File body, or empty when `notice` explains why it was not loaded. */
  readonly content: string;
  /** Binary, oversized, or read failure — shown instead of the body. */
  readonly notice: string | null;
  /** True when lines past the viewer cap were omitted. */
  readonly truncated: boolean;
}

export interface WorkspaceCodeViewEventV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  /** The view to show, or null when the viewer should close. */
  readonly codeView: WorkspaceCodeViewV1 | null;
}

/**
 * Which note an open or a tab switch brought to the front.
 *
 * Not the document. Every open and activation publishes the full
 * `FileTruthOpenReplyV1` on `documentOpened` before it replies, and that event
 * is what the renderer adopts. Echoing the document in the reply as well sent
 * an 8 MB note across IPC twice, and the preload verified both copies against
 * the envelope hash, which made the second copy a few hundred milliseconds of
 * open spent on a document nothing read.
 */
export interface WorkspaceOpenedNoteV1 {
  readonly path: string;
  readonly documentId: string;
}

export type WorkspaceOpenReplyV1 =
  | { readonly version: typeof NOTO_WORKSPACE_VERSION; readonly opened: WorkspaceOpenedNoteV1 }
  | { readonly version: typeof NOTO_WORKSPACE_VERSION; readonly opened: null }
  | { readonly version: typeof NOTO_WORKSPACE_VERSION; readonly codeView: WorkspaceCodeViewV1 };

export interface WorkspaceSaveAsReplyV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  /** What the user chose, for showing; null when they dismissed the dialog. */
  readonly path: string | null;
  /** What a save-copy request hands back to write there; null with `path`. */
  readonly token: string | null;
}

/**
 * Commands the application menu raises that the renderer has to carry out,
 * because only the renderer knows the editor's current contents.
 */
/**
 * Every command the menu can send the renderer.
 *
 * A value rather than a bare type union, because the preload has to check an
 * incoming command against something at runtime and it was checking against a
 * hand-copied list. The two drifted: `widen` and `narrow` reached the menu, the
 * validator did not know them, and the items fired into a dropped message. One
 * list means the type and the check cannot disagree again.
 */
export const WORKSPACE_MENU_COMMANDS = [
  'save',
  'save-as',
  'save-and-close',
  'undo',
  'redo',
  'settings',
  'find',
  'find-replace',
  'find-next',
  'find-previous',
  'toggle-source',
  'source-code-mode',
  'select-all',
  'select-word',
  'select-line',
  'jump-to-selection',
  'select-scope',
  'tree-sort-name',
  'tree-sort-name-desc',
  'tree-sort-modified',
  'tree-sort-modified-old',
  'tree-collapse-all',
  'shortcuts',
  'insert-comment',
  'indent-more',
  'indent-less',
  'block-paragraph',
  'block-heading-1',
  'block-heading-2',
  'block-heading-3',
  'block-heading-4',
  'block-heading-5',
  'block-heading-6',
  'block-heading-up',
  'block-heading-down',
  'block-code',
  'block-math',
  'block-quote',
  'block-ordered-list',
  'block-bullet-list',
  'block-task-list',
  'task-toggle',
  'task-complete',
  'task-incomplete',
  'sort-tasks',
  'block-rule',
  'mark-underline',
  'mark-highlight',
  'mark-math',
  'table-insert',
  'table-align-left',
  'table-align-center',
  'table-align-right',
  'table-align-none',
  'table-row-above',
  'table-row-below',
  'table-column-before',
  'table-column-after',
  'table-row-delete',
  'table-column-delete',
  'table-delete',
  'table-prettify',
  'table-copy',
  'move-up',
  'move-down',
  'move-column-left',
  'move-column-right',
  'insert-link',
  'insert-image',
  'insert-footnote',
  'insert-toc',
  'insert-frontmatter',
  'insert-link-reference',
  'insert-timeline',
  'reload-from-disk',
  'toggle-always-on-top',
  'toggle-read-only',
  'copy-as-markdown',
  'copy-as-html',
  'copy-as-plain',
  'line-endings-lf',
  'line-endings-crlf',
  'toggle-final-newline',
  'export-pdf',
  'export-html',
  'export-html-plain',
  'export-docx',
  'export-odt',
  'export-rtf',
  'export-epub',
  'export-latex',
  'export-mediawiki',
  'export-rst',
  'export-textile',
  'export-opml',
  'new-file',
  'new-folder',
  'mark-strong',
  'mark-emphasis',
  'mark-code',
  'mark-strike',
  'clear-format',
  'block-alert-note',
  'block-alert-tip',
  'block-alert-important',
  'block-alert-warning',
  'block-alert-caution',
  'toggle-focus-mode',
  'toggle-git-marks',
  'toggle-note-marks',
  'toggle-typewriter',
  'toggle-outline',
  'toggle-note-info',
  'show-note-info',
  'command-palette',
  'toggle-sidebar',
  'widen',
  'narrow',
  'quick-open',
  'reveal-document',
  'search-content',
  'navigate-back',
  'navigate-forward',
  'browse-tags',
] as const;

export type WorkspaceMenuCommandV1 = typeof WORKSPACE_MENU_COMMANDS[number];

/**
 * What to show in the system file manager.
 *
 * A kind rather than a path. Main already knows which folder is open and which
 * document is in front, so the renderer never names a location and a compromised
 * one cannot point this at somewhere it was not already looking. The whole
 * capability is then "open the file manager at something this window is already
 * showing you", which is small enough to reason about.
 */
export type WorkspaceRevealTargetV1 = 'folder' | 'document';

export interface WorkspaceRevealRequestV1 extends WorkspaceRequestV1 {
  readonly target: WorkspaceRevealTargetV1;
}

export interface WorkspaceRevealReplyV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  /** False when there was nothing of that kind to show. */
  readonly revealed: boolean;
}

/**
 * A link the reader followed out of a note.
 *
 * The scheme is checked here and again in main. The renderer is the least
 * trusted side of this application and the URL comes out of somebody's file,
 * so `shell.openExternal` must never see a string this side has only glanced
 * at: it hands the URL to the operating system, which will open far more than
 * a browser if the scheme asks it to.
 */
export interface WorkspaceOpenExternalRequestV1 extends WorkspaceRequestV1 {
  readonly url: string;
}

export interface WorkspaceOpenExternalReplyV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  /** False when the scheme was not one this opens. */
  readonly opened: boolean;
}

/**
 * Make a new note.
 *
 * The renderer names no path. Where the note goes is main's decision, taken
 * from the folder that is open, and the name is the first free one there. A
 * request that could name its own path would be a request to write anywhere
 * the application can reach.
 */
export interface WorkspaceNewFileReplyV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly created: boolean;
  /** Absent when there was nowhere to put it. */
  readonly path: string | null;
}

/**
 * Show the menu for a row of the file tree.
 *
 * The renderer names the row it was pressed on and main draws the menu, so
 * every action on it runs where the filesystem is. The path is re-resolved and
 * checked against the open folder before anything is shown: a renderer that
 * named a path outside it gets nothing.
 */
export interface WorkspaceTreeMenuRequestV1 extends WorkspaceRequestV1 {
  readonly path: string;
  readonly kind: 'file' | 'directory';
  /**
   * The other rows chosen with it, when it is one of several: the menu is then
   * for all of them (move them, trash them, copy their paths). Each is checked
   * against the open folder as `path` is.
   */
  readonly also?: readonly string[];
}

export interface WorkspaceTreeMenuReplyV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  /**
   * Whether the row was one main will draw a menu for. The answer is sent
   * before the menu opens, because a native menu holds the input loop until
   * it is dismissed and a reply behind it would not arrive until then.
   */
  readonly accepted: boolean;
}

/** One line of a file that holds the query. */
/**
 * The four things a row of the tree can have done to it.
 *
 * One channel rather than four, because all four take a target and at most a
 * name, and the difference between them is a decision main makes rather than a
 * different shape of message. The action is checked against this list on both
 * sides, so an unknown one is refused rather than falling through to a default.
 */
export const ENTRY_ACTIONS = ['rename', 'duplicate', 'trash', 'new-folder', 'move', 'move-into', 'new-note'] as const;

export type WorkspaceEntryActionV1 = (typeof ENTRY_ACTIONS)[number];

export interface WorkspaceEntryRequestV1 extends WorkspaceRequestV1 {
  readonly action: WorkspaceEntryActionV1;
  /** The row acted on. For `new-folder`, the folder to make one inside. */
  readonly target: string;
  /**
   * One name segment, never a path.
   *
   * Required for `rename` and `new-folder`, absent for the other two. Main
   * joins it to a parent it resolved itself, so the renderer cannot name a
   * destination even by accident.
   */
  readonly name: string | null;
  /**
   * The folder something is dropped into, for `move-into`, and null for
   * every other action.
   *
   * The renderer names it because the tree is what was dragged onto, and
   * main resolves it against the open folder exactly as it resolves the
   * target: a path from the renderer is a request, never an authority.
   */
  readonly destination: string | null;
}

/** Why an action did nothing. Each one is a sentence the reader can act on. */
export type WorkspaceEntryRefusalV1 =
  | 'no-folder'
  | 'outside-root'
  | 'bad-name'
  | 'exists'
  | 'unsaved-changes'
  | 'busy'
  | 'trash-failed'
  | 'into-itself'
  | 'failed';

export type WorkspaceEntryReplyV1 =
  | {
      readonly version: typeof NOTO_WORKSPACE_VERSION;
      readonly done: true;
      /** Where the entry ended up, so the tree can reveal it. */
      readonly path: string;
    }
  | {
      readonly version: typeof NOTO_WORKSPACE_VERSION;
      readonly done: false;
      readonly reason: WorkspaceEntryRefusalV1;
    };

/**
 * Asks the tree to put a field on one row.
 *
 * The name is typed where the row is, not in a dialog, because the row is
 * where the reader is looking and a dialog would hide the neighbours whose
 * names are the reason they are renaming this one.
 */
/** How a note differs from the last commit. Staged or not is git's distinction, not a reader's. */
export type WorkspaceGitChangeV1 = 'modified' | 'new' | 'deleted';

export const GIT_CHANGES: readonly WorkspaceGitChangeV1[] = ['modified', 'new', 'deleted'];

/** More marks than this and main sends none: the repository is too big to mark. */
export const MAX_GIT_MARKS = 20_000;

/**
 * Which notes in the open folder differ from the last commit, when the folder
 * is in a git repository. Empty when it is not, when git is missing, or when
 * the repository is too big to read quickly: absent, never an error.
 *
 * Paths are absolute, as the tree's rows carry them. A deleted note has no
 * row; it is listed so its folders can say something inside changed.
 */
export interface WorkspaceGitMarksV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  /** The folder these are for, so a late answer for another folder is dropped. */
  readonly root: string | null;
  readonly files: ReadonlyArray<readonly [string, WorkspaceGitChangeV1]>;
  /** Folders, below the open one, holding a change somewhere inside. */
  readonly folders: readonly string[];
  /**
   * True once git has been read for the folder; absent otherwise (not in a
   * repository, git missing, too slow). Lets "nothing changed" be told from
   * "nothing known".
   */
  readonly repository?: true;
  /**
   * The folder as the file system names it, links and Windows short names
   * resolved. Every path in `files` and `folders` is under it, as the file
   * tree's paths are, and it differs from `root` when the folder was opened
   * through another name for it. Sent with `repository`.
   */
  readonly realRoot?: string;
}

/** Bounds on a gutter message: a note over a megabyte has no gutter at all. */
export const MAX_GIT_BLOCKS = 100_000;
export const MAX_GIT_BLOCK_TEXT = 1024 * 1024 + 1024;

/**
 * Which blocks of an open note differ from the note as last committed.
 *
 * Keyed by block id rather than position, so it lands on the editor's node
 * whose origin is that block whatever has been typed since: an id names one
 * block of one accepted revision. `null` blocks and no deleted runs mean the
 * note has no committed version, or matches it.
 */
export interface WorkspaceGitBlocksV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly documentId: string;
  readonly blocks: ReadonlyArray<{
    readonly blockId: string;
    readonly change: 'modified' | 'added';
    /** The block as committed, for `modified`. */
    readonly head: string | null;
  }>;
  readonly deleted: ReadonlyArray<{
    /** The block the deleted ones stood before; null at the end of the note. */
    readonly beforeBlockId: string | null;
    /** What was there, the committed blocks joined by a blank line, for showing. */
    readonly head: string;
    /** The same blocks one by one, for putting back as they were. */
    readonly heads: readonly string[];
  }>;
}

export interface WorkspaceRenameRowEventV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  /**
   * For `rename`, the row to rename. For `new-folder`, the folder to make one
   * in. For `new-note`, the note just made, to be renamed from its first name.
   */
  readonly path: string;
  readonly intent: 'rename' | 'new-folder' | 'new-note';
}

/**
 * Everything the File menu can write a note out as.
 *
 * `pdf`, `html` and `html-plain` are how Noto draws the note, so they carry the
 * renderer's own markup. The rest are conversions of the markdown, which Pandoc
 * reads from the file on disk and which therefore need the note saved first.
 */
export const EXPORT_KINDS = [
  'pdf', 'html', 'html-plain',
  'docx', 'odt', 'rtf', 'epub', 'latex', 'mediawiki', 'rst', 'textile', 'opml',
] as const;

export type WorkspaceExportKindV1 = (typeof EXPORT_KINDS)[number];

export interface WorkspaceExportRequestV1 extends WorkspaceRequestV1 {
  readonly target: WorkspaceExportKindV1;
  /**
   * The document's body, serialized by the editor from its own schema, or null
   * for a target Pandoc converts from the file instead.
   */
  readonly html: string | null;
  /** The note's name without its extension, used as the page's title. */
  readonly title: string;
  /**
   * Whether the note has changes that have not been written.
   *
   * Sent from the renderer because that is where the knowledge lives, and used
   * to refuse a Pandoc export outright: it converts the file, so exporting a
   * note with unsaved work would produce a document of the last saved version
   * while the reader was looking at a newer one.
   */
  readonly dirty: boolean;
}

export type WorkspaceExportReplyV1 =
  | { readonly version: typeof NOTO_WORKSPACE_VERSION; readonly exported: true; readonly path: string }
  | {
      readonly version: typeof NOTO_WORKSPACE_VERSION;
      readonly exported: false;
      readonly reason: WorkspaceExportRefusalV1;
      /** For `unsafe-images`, the pictures that were refused and why. */
      readonly detail?: string;
    };

/**
 * Why an export did not happen. `unsafe-images` is a note naming pictures
 * outside the folder (or on the web, with remote images off); `pandoc-sandbox`
 * is a Pandoc build that cannot convert from inside its sandbox.
 */
export const WORKSPACE_EXPORT_REFUSALS = [
  'no-document', 'unsaved', 'cancelled', 'no-pandoc', 'failed', 'unsafe-images', 'pandoc-sandbox',
] as const;
export type WorkspaceExportRefusalV1 = typeof WORKSPACE_EXPORT_REFUSALS[number];

export interface WorkspaceContentLineV1 {
  readonly line: string;
  readonly lineNumber: number;
  /** Where the query starts within `line`, for highlighting. */
  readonly column: number;
  /** How many characters the match runs for, from `column`. */
  readonly length: number;
}

/** One note containing the query, with a few of the lines that do. */
export interface WorkspaceContentMatchV1 {
  readonly path: string;
  readonly name: string;
  readonly relativePath: string;
  /** Times the query appears in the whole file, which is what ranks it. */
  readonly occurrences: number;
  readonly lines: readonly WorkspaceContentLineV1[];
}

export interface WorkspaceContentRequestV1 extends WorkspaceRequestV1 {
  readonly query: string;
  /**
   * A folder to search inside, vault-relative, or empty for the whole vault.
   *
   * Quick open's folders tab narrows the other two to a corner of the vault,
   * and the narrowing has to happen where the scanning does: filtering sixty
   * results afterwards would search the wrong sixty.
   */
  readonly scope: string;
  /** The find bar's three switches, meaning the same thing here. */
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly regex: boolean;
}

export interface WorkspaceContentReplyV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly matches: readonly WorkspaceContentMatchV1[];
  /** Files actually read, so the box can say how much it looked at. */
  readonly scanned: number;
  /** More files matched than are reported. */
  readonly truncated: boolean;
  /** The scan hit its time budget and stopped early. */
  readonly timedOut: boolean;
  /** True when the query was an expression that does not parse; nothing was searched. */
  readonly invalidPattern: boolean;
}

/** The longest a query may be. Past this it is not a search, it is a paste. */
export const MAX_CONTENT_QUERY = 200;

/** One openable file, as the search index carries it. */
export interface WorkspaceIndexEntryV1 {
  readonly path: string;
  readonly name: string;
  /** Relative to the workspace root, always with forward slashes. */
  readonly relativePath: string;
}

export interface WorkspaceIndexReplyV1 {
  readonly version: 1;
  readonly root: string | null;
  readonly entries: readonly WorkspaceIndexEntryV1[];
  /** A ceiling stopped the walk, so the index is partial and says so. */
  readonly truncated: boolean;
}

export interface WorkspaceMenuEventV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly command: WorkspaceMenuCommandV1;
}

/**
 * The clipboard's text, sent by main when Paste as Plain Text is chosen.
 *
 * Main reads the clipboard and sends the text, rather than the renderer
 * asking for it, so the renderer can never read the clipboard on its own:
 * the text arrives only because the reader chose the command.
 */
export interface WorkspacePasteEventV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly text: string;
  /**
   * Where it goes: at the caret, as a paste does, or as blocks after the last
   * one, which is what appending to a note means. Absent is the caret, so the
   * menu's own Paste as Plain Text needs to say nothing.
   */
  readonly at?: 'caret' | 'end';
}

/**
 * Whether the note in front has changes that are not on disk.
 *
 * Sent by the renderer, which is the only side that knows: main holds the
 * file and the renderer holds the edits. The remote control reports it, so a
 * caller reading the file knows whether it is reading what is on screen.
 */
export interface WorkspaceDirtyEventV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly dirty: boolean;
}

/**
 * The paths of every loaded note with unsaved changes. Main only hears about
 * the note in front through `dirtyChanged`; a note left behind with edits is
 * what closing a window or quitting has to ask about.
 */
export interface WorkspaceUnsavedEventV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly paths: readonly string[];
}

/**
 * The note in front as the editor holds it, unsaved changes and all.
 *
 * Asked for by main, answered by the window, and carried by its own pair of
 * channels because it is the one thing main cannot work out for itself: the
 * file on disk is main's, and the edits are the renderer's.
 */
export interface WorkspaceTextRequestV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly requestId: string;
}

export interface WorkspaceTextReplyV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly requestId: string;
  readonly markdown: string | null;
}

/**
 * What a plugin adds to the editor's right-click menu.
 *
 * Main builds the menu, since the clipboard roles and the spell checker live
 * there, but only the window knows what is under the pointer: a sidenote, a
 * selection, nothing. So main asks, waits briefly, and builds the menu with
 * whatever came back; a choice comes back as the editor command to run.
 */
export interface WorkspaceContextItemV1 {
  readonly command: string;
  readonly title: string;
}

export interface WorkspaceContextRequestV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly requestId: string;
  /** The click, in the page's CSS pixels. */
  readonly x: number;
  readonly y: number;
}

export interface WorkspaceContextReplyV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly requestId: string;
  readonly items: readonly WorkspaceContextItemV1[];
}

export interface WorkspaceContextCommandV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly command: string;
}

/** Whether the editor can be driven from outside, and where from. */
export interface WorkspaceRemoteEventV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly listening: boolean;
  readonly port: number | null;
}

/** The most text a paste carries; past this it is a file, not a paste. */
export const MAX_PASTE_TEXT = 8 * 1024 * 1024;

/** One note the vault's graph names, as a place to go. */
export interface WorkspaceLinkV1 {
  readonly path: string;
  readonly relativePath: string;
  readonly title: string;
}

/**
 * What the vault's note-assistant graph knows about one note.
 *
 * `available` is false when the vault has no graph; `known` is false when
 * it has one that has not met this note (common for `moc: true` hubs). When
 * unknown, `backlinks` / `related` may still be filled by scanning other
 * notes' edges that point at this path; outbound `links` stay empty so the
 * renderer can seed them from the open note. Empty Related is omitted in UI.
 */
/** One tag as the vault's notes declare it, with how many notes carry it. */
export interface WorkspaceTagSummaryV1 {
  readonly tag: string;
  readonly count: number;
}

export interface WorkspaceTagIndexReplyV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly tags: readonly WorkspaceTagSummaryV1[];
  /** True when a budget stopped the scan before every note was read. */
  readonly truncated: boolean;
}

export interface WorkspaceNotesByTagRequestV1 extends WorkspaceRequestV1 {
  /** The tag to look up; matching is case-insensitive. */
  readonly tag: string;
}

export interface WorkspaceTagNoteV1 {
  readonly path: string;
  readonly relativePath: string;
  readonly title: string;
}

export interface WorkspaceNotesByTagReplyV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly tag: string;
  readonly notes: readonly WorkspaceTagNoteV1[];
}

/** One commit in a note's history. */
export interface NoteCommitV1 {
  readonly hash: string;
  /** When it was authored, in milliseconds. */
  readonly time: number;
  readonly author: string;
  readonly subject: string;
  /** What the commit did to the note; a merge shows no change of its own. */
  readonly change: 'added' | 'modified' | 'renamed' | 'copied' | 'deleted' | 'merge';
  /** Where the note was after the commit, from the repository's top, with forward slashes. */
  readonly path: string;
  /** Where it was before, when the commit moved it. */
  readonly from: string | null;
  /** Lines added and taken away; null for a binary file or a merge. */
  readonly added: number | null;
  readonly removed: number | null;
  /** Only text between a tool's markers changed: a script's work, not the person's. */
  readonly tooling: boolean;
  /** The commit changed more than a hundred files: a sweep across the folder. */
  readonly sweeping: boolean;
}

/** The note as the file system has it. Times in milliseconds. */
export interface NoteFileFactsV1 {
  readonly created: number;
  readonly modified: number;
  readonly bytes: number;
}

export interface WorkspaceNoteHistoryRequestV1 extends WorkspaceRequestV1 {
  /** The note. Main confines it to the open folder. */
  readonly path: string;
}

/**
 * A note's history, newest first.
 *
 * `ok` has commits; `untracked` is a note git has never committed; `not-git`
 * a note outside any repository; `slow` and `unavailable` mean git did not
 * answer, in time or at all; `outside` a path that is not in the open folder.
 */
export interface WorkspaceNoteHistoryReplyV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly state: 'ok' | 'untracked' | 'not-git' | 'slow' | 'unavailable' | 'outside';
  readonly commits: readonly NoteCommitV1[];
  /** The note has more commits than were read. */
  readonly more: boolean;
  /** Lines on disk since the last commit; null when nothing differs. */
  readonly uncommitted: { readonly added: number; readonly removed: number } | null;
  readonly file: NoteFileFactsV1 | null;
}

export interface WorkspaceNotePassageRequestV1 extends WorkspaceRequestV1 {
  /** The note. Main confines it to the open folder. */
  readonly path: string;
  /** The passage as the last commit has it: what the editor holds for a block git says is unchanged, or the committed text of a changed one. */
  readonly text: string;
}

/**
 * Which commits changed a passage, newest first, by git's own following of
 * its lines (`git log -L`): the passage is found in the note as last
 * committed, and its lines there are what git follows back. `not-found`: the
 * passage is not in the last commit as it is (written since), so git has no
 * lines to follow; the other states are those of `WorkspaceNoteHistoryReplyV1`.
 */
export interface WorkspaceNotePassageReplyV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly state: 'ok' | 'not-found' | 'untracked' | 'not-git' | 'slow' | 'unavailable' | 'outside';
  /** The passage's lines in the last commit, from 1. */
  readonly lines: { readonly from: number; readonly to: number } | null;
  /** Commit hashes, newest first. */
  readonly commits: readonly string[];
}

/** A commit that changed something under a folder. */
export interface FolderCommitV1 {
  readonly hash: string;
  /** When it was authored, in milliseconds. */
  readonly time: number;
  readonly author: string;
  readonly subject: string;
  /** The first few notes it changed there, from the folder, with forward slashes. */
  readonly notes: readonly string[];
  /** How many files it changed there in all, notes or not. */
  readonly files: number;
}

export interface WorkspaceFolderHistoryReplyV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly state: 'ok' | 'not-git' | 'slow' | 'unavailable' | 'outside';
  /** Newest first. */
  readonly commits: readonly FolderCommitV1[];
}

/**
 * Push: a note or folder was renamed or moved, and the links that reached it
 * by its old place (and its own relative links to the neighbours it left)
 * were written again to reach the same notes.
 */
export interface WorkspaceLinksFollowedV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  /** What Undo names to take this back; 0 when nothing was written. */
  readonly pass: number;
  /** Notes written again, and the links in them. */
  readonly notes: number;
  readonly links: number;
  /** Notes with links to write that have unsaved edits in the window, left alone. */
  readonly held: number;
  /** Notes changed while they were read, or that could not be written, left as they are. */
  readonly left: number;
}

export interface WorkspaceUndoLinksRequestV1 extends WorkspaceRequestV1 {
  /** The pass the notice was for. */
  readonly pass: number;
}

export interface WorkspaceUndoLinksReplyV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  /** Notes put back as they were before the move. */
  readonly restored: number;
  /** Notes changed since, and kept as they are. */
  readonly kept: number;
}

/** Push: the folder the info pane should be about, a real path inside the open folder. */
export interface WorkspaceShowFolderInfoEventV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly path: string;
}

/** Push: the folder the file tree should focus on, as the window named it, inside the open folder. */
export interface WorkspaceFocusFolderEventV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly path: string;
}

export interface WorkspaceNoteVersionRequestV1 extends WorkspaceRequestV1 {
  readonly path: string;
  readonly commit: string;
  /** The note's path at that commit, as its history gave it. */
  readonly at: string;
}

export interface WorkspaceNoteVersionReplyV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  /** Null when the commit is not one of the note's, or the text is too big to show. */
  readonly text: string | null;
}

/** Quick Open's preview of the note in front of the list: its opening, or the lines around a match in it. */
export interface WorkspaceNotePreviewRequestV1 extends WorkspaceRequestV1 {
  readonly path: string;
  /** A line to show the lines around, 1-based, for a match inside the note; null for its opening. */
  readonly line: number | null;
}

export interface WorkspaceNotePreviewReplyV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  /** A few kilobytes of the note; null when it is not a note in the open folder or cannot be read. */
  readonly text: string | null;
  /** The line the text begins on, 1-based. */
  readonly from: number;
  /** When the file last changed, in milliseconds; null with no text. */
  readonly modified: number | null;
  /**
   * The fence of a code block the text begins inside, such as "```", when the
   * window around a match starts within one; null at a note's opening or
   * outside code. Without it, the block's closing fence reads as an opening.
   */
  readonly fence: string | null;
}

/** Where a value the vault holds about a note came from. */
export type MemoryOriginV1 = 'note' | 'script' | 'folder' | 'config' | 'default';

export interface MemoryTracedV1<T> {
  readonly value: T;
  readonly from: MemoryOriginV1;
}

/**
 * Everything a folder's memory knows about one note, as `@roobli/vault`'s
 * `about` gives it. Paths are relative to the folder, with forward slashes.
 */
export interface NoteMemoryV1 {
  readonly path: string;
  readonly title: string;
  readonly id: string | null;
  readonly kind: MemoryTracedV1<string>;
  readonly known: MemoryTracedV1<string | null>;
  readonly sensitivity: MemoryTracedV1<string>;
  readonly status: string | null;
  readonly tags: readonly string[];
  readonly aliases: readonly string[];
  readonly heat: {
    readonly heat: number;
    readonly reads: number;
    readonly writes: number;
    readonly lastRead: string | null;
    readonly lastWrite: string | null;
  };
  readonly supersededBy: { readonly path: string; readonly title: string } | null;
  readonly linksHere: readonly { readonly path: string; readonly title: string; readonly relation: string | null; readonly heat: number; readonly reads: number }[];
  readonly linksHereCount: number;
  readonly namedHere: readonly { readonly id: string; readonly to: string; readonly title: string; readonly score: number; readonly around: readonly [string, string, string] }[];
  readonly namedHereCount: number;
  readonly together: readonly { readonly path: string; readonly title: string; readonly type: string; readonly count: number; readonly weight: number; readonly last: string | null }[];
  readonly togetherCount: number;
  readonly aboutSame: readonly { readonly path: string; readonly title: string; readonly why: readonly string[]; readonly excerpt: string }[];
  /** `broken` is the first few; `brokenCount` says how many there are. */
  readonly outgoing: { readonly count: number; readonly broken: readonly { readonly target: string; readonly line: number }[]; readonly brokenCount: number };
  readonly reads: readonly { readonly day: string; readonly count: number }[];
  readonly readers: readonly { readonly actor: string; readonly count: number; readonly last: string }[];
  readonly leadsHere: readonly { readonly from: string | null; readonly query: string | null; readonly count: number }[];
  /** Commits, entries appended, and the agents that said they wrote it (over MCP, or from a hook after an edit of their own), most recent first. */
  readonly writes: { readonly commits: number; readonly appends: number; readonly agents: readonly { readonly actor: string; readonly count: number; readonly last: string }[] };
  readonly agents: readonly { readonly name: string; readonly canSee: boolean; readonly why: string | null }[];
}

/**
 * `ok` carries what the memory knows; `no-memory` is a folder without a
 * `.noto/` folder, which is never written to; `opening` means the index is
 * being read and the answer will come; `unknown` a note the index does not
 * hold (a new one, or one the folder's rules leave out); `unavailable` that
 * the memory could not be read; `outside` a path not in the open folder.
 */
/** The files `keepMemory` made, folder-relative; null when the folder could not keep memory. */
export interface WorkspaceKeepMemoryReplyV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  /** `cancelled` when the person said no to main's question. */
  readonly outcome: 'made' | 'cancelled' | 'failed';
  /** The files made, folder-relative; empty unless `made`. */
  readonly made: readonly string[];
}

export interface WorkspaceTrustMemoryReplyV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly trusted: boolean;
}

/**
 * Settings → Memory → Agents. Adding an agent and taking a key back are
 * asked of the person by main, in a sheet of its own, before anything is
 * written; every answer carries the list as it is then.
 */
export type WorkspaceAgentActionV1 =
  | { readonly kind: 'list' }
  | {
    readonly kind: 'add';
    readonly name: string;
    /** The most private notes it reads; sealed ones never. */
    readonly reads: 'open' | 'private';
    /** Read and search; also propose changes; also write directly in `writeIn`. */
    readonly may: 'read' | 'propose' | 'write';
    readonly writeIn: string | null;
  }
  | { readonly kind: 'revoke'; readonly name: string };

export interface WorkspaceAgentRequestV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly requestId: string;
  readonly action: WorkspaceAgentActionV1;
}

export interface AgentRowV1 {
  readonly name: string;
  /** 0 for `default`, whoever brings no key, and for an agent whose keys were taken back. */
  readonly keys: number;
  readonly reads: 'open' | 'private' | 'sealed';
  readonly verbs: readonly string[];
  readonly writes: readonly string[];
  readonly revoked: string | null;
  /** `default` when the file does not name it: what any agent without a key gets. */
  readonly implicit: boolean;
  /** From the read record, once the memory is open; null when it has not read anything, or is not known. */
  readonly lastRead: string | null;
  readonly readCount: number;
}

export interface WorkspaceAgentsReplyV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly state: 'ok' | 'no-memory' | 'outside';
  /** What the action did: `cancelled` when the person said no in main's sheet. */
  readonly outcome: 'done' | 'cancelled' | 'failed';
  readonly error: string | null;
  readonly agents: readonly AgentRowV1[];
  /** The key just made, shown once and kept nowhere but its hash. */
  readonly key: string | null;
  /** How an agent starts this folder's MCP server: the command line shipped with Noto, run by Node. */
  readonly setup: { readonly script: string; readonly root: string } | null;
}

export type SensitivityV1 = 'open' | 'private' | 'sealed';

export interface WorkspaceMemoryAskRequestV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly requestId: string;
  /** The question, in words. */
  readonly cue: string;
  /** The note in front, by its path on disk, whose neighbours count for more; null for none. */
  readonly note: string | null;
}

/** One note of the context pack: why it came up, and the part of it worth reading. */
export interface MemoryAskItemV1 {
  readonly path: string;
  readonly title: string;
  readonly kind: string;
  readonly why: readonly string[];
  readonly excerpt: string;
}

/**
 * What the folder's memory answers a question with: the notes most likely to
 * matter, each with why and an excerpt, within its budget, and the same pack
 * as Markdown, exactly as an agent asking through MCP is given it.
 */
export interface WorkspaceMemoryAskReplyV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly state: 'ok' | 'no-memory' | 'untrusted' | 'opening' | 'unavailable' | 'outside';
  readonly value: {
    readonly cue: string;
    readonly items: readonly MemoryAskItemV1[];
    /** Notes that scored but did not fit the budget. */
    readonly omitted: number;
    readonly markdown: string;
  } | null;
}

export interface WorkspaceMemoryPrivacyRequestV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly requestId: string;
  /** The note in front, to say whether its own frontmatter makes it stricter than its folder; null for none. */
  readonly note: string | null;
}

/**
 * What `.noto/access.yaml` says, as the window draws it. Read from the file
 * and the note alone, without opening the index, so the window asks on every
 * note it brings to the front and a window that never shows Note Info still
 * costs nothing.
 */
export interface WorkspaceMemoryPrivacyReplyV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  /** The tree's root the paths are under; null outside a folder that keeps memory. */
  readonly root: string | null;
  /** The level of a note no folder pattern names, which the folder's own row shows when it is not open. */
  readonly vault: SensitivityV1;
  /** Folders given a level by a pattern of their own, as tree row paths. */
  readonly folders: readonly { readonly path: string; readonly level: SensitivityV1 }[];
  /** The note in front, when its own frontmatter is what makes it private or sealed; null otherwise. */
  readonly note: { readonly level: 'private' | 'sealed'; readonly folder: 'open' | 'private' } | null;
}

export type WorkspaceMemoryFolderActionV1 =
  | { readonly kind: 'status' }
  /** Build the index again from the notes; the notes and the read record are not touched. */
  | { readonly kind: 'rebuild' }
  /** Whether opening a note in this folder is written in its read record, on this computer. */
  | { readonly kind: 'record'; readonly on: boolean }
  /** Stop keeping memory: `.noto` goes to the Trash, after main's own sheet says what it holds. */
  | { readonly kind: 'turn-off' };

export interface WorkspaceMemoryFolderRequestV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly requestId: string;
  readonly action: WorkspaceMemoryFolderActionV1;
}

export interface WorkspaceMemoryFolderReplyV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly state: 'outside' | 'no-memory' | 'untrusted' | 'opening' | 'open' | 'unavailable';
  /** What the action did: `cancelled` when the person said no in main's sheet. */
  readonly outcome: 'done' | 'cancelled' | 'failed';
  readonly error: string | null;
  /** What the index holds, while the memory is open. */
  readonly index: {
    readonly notes: number;
    readonly links: number;
    /** Lines in the read record: notes opened, by the person and by agents. */
    readonly reads: number;
    readonly bytes: number;
    readonly refreshed: string | null;
  } | null;
  /** Whether opening a note here is written in the read record. */
  readonly recording: boolean;
}

/** The kinds of suggestion Review lists. */
export type ReviewKindV1 = 'stale' | 'mention' | 'together';

/**
 * A proposal's id as Review names it: the ref's name under
 * refs/noto/proposals, a timestamp and a slug as `@roobli/vault` makes them.
 * A ref named otherwise (anyone with git can write one) is left out.
 */
export const PROPOSAL_ID = /^[0-9A-Za-z\u4e00-\u9fff][0-9A-Za-z\u4e00-\u9fff._-]{0,160}$/;

/**
 * What Review asks of the folder's memory. Accepting, linking and taking a
 * write back skip (and name) any note with unsaved edits in the window, which
 * main adds; nothing else here writes a note.
 */
export type WorkspaceReviewActionV1 =
  /** The proposals, and how many suggestions of each kind; only `counted` are worked out if not known yet. */
  | { readonly kind: 'summary'; readonly counted: readonly ReviewKindV1[] }
  | { readonly kind: 'suggestions'; readonly type: ReviewKindV1; readonly offset: number; readonly limit: number }
  | { readonly kind: 'proposal-file'; readonly proposal: string; readonly path: string }
  | { readonly kind: 'accept'; readonly proposal: string }
  | { readonly kind: 'reject'; readonly proposal: string }
  /** The kind is named so the memory can work its list out again if the notes changed meanwhile. */
  | { readonly kind: 'link'; readonly type: ReviewKindV1; readonly ids: readonly string[] }
  | { readonly kind: 'dismiss'; readonly type: ReviewKindV1; readonly ids: readonly string[] }
  | { readonly kind: 'dismissals' }
  | { readonly kind: 'undismiss'; readonly ids: readonly string[] | 'all' }
  /** Take back the last write Review made (an accept or a link), where the files are still as it left them. */
  | { readonly kind: 'undo' }
  /**
   * The few likeliest unlinked mentions in one note, for marking in it while
   * it is in front: `note` is its path on disk, which main makes the vault's.
   */
  | { readonly kind: 'mentions'; readonly note: string };

export interface WorkspaceReviewRequestV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly requestId: string;
  readonly action: WorkspaceReviewActionV1;
}

export interface ReviewProposalV1 {
  readonly id: string;
  readonly subject: string;
  readonly author: string;
  readonly time: string;
  readonly files: readonly { readonly status: string; readonly path: string }[];
}

export interface ReviewSummaryV1 {
  readonly proposals: readonly ReviewProposalV1[];
  /** Null for a kind not worked out yet. */
  readonly counts: { readonly stale: number | null; readonly mention: number | null; readonly together: number | null };
  readonly dismissed: number;
}

export interface ReviewSuggestionV1 {
  readonly id: string;
  readonly type: ReviewKindV1;
  readonly from: string;
  readonly to: string;
  readonly toTitle: string;
  readonly score: number;
  readonly reason: string;
  readonly line: number | null;
  /** Before the mention, the mention, after it. */
  readonly around: readonly [string, string, string] | null;
}

/**
 * A mention to mark in the note in front: the words as the saved note has
 * them, with what is around them on their line, and the link to write in
 * their place. The same id as Review's, so saying no to it is saying no there.
 */
export interface ReviewMentionV1 {
  readonly id: string;
  readonly to: string;
  readonly toTitle: string;
  readonly score: number;
  readonly around: readonly [string, string, string];
  /** What the words become: a wiki link to `to` that still reads as they did. */
  readonly replacement: string;
}

export interface ReviewDismissalV1 {
  readonly id: string;
  readonly type: string;
  readonly from: string;
  readonly to: string;
  readonly time: string | null;
}

/** What each action answers, by kind. */
export interface ReviewValuesV1 {
  readonly summary: ReviewSummaryV1;
  readonly suggestions: { readonly total: number; readonly items: readonly ReviewSuggestionV1[] };
  readonly 'proposal-file': { readonly base: string | null; readonly proposed: string | null };
  readonly accept: { readonly applied: readonly string[]; readonly unchanged: readonly string[]; readonly conflicts: readonly string[]; readonly busy: readonly string[] };
  readonly reject: null;
  /** Suggestion ids: linked, no longer applicable to their note as it is now, and in a note with unsaved edits. */
  readonly link: { readonly linked: readonly string[]; readonly outdated: readonly string[]; readonly busy: readonly string[] };
  /** `missing`: ids no longer suggested at all, so there was nothing to say no to. */
  readonly dismiss: { readonly count: number; readonly missing: readonly string[] };
  readonly dismissals: readonly ReviewDismissalV1[];
  readonly undismiss: { readonly count: number };
  /** Null when there is nothing to take back. Paths: put back, written to since, and with unsaved edits. */
  readonly undo: { readonly restored: readonly string[]; readonly changed: readonly string[]; readonly busy: readonly string[] } | null;
  readonly mentions: readonly ReviewMentionV1[];
}

export interface WorkspaceReviewReplyV1<K extends WorkspaceReviewActionV1['kind'] = WorkspaceReviewActionV1['kind']> {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  /** `failed`: the memory answered with an error, in `error`; the others are those of `WorkspaceNoteMemoryReplyV1`. */
  readonly state: 'ok' | 'failed' | 'no-memory' | 'untrusted' | 'opening' | 'unavailable' | 'outside';
  readonly value: ReviewValuesV1[K] | null;
  readonly error: string | null;
}

export interface WorkspaceMemoryChangedV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
}

export interface WorkspaceNoteMemoryReplyV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  /** `untrusted`: the folder's memory runs scripts, and the person has not allowed them yet. */
  readonly state: 'ok' | 'no-memory' | 'untrusted' | 'opening' | 'unknown' | 'unavailable' | 'outside';
  readonly memory: NoteMemoryV1 | null;
}

/** A note as the memory counts it for a folder: see `@roobli/vault`'s `folderAbout`. */
export interface FolderNoteV1 {
  /** From the open folder, with forward slashes. */
  readonly path: string;
  readonly title: string;
  /** Warmth now: reads and writes, each fading by its kind's half-life. */
  readonly heat: number;
  readonly reads: number;
  readonly lastRead: string | null;
}

/** What the memory knows about a folder. Notes an agent may never see are counted for the person, as everywhere in Noto. */
export interface FolderMemoryV1 {
  /** From the open folder, without a trailing slash; `''` is the open folder itself. */
  readonly folder: string;
  readonly notes: number;
  readonly warmest: readonly FolderNoteV1[];
  readonly mostRead: readonly FolderNoteV1[];
  /** Notes no other note links to and that link to no note. */
  readonly orphans: { readonly count: number; readonly items: readonly FolderNoteV1[] };
  /** Links in its notes that name nothing in the folder. */
  readonly broken: number;
}

export interface WorkspaceFolderMemoryReplyV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly state: Exclude<WorkspaceNoteMemoryReplyV1['state'], 'unknown'>;
  readonly memory: FolderMemoryV1 | null;
}

export interface WorkspaceLinksReplyV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly available: boolean;
  readonly known: boolean;
  readonly generatedAt: string | null;
  readonly backlinks: readonly WorkspaceLinkV1[];
  readonly links: readonly WorkspaceLinkV1[];
  readonly related: readonly WorkspaceLinkV1[];
}

export interface WorkspaceDocumentEventV1 {
  readonly version: typeof NOTO_WORKSPACE_VERSION;
  readonly opened: FileTruthOpenReplyV1;
}

export type WorkspaceResultV1<T> =
  | { readonly ok: true; readonly requestId: string; readonly value: T }
  | {
      readonly ok: false;
      readonly requestId: string;
      readonly error: { readonly code: 'BAD_REQUEST' | 'WORKSPACE_FAILED'; readonly message: string };
    };

export interface NotoWorkspaceApiV1 {
  openDialog(request: WorkspaceRequestV1): Promise<WorkspaceResultV1<WorkspaceOpenReplyV1>>;
  openPath(request: WorkspaceOpenPathRequestV1): Promise<WorkspaceResultV1<WorkspaceOpenReplyV1>>;
  saveAsDialog(request: WorkspaceRequestV1): Promise<WorkspaceResultV1<WorkspaceSaveAsReplyV1>>;
  recent(request: WorkspaceRequestV1): Promise<WorkspaceResultV1<WorkspaceRecentReplyV1>>;
  activateTab(request: WorkspaceTabRequestV1): Promise<WorkspaceResultV1<WorkspaceOpenReplyV1>>;
  closeTab(request: WorkspaceTabRequestV1): Promise<WorkspaceResultV1<WorkspaceTabsEventV1>>;
  openFolder(request: WorkspaceRequestV1): Promise<WorkspaceResultV1<WorkspaceFolderEventV1>>;
  listFolder(request: WorkspaceFolderRequestV1): Promise<WorkspaceResultV1<WorkspaceFolderReplyV1>>;
  onFolderChanged(listener: (event: WorkspaceFolderEventV1) => void): () => void;
  onDocumentOpened(listener: (event: WorkspaceDocumentEventV1) => void): () => void;
  onCodeViewChanged(listener: (event: WorkspaceCodeViewEventV1) => void): () => void;
  onDocumentClosed(listener: (event: WorkspaceClosedEventV1) => void): () => void;
  onTabsChanged(listener: (event: WorkspaceTabsEventV1) => void): () => void;
  onMenuCommand(listener: (event: WorkspaceMenuEventV1) => void): () => void;
  onPasteText(listener: (event: WorkspacePasteEventV1) => void): () => void;
  onRemoteChanged(listener: (event: WorkspaceRemoteEventV1) => void): () => void;
  reportDirty(event: WorkspaceDirtyEventV1): void;
  reportUnsaved(event: WorkspaceUnsavedEventV1): void;
  onTextRequest(listener: (event: WorkspaceTextRequestV1) => void): () => void;
  replyText(event: WorkspaceTextReplyV1): void;
  onContextRequest(listener: (event: WorkspaceContextRequestV1) => void): () => void;
  replyContext(event: WorkspaceContextReplyV1): void;
  onContextCommand(listener: (event: WorkspaceContextCommandV1) => void): () => void;
  /**
   * The path of a file the reader dropped in, which the renderer may not
   * work out for itself. Empty when the browser has no file behind it.
   */
  pathForFile(file: File): string;
  /** The graph's lists for the note at `path`; the request is the folder request, a path. */
  noteLinks(request: WorkspaceFolderRequestV1): Promise<WorkspaceResultV1<WorkspaceLinksReplyV1>>;
  /** One note's commits, newest first, following renames. */
  noteHistory(request: WorkspaceNoteHistoryRequestV1): Promise<WorkspaceResultV1<WorkspaceNoteHistoryReplyV1>>;
  notePassage(request: WorkspaceNotePassageRequestV1): Promise<WorkspaceResultV1<WorkspaceNotePassageReplyV1>>;
  folderHistory(request: WorkspaceFolderRequestV1): Promise<WorkspaceResultV1<WorkspaceFolderHistoryReplyV1>>;
  /** One note's text at one of its own commits. */
  noteVersion(request: WorkspaceNoteVersionRequestV1): Promise<WorkspaceResultV1<WorkspaceNoteVersionReplyV1>>;
  notePreview(request: WorkspaceNotePreviewRequestV1): Promise<WorkspaceResultV1<WorkspaceNotePreviewReplyV1>>;
  /** What the folder's memory knows about one note. */
  noteMemory(request: WorkspaceFolderRequestV1): Promise<WorkspaceResultV1<WorkspaceNoteMemoryReplyV1>>;
  /** Begin keeping memory for the open folder. */
  keepMemory(request: WorkspaceRequestV1): Promise<WorkspaceResultV1<WorkspaceKeepMemoryReplyV1>>;
  /** Let the open folder's memory run its scripts. */
  trustMemory(request: WorkspaceRequestV1): Promise<WorkspaceResultV1<WorkspaceTrustMemoryReplyV1>>;
  /** List the folder's agents, add one, or take a key back. */
  memoryAgents(request: WorkspaceAgentRequestV1): Promise<WorkspaceResultV1<WorkspaceAgentsReplyV1>>;
  memoryPrivacy(request: WorkspaceMemoryPrivacyRequestV1): Promise<WorkspaceResultV1<WorkspaceMemoryPrivacyReplyV1>>;
  memoryFolder(request: WorkspaceMemoryFolderRequestV1): Promise<WorkspaceResultV1<WorkspaceMemoryFolderReplyV1>>;
  memoryAsk(request: WorkspaceMemoryAskRequestV1): Promise<WorkspaceResultV1<WorkspaceMemoryAskReplyV1>>;
  folderMemory(request: WorkspaceFolderRequestV1): Promise<WorkspaceResultV1<WorkspaceFolderMemoryReplyV1>>;
  /** Ask Review's question of the folder's memory. */
  memoryReview<K extends WorkspaceReviewActionV1['kind']>(request: WorkspaceReviewRequestV1 & { readonly action: { readonly kind: K } }): Promise<WorkspaceResultV1<WorkspaceReviewReplyV1<K>>>;
  tagIndex(request: WorkspaceRequestV1): Promise<WorkspaceResultV1<WorkspaceTagIndexReplyV1>>;
  notesByTag(request: WorkspaceNotesByTagRequestV1): Promise<WorkspaceResultV1<WorkspaceNotesByTagReplyV1>>;
  fileIndex(request: WorkspaceRequestV1): Promise<WorkspaceResultV1<WorkspaceIndexReplyV1>>;
  recentFolders(request: WorkspaceRequestV1): Promise<WorkspaceResultV1<WorkspaceRecentReplyV1>>;
  openRecentFolder(request: WorkspaceOpenPathRequestV1): Promise<WorkspaceResultV1<WorkspaceFolderEventV1>>;
  folder(request: WorkspaceRequestV1): Promise<WorkspaceResultV1<WorkspaceFolderEventV1>>;
  reveal(request: WorkspaceRevealRequestV1): Promise<WorkspaceResultV1<WorkspaceRevealReplyV1>>;
  openExternal(request: WorkspaceOpenExternalRequestV1): Promise<WorkspaceResultV1<WorkspaceOpenExternalReplyV1>>;
  newFile(request: WorkspaceRequestV1): Promise<WorkspaceResultV1<WorkspaceNewFileReplyV1>>;
  treeMenu(request: WorkspaceTreeMenuRequestV1): Promise<WorkspaceResultV1<WorkspaceTreeMenuReplyV1>>;
  searchContent(request: WorkspaceContentRequestV1): Promise<WorkspaceResultV1<WorkspaceContentReplyV1>>;
  manageEntry(request: WorkspaceEntryRequestV1): Promise<WorkspaceResultV1<WorkspaceEntryReplyV1>>;
  exportRendered(request: WorkspaceExportRequestV1): Promise<WorkspaceResultV1<WorkspaceExportReplyV1>>;
  /** `directories`: the folders whose listings may have changed, when main knew them; null for all of them. */
  onTreeChanged(listener: (event: { readonly directories: readonly string[] | null }) => void): () => void;
  gitMarks(request: WorkspaceRequestV1): Promise<WorkspaceResultV1<WorkspaceGitMarksV1>>;
  onGitMarksChanged(listener: (event: WorkspaceGitMarksV1) => void): () => void;
  onGitBlocksChanged(listener: (event: WorkspaceGitBlocksV1) => void): () => void;
  onMemoryChanged(listener: (event: WorkspaceMemoryChangedV1) => void): () => void;
  onRenameRow(listener: (event: WorkspaceRenameRowEventV1) => void): () => void;
  onShowFolderInfo(listener: (event: WorkspaceShowFolderInfoEventV1) => void): () => void;
  onFocusFolder(listener: (event: WorkspaceFocusFolderEventV1) => void): () => void;
  onLinksFollowed(listener: (event: WorkspaceLinksFollowedV1) => void): () => void;
  undoLinks(request: WorkspaceUndoLinksRequestV1): Promise<WorkspaceResultV1<WorkspaceUndoLinksReplyV1>>;
}

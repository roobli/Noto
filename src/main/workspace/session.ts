/**
 * Owns which documents are open, and which one is in front.
 *
 * A file-truth store knows how to open, save and recover exactly one document
 * safely, so each open document gets its own. That is what makes tabs safe
 * rather than merely convenient: two documents never share a save token, a
 * recovery journal, or an accepted revision. Recovery artifacts are already
 * keyed by a hash of the document's path, so the stores can share one root.
 *
 * This is also the single place an open can be started from, whether the
 * request came from the menu, the renderer, the dock, or a file association.
 */

import { GraphCache, linksForNote } from './note-graph';
import { buildTagIndex, notesForTag, type TagIndex } from './tag-index';
import type { SearchFlags } from '../../shared/search/pattern';
import path from 'node:path';
import { access, cp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { BrowserWindow, Menu, clipboard, dialog, shell, type MenuItemConstructorOptions } from 'electron';
import { FILE_TRUTH_CHANNELS, type FileTruthOpenReplyV1 } from '../../shared/file-truth/v1/contracts';
import { openableExternalUrl } from '../../shared/workspace/v1/validate';
import {
  NOTO_WORKSPACE_VERSION,
  WORKSPACE_CHANNELS,
  type WorkspaceTabV1,
  type WorkspaceFolderEventV1,
  type WorkspaceNewFileReplyV1,
  type WorkspaceTreeMenuReplyV1,
  type WorkspaceOpenExternalReplyV1,
  type WorkspaceLinksReplyV1,
  type WorkspaceTagIndexReplyV1,
  type WorkspaceNotesByTagReplyV1,
  type WorkspaceCodeViewV1,
} from '../../shared/workspace/v1/contracts';
import type {
  WorkspaceEntryActionV1,
  WorkspaceEntryRefusalV1,
  WorkspaceEntryReplyV1,
  WorkspaceExportReplyV1,
  WorkspaceExportKindV1,
  WorkspaceContentReplyV1, WorkspaceIndexReplyV1, WorkspaceRevealReplyV1, WorkspaceRevealTargetV1,
} from '../../shared/workspace/v1/contracts';
import type { StructuredLogger } from '../logger';
import type { FileTruthStoreV1 } from '../file-truth/v1/file-truth-store';
import type { RecentFiles } from './recent-files';
import { isEditableFile, listDirectory, type FileTreeEntryV1, isInside, type TreeSortV1 } from './file-tree';
import { languageFor, isViewableCodeFile } from '../../shared/code-viewer/languages';
import { isProbablyBinary } from '../../shared/code-viewer/binary';
import { CODE_VIEW_MAX_BYTES, CODE_VIEW_MAX_LINES } from '../../shared/code-viewer/limits';
import { standaloneHtml } from '../../shared/export/document-html';
import { inlineImages, readFileBytes } from './inline-images';
import { resolveAssetPath } from '../protocol/asset-guard';
import { buildTreeRowMenu, trashLabel } from './tree-row-menu';
import {
  findPandoc,
  importDocument,
  IMPORTABLE_EXTENSIONS,
  runPandoc,
  type ImportOutcome,
} from './import-document';
import {
  exportShape,
  exportThroughPandoc,
  needsPandoc,
  type ExportOutcome,
  type ExportTarget,
} from './export-document';
import {
  duplicateName,
  isEntryName,
  renamedFileName,
} from '../../shared/workspace/v1/entry-names';
import { buildFileIndex } from './file-index';
import { GitMarks, defaultGitRunner } from './git-marks';
import { gitBlockDiff } from './git-blocks';
import type { WorkspaceGitBlocksV1 } from '../../shared/workspace/v1/contracts';
import { searchContent } from './content-search';

const MARKDOWN_FILTERS = [
  { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'] },
  { name: 'All files', extensions: ['*'] },
];

interface OpenDocument {
  readonly store: FileTruthStoreV1;
  readonly opened: FileTruthOpenReplyV1;
  /** Rises each time this document is brought forward. See `WorkspaceTabV1`. */
  activatedAt: number;
}

/** How many documents may be open at once, so a stray loop cannot exhaust handles. */
const MAX_TABS = 24;

/**
 * What an open produced, inside main.
 *
 * Carries the whole document because main keeps it per tab. The IPC reply is
 * narrower (`WorkspaceOpenReplyV1` only names the note); the document reaches
 * the renderer once, on `documentOpened`.
 */
export type WorkspaceSessionOpenV1 =
  | { readonly version: typeof NOTO_WORKSPACE_VERSION; readonly opened: FileTruthOpenReplyV1 }
  | { readonly version: typeof NOTO_WORKSPACE_VERSION; readonly codeView: WorkspaceCodeViewV1 };

export class WorkspaceSession {
  /** Keyed by resolved path: opening the same file twice reuses its tab. */
  private readonly documents = new Map<string, OpenDocument>();
  /* Counts activations rather than reading a clock, so nothing depends on the
     machine's time being monotonic or even correct. */
  private activations = 0;
  private activePath: string | null = null;
  /** Path shown in the read-only code viewer, when one is open. */
  private codeViewPath: string | null = null;
  /** The folder shown in the sidebar, and the boundary for every listing. */
  private folderRoot: string | null = null;

  /** Paths closed in this session, most recent last. */
  private closed: string[] = [];

  /** The vault's graph, read once per version of its file. */
  private readonly graphCache = new GraphCache();

  /**
   * Whether the reader asked for the current folder.
   *
   * Remembered rather than passed each time, because the state is re-sent to a
   * renderer that has just finished loading, and a replay that forgot this
   * would leave the rail shut on a folder the reader opened by name.
   */
  private folderChosen = false;
  private indexCache: { root: string; reply: WorkspaceIndexReplyV1 } | null = null;
  /**
   * Which notes differ from the last commit, when the folder is in a git
   * repository. Read-only, and absent rather than an error everywhere else.
   * Only the files the editor opens count: Noto shows what changed in your
   * notes, not a repository's every file.
   */
  private readonly git = new GitMarks({
    publish: (event) => this.send(WORKSPACE_CHANNELS.gitMarksChanged, event),
    keep: isEditableFile,
    log: (event, fields) => this.logger.log(event, fields ?? {}),
    // Whatever made the tree's marks stale made the gutter stale too.
    onRefresh: () => this.scheduleGutter(),
  });
  private gutterTimer: ReturnType<typeof setTimeout> | null = null;
  /** Rises per gutter run, so an answer for a note no longer in front is dropped. */
  private gutterRun = 0;
  private lastGutter: WorkspaceGitBlocksV1 | null = null;
  private tagIndexCache: { root: string; index: TagIndex } | null = null;

  constructor(
    private readonly createStore: () => FileTruthStoreV1,
    private readonly recent: RecentFiles,
    private readonly getWindow: () => BrowserWindow | null,
    private readonly logger: StructuredLogger,
    /** The folders opened before, in the same shape as the recent documents:
     *  the list is a list of paths either way, so it is the same store. */
    private readonly recentFolders?: RecentFiles,
    /** How the tree is ordered, read at each listing so a change shows at once. */
    private readonly treeSort: () => TreeSortV1 = () => 'name',
    /** Whether non-Markdown text/code files open in the read-only viewer. */
    private readonly codeViewer: () => boolean = () => true,
  ) {}

  get current(): FileTruthOpenReplyV1 | null {
    return this.activePath ? this.documents.get(this.activePath)?.opened ?? null : null;
  }

  /** The folder open now, which the remote control reports and never changes. */
  get folder(): string | null {
    return this.folderRoot;
  }

  get currentPath(): string | null {
    return this.activePath;
  }

  /**
   * Where images may be read from: the open folder, and the folder the note
   * in front is in. The same containment the file tree enforces, so a note
   * can show what sits beside it and nothing that does not.
   */
  imageRoots(): string[] {
    const roots = [this.folderRoot, this.activePath ? path.dirname(this.activePath) : null];
    return roots.filter((root): root is string => root !== null);
  }

  /** The store owning a document, so a save is routed to the right one. */
  storeForDocument(documentId: string): FileTruthStoreV1 | null {
    for (const document of this.documents.values()) {
      if (document.opened.document.documentId === documentId) return document.store;
    }
    return null;
  }

  /** The store for whichever document is in front. */
  activeStore(): FileTruthStoreV1 | null {
    return this.activePath ? this.documents.get(this.activePath)?.store ?? null : null;
  }

  tabs(): WorkspaceTabV1[] {
    return [...this.documents.entries()].map(([filePath, document]) => ({
      path: filePath,
      name: path.basename(filePath),
      documentId: document.opened.document.documentId,
      active: filePath === this.activePath,
      activatedAt: document.activatedAt,
    }));
  }

  /**
   * Open a file, or bring it to the front if it is already open.
   *
   * A failed open leaves the other tabs alone; the caller decides how to report
   * it. Nothing is remembered as recent unless the open actually succeeded.
   */
  async openPath(filePath: string): Promise<WorkspaceSessionOpenV1> {
    const resolved = path.resolve(filePath);
    /*
     * Notes go through file-truth. Everything else the code viewer recognises
     * opens read-only, without a markdown parse and without a save token, so
     * the bytes on disk cannot be rewritten as prose. Anything else is still
     * refused — that is what stopped a `.ts` being opened as a note.
     */
    if (isEditableFile(resolved)) {
      this.clearCodeView();
      const opened = await this.openMarkdownPath(resolved);
      return { version: NOTO_WORKSPACE_VERSION, opened };
    }
    if (this.codeViewer() && isViewableCodeFile(resolved)) {
      const codeView = await this.loadCodeView(resolved);
      this.publishCodeView(codeView);
      if (this.folderRoot === null) await this.adoptFolder(path.dirname(resolved), false);
      await this.recent.remember(resolved);
      this.applyWindowTitle(resolved);
      this.logger.log('workspace_code_view_opened', { openCount: this.documents.size });
      return { version: NOTO_WORKSPACE_VERSION, codeView };
    }
    throw new Error(
      `Noto edits Markdown, and ${path.basename(resolved)} is not a Markdown file.`,
    );
  }

  /** Open a Markdown note the way openPath always has. */
  private async openMarkdownPath(resolved: string): Promise<FileTruthOpenReplyV1> {
    const existing = this.documents.get(resolved);
    if (existing) {
      this.activate(resolved);
      return existing.opened;
    }

    if (this.documents.size >= MAX_TABS) {
      throw new Error('Too many documents are open. Close one before opening another.');
    }

    const store = this.createStore();
    let opened: FileTruthOpenReplyV1;
    try {
      opened = await store.open(resolved);
    } catch (cause) {
      store.close();
      throw cause;
    }

    store.onExternalChange = (event) => {
      // Another program wrote the note; git may see it differently now.
      this.git.refresh();
      this.send(FILE_TRUTH_CHANNELS.externalChange, {
        version: 1,
        documentId: opened.document.documentId,
        kind: event.kind,
        saveToken: event.saveToken,
      });
    };

    this.activations += 1;
    this.documents.set(resolved, { store, opened, activatedAt: this.activations });
    this.activePath = resolved;
    if (this.folderRoot === null) await this.adoptFolder(path.dirname(resolved), false);
    await this.recent.remember(opened.path);
    this.logger.log('workspace_document_opened', {
      hasRecovery: opened.recovery !== null,
      openCount: this.documents.size,
    });
    this.publish(opened);
    this.publishTabs();
    this.applyWindowTitle(opened.path);
    return opened;
  }

  /** Read a non-Markdown file for the read-only viewer. Never writes. */
  private async loadCodeView(resolved: string): Promise<WorkspaceCodeViewV1> {
    const name = path.basename(resolved);
    const language = languageFor(name) ?? '';
    try {
      const info = await stat(resolved);
      if (info.size > CODE_VIEW_MAX_BYTES) {
        return {
          path: resolved, name, language, content: '', truncated: false,
          notice: `This file is ${info.size.toLocaleString()} bytes, over the ${CODE_VIEW_MAX_BYTES.toLocaleString()}-byte preview limit.`,
        };
      }
      const raw = await readFile(resolved);
      const text = raw.toString('utf8');
      if (isProbablyBinary(text)) {
        return {
          path: resolved, name, language, content: '', truncated: false,
          notice: 'This looks like a binary file, so it is not shown as text.',
        };
      }
      const lines = text.split('\n');
      if (lines.length > CODE_VIEW_MAX_LINES) {
        const kept = lines.slice(0, CODE_VIEW_MAX_LINES).join('\n');
        return {
          path: resolved, name, language, content: kept, truncated: true,
          notice: `Showing the first ${CODE_VIEW_MAX_LINES.toLocaleString()} lines of ${lines.length.toLocaleString()}.`,
        };
      }
      return { path: resolved, name, language, content: text, truncated: false, notice: null };
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : 'The file could not be read.';
      return {
        path: resolved, name, language, content: '', truncated: false,
        notice: reason,
      };
    }
  }

  private publishCodeView(codeView: WorkspaceCodeViewV1 | null): void {
    this.codeViewPath = codeView?.path ?? null;
    this.send(WORKSPACE_CHANNELS.codeViewChanged, {
      version: NOTO_WORKSPACE_VERSION,
      codeView,
    });
  }

  /** Hide the code viewer, if one is showing. */
  clearCodeView(): void {
    if (this.codeViewPath === null) return;
    this.publishCodeView(null);
  }


  /** Bring an already open document to the front. */
  activate(filePath: string): FileTruthOpenReplyV1 | null {
    const resolved = path.resolve(filePath);
    const document = this.documents.get(resolved);
    if (!document) return null;

    this.clearCodeView();
    this.activations += 1;
    document.activatedAt = this.activations;
    this.activePath = resolved;
    this.publish(document.opened);
    this.publishTabs();
    this.applyWindowTitle(resolved);
    // A successful bring-to-front is still a recent visit: File > Recent and
    // the empty-state list should agree with the strip along the bottom.
    void this.recent.remember(resolved).catch(() => {});
    return document.opened;
  }

  /**
   * Open the file closed most recently that still exists, Typora's Reopen
   * Closed File. Null when there is none, which the menu says nothing about:
   * the item simply does nothing, as Typora's does.
   */
  async reopenClosed(): Promise<FileTruthOpenReplyV1 | null> {
    while (this.closed.length > 0) {
      const candidate = this.closed.pop()!;
      try {
        await access(candidate);
      } catch {
        continue;
      }
      const opened = await this.openPath(candidate);
      return 'codeView' in opened ? null : opened.opened;
    }
    return null;
  }

  /**
   * Close a document and release its store.
   *
   * The neighbour to the left becomes active, which is what every tabbed editor
   * does and what the eye expects. Closing the last tab leaves the empty state
   * rather than quitting, so an accidental close is not destructive.
   */
  close(filePath: string): void {
    const resolved = path.resolve(filePath);
    const document = this.documents.get(resolved);
    if (!document) return;

    const order = [...this.documents.keys()];
    const index = order.indexOf(resolved);
    document.store.close();
    this.documents.delete(resolved);
    // Remembered for Reopen Closed File, most recent last, each path once.
    this.closed = [...this.closed.filter((known) => known !== resolved), resolved].slice(-20);

    if (this.activePath === resolved) {
      const neighbour = order[index - 1] ?? order[index + 1] ?? null;
      this.activePath = neighbour && this.documents.has(neighbour) ? neighbour : null;
    }

    const next = this.activePath ? this.documents.get(this.activePath) : null;
    if (next) {
      this.publish(next.opened);
      this.applyWindowTitle(next.opened.path);
    } else {
      this.publishClosed();
      this.applyEmptyTitle();
    }
    this.publishTabs();
  }

  /** Release every store, for shutdown. */
  closeAll(): void {
    this.git.close();
    if (this.gutterTimer !== null) clearTimeout(this.gutterTimer);
    for (const document of this.documents.values()) document.store.close();
    this.documents.clear();
    this.activePath = null;
  }

  /** Ask the user for a file. Returns null when the dialog is dismissed. */
  async openWithDialog(): Promise<FileTruthOpenReplyV1 | null> {
    const window = this.getWindow();
    const result = window
      ? await dialog.showOpenDialog(window, this.openOptions())
      : await dialog.showOpenDialog(this.openOptions());
    if (result.canceled || result.filePaths.length === 0) return null;

    let last: FileTruthOpenReplyV1 | null = null;
    for (const filePath of result.filePaths) {
      const opened = await this.openPath(filePath);
      if (!('codeView' in opened)) last = opened.opened;
    }
    return last;
  }

  /**
   * Ask the user for a folder to show in the sidebar.
   *
   * The chosen folder becomes the boundary for every later listing, so a
   * dismissed dialog leaves the previous one in place rather than clearing it.
   */
  async openFolderWithDialog(): Promise<WorkspaceFolderEventV1> {
    const window = this.getWindow();
    const options = {
      title: 'Open a folder',
      properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[],
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return this.folderEvent();

    return this.adoptFolder(path.resolve(result.filePaths[0]));
  }

  /**
   * Switch to a folder already known to be one, without the dialog.
   *
   * The recent list is the caller, and it only ever names a folder this app
   * opened before. It is still resolved and checked, because a folder can be
   * renamed or removed between one launch and the next and the honest answer
   * then is to leave the current one alone.
   */
  async openFolderPath(target: string, chosen = true): Promise<WorkspaceFolderEventV1> {
    const resolved = path.resolve(target);
    try {
      if (!(await stat(resolved)).isDirectory()) return this.folderEvent();
    } catch {
      // Gone since it was last opened. Forgetting it is the recent list's job.
      await this.recentFolders?.forget(resolved);
      return this.folderEvent();
    }
    return this.adoptFolder(resolved, chosen);
  }

  private async adoptFolder(root: string, chosen = true): Promise<WorkspaceFolderEventV1> {
    this.folderRoot = root;
    this.folderChosen = chosen;
    // A new folder invalidates the old index rather than serving it stale.
    this.indexCache = null;
    this.tagIndexCache = null;
    // Not awaited: a status is a background read, and the folder shows without it.
    void this.git.open(root);
    await this.recentFolders?.remember(root);
    this.logger.log('workspace_folder_opened', {});
    const event = this.folderEvent();
    this.send(WORKSPACE_CHANNELS.folderChanged, event);
    return event;
  }

  /**
   * Draw the menu for a row of the file tree.
   *
   * The renderer names the row; everything the menu does runs here, where the
   * filesystem is. The path is resolved through any symlink and checked
   * against the open folder first, because a renderer naming a path is a
   * renderer asking about somewhere, and only somewhere inside the folder the
   * reader opened is an answerable question.
   */
  async treeMenu(target: string, kind: 'file' | 'directory'): Promise<WorkspaceTreeMenuReplyV1> {
    const window = this.getWindow();
    const root = this.folderRoot;
    if (!window || root === null) return { version: NOTO_WORKSPACE_VERSION, accepted: false };

    let real: string;
    let realRoot: string;
    try {
      real = await realpath(path.resolve(target));
      realRoot = await realpath(root);
    } catch {
      return { version: NOTO_WORKSPACE_VERSION, accepted: false };
    }
    if (!isInside(realRoot, real)) {
      this.logger.log('tree_menu_refused', {});
      return { version: NOTO_WORKSPACE_VERSION, accepted: false };
    }

    const items = buildTreeRowMenu(real, kind, {
      open: (target) => { void this.openPath(target).catch(() => {}); },
      // The directory has already been resolved and checked against the open
      // folder above, so the note goes where the reader pressed and nowhere
      // else.
      newNote: (target) => { void this.newFile(target).catch(() => {}); },
      newFolder: (target) => this.send(WORKSPACE_CHANNELS.renameRow, {
        version: NOTO_WORKSPACE_VERSION, path: target, intent: 'new-folder',
      }),
      // The field belongs on the row, so main asks the renderer for the name
      // rather than inventing a dialog for it.
      rename: (target) => this.send(WORKSPACE_CHANNELS.renameRow, {
        version: NOTO_WORKSPACE_VERSION, path: target, intent: 'rename',
      }),
      duplicate: (target) => { void this.manageEntry({ action: 'duplicate', target, name: null }); },
      move: (target) => { void this.manageEntry({ action: 'move', target, name: null }); },
      trash: (target, kind) => { void this.confirmTrash(target, kind); },
      reveal: (target) => shell.showItemInFolder(target),
      copyPath: (target) => clipboard.writeText(target),
    });
    setImmediate(() => Menu.buildFromTemplate(items).popup({ window }));
    return { version: NOTO_WORKSPACE_VERSION, accepted: true };
  }


  /**
   * Rename, duplicate, trash, or make a folder.
   *
   * One method because all four share the part that matters: the target is
   * resolved through every symbolic link and checked against the open folder at
   * the moment the action runs, not when the menu was built. A row can go stale
   * between the two, and acting on a stale row is how a delete lands somewhere
   * nobody meant.
   *
   * The renderer sends a name, never a path. Main joins it to a parent it
   * resolved itself, so there is no string from outside anywhere in the
   * destination.
   */
  async manageEntry(request: {
    action: WorkspaceEntryActionV1;
    target: string;
    name: string | null;
    /** Only `move-into` has one; the callers inside main leave it out. */
    destination?: string | null;
  }): Promise<WorkspaceEntryReplyV1> {
    const real = await this.inRoot(request.target);
    if (real === null) {
      this.logger.log('entry_action_refused', { action: request.action, reason: 'outside-root' });
      return this.refuse(this.folderRoot === null ? 'no-folder' : 'outside-root');
    }

    if (request.action === 'rename') return this.renameEntry(real, request.name);
    if (request.action === 'duplicate') return this.duplicateEntry(real);
    if (request.action === 'new-folder') return this.newFolder(real, request.name);
    if (request.action === 'move') return this.moveEntry(real);
    if (request.action === 'move-into') return this.moveInto(real, request.destination ?? null);
    return this.trashEntry(real);
  }

  /**
   * Ask before moving something to the trash.
   *
   * The one action here that cannot be undone from inside the app, so it is
   * the one that asks. A message box rather than something in the page because
   * it must not be dismissible by a stray keystroke aimed at the document.
   */
  private async confirmTrash(target: string, kind: 'file' | 'directory'): Promise<void> {
    const window = this.getWindow();
    if (!window) return;
    const name = path.basename(target);
    const answer = await dialog.showMessageBox(window, {
      type: 'warning',
      buttons: [trashLabel(process.platform), 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: kind === 'directory'
        ? `Move the folder "${name}" and everything in it to the trash?`
        : `Move "${name}" to the trash?`,
      detail: 'You can put it back from there.',
    });
    if (answer.response !== 0) return;
    await this.manageEntry({ action: 'trash', target, name: null });
  }

  /** The real path, if it is inside the open folder. Null for anything else. */
  private async inRoot(target: string, allowRoot = false): Promise<string | null> {
    const root = this.folderRoot;
    if (root === null) return null;
    try {
      const real = await realpath(path.resolve(target));
      const realRoot = await realpath(root);
      if (!isInside(realRoot, real)) return null;
      // The root itself is not a row, and renaming or trashing the folder the
      // window is showing is not something a row menu should be able to do.
      // It is a perfectly good destination for a move, though.
      return allowRoot || real !== realRoot ? real : null;
    } catch {
      return null;
    }
  }

  private refuse(reason: WorkspaceEntryRefusalV1): WorkspaceEntryReplyV1 {
    return { version: NOTO_WORKSPACE_VERSION, done: false, reason };
  }

  private done(target: string): WorkspaceEntryReplyV1 {
    this.send(WORKSPACE_CHANNELS.treeChanged, { version: NOTO_WORKSPACE_VERSION });
    this.git.refresh();
    return { version: NOTO_WORKSPACE_VERSION, done: true, path: target };
  }

  private async renameEntry(real: string, typed: string | null): Promise<WorkspaceEntryReplyV1> {
    if (!isEntryName(typed)) return this.refuse('bad-name');
    const parent = path.dirname(real);
    const current = path.basename(real);
    const isDirectory = (await stat(real)).isDirectory();
    // A note renamed to something with no extension would vanish from a tree
    // that lists only what it can open, so it keeps the one it had.
    const name = isDirectory ? typed : renamedFileName(typed, current);
    if (name === current) return this.done(real);

    const destination = path.join(parent, name);
    if (await this.occupied(destination, real)) return this.refuse('exists');
    if (this.busyUnder(real)) return this.refuse('busy');

    try {
      await rename(real, destination);
    } catch {
      return this.refuse('failed');
    }
    await this.followMove(real, destination);
    this.logger.log('entry_renamed', { directory: isDirectory });
    return this.done(destination);
  }

  /**
   * Move a file or folder somewhere else in the vault.
   *
   * The destination is chosen with the system's folder dialog, and then checked
   * against the open folder like every other path: the dialog can reach the
   * whole disk and only the part inside the vault is a place this may write.
   *
   * A folder cannot be moved into itself or into anything under it, which is
   * the one move that would leave a piece of the tree pointing at nothing.
   * `isInside` answers both, since it is true for a folder and itself.
   */
  /**
   * Move something into a folder the reader dragged it onto.
   *
   * The same checks the dialog's move makes, and one more: a drop back into
   * the folder something already lives in is not a refusal, it is nothing,
   * which is what a short drag usually means.
   */
  private async moveInto(real: string, destination: string | null): Promise<WorkspaceEntryReplyV1> {
    if (destination === null) return this.refuse('failed');
    const folder = await this.inRoot(destination, true);
    if (folder === null) return this.refuse('outside-root');
    if (folder === real || isInside(real, folder)) return this.refuse('into-itself');

    const target = path.join(folder, path.basename(real));
    if (target === real) return this.done(real);
    if (await this.occupied(target, real)) return this.refuse('exists');
    if (this.busyUnder(real)) return this.refuse('busy');

    try {
      await rename(real, target);
    } catch {
      return this.refuse('failed');
    }
    await this.followMove(real, target);
    this.logger.log('entry_moved', { by: 'drag' });
    return this.done(target);
  }

  private async moveEntry(real: string): Promise<WorkspaceEntryReplyV1> {
    const window = this.getWindow();
    const options = {
      title: 'Move to',
      defaultPath: path.dirname(real),
      properties: ['openDirectory' as const, 'createDirectory' as const],
    };
    const chosen = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (chosen.canceled || chosen.filePaths.length === 0) return this.done(real);

    const destination = await this.inRoot(chosen.filePaths[0], true);
    if (destination === null) return this.refuse('outside-root');
    if (isInside(real, destination)) return this.refuse('into-itself');

    const target = path.join(destination, path.basename(real));
    if (target === real) return this.done(real);
    if (await this.occupied(target, real)) return this.refuse('exists');
    if (this.busyUnder(real)) return this.refuse('busy');

    try {
      await rename(real, target);
    } catch {
      return this.refuse('failed');
    }
    await this.followMove(real, target);
    this.logger.log('entry_moved', {});
    return this.done(target);
  }

  private async duplicateEntry(real: string): Promise<WorkspaceEntryReplyV1> {
    const parent = path.dirname(real);
    let taken: Set<string>;
    try {
      taken = new Set(await readdir(parent));
    } catch {
      return this.refuse('failed');
    }
    const destination = path.join(parent, duplicateName(path.basename(real), taken));
    try {
      // Recursive so a folder brings what is in it, and `force: false` so a
      // name that appeared between the listing and now is an error, not a
      // silent overwrite.
      await cp(real, destination, { recursive: true, force: false, errorOnExist: true });
    } catch {
      return this.refuse('failed');
    }
    this.logger.log('entry_duplicated', {});
    return this.done(destination);
  }

  private async newFolder(real: string, typed: string | null): Promise<WorkspaceEntryReplyV1> {
    if (!isEntryName(typed)) return this.refuse('bad-name');
    let inside = real;
    try {
      if (!(await stat(real)).isDirectory()) inside = path.dirname(real);
    } catch {
      return this.refuse('failed');
    }
    const destination = path.join(inside, typed);
    try {
      // Not recursive: this makes one folder, and a name that already exists
      // is an answer rather than something to quietly accept.
      await mkdir(destination);
    } catch (cause) {
      return this.refuse((cause as NodeJS.ErrnoException).code === 'EEXIST' ? 'exists' : 'failed');
    }
    this.logger.log('folder_created', {});
    return this.done(destination);
  }

  /**
   * Move to the system trash, never delete.
   *
   * `shell.trashItem` and no fallback. A permanent delete offered when the
   * trash is unavailable, which is what Typora does, turns the one action with
   * no undo into the one the reader reaches for when they are already
   * frustrated that the first attempt failed.
   */
  private async trashEntry(real: string): Promise<WorkspaceEntryReplyV1> {
    if (this.busyUnder(real)) return this.refuse('busy');
    try {
      await shell.trashItem(real);
    } catch {
      this.logger.log('entry_trash_failed', {});
      return this.refuse('trash-failed');
    }
    // Anything open from under it has no file any more, so its tab goes.
    for (const openPath of [...this.documents.keys()]) {
      if (openPath === real || isInside(real, openPath)) this.close(openPath);
    }
    this.logger.log('entry_trashed', {});
    return this.done(real);
  }

  /** Whether anything open under `real` is mid-save or holding recovery evidence. */
  private busyUnder(real: string): boolean {
    for (const [openPath, document] of this.documents) {
      if (openPath !== real && !isInside(real, openPath)) continue;
      if (document.store.busy) return true;
    }
    return false;
  }

  /**
   * Whether something already stands at `destination` that is not `source`.
   *
   * A case-only rename on a case-insensitive filesystem finds the source
   * itself standing at the destination, which is not a collision, so the two
   * are compared by the filesystem object they name rather than by their paths.
   */
  private async occupied(destination: string, source: string): Promise<boolean> {
    try {
      const [there, here] = await Promise.all([stat(destination), stat(source)]);
      return !(there.dev === here.dev && there.ino === here.ino);
    } catch {
      return false;
    }
  }

  /**
   * Re-point every open document that lived under a path that just moved.
   *
   * The map is rebuilt in order rather than having entries deleted and
   * re-inserted, because insertion order decides which neighbour `close` falls
   * back to and reordering it would move the reader to a different tab.
   */
  private async followMove(from: string, to: string): Promise<void> {
    const moved = [...this.documents.keys()].filter((openPath) => openPath === from || isInside(from, openPath));
    if (moved.length === 0) return;

    const rebuilt = new Map<string, OpenDocument>();
    for (const [openPath, document] of this.documents) {
      if (!moved.includes(openPath)) {
        rebuilt.set(openPath, document);
        continue;
      }
      const next = openPath === from ? to : path.join(to, path.relative(from, openPath));
      document.store.adoptPath(next);
      rebuilt.set(next, document);
      if (this.activePath === openPath) this.activePath = next;
    }
    this.documents.clear();
    for (const [openPath, document] of rebuilt) this.documents.set(openPath, document);
    this.publishTabs();
    await this.recent.remember(this.activePath ?? to).catch(() => {});
  }

  /**
   * Write out the document as Noto draws it: a page, or a printed page.
   *
   * These two come from the renderer rather than from Pandoc because what they
   * are for is how the note looks, which Pandoc has never seen. The markup
   * arrives already serialized; main adds the stylesheet, chooses the file and,
   * for a PDF, prints it in a window nobody sees.
   */
  async exportRendered(request: {
    target: WorkspaceExportKindV1;
    html: string | null;
    title: string;
    dirty: boolean;
  }): Promise<WorkspaceExportReplyV1> {
    const note = this.activePath;
    if (note === null) return { version: NOTO_WORKSPACE_VERSION, exported: false, reason: 'no-document' };

    if (needsPandoc(request.target)) {
      const outcome = await this.exportThroughPandoc(request.target, request.dirty);
      return outcome.exported
        ? { version: NOTO_WORKSPACE_VERSION, exported: true, path: outcome.path }
        : { version: NOTO_WORKSPACE_VERSION, exported: false, reason: outcome.reason };
    }
    if (request.html === null) {
      return { version: NOTO_WORKSPACE_VERSION, exported: false, reason: 'failed' };
    }

    const extension = request.target === 'pdf' ? 'pdf' : 'html';
    const destination = await this.chooseDestination(
      `${request.title}.${extension}`,
      extension === 'pdf' ? 'PDF' : 'Web page',
      extension,
    );
    if (destination === null) return { version: NOTO_WORKSPACE_VERSION, exported: false, reason: 'cancelled' };

    // The pictures travel inside the file. The addresses in the markdown are
    // relative to the note, which is right in the note and wrong everywhere
    // else, and a PDF is printed from a temporary directory where a relative
    // address resolves to nothing at all.
    const body = await inlineImages(request.html, {
      noteDirectory: path.dirname(note),
      read: readFileBytes,
      // Export reads the same files the asset protocol would serve: inside a
      // session root, after every symbolic link in the path has been followed.
      resolve: (absolute) => resolveAssetPath(absolute, { roots: this.imageRoots(), realpath }),
    });
    const page = standaloneHtml({
      title: request.title,
      body,
      styled: request.target !== 'html-plain',
    });

    try {
      if (request.target === 'html' || request.target === 'html-plain') {
        await writeFile(destination, page, 'utf8');
      } else {
        await this.printPage(page, destination);
      }
    } catch (cause) {
      this.logger.log('export_failed', {
        target: request.target,
        code: cause instanceof Error ? cause.message.split(':', 1)[0] : 'EXPORT_FAILED',
      });
      return { version: NOTO_WORKSPACE_VERSION, exported: false, reason: 'failed' };
    }
    this.logger.log('exported', { target: request.target });
    return { version: NOTO_WORKSPACE_VERSION, exported: true, path: destination };
  }

  /**
   * Print a page to PDF in a window that is never shown.
   *
   * The page is written to a temporary file and loaded from it rather than
   * handed over as a data URL: a whole document of markup makes a URL megabytes
   * long, and every layer between here and Chromium has its own opinion about
   * how long a URL may be.
   *
   * The window has no preload and no node integration. It is rendering markup
   * built from the reader's own note, which is not hostile, but a window with
   * nothing in it cannot be made to do anything either way.
   */
  private async printPage(page: string, destination: string): Promise<void> {
    const scratch = path.join(tmpdir(), `noto-export-${randomUUID()}.html`);
    const printer = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        javascript: false,
        webSecurity: true,
      },
    });
    try {
      await writeFile(scratch, page, 'utf8');
      await printer.loadFile(scratch);
      const pdf = await printer.webContents.printToPDF({
        printBackground: true,
        // A4 with the margins a document is read with rather than the browser's
        // own, which leaves a printed note swimming in white.
        pageSize: 'A4',
        margins: { top: 0.6, bottom: 0.6, left: 0.7, right: 0.7 },
      });
      await writeFile(destination, pdf);
    } finally {
      printer.destroy();
      await rm(scratch, { force: true }).catch(() => {});
    }
  }

  /** A save dialog for an exported file, which is never a note. */
  private async chooseDestination(name: string, filterName: string, extension: string): Promise<string | null> {
    const window = this.getWindow();
    const options = {
      title: 'Export',
      defaultPath: this.folderRoot ? path.join(this.folderRoot, name) : name,
      filters: [{ name: filterName, extensions: [extension] }],
    };
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    return result.canceled || !result.filePath ? null : result.filePath;
  }

  /**
   * Convert the note in front into a document format, through Pandoc.
   *
   * The file on disk is what is converted, not the screen, so a note with
   * unsaved changes is refused rather than quietly exported at its last saved
   * version: that is the kind of wrong nobody notices until after they have
   * sent it to somebody. `dirty` comes from the renderer, which is where the
   * knowledge of unsaved work lives.
   */
  async exportThroughPandoc(target: ExportTarget, dirty: boolean): Promise<ExportOutcome> {
    const outcome = await exportThroughPandoc(target, {
      notePath: this.activePath,
      dirty,
      choose: (suggested) => this.chooseDestination(
        suggested, exportShape(target).label, exportShape(target).extension,
      ),
      findPandoc: () => findPandoc(),
      run: runPandoc,
    });
    this.logger.log(outcome.exported ? 'exported' : 'export_refused',
      { target, reason: outcome.exported ? 'ok' : outcome.reason });
    return outcome;
  }

  /**
   * Convert a document that is not markdown and open the result.
   *
   * The note lands in the open folder, so it is in the vault and visible in the
   * tree the moment it arrives, rather than beside a file the reader picked
   * from somewhere else entirely.
   */
  async importDocument(): Promise<ImportOutcome> {
    const window = this.getWindow();
    const outcome = await importDocument({
      folder: this.folderRoot,
      choose: async () => {
        const options = {
          title: 'Import',
          properties: ['openFile' as const],
          filters: [{ name: 'Documents', extensions: [...IMPORTABLE_EXTENSIONS] }],
        };
        const result = window
          ? await dialog.showOpenDialog(window, options)
          : await dialog.showOpenDialog(options);
        return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
      },
      findPandoc: () => findPandoc(),
      run: runPandoc,
    });
    if (outcome.imported) {
      this.logger.log('document_imported', {});
      await this.openPath(outcome.path);
      this.send(WORKSPACE_CHANNELS.treeChanged, { version: NOTO_WORKSPACE_VERSION });
      this.git.refresh();
    } else {
      this.logger.log('document_import_refused', { reason: outcome.reason });
    }
    return outcome;
  }

  /**
   * Make a new note and open it.
   *
   * Where it goes is decided here rather than asked for: the folder that is
   * open, or failing that the folder the note in front came from. A request
   * that could name its own path would be a request to write anywhere this
   * process can reach, and the renderer is the least trusted side of it.
   *
   * The name is the first free one, and the file is created with the flag that
   * fails if something is already there, so a note is never written over even
   * if one appears between the check and the write.
   */
  async newFile(inside?: string): Promise<WorkspaceNewFileReplyV1> {
    const directory = inside ?? this.folderRoot ?? (this.activePath ? path.dirname(this.activePath) : null);
    if (directory === null) return { version: NOTO_WORKSPACE_VERSION, created: false, path: null };

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const name = attempt === 0 ? 'Untitled.md' : `Untitled ${attempt + 1}.md`;
      const target = path.join(directory, name);
      try {
        await writeFile(target, '', { encoding: 'utf8', flag: 'wx' });
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw cause;
      }
      await this.openPath(target);
      this.git.refresh();
      this.logger.log('workspace_note_created', {});
      return { version: NOTO_WORKSPACE_VERSION, created: true, path: target };
    }
    throw new Error('A hundred notes here are already called Untitled.');
  }

  /**
   * Hand a link in a note to the browser.
   *
   * What is opened is the normalised URL this check returns, never the string
   * that arrived: the parser here and the one the operating system opens with
   * do not have to agree, and checking one string while opening another is
   * how that difference becomes a bug.
   *
   * The scheme is checked here as well as in the renderer and the preload,
   * because this is the side that calls `shell.openExternal`, and that hands
   * the string to the operating system, which will launch a handler for any
   * scheme the machine knows. The URL came out of somebody's file: it is
   * exactly the kind of input this boundary exists for. The renderer having
   * checked it already is not a reason to skip checking it here, it is the
   * reason there are three checks.
   */
  openExternal(url: string): WorkspaceOpenExternalReplyV1 {
    const safe = openableExternalUrl(url);
    if (safe === null) {
      this.logger.log('external_link_refused', { length: url.length });
      return { version: NOTO_WORKSPACE_VERSION, opened: false };
    }
    // The normalised form, never the string that arrived.
    void shell.openExternal(safe);
    this.logger.log('external_link_opened', {});
    return { version: NOTO_WORKSPACE_VERSION, opened: true };
  }

  /**
   * Show the folder, or the document in front, in the system file manager.
   *
   * The path is taken from this session rather than from the request, so the
   * caller chooses between two things it can already see and cannot name a
   * third. `showItemInFolder` reveals a path by selecting it inside its parent,
   * which is what "reveal" means on every platform that has the idea.
   */
  reveal(target: WorkspaceRevealTargetV1): WorkspaceRevealReplyV1 {
    const path = target === 'folder' ? this.folderRoot : this.activePath;
    if (!path) return { version: NOTO_WORKSPACE_VERSION, revealed: false };
    shell.showItemInFolder(path);
    this.logger.log('workspace_revealed', { target });
    return { version: NOTO_WORKSPACE_VERSION, revealed: true };
  }

  /**
   * Search inside the notes of the current folder.
   *
   * Scans the same index quick open ranks, so the two agree about which files
   * exist and neither can find something the other cannot.
   */
  async searchContent(query: string, flags: SearchFlags, scope = ''): Promise<WorkspaceContentReplyV1> {
    const index = await this.fileIndex();
    const within = scope.length === 0
      ? index.entries
      : index.entries.filter((entry) => entry.relativePath.startsWith(`${scope}/`));
    return searchContent(within, query, flags);
  }

  /** Entries inside a directory of the chosen folder. */
  /**
   * The whole openable file list for the current folder.
   *
   * Cached against the root, because the walk is the expensive part and the
   * renderer asks for it whenever quick open is first used. It is dropped when
   * the folder changes rather than kept warm for a folder nobody is in.
   */
  /**
   * What the vault's note-assistant graph knows about one note.
   *
   * The note has to be inside the open folder, since the graph's paths are
   * relative to it; a note from elsewhere is simply not known.
   */
  /** Tell the renderer its listing is stale, without saying what changed. */
  announceTreeChanged(): void {
    // A rename or new note can change which tags exist; drop the scan so the
    // next Browse Tags sees the vault as it is now.
    this.tagIndexCache = null;
    this.send(WORKSPACE_CHANNELS.treeChanged, { version: NOTO_WORKSPACE_VERSION });
    // A rename, a trash or a new note changes what git reports.
    this.git.refresh();
  }

  /** The git marks as main holds them. Never runs git itself. */
  gitMarks() {
    return this.git.current();
  }

  /**
   * Something on disk may differ from what git last said: a save landed, or
   * the window came back from another program that may have committed.
   * Debounced inside, so callers need not be careful how often they say so.
   */
  refreshGitMarks(): void {
    this.git.refresh();
  }


  /**
   * Every tag the open vault's notes declare, with how many notes carry each.
   *
   * Built once per folder from the same file index quick open uses, and kept
   * until the folder changes. The scan only reads frontmatter, so it stays
   * cheaper than a content search of the same vault.
   */
  async tagIndex(): Promise<WorkspaceTagIndexReplyV1> {
    const empty = (): WorkspaceTagIndexReplyV1 => ({
      version: NOTO_WORKSPACE_VERSION, tags: [], truncated: false,
    });
    if (!this.folderRoot) return empty();
    const index = await this.ensureTagIndex();
    return {
      version: NOTO_WORKSPACE_VERSION,
      tags: index.tags.map((entry) => ({ tag: entry.tag, count: entry.notes.length })),
      truncated: index.truncated,
    };
  }

  /** Notes that carry one tag, matched case-insensitively. */
  async notesByTag(tag: string): Promise<WorkspaceNotesByTagReplyV1> {
    if (!this.folderRoot) {
      return { version: NOTO_WORKSPACE_VERSION, tag, notes: [] };
    }
    const index = await this.ensureTagIndex();
    const notes = notesForTag(index, tag).map((note) => ({
      path: note.path,
      relativePath: note.relativePath,
      title: note.title,
    }));
    // Prefer the spelling the index first saw, so the panel's heading matches the chips.
    const canonical = index.tags.find((entry) => entry.tag.toLowerCase() === tag.toLowerCase())?.tag ?? tag;
    return { version: NOTO_WORKSPACE_VERSION, tag: canonical, notes };
  }

  private async ensureTagIndex(): Promise<TagIndex> {
    if (this.tagIndexCache?.root === this.folderRoot) return this.tagIndexCache.index;
    const files = await this.fileIndex();
    const index = await buildTagIndex(files.entries);
    if (this.folderRoot) this.tagIndexCache = { root: this.folderRoot, index };
    return index;
  }

  async noteLinks(target: string): Promise<WorkspaceLinksReplyV1> {
    const empty = (available: boolean, known: boolean, generatedAt: string | null = null): WorkspaceLinksReplyV1 => ({
      version: NOTO_WORKSPACE_VERSION, available, known, generatedAt, backlinks: [], links: [], related: [],
    });
    const root = this.folderRoot;
    if (!root) {
      this.logger.log('note_links', { outcome: 'no-folder' });
      return empty(false, false);
    }
    const graph = await this.graphCache.graphFor(root);
    if (!graph) {
      this.logger.log('note_links', { outcome: 'no-graph' });
      return empty(false, false);
    }
    let realRoot: string;
    let real: string;
    try {
      realRoot = await realpath(root);
      real = await realpath(path.resolve(target));
    } catch {
      return empty(true, false, graph.generatedAt);
    }
    if (!isInside(realRoot, real)) {
      this.logger.log('note_links', { outcome: 'outside' });
      return empty(true, false, graph.generatedAt);
    }
    const relative = path.relative(realRoot, real).split(path.sep).join('/');
    const { known, links: found } = linksForNote(graph, relative);
    const absolute = (link: { relativePath: string; title: string }) => ({
      path: path.join(root, ...link.relativePath.split('/')),
      relativePath: link.relativePath,
      title: link.title,
    });
    if (!known) {
      const derived = found.backlinks.length + found.related.length;
      this.logger.log('note_links', {
        outcome: derived > 0 ? 'derived' : 'unknown',
        backlinks: found.backlinks.length,
        related: found.related.length,
      });
      return {
        version: NOTO_WORKSPACE_VERSION,
        available: true,
        known: false,
        generatedAt: graph.generatedAt,
        backlinks: found.backlinks.map(absolute),
        links: [],
        related: found.related.map(absolute),
      };
    }
    this.logger.log('note_links', {
      outcome: 'found', backlinks: found.backlinks.length, links: found.links.length, related: found.related.length,
    });
    return {
      version: NOTO_WORKSPACE_VERSION,
      available: true,
      known: true,
      generatedAt: graph.generatedAt,
      backlinks: found.backlinks.map(absolute),
      links: found.links.map(absolute),
      related: found.related.map(absolute),
    };
  }

  async fileIndex(): Promise<WorkspaceIndexReplyV1> {
    if (!this.folderRoot) {
      return { version: NOTO_WORKSPACE_VERSION, root: null, entries: [], truncated: false };
    }
    if (this.indexCache?.root === this.folderRoot) return this.indexCache.reply;
    const { entries, truncated } = await buildFileIndex(this.folderRoot);
    const reply: WorkspaceIndexReplyV1 = {
      version: NOTO_WORKSPACE_VERSION, root: this.folderRoot, entries, truncated,
    };
    this.indexCache = { root: this.folderRoot, reply };
    return reply;
  }

  async listFolder(target: string): Promise<{ version: typeof NOTO_WORKSPACE_VERSION; entries: FileTreeEntryV1[] }> {
    if (!this.folderRoot) throw new Error('NO_FOLDER_OPEN: choose a folder first');
    return {
      version: NOTO_WORKSPACE_VERSION,
      entries: await listDirectory(
        this.folderRoot, path.resolve(target), this.treeSort(), this.codeViewer(),
      ),
    };
  }

  /** The folder open now, for a renderer that subscribed after it opened. */
  currentFolder(): WorkspaceFolderEventV1 {
    return this.folderEvent();
  }

  private folderEvent(): WorkspaceFolderEventV1 {
    return {
      version: NOTO_WORKSPACE_VERSION,
      root: this.folderRoot,
      name: this.folderRoot ? path.basename(this.folderRoot) : null,
      chosen: this.folderChosen,
    };
  }

  /** Ask the user where to write a copy. Returns null when dismissed. */
  async saveAsWithDialog(): Promise<string | null> {
    const window = this.getWindow();
    const current = this.currentPath;
    const suggested = current
      ? path.join(path.dirname(current), `${path.parse(current).name} copy.md`)
      : 'Untitled.md';
    const options = {
      title: 'Save a copy',
      defaultPath: suggested,
      filters: MARKDOWN_FILTERS,
      properties: ['createDirectory', 'showOverwriteConfirmation'] as const,
    };
    const result = window
      ? await dialog.showSaveDialog(window, { ...options, properties: [...options.properties] })
      : await dialog.showSaveDialog({ ...options, properties: [...options.properties] });
    return result.canceled || !result.filePath ? null : result.filePath;
  }

  /** Re-send the current state, for a renderer that just finished loading. */
  republish(): void {
    const current = this.current;
    if (current) this.publish(current);
    this.publishTabs();
    if (this.folderRoot) this.send(WORKSPACE_CHANNELS.folderChanged, this.folderEvent());
    if (this.git.current().files.length > 0) this.send(WORKSPACE_CHANNELS.gitMarksChanged, this.git.current());
    if (this.lastGutter) this.send(WORKSPACE_CHANNELS.gitBlocksChanged, this.lastGutter);
  }

  private openOptions() {
    return {
      title: 'Open a Markdown document',
      filters: MARKDOWN_FILTERS,
      properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[],
      defaultPath: this.currentPath ? path.dirname(this.currentPath) : undefined,
    };
  }


  private send(channel: string, payload: unknown): void {
    const window = this.getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send(channel, payload);
  }

  private publish(opened: FileTruthOpenReplyV1): void {
    this.send(WORKSPACE_CHANNELS.documentOpened, {
      version: NOTO_WORKSPACE_VERSION,
      opened,
    });
    this.scheduleGutter();
  }

  /**
   * Compare the note in front with its committed version, once things settle.
   *
   * Debounced with the tree's refreshes and run after the note is on screen,
   * never on the open's own path: git and the diff are a background read.
   */
  private scheduleGutter(): void {
    if (this.gutterTimer !== null) clearTimeout(this.gutterTimer);
    this.gutterTimer = setTimeout(() => {
      this.gutterTimer = null;
      void this.updateGutter().catch(() => { /* Absent, quietly. */ });
    }, 300);
  }

  private async updateGutter(): Promise<void> {
    const run = ++this.gutterRun;
    const filePath = this.activePath;
    const store = filePath ? this.documents.get(filePath)?.store ?? null : null;
    const accepted = store?.acceptedBlocks ?? null;
    if (!filePath || !accepted) return;
    const git = await defaultGitRunner();
    const diff = git === null ? null : await gitBlockDiff(
      git, filePath, accepted.blocks.map((block) => block.markdown), accepted.byteLength,
    );
    // A save, a switch of tab or a newer run while git was answering.
    if (run !== this.gutterRun || store?.acceptedBlocks?.documentId !== accepted.documentId
      || store.acceptedBlocks.blocks !== accepted.blocks) return;
    const event: WorkspaceGitBlocksV1 = {
      version: NOTO_WORKSPACE_VERSION,
      documentId: accepted.documentId,
      blocks: (diff?.changed ?? []).map((entry) => ({
        blockId: accepted.blocks[entry.ordinal]!.id, change: entry.change, head: entry.head,
      })),
      deleted: (diff?.deleted ?? []).map((entry) => ({
        beforeBlockId: accepted.blocks[entry.before]?.id ?? null, head: entry.head,
      })),
    };
    const previous = this.lastGutter;
    this.lastGutter = event;
    // Nothing to draw and nothing drawn: not news.
    if (event.blocks.length === 0 && event.deleted.length === 0
      && (previous === null || (previous.blocks.length === 0 && previous.deleted.length === 0))) return;
    this.send(WORKSPACE_CHANNELS.gitBlocksChanged, event);
  }

  private publishClosed(): void {
    this.send(WORKSPACE_CHANNELS.documentClosed, { version: NOTO_WORKSPACE_VERSION });
  }

  private publishTabs(): void {
    this.send(WORKSPACE_CHANNELS.tabsChanged, {
      version: NOTO_WORKSPACE_VERSION,
      tabs: this.tabs(),
    });
  }

  private applyWindowTitle(filePath: string): void {
    const window = this.getWindow();
    if (!window || window.isDestroyed()) return;
    window.setTitle(path.basename(filePath));
    // Gives macOS the proxy icon and the standard "edited" dot behaviour.
    window.setRepresentedFilename(filePath);
  }

  private applyEmptyTitle(): void {
    const window = this.getWindow();
    if (!window || window.isDestroyed()) return;
    window.setTitle('Noto');
    window.setRepresentedFilename('');
  }
}

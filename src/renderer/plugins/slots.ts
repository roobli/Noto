/**
 * Slots: the places in the shell a plugin can put its own interface.
 *
 * The rule (docs/architecture/plugin-slots.md) is that the app is the first
 * plugin: an area of the window is a slot, a service the app's own features
 * use is a named capability, and a bundled feature registers through the same
 * slot a third party would. A slot hands over a DOM element and a host object,
 * never React or the shell's state, so a plugin may render with anything.
 *
 * Shell contributions live as long as the plugin is switched on, with or
 * without a note open, which is the difference from editor extensions: those
 * live inside the editor's lease and go when the note does.
 */

import { copyThroughSelection } from '../editor/noto/clipboard';
import type {
  WorkspaceNoteHistoryReplyV1, WorkspaceMemoryAskReplyV1, WorkspaceNoteMemoryReplyV1, WorkspaceReviewActionV1, WorkspaceReviewReplyV1,
} from '../../shared/workspace/v1/contracts';

export type Disposer = () => void;

export type GitChange = 'modified' | 'new' | 'deleted';

/** What git says about the open folder's notes: absolute paths, as the tree gets them. */
export interface GitSnapshot {
  /** The folder the marks are for; null when the folder is not in git. */
  readonly root: string | null;
  readonly files: ReadonlyArray<readonly [string, GitChange]>;
  /** True when git has been read for the folder; absent when nothing is known. */
  readonly repository?: true;
  /**
   * The folder as the file system names it, which every path in `files` is
   * under. It differs from `root` when the folder was opened through a link,
   * or on Windows through a short name. Present with `repository`.
   */
  readonly realRoot?: string;
}

/** A note's history as `git.read` gives it: see `WorkspaceNoteHistoryReplyV1`. */
export type NoteHistory = Omit<WorkspaceNoteHistoryReplyV1, 'version'>;
export type { NoteCommitV1 as NoteCommit } from '../../shared/workspace/v1/contracts';

/** The `git.read` capability. */
export interface GitService {
  current(): GitSnapshot | null;
  subscribe(listener: () => void): Disposer;
  /**
   * The commits that touched a note, newest first, following renames, with
   * what is on disk since the last commit. Null when main could not be asked.
   */
  history(path: string): Promise<NoteHistory | null>;
  /** A note's text at one of its own commits, by the path it had there. */
  version(path: string, commit: string, at: string): Promise<string | null>;
}

/** What the folder's memory says about a note: see `WorkspaceNoteMemoryReplyV1`. */
export type NoteMemoryAnswer = Omit<WorkspaceNoteMemoryReplyV1, 'version'>;
export type { NoteMemoryV1 as NoteMemory } from '../../shared/workspace/v1/contracts';

/** The `vault.read` capability: the open folder's memory, `@roobli/vault`'s index of it. */
export interface VaultService {
  /** What the memory knows about a note. Null when main could not be asked. */
  about(path: string): Promise<NoteMemoryAnswer | null>;
  /** Called when the memory opened or changed, so what was asked may be asked again. */
  subscribe(listener: () => void): Disposer;
  /**
   * Begin keeping memory for the open folder: the files `noto-vault init`
   * makes, then the index. Main first asks the person, saying what will be
   * written, in a sheet of its own; `cancelled` when they said no.
   */
  keep(): Promise<'made' | 'cancelled' | 'failed'>;
  /**
   * Let the open folder's memory run the scripts in its `.noto/scripts`, which
   * it needs before it opens (`untrusted`). Main names them and asks the
   * person; true when they are allowed.
   */
  trust(): Promise<boolean>;
}

export type {
  ReviewDismissalV1 as ReviewDismissal, ReviewKindV1 as ReviewKind, ReviewProposalV1 as ReviewProposal,
  ReviewSuggestionV1 as ReviewSuggestion, ReviewSummaryV1 as ReviewSummary, WorkspaceReviewActionV1 as ReviewAction,
} from '../../shared/workspace/v1/contracts';

/** What Review's memory answered: see `WorkspaceReviewReplyV1`. */
export type ReviewAnswer<K extends WorkspaceReviewActionV1['kind'] = WorkspaceReviewActionV1['kind']> = Omit<WorkspaceReviewReplyV1<K>, 'version'>;

/**
 * The `vault.review` capability: the open folder's queue of what agents
 * proposed and what the tools found, and the writes that settle it. Main
 * leaves alone any note with unsaved edits, and names it.
 */
export interface ReviewService {
  ask<K extends WorkspaceReviewActionV1['kind']>(action: Extract<WorkspaceReviewActionV1, { kind: K }>): Promise<ReviewAnswer<K>>;
  /** Called when the memory opened or changed, so what was asked may be asked again. */
  subscribe(listener: () => void): Disposer;
}

/** What every slot gets: where the window is, and how to go somewhere. */
export interface ShellHost {
  /** The folder open now, or null. */
  folder(): string | null;
  /** The note in front, as an absolute path, or null. */
  activeNote(): string | null;
  /** Bring a note to the front, as a click in the file tree would. */
  openNote(path: string): void;
  /**
   * The shell's own menu for a note or folder, as a right click on its row in
   * the file tree shows it: open, rename, duplicate, move, reveal, copy path,
   * trash. Main checks the path against the open folder and runs every item;
   * a path outside it, or gone from disk, shows nothing.
   */
  showFileMenu(path: string, kind: 'file' | 'directory'): void;
  /** Called when the folder or the note in front changes. */
  subscribe(listener: () => void): Disposer;
}

export interface RailPageHost extends ShellHost {
  /** Present only for a plugin that declares `git.read`. */
  readonly git: GitService | null;
  /** Present only for a plugin that declares `vault.read`. */
  readonly vault: VaultService | null;
  /** Present only for a plugin that declares `vault.review`. */
  readonly review: ReviewService | null;
  /** Open the diff view over the page; null closes the one this plugin opened. */
  showDiff(request: DiffRequest | null): void;
}

export interface RailPageContribution {
  /** Unique within the plugin. */
  readonly id: string;
  /** Said by the toggle's tooltip and to a screen reader. */
  readonly title: string;
  /** The toggle's icon: the `d` of a path in a 16 by 16 box, stroked like the rail's own icons. */
  readonly icon: string;
  mount(element: HTMLElement, host: RailPageHost): Disposer;
}

export interface RailPageEntry {
  /** `pluginId:pageId`, unique across plugins. */
  readonly key: string;
  readonly pluginId: string;
  readonly page: RailPageContribution;
  readonly badge: string | null;
  readonly host: RailPageHost;
}

export interface RailPageHandle {
  /** A short count or mark beside the toggle; null for none. */
  setBadge(text: string | null): void;
  dispose(): void;
}

/**
 * The info pane: everything about the note in front, beside the page.
 *
 * The shell owns the pane itself (where it is, its width, whether it is open,
 * the note's name and state at its head, a timeline across its top, and the
 * row of tabs) and plugins fill it. A tab is a page of the pane about the
 * note; a track is a row on the timeline, marks in time (commits) or amounts
 * per day (reads), on the same axis as every other track, so what was
 * written when and what was read when can be seen against each other. A
 * press on a mark brings its track's tab to the front and shows the mark
 * there. History and Properties are the app's own tabs; anything else about a
 * note, a plugin adds the same way.
 */
export interface InfoTabContribution {
  /** Unique within the plugin. */
  readonly id: string;
  /** The word on the tab. Short: the pane is narrow. */
  readonly title: string;
  /** Where it sits among the tabs, lower first; the app's own use 10 to 40. */
  readonly order?: number;
  mount(element: HTMLElement, host: InfoTabHost): InfoTabView;
}

/** A mounted tab. It stays mounted while the pane is open, so it keeps its scroll. */
export interface InfoTabView {
  /** Show the thing a timeline mark stands for, by the key the track gave the mark. */
  reveal?(key: string): void;
  dispose(): void;
}

export interface InfoTrackContribution {
  /** Unique within the plugin. */
  readonly id: string;
  /** What the track counts, said beside it and to a screen reader: "Commits". */
  readonly title: string;
  /** Lower is drawn higher. */
  readonly order?: number;
  /** The plugin's tab a press on a mark brings to the front. */
  readonly tab?: string;
  /** The track for a note, or null for none. Aborted when the note changes first. */
  load(note: string, signal: AbortSignal): Promise<InfoTrack | null>;
  /** Called when the track should be loaded again for the same note. */
  changes?(listener: () => void): Disposer;
}

export interface InfoTrack {
  /** Marks at moments, drawn as dots, or amounts per day, drawn as bars. */
  readonly kind: 'events' | 'amounts';
  readonly marks: readonly InfoMark[];
  /** Something not yet in the record (changes not committed), a hollow mark at now. */
  readonly pending?: { readonly label: string; readonly key: string } | null;
  /** A few words for the line under the timeline: "4 commits, last yesterday". */
  readonly summary?: string;
}

export interface InfoMark {
  /** When, in milliseconds. */
  readonly at: number;
  /** The amount, for a track of amounts. */
  readonly value?: number;
  /** What a pointer or a screen reader is told about the mark. */
  readonly label: string;
  /** Handed to the tab's `reveal` when the mark is pressed. */
  readonly key: string;
  /** Drawn quieter: a script's commit, say. */
  readonly faint?: boolean;
}

/**
 * Marks on the note in front: a few words underlined in the page, each with
 * a card that a pointer resting on them, or a key with the caret in them,
 * opens, and the actions on it there. A plugin says where by the words and
 * what is around them on their line, as the saved note has them; the editor
 * finds them in the note as it stands, unsaved edits and all, and marks
 * nothing where they no longer are. Never in code, headings or links.
 *
 * Link suggestions are one kind. Anything that wants a few words of the note
 * to say more, and offer to change them, is another: a reviewer's comment, a
 * term to check, a date to confirm.
 */
export interface NoteMarksContribution {
  /** Unique within the plugin. */
  readonly id: string;
  /** What these marks are, for the card and a screen reader: "Link suggestion". */
  readonly title: string;
  /** The marks for a note, by its path on disk. Aborted when the note changes first. */
  load(note: string, signal: AbortSignal): Promise<readonly NoteMark[]>;
  /** Called when the marks should be loaded again for the same note. */
  changes?(listener: () => void): Disposer;
}

export interface NoteMark {
  /** Unique among this contribution's marks for the note. */
  readonly key: string;
  /** The words marked, as written. */
  readonly text: string;
  /** What comes before them on their line; a leading `…` says it was cut short. */
  readonly before: string;
  /** What comes after them on their line; a trailing `…` says it was cut short. */
  readonly after: string;
  /** The card's first line: "Link to Argus". */
  readonly title: string;
  /** A quieter line under it: where the note it names is. */
  readonly detail?: string;
  /** In order; the first is the one Return chooses. */
  readonly actions: readonly NoteMarkAction[];
}

export interface NoteMarkAction {
  /** Unique within the mark. */
  readonly id: string;
  readonly label: string;
  /** Text to put in place of the marked words, as one edit Undo takes back. */
  readonly replace?: string;
  /** Run when chosen, after any replacement. The mark leaves the page either way. */
  run?(): void | Promise<void>;
}

export interface NoteMarksEntry {
  /** `pluginId:marksId`. */
  readonly key: string;
  readonly pluginId: string;
  readonly marks: NoteMarksContribution;
}

/** Two texts to read against each other in the diff view, over the page. */
export interface DiffRequest {
  readonly title: string;
  /** A quieter line beside the title: who, when, which commit. */
  readonly detail?: string;
  readonly before: { readonly label: string; readonly text: string };
  readonly after: { readonly label: string; readonly text: string };
  /** Buttons in the view's bar, in order. */
  readonly actions?: readonly DiffAction[];
  /** Keys that run an action while the view has the focus, as `[` for Older. */
  readonly keys?: Readonly<Record<string, string>>;
  /**
   * Called when the reader closes the view, by Close or Escape. Not when the
   * plugin closes it, opens another in its place, or the note changes: the
   * plugin knows of those already.
   */
  onClose?(): void;
}

export interface DiffAction {
  /** Unique within the request; also what `keys` names. */
  readonly id: string;
  readonly label: string;
  /** The tooltip, with the key if there is one. */
  readonly title?: string;
  /** Why it cannot run now. The button is shown disabled with this as its tooltip. */
  readonly unavailable?: string;
  run(): void;
}

/** What a tab of the info pane gets. */
export interface InfoTabHost extends RailPageHost {
  /** The note the pane is about: the one in front, once switching has paused. */
  note(): string | null;
  /** Called when `note()` changes. */
  onNote(listener: () => void): Disposer;
  /** The note's text as the editor holds it, unsaved edits and all. Needs `editor.read`; null otherwise. */
  noteText(): string | null;
  /**
   * Put this text in place of the note's, as one edit that Undo takes back.
   * Nothing is written to disk. Needs `editor.transform`; false when the note
   * is read-only, is not the one in front, or the plugin may not.
   */
  replaceNoteText(text: string): boolean;
  /** Bring one of the plugin's tabs to the front, and reveal a key in it. */
  showTab(id: string, key?: string): void;
  /** Put text on the clipboard. */
  copy(text: string): void;
}

export interface InfoTabEntry {
  /** `pluginId:tabId`. */
  readonly key: string;
  readonly pluginId: string;
  readonly tab: InfoTabContribution;
  readonly host: InfoTabHost;
}

export interface InfoTrackEntry {
  readonly key: string;
  readonly pluginId: string;
  readonly track: InfoTrackContribution;
  /** The tab a mark opens, as `pluginId:tabId`, or null. */
  readonly tabKey: string | null;
}

/** What a plugin's shell entry point is handed. */
export interface ShellContext {
  readonly pluginId: string;
  readonly host: RailPageHost;
  /** Present only for a plugin that declares `git.read`. */
  readonly git: GitService | null;
  /** Needs `rail:<id>` among the manifest's `uiExtensions`. */
  registerRailPage(page: RailPageContribution): RailPageHandle;
  /** Needs `info:<id>` among the manifest's `uiExtensions`. */
  registerInfoTab(tab: InfoTabContribution): Disposer;
  /** Needs `track:<id>` among the manifest's `uiExtensions`. */
  registerInfoTrack(track: InfoTrackContribution): Disposer;
  /** Needs `marks:<id>` among the manifest's `uiExtensions`. */
  registerNoteMarks(marks: NoteMarksContribution): Disposer;
}

type Listener = () => void;

class Signal {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): Disposer {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  emit(): void {
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { /* One listener's fault is not the others'. */ }
    }
  }
}

/** The info pane's tabs and tracks, each list in its order. */
export class InfoRegistry {
  private tabList: readonly InfoTabEntry[] = [];
  private trackList: readonly InfoTrackEntry[] = [];
  private readonly changed = new Signal();

  tabs(): readonly InfoTabEntry[] {
    return this.tabList;
  }

  tracks(): readonly InfoTrackEntry[] {
    return this.trackList;
  }

  subscribe(listener: Listener): Disposer {
    return this.changed.subscribe(listener);
  }

  addTab(pluginId: string, tab: InfoTabContribution, host: InfoTabHost): Disposer {
    const key = `${pluginId}:${tab.id}`;
    if (this.tabList.some((entry) => entry.key === key)) throw new Error(`The info tab ${key} is already registered.`);
    this.tabList = sortedByOrder([...this.tabList, { key, pluginId, tab, host }], (entry) => entry.tab.order);
    this.changed.emit();
    return once(() => {
      this.tabList = this.tabList.filter((entry) => entry.key !== key);
      this.changed.emit();
    });
  }

  addTrack(pluginId: string, track: InfoTrackContribution): Disposer {
    const key = `${pluginId}:${track.id}`;
    if (this.trackList.some((entry) => entry.key === key)) throw new Error(`The info track ${key} is already registered.`);
    const tabKey = track.tab ? `${pluginId}:${track.tab}` : null;
    this.trackList = sortedByOrder([...this.trackList, { key, pluginId, track, tabKey }], (entry) => entry.track.order);
    this.changed.emit();
    return once(() => {
      this.trackList = this.trackList.filter((entry) => entry.key !== key);
      this.changed.emit();
    });
  }
}

/** The marks plugins put on the note in front, in registration order. */
export class NoteMarksRegistry {
  private entries: readonly NoteMarksEntry[] = [];
  private readonly changed = new Signal();

  list(): readonly NoteMarksEntry[] {
    return this.entries;
  }

  subscribe(listener: Listener): Disposer {
    return this.changed.subscribe(listener);
  }

  add(pluginId: string, marks: NoteMarksContribution): Disposer {
    const key = `${pluginId}:${marks.id}`;
    if (this.entries.some((entry) => entry.key === key)) throw new Error(`The note marks ${key} are already registered.`);
    this.entries = [...this.entries, { key, pluginId, marks }];
    this.changed.emit();
    return once(() => {
      this.entries = this.entries.filter((entry) => entry.key !== key);
      this.changed.emit();
    });
  }
}

/** Stable: entries with the same order keep the order they came in. */
function sortedByOrder<T>(entries: readonly T[], order: (entry: T) => number | undefined): readonly T[] {
  return entries.map((entry, index) => ({ entry, index }))
    .sort((a, b) => ((order(a.entry) ?? 100) - (order(b.entry) ?? 100)) || a.index - b.index)
    .map(({ entry }) => entry);
}

function once(action: () => void): Disposer {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    action();
  };
}

/** The rail pages plugins have registered, in registration order. */
export class RailPageRegistry {
  private entries: readonly RailPageEntry[] = [];
  private readonly changed = new Signal();

  list(): readonly RailPageEntry[] {
    return this.entries;
  }

  subscribe(listener: Listener): Disposer {
    return this.changed.subscribe(listener);
  }

  add(pluginId: string, page: RailPageContribution, host: RailPageHost): RailPageHandle {
    const key = `${pluginId}:${page.id}`;
    if (this.entries.some((entry) => entry.key === key)) throw new Error(`The rail page ${key} is already registered.`);
    this.entries = [...this.entries, { key, pluginId, page, badge: null, host }];
    this.changed.emit();
    let live = true;
    return {
      setBadge: (text) => {
        if (!live) return;
        const badge = text && text.trim() ? text.trim().slice(0, 4) : null;
        this.entries = this.entries.map((entry) => (entry.key === key && entry.badge !== badge ? { ...entry, badge } : entry));
        this.changed.emit();
      },
      dispose: () => {
        if (!live) return;
        live = false;
        this.entries = this.entries.filter((entry) => entry.key !== key);
        this.changed.emit();
      },
    };
  }
}

/**
 * The shell's side of the host: the shell writes what it knows, every slot
 * reads it and hears when it changes.
 */
export class ShellState {
  private folderRoot: string | null = null;
  private active: string | null = null;
  private marks: GitSnapshot | null = null;
  private readonly where = new Signal();
  private readonly gitChanged = new Signal();
  private open: (path: string) => void = () => {};
  private menu: (path: string, kind: 'file' | 'directory') => void = () => {};
  private settled: string | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly noteSettled = new Signal();
  private reader: Pick<GitService, 'history' | 'version'> = {
    history: async () => null,
    version: async () => null,
  };
  private editorAccess: { text(): string | null; replace(text: string): boolean } = {
    text: () => null,
    replace: () => false,
  };
  private diffs: (request: DiffRequest | null, pluginId: string) => void = () => {};
  private tabs: (key: string, reveal?: string) => void = () => {};
  private memoryAbout: VaultService['about'] = async () => null;
  private memoryKeep: VaultService['keep'] = async () => 'failed';
  private memoryTrust: VaultService['trust'] = async () => false;
  private readonly memoryChanged = new Signal();

  /** How long the note in front must stay before the info pane follows it. */
  static readonly SETTLE_MS = 250;

  readonly host: ShellHost = {
    folder: () => this.folderRoot,
    activeNote: () => this.active,
    openNote: (path) => this.open(path),
    showFileMenu: (path, kind) => this.menu(path, kind),
    subscribe: (listener) => this.where.subscribe(listener),
  };

  readonly git: GitService = {
    current: () => this.marks,
    subscribe: (listener) => this.gitChanged.subscribe(listener),
    history: (path) => this.reader.history(path),
    version: (path, commit, at) => this.reader.version(path, commit, at),
  };

  readonly vault: VaultService = {
    about: (path) => this.memoryAbout(path),
    subscribe: (listener) => this.memoryChanged.subscribe(listener),
    keep: () => this.memoryKeep(),
    trust: () => this.memoryTrust(),
  };

  private reviewAsk: (action: WorkspaceReviewActionV1) => Promise<ReviewAnswer> = async () => ({ state: 'unavailable', value: null, error: null });

  readonly review: ReviewService = {
    ask: (action) => this.reviewAsk(action) as never,
    subscribe: (listener) => this.memoryChanged.subscribe(listener),
  };

  setReviewer(ask: (action: WorkspaceReviewActionV1) => Promise<ReviewAnswer>): void {
    this.reviewAsk = ask;
  }

  setMemoryReader(about: VaultService['about'], keep: VaultService['keep'], trust: VaultService['trust']): void {
    this.memoryAbout = about;
    this.memoryKeep = keep;
    this.memoryTrust = trust;
  }

  /** Main said the memory opened or changed. */
  memoryMoved(): void {
    this.memoryChanged.emit();
  }

  /** The note the info pane is about. */
  settledNote(): string | null {
    return this.settled;
  }

  onSettledNote(listener: Listener): Disposer {
    return this.noteSettled.subscribe(listener);
  }

  setGitReader(reader: Pick<GitService, 'history' | 'version'>): void {
    this.reader = reader;
  }

  setEditorAccess(access: { text(): string | null; replace(text: string): boolean }): void {
    this.editorAccess = access;
  }

  setDiffPresenter(show: (request: DiffRequest | null, pluginId: string) => void): void {
    this.diffs = show;
  }

  setTabShower(show: (key: string, reveal?: string) => void): void {
    this.tabs = show;
  }

  /** For the hosts: what the setters above were given. */
  noteText(): string | null { return this.editorAccess.text(); }
  replaceNoteText(text: string): boolean { return this.editorAccess.replace(text); }
  showDiff(request: DiffRequest | null, pluginId: string): void { this.diffs(request, pluginId); }
  showTab(key: string, reveal?: string): void { this.tabs(key, reveal); }

  private settle(): void {
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    // Leaving a note, or arriving at the first, is not worth waiting for.
    const wait = this.active === null || this.settled === null ? 0 : ShellState.SETTLE_MS;
    const apply = () => {
      this.settleTimer = null;
      if (this.settled === this.active) return;
      this.settled = this.active;
      this.noteSettled.emit();
    };
    if (wait === 0) apply();
    else this.settleTimer = setTimeout(apply, wait);
  }

  setOpener(open: (path: string) => void): void {
    this.open = open;
  }

  setFileMenu(menu: (path: string, kind: 'file' | 'directory') => void): void {
    this.menu = menu;
  }

  update(next: { folder?: string | null; active?: string | null; git?: GitSnapshot | null }): void {
    let moved = false;
    if (next.folder !== undefined && next.folder !== this.folderRoot) { this.folderRoot = next.folder; moved = true; }
    if (next.active !== undefined && next.active !== this.active) { this.active = next.active; moved = true; this.settle(); }
    if (moved) this.where.emit();
    if (next.git !== undefined && next.git !== this.marks) {
      this.marks = next.git;
      this.gitChanged.emit();
    }
  }
}

/** The capability check a manifest answers, for the shell contributions it may make. */
export interface ShellManifest {
  readonly id: string;
  readonly capabilities: readonly string[];
  readonly uiExtensions: readonly string[];
}

/** The context a plugin's shell entry point gets, holding only what its manifest declares. */
export function shellContext(
  manifest: ShellManifest,
  state: ShellState,
  registry: RailPageRegistry,
  info: InfoRegistry = infoPane,
  marksRegistry: NoteMarksRegistry = noteMarks,
): { context: ShellContext; dispose: Disposer } {
  const git = manifest.capabilities.includes('git.read') ? state.git : null;
  const vault = manifest.capabilities.includes('vault.read') ? state.vault : null;
  const review = manifest.capabilities.includes('vault.review') ? state.review : null;
  const reads = manifest.capabilities.includes('editor.read');
  const writes = manifest.capabilities.includes('editor.transform');
  const host: RailPageHost = { ...state.host, git, vault, review, showDiff: (request) => state.showDiff(request, manifest.id) };
  const handles = new Set<RailPageHandle>();
  const removals = new Set<Disposer>();
  const infoHost: InfoTabHost = {
    ...host,
    note: () => state.settledNote(),
    onNote: (listener) => state.onSettledNote(listener),
    noteText: () => (reads ? state.noteText() : null),
    replaceNoteText: (text) => writes && state.replaceNoteText(text),
    showTab: (id, key) => state.showTab(`${manifest.id}:${id}`, key),
    // Through a selection and the copy command, as the editor's own copies go: the async
    // clipboard refuses a page without focus, and says so only in a promise nobody reads.
    copy: (text) => { copyThroughSelection(text); },
  };
  const declared = (kind: 'info' | 'track', id: string) => {
    if (!manifest.uiExtensions.includes(`${kind}:${id}`)) {
      throw new Error(`${manifest.id} does not declare the info ${kind === 'info' ? 'tab' : 'track'} ${id} (${kind}:${id} in uiExtensions).`);
    }
  };
  const context: ShellContext = {
    pluginId: manifest.id,
    host,
    git,
    registerInfoTab(tab) {
      declared('info', tab.id);
      const remove = info.addTab(manifest.id, tab, infoHost);
      removals.add(remove);
      return () => { removals.delete(remove); remove(); };
    },
    registerInfoTrack(track) {
      declared('track', track.id);
      const remove = info.addTrack(manifest.id, track);
      removals.add(remove);
      return () => { removals.delete(remove); remove(); };
    },
    registerNoteMarks(marks) {
      if (!manifest.uiExtensions.includes(`marks:${marks.id}`)) {
        throw new Error(`${manifest.id} does not declare the note marks ${marks.id} (marks:${marks.id} in uiExtensions).`);
      }
      const remove = marksRegistry.add(manifest.id, marks);
      removals.add(remove);
      return () => { removals.delete(remove); remove(); };
    },
    registerRailPage(page) {
      if (!manifest.uiExtensions.includes(`rail:${page.id}`)) {
        throw new Error(`${manifest.id} does not declare the rail page ${page.id} (rail:${page.id} in uiExtensions).`);
      }
      const handle = registry.add(manifest.id, page, host);
      handles.add(handle);
      return {
        setBadge: (text) => handle.setBadge(text),
        dispose: () => { handles.delete(handle); handle.dispose(); },
      };
    },
  };
  return {
    context,
    dispose: () => {
      for (const handle of handles) handle.dispose();
      handles.clear();
      for (const remove of removals) remove();
      removals.clear();
      // A diff this plugin opened does not outlive it.
      state.showDiff(null, manifest.id);
    },
  };
}

/** The one registry the rail draws. */
export const railPages = new RailPageRegistry();

/** The one registry the info pane draws. */
export const infoPane = new InfoRegistry();

/** The one registry the editor draws marks from. */
export const noteMarks = new NoteMarksRegistry();

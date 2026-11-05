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

export type Disposer = () => void;

export type GitChange = 'modified' | 'new' | 'deleted';

/** What git says about the open folder's notes: absolute paths, as the tree gets them. */
export interface GitSnapshot {
  /** The folder the marks are for; null when the folder is not in git. */
  readonly root: string | null;
  readonly files: ReadonlyArray<readonly [string, GitChange]>;
  /** True when git has been read for the folder; absent when nothing is known. */
  readonly repository?: true;
}

/** The `git.read` capability. */
export interface GitService {
  current(): GitSnapshot | null;
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
  /** Called when the folder or the note in front changes. */
  subscribe(listener: () => void): Disposer;
}

export interface RailPageHost extends ShellHost {
  /** Present only for a plugin that declares `git.read`. */
  readonly git: GitService | null;
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

/** What a plugin's shell entry point is handed. */
export interface ShellContext {
  readonly pluginId: string;
  readonly host: RailPageHost;
  /** Present only for a plugin that declares `git.read`. */
  readonly git: GitService | null;
  /** Needs `rail:<id>` among the manifest's `uiExtensions`. */
  registerRailPage(page: RailPageContribution): RailPageHandle;
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

  readonly host: ShellHost = {
    folder: () => this.folderRoot,
    activeNote: () => this.active,
    openNote: (path) => this.open(path),
    subscribe: (listener) => this.where.subscribe(listener),
  };

  readonly git: GitService = {
    current: () => this.marks,
    subscribe: (listener) => this.gitChanged.subscribe(listener),
  };

  setOpener(open: (path: string) => void): void {
    this.open = open;
  }

  update(next: { folder?: string | null; active?: string | null; git?: GitSnapshot | null }): void {
    let moved = false;
    if (next.folder !== undefined && next.folder !== this.folderRoot) { this.folderRoot = next.folder; moved = true; }
    if (next.active !== undefined && next.active !== this.active) { this.active = next.active; moved = true; }
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
export function shellContext(manifest: ShellManifest, state: ShellState, registry: RailPageRegistry): { context: ShellContext; dispose: Disposer } {
  const git = manifest.capabilities.includes('git.read') ? state.git : null;
  const host: RailPageHost = { ...state.host, git };
  const handles = new Set<RailPageHandle>();
  const context: ShellContext = {
    pluginId: manifest.id,
    host,
    git,
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
    },
  };
}

/** The one registry the rail draws. */
export const railPages = new RailPageRegistry();

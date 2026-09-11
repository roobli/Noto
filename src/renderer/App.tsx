/**
 * The Noto application shell.
 *
 * One shell. The build previously carried two, `G001App` and `FileTruthApp`,
 * chosen at runtime by a bootstrap flag, with the first still wired to a
 * single-paragraph editing spike. That fork is gone along with the test-only
 * controls it hosted.
 */

import { fromLf } from '../shared/markdown/v3/line-endings';
import { sourceModeText } from './source-mode-text';
import { PLAIN_FLAGS, type SearchFlags } from '../shared/search/pattern';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type {
  FileTruthOpenReplyV1,
  FileTruthRecoveryRecordV1,
  FileTruthSaveOutcomeV1,
  FileTruthSaveTokenV1,
  FileTruthReloadRefusalV1,
  NotoPlatform,
} from '../shared/file-truth/v1/contracts';
import type {
  RecentFileV1, WorkspaceIndexEntryV1, WorkspaceTabV1,
  WorkspaceTagSummaryV1, WorkspaceTagNoteV1,
  WorkspaceCodeViewV1,
} from '../shared/workspace/v1/contracts';
import { QuickOpen, type QuickOpenMode } from './QuickOpen';
import { searchBoost, type FrecencyStoreV1 } from '../shared/search/v1/frecency';
import { ConfirmedOpenRecorder } from '../shared/search/v1/confirmed-open';
import type { NotoDocumentWire } from '../shared/markdown/v3/contracts';
import { outlineFromDocument } from './outline';
import { PLUGIN_LIFECYCLE_VERSION, type PluginLifecycleSnapshot } from '../shared/plugins/lifecycle';
import { rendererProofManifest } from '../shared/plugins/proof-manifests';
import {
  filesystemProofManifest,
  markdownPaddingManifest,
  titleShiftManifest,
} from '../shared/plugins/proof-manifests';
import { declaredHotkeys, matchHotkey } from './plugins/hotkeys';
import { NotoCanvas } from './editor/noto/NotoCanvas';
import { CodeViewer } from './CodeViewer';
import type { DocumentCount } from './editor/noto/word-count';
import { FindBar } from './FindBar';
import { RecentStrip } from './RecentStrip';
import { TagStrip } from './TagStrip';
import { TagBrowser, type TagBrowserView } from './TagBrowser';
import { parseTagsFromMarkdown } from '../shared/tags/parse';
import { WorkspaceRail, type RailView } from './WorkspaceRail';
import { SourceMode } from './SourceMode';
import { TableDialog } from './TableDialog';
import { ReloadConfirmDialog } from './ReloadConfirmDialog';
import { Shortcuts } from './Shortcuts';
import { RailFooter } from './RailFooter';
import { Preferences, type PreferencesSection } from './Preferences';
import {
  DEFAULT_SETTINGS, stepWidthMode, type NotoSettingsV1, type TreeSortV1,
} from '../shared/settings/v1/contracts';
import type { AssetRefusalV1 } from '../shared/assets/v1/contracts';
import { copyThroughSelection } from './editor/noto/clipboard';
import type { WorkspaceEntryRefusalV1, WorkspaceExportKindV1 } from '../shared/workspace/v1/contracts';
import { EXPORT_PALETTE_COMMANDS } from '../shared/export/targets';
import { EMPTY_TRAIL, forget as forgetTrail, record as recordTrail, stepBack, stepForward, type Trail } from './trail';
import { wikiCandidates, wikiTargetFor } from './wiki-target';
import { seedOutboundLinks } from './seed-links';
import { wikiLinkText } from './editor/noto/wiki-trigger';
import type { NotoEditor } from './editor/noto/NotoEditor';
import {
  acceptedSaveOutcome,
  actionableFileTruthMessage,
  fileTruthActions,
  outcomeHasRecoveryEvidence,
  presentFileTruthOutcome,
  reloadNeedsConfirm,
  type FileTruthUiState,
} from './file-truth-state';
import { RendererPluginHost } from './plugins/RendererPluginHost';
import { createRendererPluginHosts } from './plugins/bundled/hosts';
import { RendererPluginClient } from './plugins/RendererPluginClient';
import { PluginCenter } from './plugins/PluginCenter';
import { createPluginSnapshotStream } from './plugins/plugin-snapshot-stream';
import { restorePluginTriggerFocus, type PluginSnapshotAvailability } from './plugins/plugin-center-state';

const rid = (prefix: string) => `${prefix}:${crypto.randomUUID()}`;

/**
 * Why a picture was not added, said in words rather than as a code.
 *
 * Every one of these is something the reader can act on, which is the point:
 * the failure this feature has to avoid is a paste that appears to do nothing.
 */
function reloadRefusalMessage(reason: FileTruthReloadRefusalV1): string {
  if (reason === 'save-in-flight') return 'A save is in progress. Try again when it finishes.';
  if (reason === 'recovery-pending') return 'A recovery record has to be cleared before this note can be reloaded.';
  if (reason === 'parse-failed') return 'The file on disk could not be read as markdown, so nothing was changed.';
  return 'That note is not open.';
}

/** The note's name without its extension, which is the exported page's title. */
function noteTitle(notePath: string): string {
  const base = notePath.split(/[\\/]/).pop() ?? notePath;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function exportRefusalMessage(reason: 'no-document' | 'unsaved' | 'cancelled' | 'no-pandoc' | 'failed'): string {
  if (reason === 'unsaved') return 'Save the note first. This converts the file, not the screen.';
  if (reason === 'no-pandoc') return 'That format needs Pandoc, which is not installed.';
  if (reason === 'no-document') return 'Open a note first.';
  return 'That could not be exported.';
}

function imageRefusalMessage(reason: AssetRefusalV1): string {
  if (reason === 'no-document') return 'Open a note first, and the picture goes beside it.';
  if (reason === 'unsupported-type') return 'That is not a picture Noto can show.';
  if (reason === 'too-large') return 'That picture is larger than 20MB.';
  if (reason === 'outside-root') return 'The image folder in settings is outside this folder.';
  return 'The picture could not be written.';
}

/**
 * The user's stylesheet. One sheet, replaced in place, so a theme reloaded
 * twenty times does not leave twenty sheets adopted.
 *
 * Built on first use rather than at module scope: this file is imported by unit
 * tests that read it in Node, where `CSSStyleSheet` does not exist, and a
 * constructor at the top level would make importing the shell fail there.
 */
let customThemeSheet: CSSStyleSheet | null = null;
const themeSheet = (): CSSStyleSheet => (customThemeSheet ??= new CSSStyleSheet());

const bundledManifestList = [
  rendererProofManifest,
  titleShiftManifest,
  markdownPaddingManifest,
  filesystemProofManifest,
];

const bundledManifests = new Map<string, { name: string; commands: readonly { id: string; title: string }[] }>(
  bundledManifestList.map((manifest) => [manifest.id, manifest]),
);

const declaredPluginHotkeys = declaredHotkeys(bundledManifestList);

const manifestHotkeyFor = (event: KeyboardEvent): string | null =>
  matchHotkey(event, declaredPluginHotkeys);

type UiState = 'Opening' | 'No document' | FileTruthUiState;

const durableRecoveryAttention =
  'A durable recovery record needs attention before this document can be clean.';

/**
 * What the file behind the document did, when it did something the reader has
 * to decide about.
 */
const externalStateMessages: Partial<Record<UiState, string>> = {
  'Changed on disk': 'Another program wrote this file. Your unsaved changes are still here, and reloading replaces them with what is on disk.',
  'File removed': 'This file is no longer on disk. What is on screen is the only copy, and saving writes it back.',
};

export function exceptionalAlertPresentation(
  recoveryBarrier: boolean,
  outcome: FileTruthSaveOutcomeV1 | null,
  localMessage: string | null,
  state: UiState = 'Opened',
): { message: string } | null {
  if (outcome && outcome.status !== 'saved') return { message: outcome.message };
  if (localMessage) return { message: localMessage };
  if (recoveryBarrier) return { message: durableRecoveryAttention };
  const external = externalStateMessages[state];
  if (external) return { message: external };
  return null;
}

/**
 * Everything the shell tracks for one open document.
 *
 * Per document rather than per window, because each tab has its own accepted
 * revision and its own save token. Sharing one set of these across tabs would
 * mean saving one document against another's token, which the store would
 * rightly refuse.
 */
interface OpenDocumentState {
  readonly opened: FileTruthOpenReplyV1;
  readonly document: NotoDocumentWire;
  readonly token: FileTruthSaveTokenV1 | null;
  readonly outcome: FileTruthSaveOutcomeV1 | null;
  readonly recovery: FileTruthRecoveryRecordV1 | null;
  readonly dirty: boolean;
  readonly state: UiState;
  readonly cleanState: 'Opened' | 'Saved';
}

function NotoWorkspace({ platform }: { platform: NotoPlatform }) {
  const [docs, setDocs] = useState<ReadonlyMap<string, OpenDocumentState>>(new Map());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tabs, setTabs] = useState<readonly WorkspaceTabV1[]>([]);
  /** A non-Markdown file shown read-only; null while editing a note. */
  const [codeView, setCodeView] = useState<WorkspaceCodeViewV1 | null>(null);
  /** Status shown when no document is open, so it has nowhere per-document to live. */
  const [shellState, setShellState] = useState<UiState>('Opening');
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  const active = activeId ? docs.get(activeId) ?? null : null;
  /* Read from the menu handler, which runs outside the render that built it. */
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const opened = active?.opened ?? null;
  const document = active?.document ?? null;
  const token = active?.token ?? null;
  const state: UiState = active?.state ?? shellState;

  const patchDoc = useCallback((id: string, patch: Partial<OpenDocumentState>) => {
    setDocs((current) => {
      const existing = current.get(id);
      if (!existing) return current;
      const next = new Map(current);
      next.set(id, { ...existing, ...patch });
      return next;
    });
  }, []);

  /** Route a status update to the active document, or to the empty shell. */
  const setState = useCallback((value: UiState) => {
    const id = activeIdRef.current;
    if (id) patchDoc(id, { state: value });
    else setShellState(value);
  }, [patchDoc]);

  const editorDirty = active?.dirty ?? false;
  const editorDirtyRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [recoveryBarrier, setRecoveryBarrier] = useState(false);
  const recoveryBarrierRef = useRef(false);
  const outcome = active?.outcome ?? null;
  const recoveryRecord = active?.recovery ?? null;
  const [localMessage, setLocalMessage] = useState<string | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [prefs, setPrefs] = useState<{ open: boolean; section: PreferencesSection }>(
    { open: false, section: 'appearance' },
  );
  /** Bumped to re-read a stylesheet whose contents changed but whose path did not. */
  const [themeReload, setThemeReload] = useState(0);
  const [themeProblem, setThemeProblem] = useState('');
  const [activeBlock, setActiveBlock] = useState(-1);
  /** Whether something outside the window can drive it, as main reports it. */
  const [remote, setRemote] = useState<{ listening: boolean; port: number | null }>({
    listening: false, port: null,
  });
  /** The sheet of what the app can do, on the Help menu. */
  const [shortcuts, setShortcuts] = useState(false);
  /** Typora's Insert Table dialog, open or not. */
  const [tableDialog, setTableDialog] = useState(false);
  /** Dirty-buffer confirm before a reload that would discard unsaved edits. */
  const [reloadConfirm, setReloadConfirm] = useState<
    { documentId: string; offerSaveCopy: boolean } | null
  >(null);
  /** Source Code Mode, Typora's Command-slash: the note as text, for every tab. */
  const [sourceMode, setSourceMode] = useState(false);
  /** Pushes the source view's pending text into the document, before a save. */
  const sourceFlushRef = useRef<(() => void) | null>(null);
  /** Bumped when an editor is ready, so a source view can be given its editor. */
  const [editorsReady, setEditorsReady] = useState(0);
  const [pluginSnapshots, setPluginSnapshots] = useState<PluginLifecycleSnapshot[]>([]);
  const pluginSnapshotsRef = useRef(pluginSnapshots);
  pluginSnapshotsRef.current = pluginSnapshots;
  /**
   * Telling the plugin host that an editor exists.
   *
   * A plugin restored as enabled sits idle until an editor appears. Two things
   * have to be true before saying so, an editor being mounted and a snapshot
   * showing a plugin waiting, and on a restart they arrive independently:
   * the editor from opening the document, the snapshots from main over IPC.
   * Announcing only from the editor's side meant that whenever the snapshots
   * were second, which under load they often are, the plugin stayed at
   * "waiting for editor" for the life of the window.
   *
   * So the editor announces if it can, and arms a one-shot if it cannot. The
   * one shot is spent on the first snapshot that follows, which is the rest of
   * the same startup. It is deliberately not left armed: a plugin the reader
   * enables later is meant to stay idle until they activate it, and an
   * announcement standing by forever would start it the moment it was enabled.
   */
  const awaitingSnapshotsRef = useRef(false);
  const announceEditorRef = useRef(() => {});
  announceEditorRef.current = () => {
    const waiting = pluginSnapshotsRef.current
      .some((snapshot) => snapshot.desiredEnabled && snapshot.lifecycle === 'enabled-idle');
    if (!waiting) {
      // Nothing to tell yet. If the snapshots simply have not landed, the next
      // batch is this same startup and gets the announcement instead.
      awaitingSnapshotsRef.current = pluginSnapshotsRef.current.length === 0;
      return;
    }
    awaitingSnapshotsRef.current = false;
    void window.notoDesktop.plugins.triggerEvent({
      version: PLUGIN_LIFECYCLE_VERSION,
      requestId: rid('editor-ready'),
      event: 'editor.ready',
    }).catch(() => { /* The plugin center reports lifecycle faults. */ });
  };
  const [pluginAvailability, setPluginAvailability] = useState<PluginSnapshotAvailability>('loading');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [recent, setRecent] = useState<readonly RecentFileV1[]>([]);
  useEffect(() => {
    setFrecency((current) => {
      let next = current;
      // Recent entries carry their own timestamp, so a fresh window starts with
      // real history rather than with everything looking equally cold.
      for (const file of recent) {
        if (next[file.path]) continue;
        next = { ...next, [file.path]: { path: file.path, count: 1, lastOpenedAt: file.openedAt } };
      }
      return next;
    });
  }, [recent]);
  const [openError, setOpenError] = useState<string | null>(null);
  /**
   * The navigation rail: one region, two views.
   *
   * Files and Outline were separate booleans opening separate columns, so
   * wanting both spent two panels' width on navigation. They answer the same
   * question and now take turns in one region.
   */
  const [rail, setRail] = useState<{ open: boolean; view: RailView }>({ open: false, view: 'files' });
  const [settings, setSettings] = useState<NotoSettingsV1>(DEFAULT_SETTINGS);
  /* The menu handler is registered once, so it would otherwise close over the
     settings as they were at launch and step the width from 66 every time. */
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const [folder, setFolder] = useState<{ root: string | null; name: string | null }>({ root: null, name: null });

  /*
   * The trail, from the author's plugin of that name: three notes back and
   * three forward. Recorded here, on the one thing every route to a note
   * changes, the document in front, rather than at each place a note can be
   * opened from. A step back or forward replays an open and must not record
   * itself, which the flag says.
   */
  const [trail, setTrail] = useState<Trail>(EMPTY_TRAIL);
  const replayingRef = useRef(false);
  /*
   * Frecency advances only after a confirmed open, once per transition — the
   * same contract typora-plugin-lite's ConfirmedOpenRecorder keeps. Trail
   * replay notes the front document without bumping, so a step back is not a
   * second open of the note being returned to.
   */
  const confirmedOpenRef = useRef(new ConfirmedOpenRecorder());
  const activePath = opened?.path ?? null;
  useEffect(() => {
    if (!activePath) return;
    if (replayingRef.current) {
      replayingRef.current = false;
      confirmedOpenRef.current.noteWithoutRecording(activePath);
      return;
    }
    setTrail((current) => recordTrail(current, activePath));
  }, [activePath]);

  /* A short message from a plugin, shown in the status line for a moment. */
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onNotice = (event: Event) => {
      const message = (event as CustomEvent<string>).detail;
      if (typeof message !== 'string' || message.length === 0) return;
      setNotice(message);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setNotice(null), 2600);
    };
    window.addEventListener('noto:notice', onNotice);
    return () => {
      window.removeEventListener('noto:notice', onNotice);
      if (timer) clearTimeout(timer);
    };
  }, []);
  /**
   * Quick open, and whether it was opened by typing two brackets.
   *
   * When it was, choosing a note writes the link where the brackets are
   * rather than at the caret, and Escape leaves the brackets alone: the
   * reader may have meant to type them.
   */
  const [quickOpen, setQuickOpen] = useState<{ open: boolean; mode: QuickOpenMode; linking?: boolean }>(
    { open: false, mode: 'files' },
  );
  const [tagBrowser, setTagBrowser] = useState<{
    open: boolean;
    view: TagBrowserView;
    tags: readonly WorkspaceTagSummaryV1[];
    notes: readonly WorkspaceTagNoteV1[];
    loading: boolean;
    truncated: boolean;
  }>({ open: false, view: { kind: 'tags' }, tags: [], notes: [], loading: false, truncated: false });
  const [noteTags, setNoteTags] = useState<string[]>([]);

  const [recentFolders, setRecentFolders] = useState<readonly RecentFileV1[]>([]);
  const [folderMenu, setFolderMenu] = useState(false);
  /* The editor is constructed once per document and keeps the callbacks it was
     given, so a handler that closes over state has to be reached through a ref
     or it answers with whatever that state was at construction. Following a
     link resolved against an empty index for exactly this reason. */
  const followWikiLinkRef = useRef<(target: string) => void>(() => {});
  const followLinkRef = useRef<(href: string) => void>(() => {});
  /** A content-search query waiting for its document to arrive. */
  const pendingMatchRef = useRef<string | null>(null);
  const ensureFileIndexRef = useRef<() => Promise<void>>(async () => {});
  const openPathRef = useRef<(filePath: string) => Promise<void>>(async () => {});
  const refreshRecentFoldersRef = useRef<() => void>(() => {});
  const [fileIndex, setFileIndex] = useState<{
    entries: readonly WorkspaceIndexEntryV1[]; truncated: boolean;
  }>({ entries: [], truncated: false });
  /**
   * How often and how recently each file is opened.
   *
   * Kept in the renderer and seeded from the recent list main already persists,
   * rather than given a store of its own. A second persisted file would be a
   * second thing to migrate and to keep in step with the first, for a ranking
   * signal that is allowed to be approximate.
   */
  const [frecency, setFrecency] = useState<FrecencyStoreV1>({});
  /** The size of the document in front, or null before it has been counted. */
  const [count, setCount] = useState<DocumentCount | null>(null);
  /* Through a ref, as the follow handlers are: a node view is built once for a
     document and keeps whatever it was given, so a value captured at
     construction never changes again when the tab in front does. */
  const countRef = useRef<(documentId: string, next: DocumentCount) => void>(() => {});

  const editorsRef = useRef<Map<string, NotoEditor>>(new Map());
  /** Always the editor of the document in front, so call sites stay unchanged. */
  const editorRef = useRef<NotoEditor | null>(null);
  const pluginHostRef = useRef<ReadonlyMap<string, RendererPluginHost> | null>(null);
  const pluginClientRef = useRef<RendererPluginClient | null>(null);
  const pluginsButtonRef = useRef<HTMLButtonElement>(null);
  /** Show a rail view, opening the rail if it is closed, and close it when the
   *  view being asked for is already the one showing. */
  const toggleRail = useCallback((view: RailView) => {
    setRail((current) => (current.open && current.view === view
      ? { open: false, view }
      : { open: true, view }));
  }, []);
  const openPreferences = useCallback((section: PreferencesSection) => {
    setPrefs((current) => (current.open && current.section === section
      ? { open: false, section }
      : { open: true, section }));
  }, []);
  const [find, setFind] = useState<{ open: boolean; replace: boolean; query?: string }>(
    { open: false, replace: false },
  );
  const findRef = useRef(find);
  findRef.current = find;
  /*
   * The last search that was actually run, so Find Next can repeat it.
   *
   * The bar owns these while it is open; this remembers what it last asked for
   * so the stepping commands mean the same search after it has been closed.
   */
  const findOptionsRef = useRef({ caseSensitive: false, wholeWord: false, regex: false });
  const cleanStateRef = useRef<'Opened' | 'Saved'>('Opened');
  const dirtyDocumentIds = useMemo(
    () => new Set([...docs.values()].filter((doc) => doc.dirty).map((doc) => doc.document.documentId)),
    [docs],
  );
  if (!pluginHostRef.current) pluginHostRef.current = createRendererPluginHosts();

  /*
   * The editor came up before the snapshots did, so this batch is the one that
   * gets told. Watched as state rather than by wrapping the stream's own
   * writer, which stays the single thing that writes snapshot state.
   */
  useEffect(() => {
    if (!awaitingSnapshotsRef.current) return;
    if (pluginSnapshots.length === 0) return;
    awaitingSnapshotsRef.current = false;
    announceEditorRef.current();
  }, [pluginSnapshots]);

  const pluginSnapshot = pluginSnapshots.find((snapshot) => snapshot.id === rendererProofManifest.id);
  const filename = useMemo(() => opened?.path.split(/[\\/]/).at(-1) ?? 'No document', [opened]);
  // The containing folder, shortened to a leading tilde inside the home
  // directory, which is where documents nearly always are and where the
  // absolute prefix is pure noise.
  const containingFolder = useMemo(() => {
    if (!opened) return '';
    // Cut at the last separator rather than splitting and rejoining. Rejoining
    // on '/' would rewrite a Windows path into a shape the platform does not
    // use, and would leave it unable to match a home directory spelled with
    // backslashes, so the shortening below would never fire there.
    const cut = Math.max(opened.path.lastIndexOf('/'), opened.path.lastIndexOf('\\'));
    const directory = cut > 0 ? opened.path.slice(0, cut) : opened.path;
    const home = window.notoPlatform?.home;
    return home && directory.startsWith(home) ? `~${directory.slice(home.length)}` : directory;
  }, [opened]);

  /*
   * The breadcrumb over the document: where the note is, then its name.
   *
   * Inside an open folder the path is relative to the folder, which is the
   * frame the reader is already in; outside one it is the shortened folder.
   * Only the folder the note is in is shown, since a title bar is not the
   * place to read a six-level path in full, and the name must never give way
   * to it.
   */
  const crumbs = useMemo((): readonly string[] => {
    if (!opened) return [];
    const cut = Math.max(opened.path.lastIndexOf('/'), opened.path.lastIndexOf('\\'));
    const directory = cut > 0 ? opened.path.slice(0, cut) : '';
    const root = folder.root;
    const inside = root !== null && (directory === root || directory.startsWith(`${root}/`) || directory.startsWith(`${root}\\`));
    const shown = inside ? `${folder.name ?? ''}${directory.slice(root.length)}` : containingFolder;
    const segments = shown.split(/[\\/]/).filter((segment) => segment.length > 0);
    return segments.slice(-1);
  }, [opened, folder, containingFolder]);

  const updateRecoveryBarrier = (value: boolean) => {
    recoveryBarrierRef.current = value;
    setRecoveryBarrier(value);
  };

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved = settings.theme === 'system' ? (media.matches ? 'dark' : 'light') : settings.theme;
      setTheme(resolved);
      globalThis.document.documentElement.dataset.theme = resolved;
      globalThis.document.documentElement.style.colorScheme = resolved;
    };
    apply();
    // Following the system means reacting when it changes, not only at launch.
    if (settings.theme !== 'system') return;
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [settings.theme]);

  /**
   * Document typography as custom properties on the root, and the page width
   * as an attribute.
   *
   * Size and leading are numbers the reader owns, so they go in as values. The
   * width is a mode, because the pixels it resolves to depend on the canvas,
   * and the stylesheet is the one place that knows the canvas: it computes
   * each mode as a share of the width beside the rail, capped, and never more
   * than the canvas itself. See `WIDTH_MODES`.
   */
  useEffect(() => {
    const root = globalThis.document.documentElement;
    root.style.setProperty('--doc-font-size', `${settings.fontSize}px`);
    root.style.setProperty('--doc-line-height', `${settings.lineHeight}`);
    root.dataset.widthMode = settings.widthMode;
    root.dataset.proseFace = settings.proseFace;
    root.dataset.codeLineNumbers = settings.codeLineNumbers ? 'on' : 'off';
    root.dataset.codeIndentGuides = settings.codeIndentGuides ? 'on' : 'off';
    root.dataset.codeTabMarkers = settings.codeTabMarkers ? 'on' : 'off';
    root.dataset.sidenotes = settings.sidenotes ? 'on' : 'off';
    root.dataset.timelines = settings.timelines ? 'on' : 'off';
    root.dataset.focusMode = settings.focusMode ? 'on' : 'off';
  }, [settings.fontSize, settings.lineHeight, settings.widthMode, settings.proseFace, settings.codeLineNumbers,
    settings.codeIndentGuides, settings.codeTabMarkers, settings.sidenotes, settings.timelines, settings.focusMode]);

  /**
   * The user's own stylesheet, layered over the theme.
   *
   * Injected as a single style element that is replaced wholesale on every
   * change, because a stylesheet appended twice is a stylesheet that fights
   * itself. Main reads the file; the renderer never touches the filesystem.
   */
  useEffect(() => {
    const root = globalThis.document;
    let active = true;
    /*
     * A constructed stylesheet, not a `<style>` element.
     *
     * The renderer's Content Security Policy is `style-src 'self'`, which
     * refuses an inline style element outright: the element appears in the DOM
     * and the browser simply declines to apply it, which is a failure with no
     * symptom except the theme not working. A stylesheet built by script is not
     * parsed from markup and is not covered by that directive, so the policy
     * stays exactly as strict as it was. Adopted sheets also come last in the
     * cascade, which is half of why a custom theme can override anything.
     */
    const apply = (css: string) => {
      if (!active) return;
      const sheet = themeSheet();
      const sheets = root.adoptedStyleSheets.filter((existing) => existing !== sheet);
      if (!css) { root.adoptedStyleSheets = sheets; return; }
      try {
        sheet.replaceSync(css);
      } catch {
        setThemeProblem('That stylesheet could not be parsed.');
        root.adoptedStyleSheets = sheets;
        return;
      }
      root.adoptedStyleSheets = [...sheets, sheet];
    };
    if (!settings.customCssPath) { apply(''); return () => { active = false; }; }
    void window.notoSettings.readThemeCss({ version: 1, requestId: rid('theme-css') })
      .then((result) => {
        if (!active) return;
        apply(result.ok ? result.value.css : '');
        setThemeProblem(result.ok ? result.value.problem : 'The stylesheet could not be read.');
      })
      .catch(() => { apply(''); setThemeProblem('The stylesheet could not be read.'); });
    return () => { active = false; };
  }, [settings.customCssPath, themeReload]);

  // Read once at startup, then follow any change main publishes.
  useEffect(() => {
    let active = true;
    void window.notoSettings.read({ version: 1, requestId: rid('settings-read') })
      .then((result) => {
        if (!active || !result.ok) return;
        setSettings(result.value.settings);
        if (result.value.settings.sidebarOnLaunch) setRail({ open: true, view: 'files' });
      });
    const unsubscribe = window.notoSettings.onChanged((event) => {
      if (active) setSettings(event.settings);
    });
    return () => { active = false; unsubscribe(); };
  }, []);

  const changeSettings = useCallback((patch: Partial<NotoSettingsV1>) => {
    // Applied locally at once so the control responds, then confirmed by main,
    // which is the value that survives a restart.
    setSettings((current) => ({ ...current, ...patch }));
    void window.notoSettings.write({ version: 1, requestId: rid('settings-write'), patch })
      .then((result) => { if (result.ok) setSettings(result.value.settings); });
  }, []);

  useEffect(() => {
    const client = new RendererPluginClient(pluginHostRef.current!, window.notoDesktop.plugins);
    pluginClientRef.current = client;
    // The snapshots may be the second of the two to arrive, so every update
    // asks again whether there is now an editor for a waiting plugin.
    const stream = createPluginSnapshotStream(setPluginSnapshots);
    let active = true;
    let authoritative = false;
    const unsubscribe = window.notoDesktop.plugins.onSnapshots((event) => {
      if (!stream.push(event.snapshots)) return;
      authoritative = true;
      setPluginAvailability('ready');
    });
    client.start();
    void window.notoDesktop.plugins.getSnapshots({
      version: PLUGIN_LIFECYCLE_VERSION,
      requestId: rid('plugins-get'),
    }).then((result) => {
      if (!active) return;
      if (result.ok) {
        if (stream.bootstrap(result.value.snapshots)) {
          authoritative = true;
          setPluginAvailability('ready');
        }
      } else if (!authoritative) setPluginAvailability('unavailable');
    }).catch(() => {
      if (active && !authoritative) setPluginAvailability('unavailable');
    });
    return () => {
      active = false;
      stream.close();
      unsubscribe();
      void client.dispose();
      if (pluginClientRef.current === client) pluginClientRef.current = null;
    };
  }, []);

  /**
   * Plugin hotkeys and the command palette.
   *
   * Hotkeys are read from the bundled manifests rather than hard coded, so a
   * plugin declaring a binding is enough to make it work. Dispatch goes to
   * main, which owns the manifest and decides whether the plugin may run; the
   * renderer never invokes plugin code directly.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !event.shiftKey && !event.altKey && event.code === 'KeyK') {
        event.preventDefault();
        // Same reason as the menu path: preferences is modal, and its scrim
        // would sit over the palette and swallow every click on a command.
        setPrefs((current) => ({ ...current, open: false }));
        setPaletteOpen((current) => !current);
        return;
      }
      const keys = manifestHotkeyFor(event);
      if (!keys) return;
      event.preventDefault();
      void window.notoDesktop.plugins.triggerHotkey({
        version: PLUGIN_LIFECYCLE_VERSION,
        requestId: rid('plugin-hotkey'),
        keys,
      });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const executePluginCommand = useCallback((pluginId: string, commandId: string) => {
    void window.notoDesktop.plugins.executeCommand({
      version: PLUGIN_LIFECYCLE_VERSION,
      requestId: rid('plugin-command'),
      pluginId,
      commandId,
    });
    setPaletteOpen(false);
    queueMicrotask(() => editorRef.current?.focus());
  }, []);

  /** Adopt a document that main has opened, from any entry point. */
  const adopt = useCallback((reply: FileTruthOpenReplyV1) => {
    const id = reply.document.documentId;
    const status: UiState = reply.initialOutcome
      ? 'Recovery failed'
      : reply.recovery ? 'Recovery needed' : 'Opened';

    setDocs((current) => {
      // Re-activating a document already open keeps the state it has built up,
      // including its save token and whether it has unsaved changes. Adopting
      // the original open reply again would hand back a token the store has
      // since replaced, and the next save would be refused as stale.
      if (current.has(id)) return current;
      const next = new Map(current);
      next.set(id, {
        opened: reply,
        document: reply.document,
        token: reply.saveToken,
        outcome: reply.initialOutcome,
        recovery: reply.recovery,
        dirty: false,
        state: status,
        cleanState: 'Opened',
      });
      return next;
    });

    setActiveId(id);
    activeIdRef.current = id;
    setLocalMessage(null);
    editorDirtyRef.current = false;
    updateRecoveryBarrier(Boolean(reply.recovery || reply.initialOutcome));
    cleanStateRef.current = 'Opened';
  }, []);

  /**
   * Subscribe before asking.
   *
   * A document named on the command line is opened by main as soon as the page
   * loads, which can land before or after this component mounts. Subscribing
   * first and then querying covers both orderings without a race.
   */
  useEffect(() => {
    let active = true;
    const unsubscribe = window.notoWorkspace.onDocumentOpened((event) => {
      if (active) {
        setCodeView(null);
        adopt(event.opened);
      }
    });
    const unsubscribeCode = window.notoWorkspace.onCodeViewChanged((event) => {
      if (active) {
        setCodeView(event.codeView);
        // Source Code Mode is for a markdown note; a read-only code pane
        // replaces it, so the mode does not stay armed underneath.
        if (event.codeView) setSourceMode(false);
      }
    });
    /*
     * The file behind a document moved under it.
     *
     * A rebase is the quiet case and needs no reader at all: the bytes are the
     * same and only the file's identity moved, which a git checkout or a touch
     * does, so the new save token is taken and a standing conflict, if the
     * reader hit one, is cleared because it no longer applies.
     *
     * A change is only taken silently when nothing is unsaved. A note with
     * unsaved changes is never replaced without being asked, whatever the
     * setting says.
     */
    const unsubscribeExternal = window.notoFileTruth.onExternalChange((event) => {
      if (!active) return;
      setDocs((current) => {
        const existing = current.get(event.documentId);
        if (!existing) return current;
        const next = new Map(current);
        if (event.kind === 'rebased') {
          next.set(event.documentId, {
            ...existing,
            token: event.saveToken ?? existing.token,
            state: existing.state === 'External conflict' ? existing.cleanState : existing.state,
            outcome: existing.state === 'External conflict' ? null : existing.outcome,
          });
          return next;
        }
        if (event.kind === 'missing') {
          next.set(event.documentId, { ...existing, state: 'File removed' });
          return next;
        }
        if (!existing.dirty && settingsRef.current.reloadExternalChanges) {
          void reloadFromDiskRef.current(event.documentId);
          return current;
        }
        next.set(event.documentId, { ...existing, state: 'Changed on disk' });
        return next;
      });
    });
    const unsubscribeTree = window.notoWorkspace.onTreeChanged(() => {
      if (active) setTreeVersion((current) => current + 1);
    });
    const unsubscribeRename = window.notoWorkspace.onRenameRow((event) => {
      if (active) setTreeEditing({ path: event.path, intent: event.intent });
    });
    const unsubscribeTabs = window.notoWorkspace.onTabsChanged((event) => {
      if (!active) return;
      setTabs(event.tabs);
      // Main owns which documents exist, so anything it no longer lists has
      // been closed and its editor should be released.
      const live = new Set(event.tabs.map((tab) => tab.documentId));
      setDocs((current) => {
        if ([...current.keys()].every((id) => live.has(id))) return current;
        const next = new Map<string, OpenDocumentState>();
        for (const [id, doc] of current) if (live.has(id)) next.set(id, doc);
        return next;
      });
      for (const id of [...editorsRef.current.keys()]) {
        if (!live.has(id)) editorsRef.current.delete(id);
      }
      const activeTab = event.tabs.find((tab) => tab.active) ?? null;
      setActiveId(activeTab?.documentId ?? null);
      activeIdRef.current = activeTab?.documentId ?? null;
    });
    const adoptFolder = (event: { root: string | null; name: string | null; chosen?: boolean }) => {
      setFolder({ root: event.root, name: event.name });
      // A new folder changes what main will serve as an image, so notes that
      // are already open draw theirs again rather than keeping a stale refusal.
      editorsRef.current.forEach((editor) => editor.refreshImages());
      if (event.root && event.chosen) setRail({ open: true, view: 'files' });
      // Every route into a folder ends here, including the menu item, which
      // does not go through the renderer's own handler at all.
      refreshRecentFoldersRef.current();
      // Not awaited: the walk is a background job and the window stays live
      // through it. Following a wiki link needs the same index quick open does,
      // and it has no moment of its own to ask for it.
      void ensureFileIndexRef.current();
    };
    const unsubscribeFolder = window.notoWorkspace.onFolderChanged((event) => {
      if (active) adoptFolder(event);
    });
    // A folder named on the command line opens before this page can listen,
    // so ask, the way the document is asked for below.
    void window.notoWorkspace.folder({ version: 1, requestId: rid('ws-folder') })
      .then((result) => {
        if (active && result.ok && result.value.root) adoptFolder(result.value);
      })
      .catch(() => { /* Nothing to adopt is the ordinary answer. */ });
    const unsubscribeClosed = window.notoWorkspace.onDocumentClosed(() => {
      if (!active) return;
      setActiveId(null);
      activeIdRef.current = null;
      setShellState('No document');
    });

    const open = async () => {
      try {
        const result = await window.notoFileTruth.open({ version: 1, requestId: rid('ft-open') });
        if (!active) return;
        if (!result.ok) {
          // No document yet is the ordinary first-run state, not a failure.
          setState('No document');
          return;
        }
        adopt(result.value);
      } catch (error) {
        if (!active) return;
        updateRecoveryBarrier(true);
        setPending(false);
        setLocalMessage(actionableFileTruthMessage(error, 'The document could not be opened.'));
        setState('Save failed');
      }
    };
    void open();
    return () => {
      active = false;
      unsubscribe();
      unsubscribeCode();
      unsubscribeExternal();
      unsubscribeTree();
      unsubscribeRename();
      unsubscribeTabs();
      unsubscribeFolder();
      unsubscribeClosed();
    };
  }, [adopt]);

  // Keep the active editor reference pointing at the document in front, so
  // every command in this component keeps working without knowing about tabs.
  useEffect(() => {
    editorRef.current = activeId ? editorsRef.current.get(activeId) ?? null : null;
    if (active) {
      editorDirtyRef.current = active.dirty;
      cleanStateRef.current = active.cleanState;
    }
  }, [activeId, docs, active]);

  const activateTab = useCallback((filePath: string) => {
    void window.notoWorkspace.activateTab({ version: 1, requestId: rid('tab-activate'), path: filePath });
  }, []);

  /** The folders opened before, refreshed whenever one is. */
  const refreshRecentFolders = useCallback(() => {
    void window.notoWorkspace.recentFolders({ version: 1, requestId: rid('recent-folders') })
      .then((result) => { if (result.ok) setRecentFolders(result.value.files); });
  }, []);

  refreshRecentFoldersRef.current = refreshRecentFolders;
  useEffect(refreshRecentFolders, [refreshRecentFolders]);

  const chooseFolder = useCallback(() => {
    void window.notoWorkspace.openFolder({ version: 1, requestId: rid('folder-open') })
      .then((result) => {
        if (result.ok) setFolder({ root: result.value.root, name: result.value.name });
        refreshRecentFolders();
      });
  }, [refreshRecentFolders]);

  const openRecentFolder = useCallback((target: string) => {
    void window.notoWorkspace.openRecentFolder({
      version: 1, requestId: rid('folder-recent'), path: target,
    }).then((result) => {
      if (result.ok) setFolder({ root: result.value.root, name: result.value.name });
      // Whether it opened or had vanished, the list has moved on either way.
      refreshRecentFolders();
    });
  }, [refreshRecentFolders]);

  const listFolder = useCallback(async (directory: string) => {
    const result = await window.notoWorkspace.listFolder({
      version: 1, requestId: rid('folder-list'), path: directory,
    });
    if (!result.ok) throw new Error(result.error.message);
    return result.value.entries;
  }, []);

  const openFromTree = useCallback((filePath: string) => {
    // Same confirmed-open path as Quick Open: frecency only advances when this
    // succeeds, and a failed tree click does not pollute the ranking.
    void openPathRef.current(filePath);
  }, []);

  const closeTab = useCallback((filePath: string) => {
    void window.notoWorkspace.closeTab({ version: 1, requestId: rid('tab-close'), path: filePath });
  }, []);

  useEffect(() => {
    void window.notoWorkspace.recent({ version: 1, requestId: rid('recent') })
      .then((result) => { if (result.ok) setRecent(result.value.files); })
      .catch(() => setRecent([]));
  }, [document]);

  /** Record an outcome against the active document. */
  const setOutcome = (value: FileTruthSaveOutcomeV1 | null) => {
    const id = activeIdRef.current;
    if (id) patchDoc(id, { outcome: value });
  };

  const present = (value: FileTruthSaveOutcomeV1) => {
    // The document this save belongs to, not whichever tab is in front now. A
    // save that finishes after the user switched tabs must land on its own
    // document rather than overwrite the state of the one they moved to.
    const id = activeIdRef.current;
    const barrier = outcomeHasRecoveryEvidence(value);
    if (id) {
      patchDoc(id, {
        outcome: value,
        ...('recovery' in value && value.recovery
          ? { recovery: value.recovery }
          : !barrier && value.status === 'saved' ? { recovery: null } : {}),
      });
    }
    updateRecoveryBarrier(barrier);
    setLocalMessage(null);
    setPending(false);

    if (barrier && value.status === 'copy-saved') {
      const current = state;
      setState(current === 'Recovery failed' || current === 'Cleanup failed' ? current : 'Recovery needed');
    } else {
      setState(presentFileTruthOutcome(value).state);
    }

    const accepted = acceptedSaveOutcome(value);
    if (accepted && id) {
      patchDoc(id, { token: accepted.saveToken, document: accepted.document, cleanState: 'Saved' });
      // Record the new clean state before committing. `commit` reports the
      // editor clean, and that callback reads `cleanStateRef`; setting it
      // afterwards would relabel a successful save as merely "Opened".
      cleanStateRef.current = 'Saved';
      // Adopt the saved document as the clean baseline without disturbing the
      // caret or the undo history.
      editorRef.current?.commit(accepted.document);
    }
  };

  /**
   * Automatic saving.
   *
   * Debounced against typing rather than fired once the document turns dirty,
   * because a save costs between 226 ms and several seconds depending on the
   * document, and saving mid-word on a large file would stall the very typing
   * that triggered it.
   *
   * It refuses in exactly the cases the Save button is refused: a save already
   * in flight, a recovery record standing, a file that changed underneath us.
   * Automatic saving must not be a way to reach a path the manual one guards,
   * and an external conflict resolved automatically is data loss nobody
   * watched happen.
   */
  const typingRef = useRef(0);
  const [typingTick, setTypingTick] = useState(0);
  const bumpTyping = useCallback(() => {
    typingRef.current += 1;
    setTypingTick(typingRef.current);
  }, []);
  const saveRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    if (!settings.autoSave || !editorDirty || pending) return;
    if (recoveryBarrier || state === 'External conflict' || state === 'Stale editor revision') return;
    const timer = setTimeout(() => { void saveRef.current(); }, settings.autoSaveDelayMs);
    return () => clearTimeout(timer);
  }, [settings.autoSave, settings.autoSaveDelayMs, editorDirty, pending, recoveryBarrier, state, typingTick]);

  const save = async () => {
    const editor = editorRef.current;
    // Text still settling in the source view goes into the document first,
    // so a save a moment after typing there writes what is on screen.
    sourceFlushRef.current?.();
    // The editor's own word on being dirty, because the flush above may have
    // just made it so and the state this closure holds is from before.
    if (!editor || !token || pending || !(editorDirty || editor.isDirty)) return;
    let transaction: ReturnType<NotoEditor['capture']>;
    try {
      transaction = editor.capture();
    } catch (error) {
      setLocalMessage(actionableFileTruthMessage(error,
        'The editor refused this save. Finish the current word, then save again.'));
      setState('Unsaved changes');
      return;
    }
    try {
      setPending(true);
      setState('Saving');
      const result = await window.notoFileTruth.save({
        version: 1,
        requestId: rid('ft-save'),
        candidate: { version: 3, saveToken: token, transaction },
      });
      if (!result.ok) {
        setPending(false);
        setOutcome(null);
        setLocalMessage(actionableFileTruthMessage(result.error.message, 'The save transport failed. Your edits are still here.'));
        setState('Save failed');
        return;
      }
      present(result.value);
    } catch (error) {
      setPending(false);
      setOutcome(null);
      updateRecoveryBarrier(true);
      setLocalMessage(actionableFileTruthMessage(error, 'The save transport failed. Your edits are still here.'));
      setState('Save failed');
    }
  };

  const recover = async () => {
    try {
      setPending(true);
      const result = await window.notoFileTruth.recover({ version: 1, requestId: rid('ft-recover') });
      if (!result.ok) {
        setPending(false);
        setLocalMessage(actionableFileTruthMessage(result.error.message, 'Recovery transport failed. Evidence remains on disk.'));
        setState('Recovery failed');
        return;
      }
      present(result.value);
    } catch (error) {
      setPending(false);
      setOutcome(null);
      updateRecoveryBarrier(true);
      setLocalMessage(actionableFileTruthMessage(error, 'Recovery transport failed. Evidence remains on disk.'));
      setState('Recovery failed');
    }
  };

  saveRef.current = save;

  const saveCopy = async (): Promise<boolean> => {
    const editor = editorRef.current;
    if (!editor || !token || !opened) return false;

    // Ask where to put it. The menu item says "Save a Copy…", and the ellipsis
    // is a promise that the user gets to choose. This used to write
    // `<name>.md.noto-copy.md` beside the original without asking, which is
    // both a surprise and a file nobody wanted.
    const chosen = await window.notoWorkspace.saveAsDialog({
      version: 1,
      requestId: rid('save-as-dialog'),
    });
    if (!chosen.ok || chosen.value.path === null) return false;

    setPending(true);
    try {
      const transaction = editor.capture();
      const result = await window.notoFileTruth.saveCopy({
        version: 1,
        requestId: rid('ft-copy'),
        destinationPath: chosen.value.path,
        candidate: { version: 3, saveToken: token, transaction },
      });
      if (!result.ok) {
        setPending(false);
        setLocalMessage(actionableFileTruthMessage(result.error.message, 'Save a copy failed. The original is unchanged.'));
        setState('Save failed');
        return false;
      }
      present(result.value);
      return result.value.status === 'copy-saved';
    } catch (error) {
      setPending(false);
      setOutcome(null);
      setLocalMessage(actionableFileTruthMessage(error, 'Save a copy failed. The original is unchanged.'));
      setState('Save failed');
      return false;
    }
  };

  /**
   * Opening replaces the document, so an unsaved one is confirmed first rather
   * than silently discarded.
   */
  const confirmDiscard = useCallback(() => !editorDirtyRef.current
    || window.confirm('This document has unsaved changes. Open a different file and lose them?'), []);

  const openWithDialog = useCallback(async () => {
    if (!confirmDiscard()) return;
    setOpenError(null);
    try {
      const result = await window.notoWorkspace.openDialog({ version: 1, requestId: rid('open-dialog') });
      // A dismissed dialog reports ok with a null document; nothing to do.
      if (!result.ok) setOpenError(actionableFileTruthMessage(result.error.message, 'That file could not be opened.'));
    } catch (error) {
      setOpenError(actionableFileTruthMessage(error, 'That file could not be opened.'));
    }
  }, [confirmDiscard]);

  const openPath = useCallback(async (filePath: string) => {
    if (!confirmDiscard()) return;
    setOpenError(null);
    try {
      const result = await window.notoWorkspace.openPath({ version: 1, requestId: rid('open-path'), path: filePath });
      if (!result.ok) {
        // A replay that failed is over, and a note that cannot be opened is
        // not somewhere the trail should offer again.
        replayingRef.current = false;
        setTrail((current) => forgetTrail(current, filePath));
        setOpenError(actionableFileTruthMessage(result.error.message, 'That file could not be opened.'));
        return;
      }
      if ('codeView' in result.value) {
        setCodeView(result.value.codeView);
        setSourceMode(false);
        return;
      }
      // Counted only after the host confirms the open, and only once per
      // transition: a failed open never reaches here, opening the note
      // already in front does not bump again, and a trail step notes the
      // front document without treating the replay as a second open.
      if (replayingRef.current) {
        confirmedOpenRef.current.noteWithoutRecording(filePath);
      } else {
        setFrecency((current) => {
          const now = Date.now();
          return confirmedOpenRef.current.recordAfterSuccessfulOpen(current, filePath, now).store;
        });
      }
    } catch (error) {
      replayingRef.current = false;
      setOpenError(actionableFileTruthMessage(error, 'That file could not be opened.'));
    }
  }, [confirmDiscard]);
  openPathRef.current = openPath;

  /** One step along the trail, replayed as an open so nothing records it. */
  const stepTrail = useCallback((direction: -1 | 1) => {
    const step = direction < 0 ? stepBack(trail) : stepForward(trail);
    if (!step) return;
    replayingRef.current = true;
    setTrail(step.trail);
    void openPath(step.target);
  }, [trail, openPath]);
  const stepTrailRef = useRef(stepTrail);
  stepTrailRef.current = stepTrail;

  /**
   * The file index, fetched once per folder.
   *
   * On opening quick open rather than on opening the folder: someone who never
   * searches never pays for the walk, and someone who does waits once.
   */
  const ensureFileIndex = useCallback(async () => {
    try {
      const result = await window.notoWorkspace.fileIndex({ version: 1, requestId: rid('file-index') });
      if (result.ok) setFileIndex({ entries: result.value.entries, truncated: result.value.truncated });
    } catch {
      // A failed index leaves quick open searching nothing, which its own empty
      // state already explains. It is not worth an alert over the document.
      setFileIndex({ entries: [], truncated: false });
    }
  }, []);
  ensureFileIndexRef.current = ensureFileIndex;

  /**
   * Resolve a `[[wiki link]]` against the index.
   *
   * Exact relative path first, then basename with and without the extension,
   * which is the order that makes `[[00_索引]]` find the one in this folder
   * rather than the eleven others with that name. Ambiguity falls back to
   * frecency, on the grounds that the note you keep opening is the one you
   * meant.
   */
  const followWikiLink = useCallback((target: string) => {
    const here = active?.opened.path ?? null;
    const root = folder.root;
    const fromRelative = here !== null && root !== null && here.startsWith(root)
      ? here.slice(root.length).replace(/^[\\/]+/, '')
      : null;
    const matches = wikiCandidates(target, fromRelative, fileIndex.entries);
    if (matches.length === 0) {
      setLocalMessage(`No note in this folder is called “${target}”.`);
      return;
    }
    // The first is the one the path points at, which is not a matter of
    // taste. Only a bare name that several notes answer to is decided by
    // frecency, on the grounds that the one you keep opening is the one you
    // meant, and the resolver has already put the nearest of them first.
    const now = Date.now();
    const best = matches.length === 1 ? matches[0] : matches.slice(0, 1).concat(
      matches.slice(1).filter((entry) =>
        searchBoost(frecency, entry.path, now) > searchBoost(frecency, matches[0].path, now)),
    ).reduce((chosen, entry) => (
      searchBoost(frecency, entry.path, now) > searchBoost(frecency, chosen.path, now) ? entry : chosen
    ));
    void openPath(best.path);
  }, [active, folder.root, fileIndex.entries, frecency, openPath]);
  followWikiLinkRef.current = followWikiLink;

  /**
   * Follow an ordinary `[text](address)` link.
   *
   * A page on the web goes to the browser, through main, which checks the
   * scheme again before handing anything to the operating system. Anything
   * else is treated as a note in this folder and resolved the way a wiki link
   * is, by relative path and then by name, so `./chapters/one.md` and `one.md`
   * both land. An address with a fragment loses it: nothing here scrolls to a
   * heading yet, and opening the right note is most of the way there.
   */
  const followLink = useCallback((href: string) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      void window.notoWorkspace.openExternal({
        version: 1, requestId: rid('open-external'), url: href,
      }).then((result) => {
        if (result.ok && result.value.opened) return;
        setLocalMessage('That link is not one Noto opens.');
      });
      return;
    }
    const withoutFragment = href.split('#')[0];
    if (withoutFragment.length === 0) {
      setLocalMessage('A link to a place inside this note is not followed yet.');
      return;
    }
    let target = withoutFragment;
    try {
      target = decodeURIComponent(withoutFragment);
    } catch {
      // A malformed escape is not worth refusing over; the raw text may match.
    }
    followWikiLink(target.replace(/^\.\//, ''));
  }, [followWikiLink]);
  followLinkRef.current = followLink;

  /**
   * Ask main for the menu on a tree row.
   *
   * The path only names the row; main resolves it, checks it is inside the
   * open folder and draws the menu itself, so nothing the menu does runs here.
   */
  const showTreeMenu = useCallback((rowPath: string, kind: 'file' | 'directory') => {
    void window.notoWorkspace.treeMenu({
      version: 1, requestId: rid('tree-menu'), path: rowPath, kind,
    });
  }, []);
  countRef.current = (documentId, next) => {
    if (documentId === activeIdRef.current) setCount(next);
  };


  // The note's tags come from its frontmatter. Re-read when the note in front
  // changes or when a keystroke could have edited the YAML: the chips are a
  // view of the file, not a second store.
  useEffect(() => {
    if (!settings.fileTags) {
      setNoteTags([]);
      return;
    }
    const markdown = editorRef.current?.getMarkdown()
      ?? active?.opened.document.text
      ?? '';
    setNoteTags(parseTagsFromMarkdown(markdown));
  }, [settings.fileTags, active?.opened.path, active?.document.revisionId, editorsReady]);


  const openTagBrowser = useCallback(async (tag?: string) => {
    if (!settings.fileTags) return;
    setPrefs((current) => ({ ...current, open: false }));
    setQuickOpen((current) => ({ ...current, open: false }));
    setTagBrowser((current) => ({
      ...current,
      open: true,
      view: tag ? { kind: 'notes', tag } : { kind: 'tags' },
      loading: true,
      notes: tag ? current.notes : [],
    }));
    const index = await window.notoWorkspace.tagIndex({ version: 1, requestId: rid('tag-index') });
    if (!index.ok) {
      setTagBrowser((current) => ({ ...current, loading: false, tags: [], truncated: false }));
      return;
    }
    if (tag) {
      const notes = await window.notoWorkspace.notesByTag({
        version: 1, requestId: rid('notes-by-tag'), tag,
      });
      setTagBrowser({
        open: true,
        view: { kind: 'notes', tag: notes.ok ? notes.value.tag : tag },
        tags: index.value.tags,
        notes: notes.ok ? notes.value.notes : [],
        loading: false,
        truncated: index.value.truncated,
      });
      return;
    }
    setTagBrowser({
      open: true,
      view: { kind: 'tags' },
      tags: index.value.tags,
      notes: [],
      loading: false,
      truncated: index.value.truncated,
    });
  }, [settings.fileTags]);

  const noteLinks = useCallback(async (target: string) => {
    const result = await window.notoWorkspace.noteLinks({ version: 1, requestId: rid('note-links'), path: target });
    return result.ok ? { reply: result.value } : { error: result.error.message };
  }, []);

  /** Outbound wiki links in the open note — Links-rail fallback for MOC hubs. */
  const seedLinks = useMemo(() => {
    const notePath = active?.opened.path ?? null;
    const root = folder.root;
    if (notePath === null || root === null || !notePath.startsWith(root)) return [];
    const fromRelative = notePath.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
    const markdown = editorRef.current?.getMarkdown()
      ?? active?.opened.document.text
      ?? '';
    return seedOutboundLinks(markdown, fromRelative, fileIndex.entries);
  }, [active?.opened.path, active?.opened.document.text, active?.document.revisionId, folder.root, fileIndex.entries, editorsReady]);

  const searchContent = useCallback(async (query: string, flags: SearchFlags = PLAIN_FLAGS, scope = '') => {
    const result = await window.notoWorkspace.searchContent({
      version: 1, requestId: rid('search-content'), query, scope, ...flags,
    });
    return result.ok
      ? {
        matches: result.value.matches,
        truncated: result.value.truncated,
        timedOut: result.value.timedOut,
        invalidPattern: result.value.invalidPattern,
      }
      : null;
  }, []);

  /**
   * Open a note at what was found in it.
   *
   * The editor's own find is reused rather than a second way of locating text:
   * it already highlights every occurrence and scrolls the first into view, and
   * two mechanisms for "show me this string" would eventually disagree. It runs
   * after the document has actually been adopted, since searching a document
   * that has not arrived finds nothing.
   */
  const openMatch = useCallback((filePath: string, query: string) => {
    // Recorded before the open, not after it. The document is adopted through
    // an event rather than through the reply, so the editor can be mounted and
    // asking for a pending query before the promise this awaits has settled.
    pendingMatchRef.current = query;
    void openPath(filePath);
  }, [openPath]);

  /** The link text for a note, relative to the one being edited. */
  const insertWikiLink = useCallback((entry: WorkspaceIndexEntryV1, atTrigger = false) => {
    const editor = editorRef.current;
    if (!editor) return;
    // Note-relative target via wikiTargetFor (same arithmetic apply-graph and
    // MOC authors use), with |title when the shown name differs from the path.
    const here = active?.opened.path ?? null;
    const root = folder.root;
    const fromRelative = here !== null && root !== null && here.startsWith(root)
      ? here.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
      : entry.relativePath;
    const target = wikiTargetFor(entry.relativePath, fromRelative);
    const title = entry.name.replace(/\.md$/i, '');
    // Typed brackets are replaced by the link; a link asked for from quick
    // open goes in at the caret, where there are no brackets to replace.
    if (atTrigger && editor.replaceWikiTrigger(target, title)) return;
    editor.insertText(wikiLinkText(target, title));
  }, [active?.opened.path, folder.root]);

  /**
   * A document reported that its unsaved state changed.
   *
   * Attributed to the document that raised it rather than to whichever tab is
   * in front, so a background document cannot relabel the one being read.
   */
  /**
   * A picture pasted or dropped into the document.
   *
   * The renderer has bytes and no idea where they should go. Main decides the
   * folder, the name and the text to insert, and this either hands back what it
   * said or reports why it refused. Null means nothing is inserted, and the
   * reader has already been told why.
   */
  const writeImage = useCallback(async (bytes: Uint8Array) => {
    const result = await window.notoAssets.write({ version: 1, requestId: rid('image'), bytes });
    if (!result.ok) {
      setLocalMessage(actionableFileTruthMessage(result.error.message, 'The picture could not be added.'));
      return null;
    }
    if (result.value.written) {
      // Written, but not where the setting asked: say so, and use the copy.
      const upload = result.value.upload;
      if (upload && !upload.ok) {
        setLocalMessage(upload.reason === 'unreachable'
          ? 'PicGo.app is not running, so the picture was kept beside the note instead.'
          : `PicGo did not take the picture (${upload.detail ?? upload.reason}), so it was kept beside the note.`);
      }
      return result.value;
    }
    setLocalMessage(imageRefusalMessage(result.value.reason));
    return null;
  }, []);

  /**
   * Read the file again and take what it says now.
   *
   * The document keeps its identity across this, so the editor is not torn down
   * and rebuilt: the caret, the scroll position and the undo history all
   * survive. `replaceMarkdown` changes only the blocks that actually differ, in
   * one undoable step, so taking somebody else's edit can be undone like any
   * other change, and the blocks that did not move keep their pristine
   * provenance so the next save is still byte for byte.
   */
  const reloadFromDisk = useCallback(async (documentId: string) => {
    const result = await window.notoFileTruth.reload({
      version: 1, requestId: rid('reload'), documentId,
    });
    if (!result.ok) {
      setLocalMessage(actionableFileTruthMessage(result.error.message, 'The note could not be reloaded.'));
      return;
    }
    const outcome = result.value;
    if (outcome.status === 'unchanged') {
      patchDoc(documentId, { state: cleanStateRef.current, outcome: null });
      setLocalMessage(null);
      return;
    }
    if (outcome.status === 'missing') {
      patchDoc(documentId, { state: 'File removed' });
      setLocalMessage('That file is no longer on disk. What is on screen is the only copy.');
      return;
    }
    if (outcome.status === 'refused') {
      setLocalMessage(reloadRefusalMessage(outcome.reason));
      return;
    }
    const editor = editorsRef.current.get(documentId);
    editor?.replaceMarkdown(outcome.opened.document.text);
    editor?.commit(outcome.opened.document);
    patchDoc(documentId, {
      opened: outcome.opened,
      document: outcome.opened.document,
      token: outcome.opened.saveToken,
      outcome: null,
      recovery: null,
      dirty: false,
      state: 'Opened',
    });
    setLocalMessage(null);
  }, [patchDoc]);
  const reloadFromDiskRef = useRef(reloadFromDisk);
  reloadFromDiskRef.current = reloadFromDisk;

  /**
   * Ask before a dirty buffer is replaced. Clean notes reload at once; dirty
   * ones get a confirm that names the discard and offers a copy first. The
   * silent external-change path calls `reloadFromDisk` directly and never
   * reaches here, because it only runs when the buffer is clean.
   */
  const requestReloadFromDisk = useCallback((documentId: string) => {
    const existing = docsRef.current.get(documentId);
    const dirty = existing?.dirty === true;
    if (!reloadNeedsConfirm(dirty)) {
      void reloadFromDisk(documentId);
      return;
    }
    setReloadConfirm({ documentId, offerSaveCopy: true });
  }, [reloadFromDisk]);
  const requestReloadFromDiskRef = useRef(requestReloadFromDisk);
  requestReloadFromDiskRef.current = requestReloadFromDisk;

  /**
   * One step round the ring of page widths.
   *
   * Reached from the View menu and from Command and a bracket, which the editor
   * offers when the caret is not in a list, so the two cannot drift apart.
   */
  const stepWidth = useCallback((direction: 1 | -1) => {
    changeSettings({ widthMode: stepWidthMode(settingsRef.current.widthMode, direction) });
  }, [changeSettings]);
  const stepWidthRef = useRef(stepWidth);
  stepWidthRef.current = stepWidth;

  /** Reading rather than writing, for the status line to say so. */
  const [readOnly, setReadOnly] = useState(false);

  /** The row wearing a name field, put there by the row menu in main. */
  const [treeEditing, setTreeEditing] = useState<
    { path: string; intent: 'rename' | 'new-folder' } | null
  >(null);
  /** Bumped whenever something in the tree moved, so listings are read again. */
  const [treeVersion, setTreeVersion] = useState(0);

  // Turning the viewer off dismisses a code file and refreshes the tree so
  // non-Markdown rows disappear again.
  useEffect(() => {
    if (!settings.codeViewer) setCodeView(null);
    setTreeVersion((current) => current + 1);
  }, [settings.codeViewer]);

  /** Bumped to shut every folder in the tree, which the tree watches for. */
  const [treeCollapse, setTreeCollapse] = useState(0);

  /**
   * What to say when an action on a row did nothing.
   *
   * Every one of these is something the reader can act on, which is the point
   * of naming them separately rather than reporting a single failure.
   */
  const entryRefusalMessage = (reason: WorkspaceEntryRefusalV1): string => {
    if (reason === 'exists') return 'Something here is already called that.';
    if (reason === 'bad-name') return 'That name cannot be used for a file.';
    if (reason === 'busy') return 'That note is saving. Try again in a moment.';
    if (reason === 'trash-failed') return 'The system trash refused it. Nothing was deleted.';
    if (reason === 'outside-root') return 'That is no longer inside the open folder.';
    if (reason === 'no-folder') return 'Open a folder first.';
    return 'That did not work, and nothing was changed.';
  };

  const finishTreeEdit = useCallback((name: string | null) => {
    const editing = treeEditing;
    setTreeEditing(null);
    if (!editing || name === null) return;
    void window.notoWorkspace.manageEntry({
      version: 1,
      requestId: rid('entry'),
      action: editing.intent === 'new-folder' ? 'new-folder' : 'rename',
      target: editing.path,
      name,
      destination: null,
    }).then((result) => {
      if (!result.ok) {
        setLocalMessage(actionableFileTruthMessage(result.error.message, 'That did not work.'));
        return;
      }
      if (!result.value.done) setLocalMessage(entryRefusalMessage(result.value.reason));
    });
  }, [treeEditing]);

  /** A row dragged onto a folder: main moves it and the tree hears about it. */
  const moveEntryInto = useCallback((source: string, destination: string) => {
    void window.notoWorkspace.manageEntry({
      version: 1,
      requestId: rid('entry'),
      action: 'move-into',
      target: source,
      name: null,
      destination,
    }).then((result) => {
      if (!result.ok) {
        setLocalMessage(actionableFileTruthMessage(result.error.message, 'That could not be moved.'));
        return;
      }
      if (!result.value.done) setLocalMessage(entryRefusalMessage(result.value.reason));
    });
  }, []);

  const onDocumentDirtyChange = useCallback((documentId: string, dirty: boolean) => {
    // Main is told too: it holds the file, the renderer holds the edits, and
    // the remote control has to be able to say which is ahead.
    if (documentId === activeIdRef.current) {
      window.notoWorkspace.reportDirty({ version: 1, dirty });
    }
    setDocs((current) => {
      const existing = current.get(documentId);
      if (!existing || existing.dirty === dirty) return current;
      const next = new Map(current);
      next.set(documentId, {
        ...existing,
        dirty,
        outcome: !dirty && !recoveryBarrierRef.current ? null : existing.outcome,
        state: recoveryBarrierRef.current
          ? existing.state
          : dirty ? 'Unsaved changes' : existing.cleanState,
      });
      return next;
    });

    if (documentId !== activeIdRef.current) return;
    editorDirtyRef.current = dirty;
    if (!dirty && !recoveryBarrierRef.current) setLocalMessage(null);
  }, []);

  /** Closing preferences returns focus to whatever opened it, so keyboard
   *  users are not dropped at the top of the document. */
  const closePlugins = useCallback(() => {
    setPrefs((current) => ({ ...current, open: false }));
    restorePluginTriggerFocus(pluginsButtonRef.current);
  }, []);

  /**
   * Menu commands arrive from main because only the renderer knows the editor's
   * contents. Keep this list aligned with `WorkspaceMenuCommandV1`.
   */
  // Main asks for the note as the editor holds it, which is the only copy
  // that includes unsaved changes.
  useEffect(() => window.notoWorkspace.onTextRequest((event) => {
    const editor = editorRef.current;
    // What the file would hold if it were saved now, not what the editor
    // holds internally: the same line endings and the same last line. A
    // caller comparing this against the file when nothing is dirty must see
    // no difference, or the two sources are not comparable at all.
    const markdown = editor === null
      ? null
      : fromLf(
        editor.getMarkdown() + (editor.envelope.hasFinalNewline ? '\n' : ''),
        editor.envelope.lineEnding === 'crlf' ? 'crlf' : 'lf',
      );
    window.notoWorkspace.replyText({ version: 1, requestId: event.requestId, markdown });
  }), []);

  useEffect(() => {
    const stop = window.notoWorkspace.onRemoteChanged((event) => {
      setRemote({ listening: event.listening, port: event.port });
    });
    // Asked once as well as listened for, since it may already be on when
    // this window opens.
    void window.notoSettings.remoteStatus({ version: 1, requestId: rid('remote-status') })
      .then((result) => {
        if (result.ok) setRemote({ listening: result.value.listening, port: result.value.port });
      });
    return stop;
  }, []);

  useEffect(() => window.notoWorkspace.onPasteText((event) => {
    // A paste lands at the caret; an append becomes blocks of its own after
    // the last one, which is what "add this to the note" means.
    if (event.at === 'end') editorRef.current?.appendMarkdown(event.text);
    else editorRef.current?.pasteText(event.text);
  }), []);

  /**
   * Write the note in front out as something else.
   *
   * Shared by the File menu and the command palette so the two cannot drift:
   * both ask main the same way, with the editor's own markup for the formats
   * Noto renders and nothing for the ones Pandoc converts from the file.
   */
  const exportNote = useCallback((target: WorkspaceExportKindV1) => {
    const editor = editorRef.current;
    const current = docsRef.current.get(activeIdRef.current ?? '') ?? null;
    if (!editor || !current) { setLocalMessage('Open a note first.'); return; }
    const rendered = target === 'pdf' || target === 'html' || target === 'html-plain';
    void window.notoWorkspace.exportRendered({
      version: 1,
      requestId: rid('export'),
      target,
      html: rendered ? editor.documentHtml() : null,
      title: noteTitle(current.opened.path),
      dirty: current.dirty,
    }).then((result) => {
      if (!result.ok) {
        setLocalMessage(actionableFileTruthMessage(result.error.message, 'That could not be exported.'));
        return;
      }
      if (result.value.exported) {
        setLocalMessage(`Exported to ${result.value.path.split('/').pop() ?? 'the file'}.`);
        return;
      }
      if (result.value.reason !== 'cancelled') {
        setLocalMessage(exportRefusalMessage(result.value.reason));
      }
    });
  }, []);

  useEffect(() => window.notoWorkspace.onMenuCommand((event) => {
    switch (event.command) {
      case 'save':
        void save();
        break;
      case 'save-as':
        void saveCopy();
        break;
      case 'reveal-document':
        void window.notoWorkspace.reveal({
          version: 1, requestId: rid('reveal'), target: 'document',
        });
        break;
      case 'navigate-back':
        stepTrailRef.current(-1);
        break;
      case 'navigate-forward':
        stepTrailRef.current(1);
        break;
      case 'browse-tags':
        void openTagBrowser();
        break;
      case 'quick-open':
        // Preferences is modal and would sit over it, for the same reason the
        // command palette dismisses it.
        setPrefs((current) => ({ ...current, open: false }));
        void ensureFileIndex();
        setQuickOpen((current) => ({ open: !(current.open && current.mode === 'files'), mode: 'files' }));
        break;
      case 'search-content':
        // Typora's chord opens the sidebar's search, which stays open while
        // the notes it found are read one after another.
        setPrefs((current) => ({ ...current, open: false }));
        setQuickOpen((current) => ({ ...current, open: false }));
        setRail({ open: true, view: 'search' });
        break;
      case 'command-palette':
        // Preferences is modal, so leaving it open would put its scrim over the
        // palette and swallow every click on a command. Asking for a command to
        // run against the document is also a statement that you are done with
        // preferences.
        setPrefs((current) => ({ ...current, open: false }));
        setPaletteOpen((current) => !current);
        break;
      // Every block and table command runs the editor's own code, so the menu
      // and the keyboard never drift apart.
      case 'block-paragraph': case 'block-heading-1': case 'block-heading-2':
      case 'block-heading-3': case 'block-heading-4': case 'block-heading-5':
      case 'block-heading-6': case 'block-heading-up': case 'block-heading-down':
      case 'block-code': case 'block-math': case 'block-quote':
      case 'block-ordered-list': case 'block-bullet-list': case 'block-task-list':
      case 'block-rule': case 'mark-underline': case 'mark-highlight': case 'mark-math':
      case 'insert-sidenote':
      case 'select-scope': case 'insert-comment': case 'indent-more': case 'indent-less':
      case 'table-row-above': case 'table-row-below':
      case 'table-column-before': case 'table-column-after':
      case 'table-row-delete': case 'table-column-delete': case 'table-delete':
      case 'move-up': case 'move-down':
      case 'move-column-left': case 'move-column-right':
      case 'task-toggle': case 'task-complete': case 'task-incomplete': case 'sort-tasks':
      case 'insert-link': case 'clear-format':
      case 'table-prettify': case 'table-copy':
      case 'insert-footnote': case 'insert-toc':
      case 'insert-frontmatter': case 'insert-link-reference':
      case 'block-alert-note': case 'block-alert-tip': case 'block-alert-important':
      case 'block-alert-warning': case 'block-alert-caution':
      case 'table-align-left': case 'table-align-center': case 'table-align-right': case 'table-align-none':
      case 'select-word': case 'select-line': case 'jump-to-selection':
      case 'mark-strong': case 'mark-emphasis': case 'mark-code': case 'mark-strike':
        if (!editorRef.current?.runCommand(event.command)) {
          setLocalMessage('That does not apply where the cursor is.');
        }
        break;
      case 'line-endings-lf': case 'line-endings-crlf': case 'toggle-final-newline': {
        const editor = editorRef.current;
        if (!editor) { setLocalMessage('Open a note first.'); break; }
        const changed = event.command === 'toggle-final-newline'
          ? editor.setEnvelope({ hasFinalNewline: !editor.envelope.hasFinalNewline })
          : editor.setEnvelope({ lineEnding: event.command === 'line-endings-lf' ? 'lf' : 'crlf' });
        // Nothing is written yet, and a reader who chose an ending and saw no
        // change at all would reasonably think the menu did nothing.
        if (changed) {
          setLocalMessage(editor.envelope.hasFinalNewline || event.command !== 'toggle-final-newline'
            ? 'Saved with that from now on. Save to write it.'
            : 'The file will no longer end with a newline. Save to write it.');
        }
        break;
      }
      case 'export-pdf': case 'export-html': case 'export-html-plain':
      case 'export-docx': case 'export-odt': case 'export-rtf': case 'export-epub':
      case 'export-latex': case 'export-mediawiki': case 'export-rst':
      case 'export-textile': case 'export-opml': {
        exportNote(event.command.slice('export-'.length) as WorkspaceExportKindV1);
        break;
      }
      case 'toggle-always-on-top':
        void changeSettings({ alwaysOnTop: !settings.alwaysOnTop });
        break;
      case 'toggle-read-only': {
        const editor = editorRef.current;
        if (!editor) break;
        const next = !editor.isReadOnly;
        editor.setReadOnly(next);
        setReadOnly(next);
        setLocalMessage(next
          ? 'Read-only. Nothing you type will change this note.'
          : null);
        break;
      }
      case 'copy-as-markdown': case 'copy-as-html': case 'copy-as-plain': {
        const as = event.command === 'copy-as-html' ? 'html'
          : event.command === 'copy-as-plain' ? 'plain' : 'markdown';
        const copied = editorRef.current?.copySelection(as) ?? null;
        if (copied === null) {
          setLocalMessage('Select something first.');
          break;
        }
        if (!copyThroughSelection(copied)) setLocalMessage('The clipboard refused it.');
        break;
      }
      case 'reload-from-disk': {
        const id = activeIdRef.current;
        if (id) requestReloadFromDiskRef.current(id);
        else setLocalMessage('Open a note first.');
        break;
      }
      case 'insert-image':
        void window.notoAssets.pick({ version: 1, requestId: rid('pick-image') })
          .then((result) => {
            if (!result.ok) {
              setLocalMessage(actionableFileTruthMessage(result.error.message, 'The picture could not be added.'));
              return;
            }
            if (result.value.written) {
              editorRef.current?.insertWrittenImage(result.value);
              return;
            }
            if (result.value.reason === 'cancelled') return;
            setLocalMessage(imageRefusalMessage(result.value.reason));
          });
        break;
      case 'new-file':
        void window.notoWorkspace.newFile({ version: 1, requestId: rid('new-file') })
          .then((result) => {
            if (result.ok && result.value.created) return;
            setLocalMessage(result.ok
              ? 'Open a folder first, and the new note goes in it.'
              : actionableFileTruthMessage(result.error.message, 'The note could not be made.'));
          });
        break;
      case 'toggle-focus-mode':
        changeSettings({ focusMode: !settings.focusMode });
        break;
      case 'toggle-typewriter':
        changeSettings({ typewriterMode: !settings.typewriterMode });
        break;
      case 'toggle-outline':
        toggleRail('outline');
        break;
      case 'tree-sort-name': case 'tree-sort-name-desc':
      case 'tree-sort-modified': case 'tree-sort-modified-old':
        changeSettings({ treeSort: event.command.slice('tree-sort-'.length) as TreeSortV1 });
        // The order is main's, so the tree has to ask again to see it.
        setTreeVersion((current) => current + 1);
        break;
      case 'shortcuts':
        setShortcuts((open) => !open);
        break;
      case 'tree-collapse-all':
        setRail((current) => ({ ...current, open: true, view: 'files' }));
        setTreeCollapse((current) => current + 1);
        break;
      case 'source-code-mode':
        if (editorRef.current) setSourceMode((current) => !current);
        break;
      case 'table-insert':
        // Typora asks how big first.
        if (editorRef.current) setTableDialog(true);
        else setLocalMessage('Open a note first.');
        break;
      case 'toggle-source':
        if (sourceMode) break;
        // Refusing means the hand-edited text no longer parses as one block.
        if (editorRef.current && !editorRef.current.toggleSourceAtSelection()) {
          setLocalMessage('That source edit is no longer a single block, so it cannot be rendered yet.');
        }
        break;
      case 'undo':
        editorRef.current?.history('undo');
        break;
      case 'redo':
        editorRef.current?.history('redo');
        break;
      case 'settings':
        setPrefs({ open: true, section: 'appearance' });
        break;
      case 'toggle-sidebar':
        toggleRail('files');
        break;
      // Three modes in a ring, as in the plugin this is ported from: the chord
      // changes the shape of the page in one press and never lands on nothing.
      case 'widen':
        stepWidthRef.current(1);
        break;
      case 'narrow':
        stepWidthRef.current(-1);
        break;
      case 'find-next': case 'find-previous': {
        const editor = editorRef.current;
        if (!editor) break;
        /*
         * Stepping without the bar holding focus, which is the whole point.
         *
         * A search that was never run has nothing to step through, so the last
         * query is run first. That is also what makes this work after the bar
         * has been closed: closing it clears the highlights but not the query.
         */
        const query = findRef.current.query ?? '';
        if (query.length === 0) {
          setFind((current) => ({ ...current, open: true }));
          break;
        }
        const outcome = editor.search({ query, ...findOptionsRef.current });
        if (outcome.matches === 0) {
          setLocalMessage('No matches.');
          break;
        }
        editor.goToMatch(event.command === 'find-next' ? 'forward' : 'backward');
        break;
      }
      case 'find':
        setPrefs((current) => ({ ...current, open: false }));
        setFind({ open: true, replace: false });
        break;
      case 'find-replace':
        setPrefs((current) => ({ ...current, open: false }));
        setFind({ open: true, replace: true });
        break;
      default:
        break;
    }
  }));

  /**
   * Built-in export first, then whatever active plugins offer.
   *
   * Export is the largest Typora habit that used to live only in the File menu,
   * so a reader who reaches for the palette looking for it finds it. Plugin
   * commands keep their own source label underneath.
   */
  const paletteCommands = useMemo(() => {
    const builtin = EXPORT_PALETTE_COMMANDS.map((command) => ({
      kind: 'export' as const,
      target: command.target,
      title: command.title,
      source: command.source,
    }));
    const plugins = pluginSnapshots
      .filter((snapshot) => snapshot.lifecycle === 'active')
      .flatMap((snapshot) => {
        const manifest = bundledManifests.get(snapshot.id);
        return (manifest?.commands ?? []).map((command) => ({
          kind: 'plugin' as const,
          pluginId: snapshot.id,
          commandId: command.id,
          title: command.title,
          source: manifest?.name ?? snapshot.id,
        }));
      });
    return [...builtin, ...plugins];
  }, [pluginSnapshots]);

  const outline = useMemo(() => (document ? outlineFromDocument(document) : []), [document]);
  /**
   * The heading the caret is under, which is the one question a list of
   * headings is asked while you are writing rather than navigating. The
   * nearest heading at or before the block, since a paragraph belongs to the
   * heading above it.
   */
  const currentHeading = useMemo(() => {
    let found = -1;
    for (const entry of outline) {
      if (entry.blockIndex <= activeBlock) found = entry.blockIndex;
      else break;
    }
    return found;
  }, [outline, activeBlock]);

  const actions = state === 'Opening' || state === 'No document'
    ? []
    : fileTruthActions(state, editorDirty, recoveryBarrier);
  const saveBlocked = recoveryBarrier || state === 'External conflict' || state === 'Stale editor revision';
  const alert = exceptionalAlertPresentation(recoveryBarrier, outcome, localMessage, state);
  const nextTheme = theme === 'light' ? 'dark' : 'light';
  /* Every platform has the idea and none of them share a name for it, so the
     label says the one the reader will recognise on their own machine. */
  const fileManagerName = platform === 'darwin' ? 'Finder'
    : platform === 'win32' ? 'File Explorer' : 'the file manager';

  return (
    <div className="app-shell"
      // Only macOS puts window controls over the page, so only macOS needs the
      // title bar to leave room for them. The value is the one bootstrap
      // validated, which the shell already has.
      data-platform={platform}
      data-testid="noto-app" data-file-state={state}
      /* Rail width as a CSS variable for anything that still wants to know
         how wide the open rail is (print, narrow-window overrides). */
      style={{ '--shell-rail': rail.open ? `${settings.railWidth}px` : '0px' } as CSSProperties}
      data-plugin-lifecycle={pluginSnapshot?.lifecycle ?? 'disabled'}
      data-plugin-registrations={pluginSnapshot?.rendererRegistrations ?? 0}>
      <a className="skip-link" href="#document-canvas">Skip to document</a>

      {/* Identity, not actions.
          Six bordered text buttons in a row read as a toolbar and competed with
          the document on every screen. What is left is the filename where a
          window title belongs and icons that stay quiet until they are wanted.
          Open moved to the File menu and the empty state, Outline into the
          rail, Theme into preferences, Find to its shortcut. */}
      {/* Below the title bar (Claude-style): traffic lights and sidebar/trail
          controls share the full-width title row; the rail starts underneath. */}
      {rail.open && (
          <WorkspaceRail
            links={{
              currentPath: active?.opened.path ?? null,
              onLinks: noteLinks,
              onOpen: (target) => { void openPath(target); },
              seedLinks,
            }}
            search={{
              onSearch: searchContent,
              onOpenMatch: openMatch,
              currentPath: active?.opened.path ?? null,
              onClose: () => setRail({ open: true, view: 'files' }),
            }}
            view={rail.view}
            onView={(view) => setRail({ open: true, view })}
            width={settings.railWidth}
            onResize={(railWidth) => changeSettings({ railWidth })}
            outline={outline}
            currentHeading={currentHeading}
            onGoToBlock={(blockIndex) => editorRef.current?.focusBlock(blockIndex)}
            tree={{
              vaultMenu: (
                <RailFooter
                  folderName={folder.name}
                  folderPath={folder.root}
                  recentFolders={recentFolders}
                  open={folderMenu}
                  onToggle={() => setFolderMenu((current) => !current)}
                  onClose={() => setFolderMenu(false)}
                  onChooseFolder={chooseFolder}
                  onOpenRecentFolder={openRecentFolder}
                  onRefresh={() => { void ensureFileIndex(); setFolder((current) => ({ ...current })); }}
                  fileManagerName={fileManagerName}
                  onReveal={() => { void window.notoWorkspace.reveal({
                    version: 1, requestId: rid('reveal'), target: 'folder',
                  }); }}
                />
              ),
              root: folder.root,
              rootName: folder.name,
              activePath: codeView?.path ?? opened?.path ?? null,
              list: listFolder,
              onOpenFile: openFromTree,
              onRowMenu: showTreeMenu,
              onChooseFolder: chooseFolder,
              onMoveEntry: moveEntryInto,
              editing: treeEditing,
              onEditingDone: finishTreeEdit,
              reloadToken: treeVersion,
              collapseToken: treeCollapse,
            }}
          />
      )}

      <header className="titlebar">
        <div className="title-left">
          <button type="button" className="icon-button" data-testid="sidebar-toggle"
            aria-pressed={rail.open} aria-label={rail.open ? 'Hide the rail' : 'Show the rail'}
            title={rail.open ? 'Hide the rail' : 'Show the rail'}
            onClick={() => toggleRail(rail.view)}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75" />
              <path d="M6.25 2.75v10.5" />
            </svg>
          </button>
          {/* Back and forward along the trail: three notes each way, from the
              author's plugin. Beside the rail toggle, where an editor's
              navigation lives, rather than floating over the page. */}
          <button type="button" className="icon-button title-nav" data-testid="nav-back"
            disabled={trail.back.length === 0} aria-label="Back" title="Back (⌘⌥←)"
            onClick={() => stepTrail(-1)}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.25 5.25 8 10 12.75" /></svg>
          </button>
          <button type="button" className="icon-button title-nav" data-testid="nav-forward"
            disabled={trail.forward.length === 0} aria-label="Forward" title="Forward (⌘⌥→)"
            onClick={() => stepTrail(1)}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.25 10.75 8 6 12.75" /></svg>
          </button>
        </div>

        <div className="document-identity" data-testid="document-identity">
          {crumbs.map((crumb, index) => (
            <span key={`${index}-${crumb}`} className="crumb">{crumb}</span>
          ))}
          <strong title={opened?.path} aria-label={opened ? `${filename}. ${opened.path}` : filename}>{filename}</strong>
          {/* Whether there is work to lose is the one thing worth seeing
              without reading. It is also the whole save affordance when the
              document is clean, since the Save icon is not drawn then. */}
          {opened && editorDirty && (
            <span className="unsaved-dot" data-testid="unsaved-dot" role="img" aria-label="Unsaved changes" />
          )}
        </div>

        {/* Not drawn. The dot carries this for sighted readers and the alert
            carries the exceptional states; this stays so the live region still
            announces them. */}
        <span className="file-state" data-testid="file-state" aria-live="polite">{state}</span>

        <div className="title-actions">
          <button ref={pluginsButtonRef} type="button" className="icon-button" data-testid="plugin-toggle"
            aria-expanded={prefs.open && prefs.section === 'plugins'} aria-controls="plugin-drawer"
            aria-label="Plugins" title="Plugins"
            onClick={() => openPreferences('plugins')}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect x="2.25" y="2.25" width="5" height="5" rx="1.2" />
              <rect x="8.75" y="8.75" width="5" height="5" rx="1.2" />
              <path d="M8.75 4.75h5M4.75 8.75v5" />
            </svg>
          </button>
          <button type="button" className="icon-button" data-testid="settings-toggle"
            aria-expanded={prefs.open && prefs.section !== 'plugins'}
            aria-label="Preferences" title="Preferences"
            onClick={() => openPreferences('appearance')}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="2.1" />
              <path d="M8 1.4v1.6M8 13v1.6M14.6 8H13M3 8H1.4M12.7 3.3l-1.1 1.1M4.4 11.6l-1.1 1.1M12.7 12.7l-1.1-1.1M4.4 4.4 3.3 3.3" />
            </svg>
          </button>
          {/* Drawn only when there is something to save. A permanently greyed
              Save is noise in a window that is saved almost all of the time,
              and it says nothing when it finally lights up. */}
          {(editorDirty || state === 'Save failed') && (
            <button type="button" className="icon-button is-live" data-testid="save-button"
              aria-label={state === 'Save failed' ? 'Retry save' : 'Save'}
              title={state === 'Save failed' ? 'Retry save' : 'Save'}
              disabled={pending || saveBlocked}
              onClick={() => void save()}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3.4 2.4h7l3.2 3.2v8h-11z" />
                <path d="M5.4 2.4v3.9h5V2.4M5.4 13.6V9.4h5.2v4.2" />
              </svg>
            </button>
          )}
        </div>
      </header>

      <Preferences
        open={prefs.open}
        section={prefs.section}
        onSection={(section) => setPrefs({ open: true, section })}
        settings={settings}
        onChange={changeSettings}
        onClose={closePlugins}
        themeProblem={themeProblem}
        onReloadCss={() => setThemeReload((current) => current + 1)}
        plugins={(
          <PluginCenter api={window.notoDesktop} snapshots={pluginSnapshots}
            availability={pluginAvailability} open />
        )}
      />

      <div
        className={`workspace-layout ${rail.open ? 'has-rail' : ''}`}
        data-source-mode={sourceMode ? 'on' : undefined}
      >
        {shortcuts && <Shortcuts mac={platform === 'darwin'} onClose={() => setShortcuts(false)} />}
        {reloadConfirm && (
          <ReloadConfirmDialog
            offerSaveCopy={reloadConfirm.offerSaveCopy}
            onCancel={() => {
              setReloadConfirm(null);
              editorRef.current?.focus();
            }}
            onReload={() => {
              const id = reloadConfirm.documentId;
              setReloadConfirm(null);
              void reloadFromDisk(id);
            }}
            onSaveCopy={() => {
              const id = reloadConfirm.documentId;
              setReloadConfirm(null);
              void (async () => {
                const kept = await saveCopy();
                // Work is on the copy now; take the disk version into the
                // original path without asking again.
                if (kept) void reloadFromDisk(id);
                else editorRef.current?.focus();
              })();
            }}
          />
        )}

        {tableDialog && (
          <TableDialog
            onClose={() => { setTableDialog(false); editorRef.current?.focus(); }}
            onInsert={(rows, columns) => {
              setTableDialog(false);
              if (!editorRef.current?.insertTable(rows, columns)) {
                setLocalMessage('A table cannot go where the cursor is.');
              }
            }}
          />
        )}
        {/* A sibling of the canvas rather than a child of it, so opening find
            overlays the document instead of pushing every line down. */}
        {document && (
          <FindBar
            open={find.open}
            showReplace={find.replace}
            initialQuery={find.query}
            onSearch={(options) => {
              const { query, ...rest } = options;
              findOptionsRef.current = rest;
              setFind((current) => (current.query === query ? current : { ...current, query }));
              return editorRef.current?.search(options) ?? { matches: 0, active: -1 };
            }}
            onGo={(direction) => editorRef.current?.goToMatch(direction) ?? { matches: 0, active: -1 }}
            onReplace={(replacement, scope) => editorRef.current?.replace(replacement, scope) ?? 0}
            onClose={() => {
              editorRef.current?.clearSearch();
              setFind({ open: false, replace: false });
              editorRef.current?.focus();
            }}
          />
        )}

        <main id="document-canvas" className="canvas-scroll" tabIndex={-1} aria-label="Document canvas">
          {codeView ? <CodeViewer view={codeView} /> : null}
          {/* Every open document keeps its editor mounted, with only the
              active one visible. Unmounting the others would destroy their
              undo history, selection and scroll position, so returning to a
              tab would lose the work in progress there. */}
          {[...docs.values()].map((doc) => (
            <div
              key={doc.document.documentId}
              className="canvas-slot"
              hidden={codeView !== null || doc.document.documentId !== activeId}
              aria-hidden={codeView !== null || doc.document.documentId !== activeId}
            >
              {sourceMode && doc.document.documentId === activeId && editorsRef.current.get(doc.document.documentId) && (
                <SourceModeView
                  key={`${doc.document.documentId}:${doc.document.revisionId}:${editorsReady}`}
                  editor={editorsRef.current.get(doc.document.documentId)!}
                  fileText={doc.document.text}
                  startBlock={activeBlock}
                  registerFlush={(flush) => { sourceFlushRef.current = flush; }}
                />
              )}
              <div hidden={sourceMode} className="canvas-rendered">
              {settings.fileTags && doc.document.documentId === activeId && (
                <TagStrip tags={noteTags} onTag={(tag) => { void openTagBrowser(tag); }} />
              )}
              <NotoCanvas
                document={doc.document}
                mac={platform === 'darwin'}
                smartQuotes={settings.smartQuotes}
                smartDashes={settings.smartDashes}
                smartEllipsis={settings.smartEllipsis}
                spellCheck={settings.spellCheck}
                documentPath={doc.opened.path}
                remoteImages={settings.remoteImages}
                typewriterMode={settings.typewriterMode}
                autoPair={settings.autoPair}
                todoCheckTime={settings.todoCheckTime}
                markHighlight={settings.markHighlight}
                markSuperscript={settings.markSuperscript}
                markSubscript={settings.markSubscript}
                sidenotes={settings.sidenotes}
                onActiveBlockChanged={setActiveBlock}
                onDirtyChange={(dirty) => onDocumentDirtyChange(doc.document.documentId, dirty)}
                onDocumentChanged={() => {
                  if (doc.document.documentId === activeIdRef.current) {
                    bumpTyping();
                    if (settings.fileTags) {
                      const markdown = editorsRef.current.get(doc.document.documentId)?.getMarkdown() ?? '';
                      setNoteTags(parseTagsFromMarkdown(markdown));
                    }
                  }
                }}
                onFollowWikiLink={(target) => followWikiLinkRef.current(target)}
                onWikiTrigger={() => {
                  // Only where there is something to choose from: an empty
                  // index would open a palette with nothing in it.
                  void ensureFileIndex();
                  setQuickOpen({ open: true, mode: 'files', linking: true });
                }}
                onFollowLink={(href) => followLinkRef.current(href)}
                onDropNote={(file) => {
                  // The renderer never names a path itself; the bridge reads
                  // the file's from the browser and main opens it.
                  const target = window.notoWorkspace.pathForFile(file);
                  if (target) void openPath(target);
                  else setLocalMessage('That file could not be located.');
                }}
                onCountChanged={(next) => countRef.current(doc.document.documentId, next)}
                onWriteImage={writeImage}
                onWidthStep={(direction) => stepWidthRef.current(direction)}
                onReady={(editor) => {
                  editorsRef.current.set(doc.document.documentId, editor);
                  setEditorsReady((count) => count + 1);
                  if (doc.document.documentId === activeIdRef.current) {
                    editorRef.current = editor;
                    pluginClientRef.current?.attachAdapter(editor);
                    // An editor exists now, which is the event enabled
                    // plugins wait for. Announced by the effect below rather
                    // than from here, because the editor and the plugin
                    // snapshots arrive independently and either can be second.
                    announceEditorRef.current();
                    // A content result was what opened this document, so show
                    // the reader what they searched for rather than the top of
                    // a file they now have to scan by eye.
                    const pending = pendingMatchRef.current;
                    pendingMatchRef.current = null;
                    if (pending) setFind({ open: true, replace: false, query: pending });
                  }
                }}
                onTeardown={(editor) => {
                  editorsRef.current.delete(doc.document.documentId);
                  if (editorRef.current !== editor) return;
                  // Detach before dropping the reference, so a plugin can never
                  // hold a port whose editor is already gone.
                  void pluginClientRef.current?.detachAdapter();
                  editorRef.current = null;
                }}
                onError={(message) => {
                  setLocalMessage(actionableFileTruthMessage(message, 'The editor failed to start.'));
                  setState('Save failed');
                }}
              />
              </div>
            </div>
          ))}
          {document || codeView
            ? null
            : state === 'Opening'
              ? <div className="opening-state">Starting…</div>
              : <section className="empty-state" data-testid="empty-state">
                  <h1>No document open</h1>
                  <p>Open a folder to browse its notes, or a single file to start writing.</p>
                  <div className="empty-actions">
                    <button type="button" className="primary" data-testid="empty-open-folder"
                      onClick={chooseFolder}>Open a folder…</button>
                    <button type="button" data-testid="empty-open"
                      onClick={() => void openWithDialog()}>Open a document…</button>
                  </div>
                  {openError && <p role="alert" className="empty-error">{openError}</p>}
                  {recent.length > 0 && (
                    <div className="recent-list">
                      <span className="aside-heading">Recent</span>
                      {recent.slice(0, 8).map((file) => (
                        <button key={file.path} type="button" className="file-row" title={file.path}
                          onClick={() => void openPath(file.path)}>
                          <strong>{file.name}</strong>
                          <span>{file.path}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </section>}
        </main>
      </div>

      <TagBrowser
        open={tagBrowser.open}
        view={tagBrowser.view}
        tags={tagBrowser.tags}
        notes={tagBrowser.notes}
        loading={tagBrowser.loading}
        truncated={tagBrowser.truncated}
        onOpenTag={(tag) => { void openTagBrowser(tag); }}
        onOpenNote={(path) => {
          setTagBrowser((current) => ({ ...current, open: false }));
          void openPath(path);
        }}
        onBack={() => { void openTagBrowser(); }}
        onClose={() => {
          setTagBrowser((current) => ({ ...current, open: false }));
          editorRef.current?.focus();
        }}
      />

      <QuickOpen
        open={quickOpen.open}
        mode={quickOpen.mode}
        onMode={(mode) => setQuickOpen({ open: true, mode })}
        onSearchContent={(query, scope) => searchContent(query, PLAIN_FLAGS, scope)}
        onOpenMatch={openMatch}
        width={settings.quickOpenWidth}
        onWidth={(quickOpenWidth) => changeSettings({ quickOpenWidth })}
        entries={fileIndex.entries}
        frecency={frecency}
        truncated={fileIndex.truncated}
        canInsertLink={document !== null}
        onOpenFile={(filePath) => void openPath(filePath)}
        onInsertLink={(entry) => insertWikiLink(entry, quickOpen.linking === true)}
        linking={quickOpen.linking === true}
        onClose={() => { setQuickOpen((current) => ({ ...current, open: false })); editorRef.current?.focus(); }}
      />

      {paletteOpen && (
        <div className="command-palette" role="dialog" aria-modal="true" aria-label="Commands"
          data-testid="command-palette">
          <div className="dialog-heading">
            <strong>Commands</strong>
            <button type="button" onClick={() => setPaletteOpen(false)}>Close</button>
          </div>
          {paletteCommands.map((command) => (
            <button
              key={command.kind === 'export' ? `export:${command.target}` : `${command.pluginId}:${command.commandId}`}
              type="button"
              className="palette-result"
              data-testid={command.kind === 'export' ? `palette-export-${command.target}` : undefined}
              onClick={() => {
                setPaletteOpen(false);
                if (command.kind === 'export') exportNote(command.target);
                else executePluginCommand(command.pluginId, command.commandId);
              }}>
              <strong>{command.title}</strong>
              <span>{command.source}</span>
            </button>
          ))}
        </div>
      )}

      {alert && (
        <section className={`file-truth-alert alert-${state.toLowerCase().replaceAll(' ', '-')}`}
          role="alert" data-testid="file-truth-alert">
          <strong>{state}</strong>
          <p>{alert.message}</p>
          {recoveryRecord && (
            <p className="recovery-record">
              Recovery record {recoveryRecord.attemptId.slice(0, 12)} at {recoveryRecord.stage}. Retry
              recovery verifies the accepted bytes and then clears this durable evidence.
            </p>
          )}
          <div className="file-truth-actions">
            {actions.includes('retry-recovery') && <button type="button" disabled={pending} onClick={() => void recover()}>Retry recovery</button>}
            {actions.includes('retry-save') && <button type="button" disabled={pending} onClick={() => void save()}>Retry save</button>}
            {actions.includes('reload') && (
              <button type="button" data-testid="reload-from-disk" disabled={pending}
                onClick={() => { const id = activeIdRef.current; if (id) requestReloadFromDisk(id); }}>
                Reload from disk
              </button>
            )}
            {actions.includes('save-copy') && <button type="button" disabled={pending} onClick={() => void saveCopy()}>Save a copy</button>}
          </div>
          {outcome?.status === 'copy-saved' && <p>The original is unchanged. Your current edits are still unsaved.</p>}
        </section>
      )}

      {/* Where the file lives, and what state it is in.
          Deliberately not the file name: the title bar already shows that, and
          repeating it in the corner spends the only other line the window has
          on something the reader has already read. The containing folder is
          what the title bar cannot tell them, and the full path is on hover. */}
      {opened && (
        <footer className={readOnly ? 'operational-status has-flag' : 'operational-status'}>
          <RecentStrip tabs={tabs} dirty={dirtyDocumentIds} onActivate={activateTab} />
          <span className="status-path" title={opened.path}>{containingFolder}</span>
          {/* Only the resting states. Every other state is already on the title
              bar, and an unsaved document was announcing itself three times at
              once: the dot on the name, the word beside the actions, and this.
              What this line adds is the fidelity promise, which nothing else
              says. */}
          {/* Keyed on what it says, so React remounts the line whenever the
              message changes and the fade starts again. The line says its
              piece and then recedes: a promise that is always on screen stops
              being read, and the window is quieter for its absence. */}
          {/* Read-only is a mode with no other sign on screen, and a reader
              whose typing does nothing needs to be told why rather than
              concluding the app is broken. */}
          {readOnly && <span className="status-flag" data-testid="read-only-flag">Read-only</span>}
          {/* Something outside this window can drive it, and a reader must
              never have to wonder whether that is so. */}
          {remote.listening && (
            <button
              type="button"
              className="status-flag status-remote"
              data-testid="remote-flag"
              title={`Listening on http://127.0.0.1:${remote.port ?? ''}. Press to open the Remote settings.`}
              onClick={() => openPreferences('remote')}
            >
              Remote
            </button>
          )}
          <span key={notice ?? state} className={notice ? 'status-message is-notice' : 'status-message'}
            data-testid={notice ? 'status-notice' : undefined} aria-live="polite">
            {notice ?? (state === 'Opened' ? 'Exact source preserved' : state === 'Saved' ? 'Exact source saved' : '')}
          </span>
          {/* The one number a writer looks for, at the end of the line where
              nothing else competes with it. Counted after typing stops, so it
              settles a moment behind the words rather than flickering under
              them. */}
          {count !== null && (
            // Typora's word count opens on a click to the rest of the numbers.
            // A disclosure rather than a dialog: it is a glance, and the
            // browser opens and closes it without a line of script.
            <details className="count-disclosure">
              <summary className="status-count" data-testid="status-count"
                title="Words, characters and lines">
                {count.words.toLocaleString()} {count.words === 1 ? 'word' : 'words'}
              </summary>
              <dl className="count-popover" data-testid="count-popover">
                <dt>Words</dt><dd>{count.words.toLocaleString()}</dd>
                <dt>Characters</dt><dd>{count.characters.toLocaleString()}</dd>
                <dt>Without spaces</dt><dd>{count.charactersNoSpaces.toLocaleString()}</dd>
                <dt>Lines</dt><dd>{count.lines.toLocaleString()}</dd>
                <dt>Paragraphs</dt><dd>{count.blocks.toLocaleString()}</dd>
              </dl>
            </details>
          )}
        </footer>
      )}
    </div>
  );
}

export function BootstrapFailure({ message }: { message: string }) {
  const actionable = actionableFileTruthMessage(message, 'Noto could not start safely.');
  return (
    <main className="opening-state" data-testid="bootstrap-failure" role="alert">
      <strong>Noto could not start safely.</strong>
      <p>{actionable}</p>
      <p>No document was opened and no save was attempted.</p>
    </main>
  );
}

/** The source view over one editor: reads its text once, settles block-wise or via source escape. */
function SourceModeView({ editor, fileText, startBlock, registerFlush }: {
  editor: NotoEditor;
  fileText: string;
  startBlock: number;
  registerFlush: (flush: (() => void) | null) => void;
}) {
  const initial = useMemo(() => sourceModeText({
    dirty: editor.isDirty,
    fileText,
    reconstructed: editor.getMarkdown(),
    hasFinalNewline: editor.envelope.hasFinalNewline,
    pendingSource: editor.pendingSourceMarkdown,
  }), [editor, fileText]);
  return (
    <SourceMode
      initialText={initial}
      startBlock={Math.max(0, startBlock)}
      apply={(markdown) => editor.applySourceBuffer(markdown)}
      onLeave={(block) => editor.focusBlock(block)}
      registerFlush={registerFlush}
    />
  );
}

export function App() {
  const [boot, setBoot] = useState<{ platform: NotoPlatform; error: string | null } | null>(null);

  useEffect(() => {
    let active = true;
    void window.notoFileTruth.bootstrap({ version: 1, requestId: rid('ft-bootstrap') })
      .then((result) => {
        if (!active) return;
        setBoot(result.ok
          ? { platform: result.value.platform, error: null }
          : { platform: 'linux', error: result.error.message });
      })
      .catch((error) => {
        if (active) {
          setBoot({
            platform: 'linux',
            error: error instanceof Error ? error.message : 'Bootstrap transport failed.',
          });
        }
      });
    return () => { active = false; };
  }, []);

  if (boot === null) return <div className="opening-state">Starting Noto…</div>;
  if (boot.error) return <BootstrapFailure message={boot.error} />;
  return <NotoWorkspace platform={boot.platform} />;
}

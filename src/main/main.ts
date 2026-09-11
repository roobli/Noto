import { randomUUID } from 'node:crypto';
import { isTrustedRendererSender } from './ipc/trusted-renderer';
import { ipcMain } from 'electron';
import { isWorkspaceDirtyEventV1, isWorkspaceTextReplyV1 } from '../shared/workspace/v1/validate';
import {
  NOTO_WORKSPACE_VERSION, WORKSPACE_CHANNELS,
} from '../shared/workspace/v1/contracts';
import { startRemoteServer, type RunningRemote } from './remote/server';
import { TokenStore } from './remote/token-store';
import { confineRemoteOpenPath } from './remote/resolve-open-path';
import {
  NOTO_SETTINGS_VERSION, SETTINGS_CHANNELS, type NotoSettingsV1, type NotoTheme, type RemoteStatusReplyV1,
} from '../shared/settings/v1/contracts';
import { ensureThemeFolder, listThemes } from './workspace/themes';
import path from 'node:path';
import { statSync } from 'node:fs';
import { readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { app, BrowserWindow, dialog, nativeTheme, shell } from 'electron';
import { FileTruthStoreV1 } from './file-truth/v1/file-truth-store';
import { registerFileTruthHandlers } from './file-truth/v1/register-file-truth-handlers';
import { registerIpcHandlers } from './ipc/register-handlers';
import { createLogger } from './logger';
import { CapabilityBroker } from './plugins/capability-broker';
import { LocalPluginStateStore } from './plugins/local-plugin-state-store';
import { PluginRegistry, bundledPluginCatalog } from './plugins/plugin-registry';
import {
  bundledPluginResourceRoot,
  discoverBundledPluginCatalog,
} from './plugins/bundled-plugin-discovery';
import { RendererLeaseBridge } from './plugins/renderer-lease-bridge';
import { ServiceHost } from './plugins/service-host';
import { ExperimentalPluginRuntimeHost } from './plugins/experimental-plugin-runtime-host';
import { installNotoProtocol, isAllowedRendererUrl, registerNotoScheme } from './protocol/register-app-protocol';
import { IPC_CHANNELS } from '../shared/ipc/contracts';
import type { PluginCatalog } from '../shared/plugins/catalog';
import { PLUGIN_LIFECYCLE_VERSION } from '../shared/plugins/lifecycle';
import { createEditorWindow, headless, type RendererConsoleState } from './windows/create-editor-window';
import {
  EDITOR_CHROME_COLORS,
  resolveEditorChromeTone,
  syncEditorTitleBarOverlay,
} from './windows/editor-window-chrome';
import { RecentFiles } from './workspace/recent-files';
import { SettingsStore } from './workspace/settings-store';
import { registerSettingsHandlers } from './workspace/register-settings-handlers';
import { WorkspaceSession } from './workspace/session';
import { installApplicationMenu, sendPasteText } from './workspace/menu';
import { registerWorkspaceHandlers } from './workspace/register-workspace-handlers';
import { registerAssetHandlers } from './workspace/register-asset-handlers';

registerNotoScheme();

const argumentValue = (name: string): string | null => {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : null;
};

const explicitUserData = argumentValue('user-data-dir');
if (explicitUserData) app.setPath('userData', path.resolve(explicitUserData));

/**
 * A document named on the command line, from a file association, or by the
 * `open-file` event. This is a convenience, not the only way in: the
 * application menu opens documents without any of it.
 */
const markdownArgument = (argv: readonly string[]): string | null =>
  argv.find((value) => !value.startsWith('-') && /\.(md|markdown|mdown|mkd|txt)$/i.test(value)) ?? null;

const isDirectory = (candidate: string): boolean => {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
};

/**
 * A folder named on the command line, as `noto ~/notes`.
 *
 * Resolved against the working directory, since that is what a shell means
 * by a relative path. In development the first argument is the app itself,
 * which is a directory, so the scan starts after it there.
 */
const folderArgument = (argv: readonly string[]): string | null => {
  for (const value of argv) {
    if (value.startsWith('-')) continue;
    const candidate = path.resolve(value);
    if (isDirectory(candidate)) return candidate;
  }
  return null;
};

const launchArguments = app.isPackaged ? process.argv.slice(1) : process.argv.slice(2);
const openArgument = argumentValue('open');
const folderFlag = argumentValue('folder');
/*
 * Folder resolution order: an explicit `--folder=`, then `--open=` when that
 * path is itself a directory, then a bare positional directory. The code-viewer
 * e2e (and anyone launching `noto --open=note.md --folder=vault`) needs the
 * flag; without it the note still brings its parent folder, but as a restore
 * rather than a choice, so the rail stays shut.
 */
let pendingOpenFolder: string | null = folderFlag && isDirectory(folderFlag)
  ? path.resolve(folderFlag)
  : openArgument && isDirectory(openArgument)
    ? path.resolve(openArgument)
    : folderArgument(launchArguments);
let pendingOpenPath: string | null = openArgument && !isDirectory(openArgument)
  ? openArgument
  : markdownArgument(launchArguments);

const evidenceDirectory = path.resolve(
  process.env.NTO_EVIDENCE_DIR ?? path.join(app.getPath('userData'), 'evidence'),
);
const logger = createLogger(evidenceDirectory);
const rendererConsole: RendererConsoleState = { errors: 0, warnings: 0 };
let editorWindow: BrowserWindow | null = null;
let session: WorkspaceSession | null = null;

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  // A folder dropped on the dock icon opens as the workspace, not as a file.
  if (isDirectory(filePath)) {
    if (session) void session.openFolderPath(filePath).catch(() => logger.log('workspace_open_folder_failed', {}));
    else pendingOpenFolder = filePath;
    return;
  }
  if (session) void session.openPath(filePath).catch((error) => logger.log('workspace_open_file_failed', {
    code: error instanceof Error ? error.message.split(':', 1)[0] : 'OPEN_FAILED',
  }));
  else pendingOpenPath = filePath;
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const folder = folderArgument(argv.slice(1));
    if (folder && session) {
      void session.openFolderPath(folder).catch(() => logger.log('workspace_open_folder_failed', {}));
    }
    const candidate = markdownArgument(argv);
    if (candidate && session) {
      void session.openPath(candidate).catch((error) => logger.log('workspace_open_file_failed', {
        code: error instanceof Error ? error.message.split(':', 1)[0] : 'OPEN_FAILED',
      }));
    }
    if (editorWindow && !headless()) {
      if (editorWindow.isMinimized()) editorWindow.restore();
      editorWindow.focus();
    }
  });
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

/**
 * Whether a window should come up above the others.
 *
 * Held here rather than read from the store, because a window is rebuilt on
 * `activate` after every window has been closed, which happens outside the
 * scope the store lives in. Losing the setting at that moment would be losing
 * it exactly when the reader notices.
 */
let windowAlwaysOnTop = false;

function createApplicationWindow(preloadPath: string, theme: NotoTheme = 'system'): BrowserWindow {
  editorWindow = createEditorWindow(preloadPath, logger, rendererConsole, {
    theme,
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
  });
  if (windowAlwaysOnTop) editorWindow.setAlwaysOnTop(true);
  editorWindow.on('closed', () => { editorWindow = null; });
  return editorWindow;
}

function syncWindowChromeTheme(theme: NotoTheme): void {
  const window = editorWindow;
  if (!window || window.isDestroyed()) return;
  syncEditorTitleBarOverlay(
    process.platform,
    (options) => window.setTitleBarOverlay(options),
    theme,
    nativeTheme,
  );
  /* Match the frame fill to the title bar so a resize flash is not a white strip. */
  const tone = resolveEditorChromeTone(theme, nativeTheme.shouldUseDarkColors);
  window.setBackgroundColor(EDITOR_CHROME_COLORS[tone].background);
}

async function run(): Promise<void> {
  await app.whenReady();
  app.setAppUserModelId('dev.lr00rl.noto');
  const rendererRoot = path.join(__dirname, '..', 'renderer', 'main_window');
  await installNotoProtocol(rendererRoot, logger, { roots: () => session?.imageRoots() ?? [] });

  const serviceModulePath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', '.vite', 'build', 'fs-service.js')
    : path.join(__dirname, 'fs-service.js');
  const broker = new CapabilityBroker();
  const serviceHost = new ServiceHost(serviceModulePath, null, broker, logger);
  const experimentalRuntimeRoot = path.join(__dirname, '..', 'renderer', 'plugin_runtime');
  const experimentalRuntimeHost = new ExperimentalPluginRuntimeHost({
    pluginPreloadPath: path.join(__dirname, 'plugin-preload.js'),
    runtimeHtmlBytes: await readFile(path.join(experimentalRuntimeRoot, 'index.html')),
    bootstrapModuleBytes: await readFile(path.join(experimentalRuntimeRoot, 'bootstrap.js')),
    diagnostic: (event, details) => logger.log(`experimental_plugin_${event}`, details),
  }, () => {
    const window = editorWindow;
    return window && !window.webContents.isDestroyed() ? window.webContents.getOSProcessId() : null;
  });

  const pluginResourceRoot = bundledPluginResourceRoot({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
  let pluginCatalog: PluginCatalog;
  let pluginDiscoveryFailure: string | undefined;
  try {
    pluginCatalog = await discoverBundledPluginCatalog(pluginResourceRoot);
  } catch (error) {
    pluginCatalog = bundledPluginCatalog;
    pluginDiscoveryFailure = error instanceof Error ? error.message.split(':', 1)[0] : 'PLUGIN_DISCOVERY_UNAVAILABLE';
    logger.log('plugin_manifest_discovery_failed_visible', { code: pluginDiscoveryFailure });
  }
  const pluginStateStore = new LocalPluginStateStore(
    path.join(app.getPath('userData'), 'plugins', 'local-state.json'),
    pluginCatalog,
  );
  const rendererLeaseBridge = new RendererLeaseBridge({
    dispatch: (request) => {
      const window = editorWindow;
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
        throw new Error('PLUGIN_RENDERER_DISPOSED');
      }
      if (!isAllowedRendererUrl(window.webContents.mainFrame.url)) {
        throw new Error('PLUGIN_RENDERER_NAVIGATED');
      }
      window.webContents.send(IPC_CHANNELS.pluginRendererRequest, request);
    },
    diagnostic: (code) => logger.log('plugin_renderer_transport_failed', { code }),
  });
  let pluginRegistry!: PluginRegistry;
  pluginRegistry = new PluginRegistry({
    catalog: pluginCatalog,
    initialDiscoveryFailure: pluginDiscoveryFailure,
    stateStore: pluginStateStore,
    rendererHost: rendererLeaseBridge,
    serviceHost,
    publish: () => {
      const window = editorWindow;
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
      if (!isAllowedRendererUrl(window.webContents.mainFrame.url)) return;
      try {
        window.webContents.send(IPC_CHANNELS.pluginSnapshots, {
          version: PLUGIN_LIFECYCLE_VERSION,
          snapshots: pluginRegistry.getSnapshots(),
        });
      } catch {
        logger.log('plugin_snapshot_publish_failed', { code: 'PLUGIN_RENDERER_DISPOSED' });
      }
    },
  });
  try {
    await pluginRegistry.hydrate();
  } catch (error) {
    logger.log('plugin_state_hydration_failed_visible', {
      code: error instanceof Error ? error.message.split(':', 1)[0] : 'PLUGIN_FAILED',
    });
  }

  const userData = app.getPath('userData');
  // One store per open document, created on demand. Each owns its own accepted
  // revision and recovery journal, which is what keeps tabs from sharing save
  // state.
  const createStore = () => new FileTruthStoreV1(userData, logger);

  const recent = new RecentFiles(path.join(userData, 'recent-files.json'));
  await recent.load();
  // The same store, a second time: a recent folder is a path with a name and a
  // timestamp, exactly like a recent document, so it does not need its own class.
  const recentFolders = new RecentFiles(path.join(userData, 'recent-folders.json'));
  await recentFolders.load();
  const settings = new SettingsStore(path.join(userData, 'settings.json'));
  await settings.load();
  session = new WorkspaceSession(
    createStore, recent, () => editorWindow, logger, recentFolders,
    () => settings.current().treeSort,
    () => settings.current().codeViewer,
  );
  app.once('before-quit', () => session?.closeAll());

  /*
   * The two ticks in the View menu.
   *
   * Read-only lives here rather than in settings because it is a property of
   * this window right now, not a preference: a reader turns it on to consult a
   * note and expects a fresh window to be writable.
   */
  windowAlwaysOnTop = settings.current().alwaysOnTop;
  /*
   * The line endings shown as ticked.
   *
   * Read from the document in front, because that is where the truth is, with
   * an override for the moment between the reader choosing an ending and the
   * save that writes it: until then the file still has the old one and the menu
   * would keep saying so. Cleared when a different document comes forward.
   */
  const chosen: { lineEnding?: 'lf' | 'crlf'; finalNewline?: boolean } = {};
  let shownDocument: string | null = null;
  const documentShape = () => {
    const current = session?.current ?? null;
    if (current?.document.documentId !== shownDocument) {
      shownDocument = current?.document.documentId ?? null;
      chosen.lineEnding = undefined;
      chosen.finalNewline = undefined;
    }
    const own = current?.document.envelope;
    return {
      // A file with no newline at all in it has no ending of its own, so the
      // menu shows the one a new file would be written with.
      lineEnding: chosen.lineEnding ?? (own?.lineEnding === 'crlf' ? 'crlf' : 'lf'),
      finalNewline: chosen.finalNewline ?? own?.hasFinalNewline ?? true,
    } as const;
  };
  /*
   * The themes folder, beside the settings file.
   *
   * A folder rather than a preference holding one path, because a reader with
   * three themes wants to try them, and a menu of what is there is the whole
   * of Typora's interaction with them. Picking one writes the same
   * `customCssPath` a hand-typed path writes, so there is one way a stylesheet
   * reaches the window.
   */
  const themeFolder = await ensureThemeFolder(path.join(userData, 'themes'));
  let themes = await listThemes(themeFolder);
  const menuState = {
    readOnly: false,
    alwaysOnTop: windowAlwaysOnTop,
    treeSort: settings.current().treeSort,
    themes,
    themePath: settings.current().customCssPath,
  };
  if (windowAlwaysOnTop) editorWindow?.setAlwaysOnTop(true);
  const refreshMenu = () => installApplicationMenu(() => editorWindow, recent.list(), {
    openDialog: () => { void session?.openWithDialog().then(refreshMenu).catch(reportOpenFailure); },
    openPath: (filePath) => { void session?.openPath(filePath).then(refreshMenu).catch(reportOpenFailure); },
    openFolder: () => { void session?.openFolderWithDialog().catch(reportOpenFailure); },
    pastePlain: () => sendPasteText(editorWindow),
    print: () => {
      editorWindow?.webContents.print({ printBackground: true }, (ok, reason) => {
        logger.log('print', { ok, reason: reason || undefined });
      });
    },
    importDocument: () => {
      void session?.importDocument().then((outcome) => {
        refreshMenu();
        if (!outcome.imported && outcome.reason !== 'cancelled') reportImportRefusal(outcome.reason);
      }).catch(() => reportImportRefusal('failed'));
    },
    closeTab: () => {
      const current = session?.currentPath;
      if (current) session?.close(current);
    },
    reopenClosed: () => {
      void session?.reopenClosed().then(() => refreshMenu()).catch(reportOpenFailure);
    },
    chooseTheme: (themePath: string) => {
      void settings.update({ customCssPath: themePath }).then((written: NotoSettingsV1) => {
        menuState.themePath = written.customCssPath;
        refreshMenu();
        editorWindow?.webContents.send(SETTINGS_CHANNELS.changed, {
          version: NOTO_SETTINGS_VERSION, settings: written,
        });
      }).catch(() => logger.log('settings_theme_write_failed', {}));
    },
    openThemeFolder: () => {
      // Listed again on the way out, so a stylesheet dropped in while the
      // folder is open is on the menu the next time it is pulled down.
      void shell.openPath(themeFolder).then(async () => {
        themes = await listThemes(themeFolder);
        menuState.themes = themes;
        refreshMenu();
      }).catch(() => logger.log('settings_theme_folder_failed', {}));
    },
    clearRecent: () => {
      void Promise.all(recent.list().map((file) => recent.forget(file.path))).then(refreshMenu);
    },
  }, { ...menuState, ...documentShape() }, (command) => {
    // The renderer owns whether the editor is read-only, and this menu shows a
    // tick for it. Both flip on the same press, from the same starting point,
    // so the tick and the editor agree without a second message to keep them
    // in step.
    if (command === 'line-endings-lf' || command === 'line-endings-crlf') {
      chosen.lineEnding = command === 'line-endings-lf' ? 'lf' : 'crlf';
      refreshMenu();
      return;
    }
    if (command === 'toggle-final-newline') {
      chosen.finalNewline = !documentShape().finalNewline;
      refreshMenu();
      return;
    }
    if (command !== 'toggle-read-only') return;
    menuState.readOnly = !menuState.readOnly;
    refreshMenu();
  });
  /*
   * Say why an import did nothing, in a box rather than in the log.
   *
   * The one that matters is pandoc being absent: the reader has asked for a
   * conversion this app cannot do on its own, and the useful answer names the
   * program and how to get it rather than reporting a failure they cannot act
   * on. It is a message box because main owns the whole operation and there is
   * nothing in the page to attach a message to.
   */
  const reportImportRefusal = (reason: string) => {
    const window = editorWindow;
    const message = reason === 'no-pandoc'
      ? 'Importing needs Pandoc, which is not installed.'
      : reason === 'no-folder'
        ? 'Open a folder first, and the imported note goes in it.'
        : reason === 'unsupported'
          ? 'Noto cannot import that kind of file.'
          : 'That document could not be converted.';
    const detail = reason === 'no-pandoc'
      ? 'Install it with "brew install pandoc", then try again. Noto does not ship Pandoc: it is a large program with its own releases, and one you may already have.'
      : undefined;
    logger.log('document_import_reported', { reason });
    if (!window) return;
    void dialog.showMessageBox(window, { type: 'info', message, detail, buttons: ['OK'] });
  };

  const reportOpenFailure = (error: unknown) => logger.log('workspace_open_failed', {
    code: error instanceof Error ? error.message.split(':', 1)[0] : 'OPEN_FAILED',
  });
  refreshMenu();

  registerIpcHandlers({
    getWindow: () => editorWindow,
    logger,
    rendererConsole,
    pluginRegistry,
    rendererLeaseBridge,
    serviceHost,
  });
  registerFileTruthHandlers({
    session,
    getWindow: () => editorWindow,
    logger,
  });
  registerAssetHandlers({
    session,
    settings: () => settings.current(),
    getWindow: () => editorWindow,
    logger,
  });
  /*
   * The remote control: off until the setting says otherwise.
   *
   * Built in rather than a plugin because what it does is drive the
   * workspace, which is exactly what a plugin is kept away from. It listens
   * on the loopback interface, takes a token from a file only this account
   * can read, and the window says while it is on.
   */
  // What the renderer last said about unsaved changes, which is the only
  // side that knows and the one thing a remote reader needs told.
  let documentDirty = false;
  ipcMain.on(WORKSPACE_CHANNELS.dirtyChanged, (event, value: unknown) => {
    if (!isTrustedRendererSender(editorWindow, event) || !isWorkspaceDirtyEventV1(value)) return;
    documentDirty = value.dirty;
  });

  /**
   * Ask the window for the note as the editor holds it.
   *
   * Answered on its own channel with the id it was asked with, so two
   * questions in flight cannot be confused for one another, and given up on
   * after a moment: a window busy enough not to answer is one whose file on
   * disk is the better answer anyway.
   */
  const askWindowForText = (): Promise<string | null> => {
    const window = editorWindow;
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return Promise.resolve(null);
    const requestId = `text:${randomUUID()}`;
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => { ipcMain.removeListener(WORKSPACE_CHANNELS.documentTextReply, listener); resolve(null); }, 700);
      const listener = (event: Electron.IpcMainEvent, value: unknown) => {
        if (!isTrustedRendererSender(editorWindow, event) || !isWorkspaceTextReplyV1(value)) return;
        if (value.requestId !== requestId) return;
        clearTimeout(timer);
        ipcMain.removeListener(WORKSPACE_CHANNELS.documentTextReply, listener);
        resolve(value.markdown);
      };
      ipcMain.on(WORKSPACE_CHANNELS.documentTextReply, listener);
      window.webContents.send(WORKSPACE_CHANNELS.documentText, {
        version: NOTO_WORKSPACE_VERSION, requestId,
      });
    });
  };

  const tokens = new TokenStore(path.join(userData, 'remote-token'));
  let remote: RunningRemote | null = null;
  let remoteProblem = '';

  const remoteStatus = async (): Promise<RemoteStatusReplyV1> => ({
    version: NOTO_SETTINGS_VERSION,
    listening: remote !== null,
    port: remote?.port ?? null,
    token: settings.current().remoteControl ? await tokens.current() : '',
    problem: remoteProblem,
  });

  /*
   * Where it is listening, written beside the token.
   *
   * A caller has to find the port somehow, and reading it out of a
   * preferences pane by eye is not something a script can do. The file says
   * the port and the process it belongs to, is readable by this account
   * alone like the token, and is removed the moment it stops listening so a
   * stale one never points somewhere nothing is.
   */
  const addressFile = path.join(userData, 'remote.json');
  const writeAddress = async (port: number | null): Promise<void> => {
    try {
      if (port === null) await rm(addressFile, { force: true });
      else {
        await writeFile(
          addressFile,
          `${JSON.stringify({ version: 1, port, pid: process.pid }, null, 2)}\n`,
          { encoding: 'utf8', mode: 0o600 },
        );
      }
    } catch {
      // A file that cannot be written is not worth failing to listen over.
    }
  };

  const applyRemote = async (wanted: boolean): Promise<void> => {
    if (!wanted) {
      remoteProblem = '';
      const running = remote;
      remote = null;
      await running?.stop();
      await writeAddress(null);
      editorWindow?.webContents.send(WORKSPACE_CHANNELS.remoteChanged, {
        version: NOTO_WORKSPACE_VERSION, listening: false, port: null,
      });
      return;
    }
    if (remote) return;
    try {
      remote = await startRemoteServer({
        deps: {
          token: await tokens.current(),
          status: () => ({
            version: app.getVersion(),
            vault: session?.folder ?? null,
            note: session?.currentPath ?? null,
            dirty: documentDirty,
          }),
          readCurrent: async () => {
            const target = session?.currentPath ?? null;
            if (target === null) return null;
            // The editor's own copy first, since that is the one with the
            // unsaved changes in it; the file is the answer when there is no
            // window to ask, or it does not answer in time.
            const live = await askWindowForText();
            if (live !== null) {
              return { path: target, markdown: live, source: 'editor' as const, dirty: documentDirty };
            }
            return {
              path: target,
              markdown: await readFile(target, 'utf8'),
              source: 'disk' as const,
              dirty: documentDirty,
            };
          },
          open: async (target) => {
            // Relative to the open folder, or absolute — but only inside it.
            // openPath itself does not confine (File > Open may leave the
            // folder); the remote path is the one that must not.
            const root = session?.folder ?? null;
            const resolved = await confineRemoteOpenPath(root, target, { realpath });
            if (resolved === null) {
              return {
                opened: false,
                code: 'outside-folder',
                reason: 'That is not in this folder.',
              };
            }
            try {
              await session?.openPath(resolved);
              refreshMenu();
              return { opened: true };
            } catch (error) {
              const code = error instanceof Error ? error.message.split(':', 1)[0] : 'OPEN_FAILED';
              return {
                opened: false,
                code: code === 'ENOENT' ? 'no-such-note'
                  : code.includes('OUTSIDE') ? 'outside-folder'
                    : 'open-failed',
                reason: code === 'ENOENT'
                  ? 'There is no note at that path.'
                  : 'That note could not be opened.',
              };
            }
          },
          insert: (text, at) => {
            const window = editorWindow;
            if (!window || window.isDestroyed()) return { inserted: false, reason: 'No window is open.' };
            window.webContents.send(WORKSPACE_CHANNELS.pasteText, {
              version: NOTO_WORKSPACE_VERSION, text, at,
            });
            return { inserted: true };
          },
          search: async (query, flags) => {
            const found = await session?.searchContent(query, flags, '');
            return {
              matches: (found?.matches ?? []).map((match) => ({
                path: match.path,
                relativePath: match.relativePath,
                occurrences: match.occurrences,
                lines: match.lines,
              })),
              truncated: found?.truncated ?? false,
              timedOut: found?.timedOut ?? false,
              invalidPattern: found?.invalidPattern ?? false,
            };
          },
          run: (command) => {
            const window = editorWindow;
            if (!window || window.isDestroyed()) return { ran: false, reason: 'No window is open.' };
            window.webContents.send(WORKSPACE_CHANNELS.menuCommand, {
              version: NOTO_WORKSPACE_VERSION, command,
            });
            return { ran: true };
          },
        },
        log: (event, detail) => logger.log(event, detail),
      });
      remoteProblem = '';
      await writeAddress(remote.port);
    } catch (error) {
      remote = null;
      await writeAddress(null);
      remoteProblem = error instanceof Error && 'code' in error && error.code === 'EADDRINUSE'
        ? 'Something else is already listening on that port.'
        : 'The remote control could not start.';
      logger.log('remote_failed', { problem: remoteProblem });
    }
    editorWindow?.webContents.send(WORKSPACE_CHANNELS.remoteChanged, {
      version: NOTO_WORKSPACE_VERSION,
      listening: remote !== null,
      port: remote?.port ?? null,
    });
  };

  if (settings.current().remoteControl) await applyRemote(true);
  app.once('before-quit', () => { void applyRemote(false); });

  registerSettingsHandlers({
    settings,
    getWindow: () => editorWindow,
    logger,
    remote: {
      status: remoteStatus,
      regenerate: async () => {
        await tokens.regenerate();
        // The socket holds the token it started with, so it is restarted.
        if (remote) { await applyRemote(false); await applyRemote(true); }
        return remoteStatus();
      },
    },
    onChanged: (reply) => {
      logger.log('settings_changed', { theme: reply.settings.theme });
      syncWindowChromeTheme(reply.settings.theme);
      // The window has to be told, and the menu's tick has to follow, or the
      // preference and what the window is doing drift apart.
      if (!reply.settings.codeViewer) session?.clearCodeView();
      if (reply.settings.alwaysOnTop !== menuState.alwaysOnTop) {
        menuState.alwaysOnTop = reply.settings.alwaysOnTop;
        windowAlwaysOnTop = reply.settings.alwaysOnTop;
        editorWindow?.setAlwaysOnTop(reply.settings.alwaysOnTop);
        refreshMenu();
      }
      // The tree's order shows as a tick in the View menu, and the tree
      // itself is listed again when it changes.
      if (reply.settings.remoteControl !== (remote !== null)) void applyRemote(reply.settings.remoteControl);
      if (reply.settings.customCssPath !== menuState.themePath) {
        menuState.themePath = reply.settings.customCssPath;
        refreshMenu();
      }
      if (reply.settings.treeSort !== menuState.treeSort) {
        menuState.treeSort = reply.settings.treeSort;
        refreshMenu();
        // The listing is made in main, so the tree has to ask for it again.
        // The same event a file action sends, since the answer is the same:
        // what you have is stale.
        session?.announceTreeChanged();
      }
    },
  });
  registerWorkspaceHandlers({
    session,
    recent,
    getWindow: () => editorWindow,
    logger,
    onMenuStale: refreshMenu,
    recentFolders: async () => { await recentFolders.load(); return recentFolders.list(); },
  });

  const preloadPath = path.join(__dirname, 'preload.js');
  const window = createApplicationWindow(preloadPath, settings.current().theme);
  nativeTheme.on('updated', () => {
    if (settings.current().theme === 'system') syncWindowChromeTheme('system');
  });
  const disposeRendererAuthority = () => {
    const leases = rendererLeaseBridge.activeLeases();
    rendererLeaseBridge.rendererDisposed();
    for (const lease of leases) {
      void pluginRegistry.rendererDisposed(lease.pluginId, lease.leaseId, lease.generation)
        .catch((error) => logger.log('plugin_renderer_disposal_failed', {
          code: error instanceof Error ? error.message.split(':', 1)[0] : 'PLUGIN_FAILED',
        }));
    }
  };
  window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) disposeRendererAuthority();
  });
  window.webContents.once('destroyed', disposeRendererAuthority);

  // A folder or a document named on the command line opens once the renderer
  // can receive it. The folder first, so a document inside it opens with its
  // tree already showing.
  if (pendingOpenFolder || pendingOpenPath) {
    const folder = pendingOpenFolder;
    const target = pendingOpenPath;
    pendingOpenFolder = null;
    pendingOpenPath = null;
    window.webContents.once('did-finish-load', () => {
      if (folder) void session?.openFolderPath(folder).catch(() => logger.log('workspace_open_folder_failed', {}));
      if (target) void session?.openPath(target).then(refreshMenu).catch(reportOpenFailure);
    });
  } else {
    /*
     * Nothing named, so the folder from last time comes back.
     *
     * Launching from the dock gave an empty window and an invitation to open a
     * folder, to somebody who has opened the same one every day. The folder
     * only: which note was in front is not restored, because reopening a
     * document is a change to it as far as the recovery journal is concerned
     * and starting a session by touching a file nobody asked for is not worth
     * the convenience.
     *
     * Not marked as chosen, because the reader is not choosing it now. That
     * leaves the rail obeying its own setting instead of springing open.
     */
    window.webContents.once('did-finish-load', () => {
      /*
       * Loaded again here rather than trusted from startup. The window can
       * finish loading before the read of the recent folders that startup
       * began has come back, and then the list is empty and there is nothing
       * to restore. The renderer catches a folder that arrives after it has
       * mounted: it attaches its listener before it asks.
       */
      void (async () => {
        await recentFolders.load();
        const [last] = recentFolders.list();
        if (!last) return;
        await session?.openFolderPath(last.path, false)
          .catch(() => logger.log('workspace_restore_folder_failed', {}));
      })();
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const restored = createApplicationWindow(preloadPath, settings.current().theme);
      restored.webContents.once('did-finish-load', () => session?.republish());
    }
  });

  let shutdownStarted = false;
  app.on('before-quit', (event) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    event.preventDefault();
    void pluginRegistry.shutdown()
      .catch((error) => logger.log('plugin_shutdown_failed', {
        code: error instanceof Error ? error.message.split(':', 1)[0] : 'PLUGIN_FAILED',
      }))
      .then(() => experimentalRuntimeHost.shutdown().catch((error) => logger.log('experimental_runtime_shutdown_failed', {
        code: error instanceof Error ? error.message.split(':', 1)[0] : 'EXPERIMENTAL_RUNTIME_FAILED',
      })))
      .then(() => serviceHost.stop().catch((error) => logger.log('service_stop_failed', {
        code: error instanceof Error ? error.message.split(':', 1)[0] : 'SERVICE_FAILED',
      })))
      .finally(() => {
        rendererLeaseBridge.rendererDisposed();
        app.quit();
      });
  });
}

void run().catch((error) => {
  logger.log('application_start_failed', {
    code: error instanceof Error ? error.message.split(':', 1)[0] : 'BOOTSTRAP_FAILED',
  });
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());

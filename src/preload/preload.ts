import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  ASSET_CHANNELS,
  type AssetRequestV1,
  type AssetResultV1,
  type AssetTestUploadReplyV1,
  type AssetWriteReplyV1,
  type AssetWriteRequestV1,
  type NotoAssetsApiV1,
} from '../shared/assets/v1/contracts';
import {
  isAssetRequestV1,
  isAssetResultV1,
  isAssetTestUploadResultV1,
  isAssetWriteRequestV1,
} from '../shared/assets/v1/validate';
import type {
  DiagnosticsReply,
  DiagnosticsRequest,
  NotoPluginsApi,
  NotoDesktopApi,
  Result,
  ServiceOperationReply,
  ServiceRequest,
} from '../shared/ipc/contracts';
import { IPC_CHANNELS } from '../shared/ipc/contracts';
import {
  SETTINGS_CHANNELS,
  type NotoSettingsApiV1,
  type SettingsReplyV1,
  type SettingsRequestV1,
  type SettingsResultV1,
  type SettingsWriteRequestV1,
  type RemoteStatusReplyV1,
} from '../shared/settings/v1/contracts';
import {
  isSettingsReplyV1,
  isSettingsRequestV1,
  isSettingsResultV1,
  isThemeCssResultV1,
  isSystemFontsResultV1,
  isSettingsWriteRequestV1,
  isRemoteStatusResultV1,
} from '../shared/settings/v1/validate';
import type {
  FileTruthBootstrapReplyV1,
  FileTruthRequestV1,
  FileTruthResultV1,
  FileTruthDiagnosticsV1,
  FileTruthOpenReplyV1,
  FileTruthSaveOutcomeV1,
  FileTruthSaveCopyRequestV1,
  FileTruthSaveRequestV1,
  FileTruthExternalChangeEventV1,
  FileTruthReloadOutcomeV1,
  FileTruthReloadRequestV1,
  NotoFileTruthApiV1,
} from '../shared/file-truth/v1/contracts';
import { FILE_TRUTH_CHANNELS } from '../shared/file-truth/v1/contracts';
import {
  isDiagnosticsRequest,
  isDiagnosticsResult,
  isPluginLifecycleRequest,
  isPluginLifecycleResult,
  isPluginSnapshotEvent,
  isServiceRequest,
  isServiceResult,
  isRendererTransportAck,
  isRendererTransportRequest,
  isRendererReadyMessage,
} from '../shared/ipc/validate';
import type {
  PluginLifecycleAction,
  PluginLifecycleReply,
  PluginLifecycleRequest,
  RendererReadyMessage,
  RendererTransportAck,
} from '../shared/plugins/lifecycle';
import {
  isFileTruthBootstrapResultV1,
  isFileTruthDiagnosticsResultV1,
  isFileTruthExternalChangeEventV1,
  isFileTruthOpenResultV1,
  isFileTruthReloadRequestV1,
  isFileTruthReloadResultV1,
  isFileTruthRequestV1,
  isFileTruthSaveCopyRequestV1,
  isFileTruthSaveRequestV1,
  isFileTruthSaveResultV1,
} from '../shared/file-truth/v1/validate';
import type {
  NotoWorkspaceApiV1,
  WorkspaceDocumentEventV1,
  WorkspaceCodeViewEventV1,
  WorkspaceMenuEventV1,
  WorkspacePasteEventV1,
  WorkspaceRemoteEventV1,
  WorkspaceDirtyEventV1,
  WorkspaceTextRequestV1,
  WorkspaceTextReplyV1,
  WorkspaceLinksReplyV1,
  WorkspaceOpenPathRequestV1,
  WorkspaceTabRequestV1,
  WorkspaceTabsEventV1,
  WorkspaceClosedEventV1,
  WorkspaceFolderRequestV1,
  WorkspaceFolderEventV1,
  WorkspaceFolderReplyV1,
  WorkspaceOpenReplyV1,
  WorkspaceRecentReplyV1,
  WorkspaceRequestV1,
  WorkspaceResultV1,
  WorkspaceIndexReplyV1,
  WorkspaceContentReplyV1,
  WorkspaceTagIndexReplyV1,
  WorkspaceNotesByTagReplyV1,
  WorkspaceNotesByTagRequestV1,
  WorkspaceContentRequestV1,
  WorkspaceEntryReplyV1,
  WorkspaceEntryRequestV1,
  WorkspaceExportReplyV1,
  WorkspaceExportRequestV1,
  WorkspaceRenameRowEventV1,
  WorkspaceRevealReplyV1,
  WorkspaceNewFileReplyV1,
  WorkspaceTreeMenuReplyV1,
  WorkspaceTreeMenuRequestV1,
  WorkspaceOpenExternalReplyV1,
  WorkspaceOpenExternalRequestV1,
  WorkspaceRevealRequestV1,
  WorkspaceSaveAsReplyV1,
} from '../shared/workspace/v1/contracts';
import { NOTO_WORKSPACE_VERSION, WORKSPACE_CHANNELS } from '../shared/workspace/v1/contracts';
import {
  isWorkspaceDocumentEventV1,
  isWorkspaceCodeViewEventV1,
  isWorkspaceMenuEventV1,
  isWorkspacePasteEventV1,
  isWorkspaceRemoteEventV1,
  isWorkspaceDirtyEventV1,
  isWorkspaceTextRequestV1,
  isWorkspaceTextReplyV1,
  isWorkspaceLinksResultV1,
  isWorkspaceOpenPathRequestV1,
  isWorkspaceTabRequestV1,
  isWorkspaceTabsEventV1,
  isWorkspaceTabsResultV1,
  isWorkspaceClosedEventV1,
  isWorkspaceFolderRequestV1,
  isWorkspaceFolderEventV1,
  isWorkspaceFolderResultV1,
  isWorkspaceListResultV1,
  isWorkspaceOpenResultV1,
  isWorkspaceRecentResultV1,
  isWorkspaceRequestV1,
  isWorkspaceIndexResultV1,
  isWorkspaceContentRequestV1,
  isWorkspaceEntryRequestV1,
  isWorkspaceEntryResultV1,
  isWorkspaceExportRequestV1,
  isWorkspaceExportResultV1,
  isWorkspaceRenameRowEventV1,
  isWorkspaceContentResultV1,
  isWorkspaceTagIndexResultV1,
  isWorkspaceNotesByTagRequestV1,
  isWorkspaceNotesByTagResultV1,
  isWorkspaceNewFileResultV1,
  isWorkspaceTreeMenuRequestV1,
  isWorkspaceTreeMenuResultV1,
  isWorkspaceOpenExternalRequestV1,
  isWorkspaceOpenExternalResultV1,
  isWorkspaceRevealRequestV1,
  isWorkspaceRevealResultV1,
  isWorkspaceSaveAsResultV1,
} from '../shared/workspace/v1/validate';

function rejected<T>(requestId: string, message: string): Result<T> {
  return { ok: false, requestId, error: { code: 'BAD_REQUEST', message } };
}

async function invoke<T>(
  channel: string,
  request: unknown,
  requestId: string,
  validate: (value: unknown, expectedRequestId: string) => value is Result<T>,
): Promise<Result<T>> {
  const value: unknown = await ipcRenderer.invoke(channel, request);
  if (!validate(value, requestId)) {
    return rejected(requestId, 'Main returned an invalid protocol response');
  }
  return value;
}

async function invokePlugin(
  request: PluginLifecycleRequest,
): Promise<Result<PluginLifecycleReply>> {
  if (!isPluginLifecycleRequest(request)) {
    return rejected('invalid', 'Invalid plugin lifecycle request');
  }
  const value: unknown = await ipcRenderer.invoke(IPC_CHANNELS.pluginLifecycle, request);
  return isPluginLifecycleResult(value, request.requestId, request.action)
    ? value
    : rejected(request.requestId, 'Main returned an invalid plugin lifecycle response');
}

const lifecycleRequest = <TAction extends PluginLifecycleAction>(
  action: TAction,
  request: object,
): PluginLifecycleRequest => ({ ...request, action }) as PluginLifecycleRequest;

const pluginsApi: NotoPluginsApi = Object.freeze({
  getSnapshots: (request: Parameters<NotoPluginsApi['getSnapshots']>[0]) =>
    invokePlugin(lifecycleRequest('get-snapshots', request)),
  enable: (request: Parameters<NotoPluginsApi['enable']>[0]) =>
    invokePlugin(lifecycleRequest('enable', request)),
  disable: (request: Parameters<NotoPluginsApi['disable']>[0]) =>
    invokePlugin(lifecycleRequest('disable', request)),
  triggerStartup: (request: Parameters<NotoPluginsApi['triggerStartup']>[0]) =>
    invokePlugin(lifecycleRequest('trigger-startup', request)),
  triggerEvent: (request: Parameters<NotoPluginsApi['triggerEvent']>[0]) =>
    invokePlugin(lifecycleRequest('trigger-event', request)),
  triggerHotkey: (request: Parameters<NotoPluginsApi['triggerHotkey']>[0]) =>
    invokePlugin(lifecycleRequest('trigger-hotkey', request)),
  executeCommand: (request: Parameters<NotoPluginsApi['executeCommand']>[0]) =>
    invokePlugin(lifecycleRequest('execute-command', request)),
  setSetting: (request: Parameters<NotoPluginsApi['setSetting']>[0]) =>
    invokePlugin(lifecycleRequest('set-setting', request)),
  replaceGeneration: (request: Parameters<NotoPluginsApi['replaceGeneration']>[0]) =>
    invokePlugin(lifecycleRequest('replace-generation', request)),
  rendererDisposed: (request: Parameters<NotoPluginsApi['rendererDisposed']>[0]) =>
    invokePlugin(lifecycleRequest('renderer-disposed', request)),
  onSnapshots: (listener: Parameters<NotoPluginsApi['onSnapshots']>[0]) => {
    const receive = (_event: unknown, value: unknown) => {
      if (isPluginSnapshotEvent(value)) listener(value);
    };
    ipcRenderer.on(IPC_CHANNELS.pluginSnapshots, receive);
    return () => { ipcRenderer.removeListener(IPC_CHANNELS.pluginSnapshots, receive); };
  },
  onRendererRequest: (listener: Parameters<NotoPluginsApi['onRendererRequest']>[0]) => {
    const receive = (_event: unknown, value: unknown) => {
      if (isRendererTransportRequest(value)) listener(value);
    };
    ipcRenderer.on(IPC_CHANNELS.pluginRendererRequest, receive);
    return () => { ipcRenderer.removeListener(IPC_CHANNELS.pluginRendererRequest, receive); };
  },
  acknowledgeRenderer: (ack: RendererTransportAck) => {
    if (!isRendererTransportAck(ack)) return;
    ipcRenderer.send(IPC_CHANNELS.pluginRendererAck, ack);
  },
  rendererReady: (message: RendererReadyMessage) => {
    if (!isRendererReadyMessage(message)) return;
    ipcRenderer.send(IPC_CHANNELS.pluginRendererReady, message);
  },
});

const api: NotoDesktopApi = Object.freeze({
  requestService: (request: ServiceRequest): Promise<Result<ServiceOperationReply>> =>
    isServiceRequest(request)
      ? invoke(IPC_CHANNELS.service, request, request.requestId, isServiceResult)
      : Promise.resolve(rejected('invalid', 'Invalid service request')),
  diagnostics: (request: DiagnosticsRequest): Promise<Result<DiagnosticsReply>> =>
    isDiagnosticsRequest(request)
      ? invoke(IPC_CHANNELS.diagnostics, request, request.requestId, isDiagnosticsResult)
      : Promise.resolve(rejected('invalid', 'Invalid diagnostics request')),
  plugins: pluginsApi,
});

contextBridge.exposeInMainWorld('notoDesktop', api);

function rejectedFileTruth<T>(requestId: string, message: string): FileTruthResultV1<T> {
  return { ok: false, requestId, error: { code: 'BAD_REQUEST', message } };
}

async function invokeFileTruth<T>(channel: string, request: unknown, requestId: string,
  validate: (value: unknown, expectedRequestId: string) => value is FileTruthResultV1<T>): Promise<FileTruthResultV1<T>> {
  const value: unknown = await ipcRenderer.invoke(channel, request);
  return validate(value, requestId) ? value : rejectedFileTruth(requestId, 'Main returned an invalid file-truth v1 response');
}

const fileTruthApi: NotoFileTruthApiV1 = Object.freeze({
  bootstrap: (request: FileTruthRequestV1) => isFileTruthRequestV1(request)
    ? invokeFileTruth<FileTruthBootstrapReplyV1>(FILE_TRUTH_CHANNELS.bootstrap, request, request.requestId, isFileTruthBootstrapResultV1)
    : Promise.resolve(rejectedFileTruth<FileTruthBootstrapReplyV1>('invalid', 'Invalid file-truth bootstrap request')),
  open: (request: FileTruthRequestV1) => isFileTruthRequestV1(request)
    ? invokeFileTruth<FileTruthOpenReplyV1>(FILE_TRUTH_CHANNELS.open, request, request.requestId, isFileTruthOpenResultV1)
    : Promise.resolve(rejectedFileTruth<FileTruthOpenReplyV1>('invalid', 'Invalid file-truth open request')),
  save: (request: FileTruthSaveRequestV1) => isFileTruthSaveRequestV1(request)
    ? invokeFileTruth<FileTruthSaveOutcomeV1>(FILE_TRUTH_CHANNELS.save, request, request.requestId, isFileTruthSaveResultV1)
    : Promise.resolve(rejectedFileTruth<FileTruthSaveOutcomeV1>('invalid', 'Invalid file-truth save request')),
  saveCopy: (request: FileTruthSaveCopyRequestV1) => isFileTruthSaveCopyRequestV1(request)
    ? invokeFileTruth<FileTruthSaveOutcomeV1>(FILE_TRUTH_CHANNELS.saveCopy, request, request.requestId, isFileTruthSaveResultV1)
    : Promise.resolve(rejectedFileTruth<FileTruthSaveOutcomeV1>('invalid', 'Invalid file-truth save-copy request')),
  recover: (request: FileTruthRequestV1) => isFileTruthRequestV1(request)
    ? invokeFileTruth<FileTruthSaveOutcomeV1>(FILE_TRUTH_CHANNELS.recover, request, request.requestId, isFileTruthSaveResultV1)
    : Promise.resolve(rejectedFileTruth<FileTruthSaveOutcomeV1>('invalid', 'Invalid file-truth recovery request')),
  diagnostics: (request: FileTruthRequestV1) => isFileTruthRequestV1(request)
    ? invokeFileTruth<FileTruthDiagnosticsV1>(FILE_TRUTH_CHANNELS.diagnostics, request, request.requestId, isFileTruthDiagnosticsResultV1)
    : Promise.resolve(rejectedFileTruth<FileTruthDiagnosticsV1>('invalid', 'Invalid file-truth diagnostics request')),
  reload: (request: FileTruthReloadRequestV1) => isFileTruthReloadRequestV1(request)
    ? invokeFileTruth<FileTruthReloadOutcomeV1>(FILE_TRUTH_CHANNELS.reload, request, request.requestId, isFileTruthReloadResultV1)
    : Promise.resolve(rejectedFileTruth<FileTruthReloadOutcomeV1>('invalid', 'Invalid file-truth reload request')),
  onExternalChange: (listener: (event: FileTruthExternalChangeEventV1) => void) =>
    subscribe(FILE_TRUTH_CHANNELS.externalChange, isFileTruthExternalChangeEventV1, listener),
});

contextBridge.exposeInMainWorld('notoFileTruth', fileTruthApi);

function rejectedWorkspace<T>(requestId: string, message: string): WorkspaceResultV1<T> {
  return { ok: false, requestId, error: { code: 'BAD_REQUEST', message } };
}

async function invokeWorkspace<T>(channel: string, request: unknown, requestId: string,
  validate: (value: unknown, expectedRequestId: string) => value is WorkspaceResultV1<T>): Promise<WorkspaceResultV1<T>> {
  const value: unknown = await ipcRenderer.invoke(channel, request);
  return validate(value, requestId) ? value : rejectedWorkspace(requestId, 'Main returned an invalid workspace response');
}

/**
 * Push channels validate before invoking the listener, so a malformed message
 * from a compromised main process cannot reach renderer state.
 */
function subscribe<T>(channel: string, guard: (value: unknown) => value is T, listener: (event: T) => void): () => void {
  const handler = (_event: unknown, value: unknown) => {
    if (guard(value)) listener(value);
  };
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.removeListener(channel, handler); };
}

function rejectedSettings(requestId: string, message: string): SettingsResultV1<SettingsReplyV1> {
  return { ok: false, requestId, error: { code: 'BAD_REQUEST', message } };
}

/** The two remote-control questions, which answer with their own reply shape. */
async function askRemote(
  channel: string,
  request: SettingsRequestV1,
): Promise<SettingsResultV1<RemoteStatusReplyV1>> {
  const bad = (requestId: string, message: string): SettingsResultV1<RemoteStatusReplyV1> =>
    ({ ok: false, requestId, error: { code: 'BAD_REQUEST', message } });
  if (!isSettingsRequestV1(request)) return bad('invalid', 'Invalid remote control request');
  const value: unknown = await ipcRenderer.invoke(channel, request);
  return isRemoteStatusResultV1(value, request.requestId)
    ? value
    : bad(request.requestId, 'Main returned an invalid remote control response');
}

async function invokeSettings(channel: string, request: unknown, requestId: string): Promise<SettingsResultV1<SettingsReplyV1>> {
  const value: unknown = await ipcRenderer.invoke(channel, request);
  return isSettingsResultV1(value, requestId)
    ? value
    : rejectedSettings(requestId, 'Main returned an invalid settings response');
}

const workspaceApi: NotoWorkspaceApiV1 = Object.freeze({
  openDialog: (request: WorkspaceRequestV1) => isWorkspaceRequestV1(request)
    ? invokeWorkspace<WorkspaceOpenReplyV1>(WORKSPACE_CHANNELS.openDialog, request, request.requestId, isWorkspaceOpenResultV1)
    : Promise.resolve(rejectedWorkspace<WorkspaceOpenReplyV1>('invalid', 'Invalid workspace open request')),
  openPath: (request: WorkspaceOpenPathRequestV1) => isWorkspaceOpenPathRequestV1(request)
    ? invokeWorkspace<WorkspaceOpenReplyV1>(WORKSPACE_CHANNELS.openPath, request, request.requestId, isWorkspaceOpenResultV1)
    : Promise.resolve(rejectedWorkspace<WorkspaceOpenReplyV1>('invalid', 'Invalid workspace open-path request')),
  saveAsDialog: (request: WorkspaceRequestV1) => isWorkspaceRequestV1(request)
    ? invokeWorkspace<WorkspaceSaveAsReplyV1>(WORKSPACE_CHANNELS.saveAsDialog, request, request.requestId, isWorkspaceSaveAsResultV1)
    : Promise.resolve(rejectedWorkspace<WorkspaceSaveAsReplyV1>('invalid', 'Invalid workspace save-as request')),
  recent: (request: WorkspaceRequestV1) => isWorkspaceRequestV1(request)
    ? invokeWorkspace<WorkspaceRecentReplyV1>(WORKSPACE_CHANNELS.recent, request, request.requestId, isWorkspaceRecentResultV1)
    : Promise.resolve(rejectedWorkspace<WorkspaceRecentReplyV1>('invalid', 'Invalid workspace recent request')),
  activateTab: (request: WorkspaceTabRequestV1) => isWorkspaceTabRequestV1(request)
    ? invokeWorkspace<WorkspaceOpenReplyV1>(WORKSPACE_CHANNELS.activateTab, request, request.requestId, isWorkspaceOpenResultV1)
    : Promise.resolve(rejectedWorkspace<WorkspaceOpenReplyV1>('invalid', 'Invalid workspace activate-tab request')),
  closeTab: (request: WorkspaceTabRequestV1) => isWorkspaceTabRequestV1(request)
    ? invokeWorkspace<WorkspaceTabsEventV1>(WORKSPACE_CHANNELS.closeTab, request, request.requestId, isWorkspaceTabsResultV1)
    : Promise.resolve(rejectedWorkspace<WorkspaceTabsEventV1>('invalid', 'Invalid workspace close-tab request')),
  openFolder: (request: WorkspaceRequestV1) => isWorkspaceRequestV1(request)
    ? invokeWorkspace<WorkspaceFolderEventV1>(WORKSPACE_CHANNELS.openFolder, request, request.requestId, isWorkspaceFolderResultV1)
    : Promise.resolve(rejectedWorkspace<WorkspaceFolderEventV1>('invalid', 'Invalid workspace open-folder request')),
  listFolder: (request: WorkspaceFolderRequestV1) => isWorkspaceFolderRequestV1(request)
    ? invokeWorkspace<WorkspaceFolderReplyV1>(WORKSPACE_CHANNELS.listFolder, request, request.requestId, isWorkspaceListResultV1)
    : Promise.resolve(rejectedWorkspace<WorkspaceFolderReplyV1>('invalid', 'Invalid workspace list-folder request')),
  onFolderChanged: (listener: (event: WorkspaceFolderEventV1) => void) =>
    subscribe(WORKSPACE_CHANNELS.folderChanged, isWorkspaceFolderEventV1, listener),
  onDocumentOpened: (listener: (event: WorkspaceDocumentEventV1) => void) =>
    subscribe(WORKSPACE_CHANNELS.documentOpened, isWorkspaceDocumentEventV1, listener),
  onCodeViewChanged: (listener: (event: WorkspaceCodeViewEventV1) => void) =>
    subscribe(WORKSPACE_CHANNELS.codeViewChanged, isWorkspaceCodeViewEventV1, listener),
  onDocumentClosed: (listener: (event: WorkspaceClosedEventV1) => void) =>
    subscribe(WORKSPACE_CHANNELS.documentClosed, isWorkspaceClosedEventV1, listener),
  onTabsChanged: (listener: (event: WorkspaceTabsEventV1) => void) =>
    subscribe(WORKSPACE_CHANNELS.tabsChanged, isWorkspaceTabsEventV1, listener),
  recentFolders: (request: WorkspaceRequestV1) => isWorkspaceRequestV1(request)
    ? invokeWorkspace<WorkspaceRecentReplyV1>(WORKSPACE_CHANNELS.recentFolders, request, request.requestId, isWorkspaceRecentResultV1)
    : Promise.resolve(rejectedWorkspace<WorkspaceRecentReplyV1>('invalid', 'Invalid recent folders request')),
  openRecentFolder: (request: WorkspaceOpenPathRequestV1) => isWorkspaceOpenPathRequestV1(request)
    ? invokeWorkspace<WorkspaceFolderEventV1>(WORKSPACE_CHANNELS.openRecentFolder, request, request.requestId, isWorkspaceFolderResultV1)
    : Promise.resolve(rejectedWorkspace<WorkspaceFolderEventV1>('invalid', 'Invalid open recent folder request')),
  folder: (request: WorkspaceRequestV1) => isWorkspaceRequestV1(request)
    ? invokeWorkspace<WorkspaceFolderEventV1>(WORKSPACE_CHANNELS.folder, request, request.requestId, isWorkspaceFolderResultV1)
    : Promise.resolve(rejectedWorkspace<WorkspaceFolderEventV1>('invalid', 'Invalid folder request')),
  searchContent: (request: WorkspaceContentRequestV1) => isWorkspaceContentRequestV1(request)
    ? invokeWorkspace<WorkspaceContentReplyV1>(WORKSPACE_CHANNELS.searchContent, request, request.requestId, isWorkspaceContentResultV1)
    : Promise.resolve(rejectedWorkspace<WorkspaceContentReplyV1>('invalid', 'Invalid content search request')),
  reveal: (request: WorkspaceRevealRequestV1) => isWorkspaceRevealRequestV1(request)
    ? invokeWorkspace<WorkspaceRevealReplyV1>(WORKSPACE_CHANNELS.reveal, request, request.requestId, isWorkspaceRevealResultV1)
    : Promise.resolve(rejectedWorkspace<WorkspaceRevealReplyV1>('invalid', 'Invalid reveal request')),
  openExternal: (request: WorkspaceOpenExternalRequestV1) => isWorkspaceOpenExternalRequestV1(request)
    ? invokeWorkspace<WorkspaceOpenExternalReplyV1>(WORKSPACE_CHANNELS.openExternal, request, request.requestId, isWorkspaceOpenExternalResultV1)
    : Promise.resolve(rejectedWorkspace<WorkspaceOpenExternalReplyV1>('invalid', 'Invalid external link request')),
  newFile: (request: WorkspaceRequestV1) => isWorkspaceRequestV1(request)
    ? invokeWorkspace<WorkspaceNewFileReplyV1>(WORKSPACE_CHANNELS.newFile, request, request.requestId, isWorkspaceNewFileResultV1)
    : Promise.resolve(rejectedWorkspace<WorkspaceNewFileReplyV1>('invalid', 'Invalid new file request')),
  treeMenu: (request: WorkspaceTreeMenuRequestV1) => isWorkspaceTreeMenuRequestV1(request)
    ? invokeWorkspace<WorkspaceTreeMenuReplyV1>(WORKSPACE_CHANNELS.treeMenu, request, request.requestId, isWorkspaceTreeMenuResultV1)
    : Promise.resolve(rejectedWorkspace<WorkspaceTreeMenuReplyV1>('invalid', 'Invalid tree menu request')),
  fileIndex: (request: WorkspaceRequestV1) => isWorkspaceRequestV1(request)
    ? invokeWorkspace<WorkspaceIndexReplyV1>(WORKSPACE_CHANNELS.fileIndex, request, request.requestId, isWorkspaceIndexResultV1)
    : Promise.resolve(rejectedWorkspace<WorkspaceIndexReplyV1>('invalid', 'Invalid file index request')),
  onMenuCommand: (listener: (event: WorkspaceMenuEventV1) => void) =>
    subscribe(WORKSPACE_CHANNELS.menuCommand, isWorkspaceMenuEventV1, listener),
  onPasteText: (listener: (event: WorkspacePasteEventV1) => void) =>
    subscribe(WORKSPACE_CHANNELS.pasteText, isWorkspacePasteEventV1, listener),
  onRemoteChanged: (listener: (event: WorkspaceRemoteEventV1) => void) =>
    subscribe(WORKSPACE_CHANNELS.remoteChanged, isWorkspaceRemoteEventV1, listener),
  reportDirty: (event: WorkspaceDirtyEventV1) => {
    if (isWorkspaceDirtyEventV1(event)) ipcRenderer.send(WORKSPACE_CHANNELS.dirtyChanged, event);
  },
  onTextRequest: (listener: (event: WorkspaceTextRequestV1) => void) =>
    subscribe(WORKSPACE_CHANNELS.documentText, isWorkspaceTextRequestV1, listener),
  replyText: (event: WorkspaceTextReplyV1) => {
    if (isWorkspaceTextReplyV1(event)) ipcRenderer.send(WORKSPACE_CHANNELS.documentTextReply, event);
  },
  pathForFile: (file: File) => {
    try {
      return file instanceof File ? webUtils.getPathForFile(file) : '';
    } catch {
      return '';
    }
  },
  noteLinks: (request: WorkspaceFolderRequestV1) => isWorkspaceFolderRequestV1(request)
    ? invokeWorkspace<WorkspaceLinksReplyV1>(WORKSPACE_CHANNELS.noteLinks, request, request.requestId, isWorkspaceLinksResultV1)
    : Promise.resolve(rejectedWorkspace<WorkspaceLinksReplyV1>('invalid', 'Invalid note links request')),
  tagIndex: (request: WorkspaceRequestV1) => isWorkspaceRequestV1(request)
    ? invokeWorkspace<WorkspaceTagIndexReplyV1>(WORKSPACE_CHANNELS.tagIndex, request, request.requestId, isWorkspaceTagIndexResultV1)
    : Promise.resolve(rejectedWorkspace<WorkspaceTagIndexReplyV1>('invalid', 'Invalid tag index request')),
  notesByTag: (request: WorkspaceNotesByTagRequestV1) => isWorkspaceNotesByTagRequestV1(request)
    ? invokeWorkspace<WorkspaceNotesByTagReplyV1>(WORKSPACE_CHANNELS.notesByTag, request, request.requestId, isWorkspaceNotesByTagResultV1)
    : Promise.resolve(rejectedWorkspace<WorkspaceNotesByTagReplyV1>('invalid', 'Invalid notes-by-tag request')),
  manageEntry: (request: WorkspaceEntryRequestV1) => isWorkspaceEntryRequestV1(request)
    ? invokeWorkspace<WorkspaceEntryReplyV1>(WORKSPACE_CHANNELS.manageEntry, request, request.requestId, isWorkspaceEntryResultV1)
    : Promise.resolve(rejectedWorkspace<WorkspaceEntryReplyV1>('invalid', 'Invalid entry action request')),
  // The event carries nothing: it says a listing is stale, and the renderer
  // asks for what it needs. A payload here would be a second source of truth
  // about the tree.
  onTreeChanged: (listener: () => void) =>
    subscribe(
      WORKSPACE_CHANNELS.treeChanged,
      (value): value is { version: 1 } => typeof value === 'object' && value !== null
        && (value as { version?: unknown }).version === NOTO_WORKSPACE_VERSION,
      () => listener(),
    ),
  exportRendered: (request: WorkspaceExportRequestV1) => isWorkspaceExportRequestV1(request)
    ? invokeWorkspace<WorkspaceExportReplyV1>(WORKSPACE_CHANNELS.exportRendered, request, request.requestId, isWorkspaceExportResultV1)
    : Promise.resolve(rejectedWorkspace<WorkspaceExportReplyV1>('invalid', 'Invalid export request')),
  onRenameRow: (listener: (event: WorkspaceRenameRowEventV1) => void) =>
    subscribe(WORKSPACE_CHANNELS.renameRow, isWorkspaceRenameRowEventV1, listener),
});

const settingsApi: NotoSettingsApiV1 = Object.freeze({
  read: (request: SettingsRequestV1) => isSettingsRequestV1(request)
    ? invokeSettings(SETTINGS_CHANNELS.read, request, request.requestId)
    : Promise.resolve(rejectedSettings('invalid', 'Invalid settings read request')),
  write: (request: SettingsWriteRequestV1) => isSettingsWriteRequestV1(request)
    ? invokeSettings(SETTINGS_CHANNELS.write, request, request.requestId)
    : Promise.resolve(rejectedSettings('invalid', 'Invalid settings write request')),
  readThemeCss: async (request: SettingsRequestV1) => {
    if (!isSettingsRequestV1(request)) {
      return { ok: false as const, requestId: 'invalid',
        error: { code: 'BAD_REQUEST', message: 'Invalid theme stylesheet request' } };
    }
    const value: unknown = await ipcRenderer.invoke(SETTINGS_CHANNELS.themeCss, request);
    return isThemeCssResultV1(value, request.requestId)
      ? value
      : { ok: false as const, requestId: request.requestId,
        error: { code: 'BAD_REQUEST', message: 'Main returned an invalid theme stylesheet response' } };
  },
  listFonts: async (request: SettingsRequestV1) => {
    if (!isSettingsRequestV1(request)) {
      return { ok: false as const, requestId: 'invalid',
        error: { code: 'BAD_REQUEST', message: 'Invalid font list request' } };
    }
    const value: unknown = await ipcRenderer.invoke(SETTINGS_CHANNELS.listFonts, request);
    return isSystemFontsResultV1(value, request.requestId)
      ? value
      : { ok: false as const, requestId: request.requestId,
        error: { code: 'BAD_REQUEST', message: 'Main returned an invalid font list response' } };
  },
  remoteStatus: (request: SettingsRequestV1) => askRemote(SETTINGS_CHANNELS.remoteStatus, request),
  regenerateRemoteToken: (request: SettingsRequestV1) => askRemote(SETTINGS_CHANNELS.remoteRegenerate, request),
  onChanged: (listener: (event: SettingsReplyV1) => void) =>
    subscribe(SETTINGS_CHANNELS.changed, isSettingsReplyV1, listener),
});

/**
 * Pictures.
 *
 * The bytes go across as a Uint8Array and structured clone copies them, so the
 * renderer's buffer is not shared with main and nothing on this side can change
 * what main is about to write.
 */
function rejectedAsset(requestId: string, message: string): AssetResultV1<AssetWriteReplyV1> {
  return { ok: false, requestId, error: { code: 'BAD_REQUEST', message } };
}

async function invokeAsset(channel: string, request: unknown, requestId: string): Promise<AssetResultV1<AssetWriteReplyV1>> {
  const value: unknown = await ipcRenderer.invoke(channel, request);
  return isAssetResultV1(value, requestId)
    ? value
    : rejectedAsset(requestId, 'Main returned an invalid asset response');
}

const assetsApi: NotoAssetsApiV1 = Object.freeze({
  write: (request: AssetWriteRequestV1) => isAssetWriteRequestV1(request)
    ? invokeAsset(ASSET_CHANNELS.write, request, request.requestId)
    : Promise.resolve(rejectedAsset('invalid', 'Invalid image write request')),
  pick: (request: AssetRequestV1) => isAssetRequestV1(request)
    ? invokeAsset(ASSET_CHANNELS.pick, request, request.requestId)
    : Promise.resolve(rejectedAsset('invalid', 'Invalid image pick request')),
  testUpload: async (request: AssetRequestV1): Promise<AssetResultV1<AssetTestUploadReplyV1>> => {
    if (!isAssetRequestV1(request)) {
      return { ok: false, requestId: 'invalid', error: { code: 'BAD_REQUEST', message: 'Invalid upload test request' } };
    }
    const value: unknown = await ipcRenderer.invoke(ASSET_CHANNELS.testUpload, request);
    return isAssetTestUploadResultV1(value, request.requestId)
      ? value
      : { ok: false, requestId: request.requestId, error: { code: 'BAD_REQUEST', message: 'Main returned an invalid upload test response' } };
  },
});

contextBridge.exposeInMainWorld('notoWorkspace', workspaceApi);
contextBridge.exposeInMainWorld('notoSettings', settingsApi);
contextBridge.exposeInMainWorld('notoAssets', assetsApi);

/**
 * The user's home directory, used only to shorten a displayed path to a leading
 * tilde in the status bar.
 *
 * It is a string the window already effectively knows from any file it has
 * open, so showing it reveals nothing, and it never reaches the document. The
 * platform itself is not exposed here: bootstrap already reports it, validated,
 * and one source for it is enough.
 */
contextBridge.exposeInMainWorld('notoPlatform', Object.freeze({
  home: process.env.HOME ?? process.env.USERPROFILE ?? '',
}));

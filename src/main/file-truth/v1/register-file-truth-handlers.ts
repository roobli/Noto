import { ipcMain, type BrowserWindow } from 'electron';
import type {
  FileTruthBootstrapReplyV1,
  FileTruthRequestV1,
  FileTruthResultV1,
  FileTruthSaveCopyRequestV1,
  FileTruthSaveRequestV1,
  FileTruthReloadRequestV1,
  NotoPlatform,
} from '../../../shared/file-truth/v1/contracts';
import { FILE_TRUTH_CHANNELS } from '../../../shared/file-truth/v1/contracts';

/** Noto ships for these three. Anything else is reported as linux-like. */
function currentPlatform(): NotoPlatform {
  if (process.platform === 'darwin' || process.platform === 'win32') return process.platform;
  return 'linux';
}
import {
  isFileTruthRequestV1,
  isFileTruthSaveCopyRequestV1,
  isFileTruthSaveRequestV1,
  isFileTruthReloadRequestV1,
} from '../../../shared/file-truth/v1/validate';
import type { StructuredLogger } from '../../logger';
import { isTrustedRendererSender } from '../../ipc/trusted-renderer';
import type { FileTruthStoreV1 } from './file-truth-store';

export function registerFileTruthHandlers(deps: {
  session: {
    readonly currentPath: string | null;
    activeStore(): FileTruthStoreV1 | null;
    storeForDocument(documentId: string): FileTruthStoreV1 | null;
  };
  getWindow: () => BrowserWindow | null;
  logger: StructuredLogger;
}): void {
  const register = <TRequest extends { requestId: string }, TReply>(channel: string, validate: (value: unknown) => value is TRequest,
    operation: (request: TRequest) => Promise<TReply> | TReply) => {
    ipcMain.handle(channel, async (event, value: unknown): Promise<FileTruthResultV1<TReply>> => {
      const candidateId = typeof value === 'object' && value && 'requestId' in value ? String((value as { requestId: unknown }).requestId).slice(0, 96) : 'invalid';
      if (!isTrustedRendererSender(deps.getWindow(), event) || !validate(value)) {
        deps.logger.log('file_truth_ipc_rejected', { channel, requestId: candidateId });
        return { ok: false, requestId: candidateId, error: { code: 'BAD_REQUEST', message: 'File-truth v1 request validation failed.' } };
      }
      try { return { ok: true, requestId: value.requestId, value: await operation(value) }; }
      catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 2048) : 'Unknown transport failure';
        // Folder-only restore / empty window: open (and recover/diagnostics) with
        // no document is ordinary, not a broken transport. Keep the log quiet.
        if (message.startsWith('NO_DOCUMENT_OPEN:')) {
          return { ok: false, requestId: value.requestId, error: { code: 'NO_DOCUMENT_OPEN', message } };
        }
        deps.logger.log('file_truth_transport_failed', { channel, requestId: value.requestId });
        return { ok: false, requestId: value.requestId, error: { code: 'FILE_TRUTH_TRANSPORT_FAILED', message } };
      }
    });
  };
  register<FileTruthRequestV1, FileTruthBootstrapReplyV1>(FILE_TRUTH_CHANNELS.bootstrap, isFileTruthRequestV1,
    () => ({ version: 1, enabled: true, platform: currentPlatform() }));
  // Reopens whatever the workspace has open. Choosing a different document goes
  // through the workspace channels, which own that decision.
  const activeStore = (): FileTruthStoreV1 => {
    const store = deps.session.activeStore();
    if (!store) throw new Error('NO_DOCUMENT_OPEN: open a document first');
    return store;
  };

  /**
   * The store that owns the document a save is for.
   *
   * Routed by document id rather than by whichever tab happens to be in front,
   * so a save that was started before the user switched tabs still lands on the
   * document it was captured from.
   */
  const storeForSave = (documentId: string): FileTruthStoreV1 => {
    const store = deps.session.storeForDocument(documentId);
    if (!store) throw new Error('UNKNOWN_DOCUMENT: that document is not open');
    return store;
  };

  // Startup always asks to reopen. Folder-only restore has no current path —
  // that is a quiet no-op (NO_DOCUMENT_OPEN), not a transport failure.
  register<FileTruthRequestV1, Awaited<ReturnType<FileTruthStoreV1['open']>>>(FILE_TRUTH_CHANNELS.open, isFileTruthRequestV1, () => {
    const current = deps.session.currentPath;
    if (!current) throw new Error('NO_DOCUMENT_OPEN: open a document first');
    return activeStore().open(current);
  });
  register<FileTruthSaveRequestV1, Awaited<ReturnType<FileTruthStoreV1['save']>>>(FILE_TRUTH_CHANNELS.save, isFileTruthSaveRequestV1,
    (request) => storeForSave(request.candidate.transaction.documentId).save(request.candidate));
  register<FileTruthSaveCopyRequestV1, Awaited<ReturnType<FileTruthStoreV1['saveCopy']>>>(FILE_TRUTH_CHANNELS.saveCopy, isFileTruthSaveCopyRequestV1,
    (request) => storeForSave(request.candidate.transaction.documentId)
      .saveCopy(request.candidate, request.destinationPath));
  register<FileTruthRequestV1, Awaited<ReturnType<FileTruthStoreV1['recover']>>>(FILE_TRUTH_CHANNELS.recover, isFileTruthRequestV1,
    () => activeStore().recover());
  register<FileTruthRequestV1, ReturnType<FileTruthStoreV1['diagnostics']>>(FILE_TRUTH_CHANNELS.diagnostics, isFileTruthRequestV1,
    () => activeStore().diagnostics());
  // Routed by document id, like a save, so main only ever reloads a document it
  // opened itself and the renderer never names a file.
  register<FileTruthReloadRequestV1, Awaited<ReturnType<FileTruthStoreV1['reload']>>>(FILE_TRUTH_CHANNELS.reload, isFileTruthReloadRequestV1,
    (request) => storeForSave(request.documentId).reload());
}

import { ipcMain, type BrowserWindow } from 'electron';
import { UPDATE_CHANNELS, type UpdateRequestV1, type UpdateResultV1, type UpdateStatusV1 } from '../../shared/updates/v1/contracts';
import { isUpdateRequestV1 } from '../../shared/updates/v1/validate';
import { isTrustedRendererSender } from '../ipc/trusted-renderer';
import type { StructuredLogger } from '../logger';
import type { AppUpdater } from './app-updater';

export function registerUpdateHandlers(deps: {
  updater: AppUpdater;
  getWindow: () => BrowserWindow | null;
  logger: StructuredLogger;
}): void {
  const register = (
    channel: string,
    operation: (request: UpdateRequestV1) => Promise<UpdateStatusV1>,
  ) => {
    ipcMain.handle(channel, async (event, value: unknown): Promise<UpdateResultV1<UpdateStatusV1>> => {
      const candidateId = typeof value === 'object' && value !== null && 'requestId' in value
        ? String((value as { requestId: unknown }).requestId).slice(0, 96)
        : 'invalid';
      if (!isTrustedRendererSender(deps.getWindow(), event) || !isUpdateRequestV1(value)) {
        deps.logger.log('updates_ipc_rejected', { channel, requestId: candidateId });
        return {
          ok: false,
          requestId: candidateId,
          error: { code: 'BAD_REQUEST', message: 'Update request validation failed.' },
        };
      }
      try {
        return { ok: true, requestId: value.requestId, value: await operation(value) };
      } catch (error) {
        deps.logger.log('updates_operation_failed', { channel, requestId: value.requestId });
        return {
          ok: false,
          requestId: value.requestId,
          error: {
            code: 'UPDATE_FAILED',
            message: error instanceof Error ? error.message.slice(0, 2048) : 'The update operation failed.',
          },
        };
      }
    });
  };

  register(UPDATE_CHANNELS.status, async () => deps.updater.status());
  register(UPDATE_CHANNELS.check, async () => deps.updater.check('manual'));
  register(UPDATE_CHANNELS.download, async () => deps.updater.download());
  register(UPDATE_CHANNELS.install, async () => deps.updater.install());
  register(UPDATE_CHANNELS.openRelease, async () => deps.updater.openRelease());
}

/**
 * Settings IPC.
 *
 * Same shape as the other handler modules: reject untrusted senders, validate
 * the request, and never let an exception escape as an unhandled rejection.
 */

import { readFile, stat } from 'node:fs/promises';
import { ipcMain, type BrowserWindow } from 'electron';
import {
  NOTO_SETTINGS_VERSION,
  SETTINGS_CHANNELS,
  THEME_CSS_MAX_BYTES,
  type SettingsReplyV1,
  type SettingsResultV1,
  type SettingsWriteRequestV1,
  type ThemeCssReplyV1,
  type SystemFontsReplyV1,
  type RemoteStatusReplyV1,
} from '../../shared/settings/v1/contracts';
import {
  isSettingsRequestV1,
  isSettingsWriteRequestV1,
} from '../../shared/settings/v1/validate';
import { isTrustedRendererSender } from '../ipc/trusted-renderer';
import type { StructuredLogger } from '../logger';
import type { SettingsStore } from './settings-store';
import { listSystemFontFamilies } from './list-system-fonts';

export function registerSettingsHandlers(deps: {
  settings: SettingsStore;
  getWindow: () => BrowserWindow | null;
  logger: StructuredLogger;
  /** Called after a successful write, so main can react to a changed setting. */
  onChanged: (settings: SettingsReplyV1) => void;
  /** What the remote control is doing, and how to give it a new token. */
  remote?: {
    status: () => Promise<RemoteStatusReplyV1>;
    regenerate: () => Promise<RemoteStatusReplyV1>;
  };
}): void {
  const register = <TRequest extends { requestId: string }, TReply>(
    channel: string,
    validate: (value: unknown) => value is TRequest,
    operation: (request: TRequest) => Promise<TReply>,
  ) => {
    ipcMain.handle(channel, async (event, value: unknown): Promise<SettingsResultV1<TReply>> => {
      const candidateId = typeof value === 'object' && value !== null && 'requestId' in value
        ? String((value as { requestId: unknown }).requestId).slice(0, 96)
        : 'invalid';
      if (!isTrustedRendererSender(deps.getWindow(), event) || !validate(value)) {
        deps.logger.log('settings_ipc_rejected', { channel, requestId: candidateId });
        return {
          ok: false,
          requestId: candidateId,
          error: { code: 'BAD_REQUEST', message: 'Settings request validation failed.' },
        };
      }
      try {
        return { ok: true, requestId: value.requestId, value: await operation(value) };
      } catch (error) {
        deps.logger.log('settings_operation_failed', { channel, requestId: value.requestId });
        return {
          ok: false,
          requestId: value.requestId,
          error: {
            code: 'SETTINGS_FAILED',
            message: error instanceof Error ? error.message.slice(0, 2048) : 'The settings operation failed.',
          },
        };
      }
    });
  };

  register(SETTINGS_CHANNELS.read, isSettingsRequestV1, async () => ({
    version: NOTO_SETTINGS_VERSION,
    settings: await deps.settings.load(),
  }));

  register(SETTINGS_CHANNELS.write, isSettingsWriteRequestV1, async (request: SettingsWriteRequestV1) => {
    const reply: SettingsReplyV1 = {
      version: NOTO_SETTINGS_VERSION,
      settings: await deps.settings.update(request.patch),
    };
    deps.onChanged(reply);
    // Every window is told, so a setting changed in one is not stale in another.
    const window = deps.getWindow();
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(SETTINGS_CHANNELS.changed, reply);
    }
    return reply;
  });

  /**
   * The user's stylesheet.
   *
   * The renderer asks for "the theme" and never names a file: the path comes
   * from the settings main already owns, so this handler cannot be aimed at
   * anything else no matter what the caller sends. A missing or oversized file
   * is reported as a problem string rather than an error, because a broken
   * theme should leave the editor working and say so in preferences.
   */
  register<{ requestId: string }, ThemeCssReplyV1>(
    SETTINGS_CHANNELS.themeCss,
    isSettingsRequestV1,
    async () => {
      const empty = { version: NOTO_SETTINGS_VERSION, css: '', problem: '' } as const;
      const { customCssPath } = await deps.settings.load();
      if (!customCssPath) return empty;
      try {
        const info = await stat(customCssPath);
        if (!info.isFile()) return { ...empty, problem: 'That path is not a file.' };
        if (info.size > THEME_CSS_MAX_BYTES) {
          return { ...empty, problem: `Stylesheet is larger than ${THEME_CSS_MAX_BYTES / 1024} KB.` };
        }
        return { version: NOTO_SETTINGS_VERSION, css: await readFile(customCssPath, 'utf8'), problem: '' };
      } catch {
        deps.logger.log('settings_theme_css_unreadable', { requestId: 'theme-css' });
        return { ...empty, problem: 'Stylesheet could not be read.' };
      }
    },
  );


  register<{ requestId: string }, SystemFontsReplyV1>(
    SETTINGS_CHANNELS.listFonts,
    isSettingsRequestV1,
    async () => ({
      version: NOTO_SETTINGS_VERSION,
      families: await listSystemFontFamilies(),
    }),
  );

  const remoteReply = async (kind: 'status' | 'regenerate'): Promise<RemoteStatusReplyV1> => {
    const off = {
      version: NOTO_SETTINGS_VERSION, listening: false, port: null, token: '', problem: '',
    } as const;
    if (!deps.remote) return off;
    return kind === 'status' ? deps.remote.status() : deps.remote.regenerate();
  };

  register<{ requestId: string }, RemoteStatusReplyV1>(
    SETTINGS_CHANNELS.remoteStatus,
    isSettingsRequestV1,
    () => remoteReply('status'),
  );

  // A new token is a change the reader asked for, and everything holding the
  // old one stops working the moment it is made, which is the point of it.
  register<{ requestId: string }, RemoteStatusReplyV1>(
    SETTINGS_CHANNELS.remoteRegenerate,
    isSettingsRequestV1,
    () => remoteReply('regenerate'),
  );
}

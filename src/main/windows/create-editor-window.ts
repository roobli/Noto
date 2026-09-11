import path from 'node:path';
import { BrowserWindow } from 'electron';
import type { NotoTheme } from '../../shared/settings/v1/contracts';
import { summarizeUntrustedText, type StructuredLogger } from '../logger';
import { isAllowedRendererUrl } from '../protocol/register-app-protocol';
import { classifyRendererConsoleMessage } from './classify-renderer-console-message';
import {
  EDITOR_CHROME_COLORS,
  editorWindowFrameOptions,
  resolveEditorChromeTone,
} from './editor-window-chrome';
import { installEditorContextMenu } from './editor-context-menu';

export interface RendererConsoleState {
  errors: number;
  warnings: number;
}

export interface CreateEditorWindowOptions {
  readonly theme?: NotoTheme;
  readonly shouldUseDarkColors?: boolean;
}

/** Set by the test runner. Never set when a person launches the app. */
export function headless(): boolean {
  return process.env.NOTO_HEADLESS === '1';
}

export function createEditorWindow(
  preloadPath: string,
  logger: StructuredLogger,
  consoleState: RendererConsoleState,
  options: CreateEditorWindowOptions = {},
): BrowserWindow {
  const tone = resolveEditorChromeTone(
    options.theme ?? 'system',
    options.shouldUseDarkColors ?? false,
  );
  const frame = editorWindowFrameOptions(process.platform, tone);
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: EDITOR_CHROME_COLORS[tone].background,
    ...frame,
    show: false,
    webPreferences: {
      preload: path.resolve(preloadPath),
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  installEditorContextMenu(window);
  window.webContents.on('will-frame-navigate', (event) => {
    if (!isAllowedRendererUrl(event.url)) {
      event.preventDefault();
      logger.log('navigation_denied', { url: event.url.slice(0, 512) });
    }
  });
  window.webContents.on('console-message', (_event, level, message, lineNumber, sourceId) => {
    if (classifyRendererConsoleMessage(level, message, sourceId) === 'runtime-noise') {
      logger.log('renderer_console_runtime_noise', {
        level,
        lineNumber,
        ...summarizeUntrustedText(message),
      });
      return;
    }
    if (level === 3) consoleState.errors += 1;
    if (level === 2) consoleState.warnings += 1;
    logger.log('renderer_console', {
      level,
      lineNumber,
      ...summarizeUntrustedText(message),
    });
  });
  /*
   * Stay off screen when a test is driving.
   *
   * The end-to-end suite launches this app well over a hundred times in a run,
   * and every launch used to raise a window and take the keyboard focus, which
   * makes the machine unusable for as long as the suite runs and flashes the
   * screen once per test. Everything the tests do reaches the page through the
   * debugging protocol, which does not need the window on screen, so a window
   * that never shows is a window that never interrupts anybody.
   */
  if (!headless()) window.once('ready-to-show', () => window.show());
  void window.loadURL('noto://bundle/index.html');
  return window;
}

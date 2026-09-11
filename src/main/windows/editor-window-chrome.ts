import type { NativeTheme, TitleBarOverlay } from 'electron';
import type { NotoTheme } from '../../shared/settings/v1/contracts';

/** Matches `.titlebar` height in `app.scss` — Typora-like restraint. */
export const EDITOR_TITLEBAR_HEIGHT_PX = 32 as const;

/**
 * Paper / ink for the native Window Controls Overlay.
 *
 * Kept as literals (same bytes as `_roob-tokens.scss`) so main can paint the
 * caption-button strip without reading the renderer stylesheet. Traffic-light
 * avoidance is macOS-only; on Windows and Linux these colours are what make
 * the overlay read as part of the same title bar rather than a second chrome.
 */
export const EDITOR_CHROME_COLORS = {
  light: { background: '#FAF9F6', symbol: '#34312E' },
  dark: { background: '#1F1E1C', symbol: '#D7D4CF' },
} as const;

export type EditorChromeTone = keyof typeof EDITOR_CHROME_COLORS;

export function resolveEditorChromeTone(
  theme: NotoTheme,
  shouldUseDarkColors: boolean,
): EditorChromeTone {
  if (theme === 'dark') return 'dark';
  if (theme === 'light') return 'light';
  return shouldUseDarkColors ? 'dark' : 'light';
}

export function titleBarOverlayForTone(tone: EditorChromeTone): TitleBarOverlay {
  const colors = EDITOR_CHROME_COLORS[tone];
  return {
    color: colors.background,
    symbolColor: colors.symbol,
    height: EDITOR_TITLEBAR_HEIGHT_PX,
  };
}

export type EditorWindowFrameOptions =
  | {
      titleBarStyle: 'hiddenInset';
      trafficLightPosition: { readonly x: number; readonly y: number };
    }
  | {
      titleBarStyle: 'hidden';
      titleBarOverlay: TitleBarOverlay;
    };

/**
 * Platform frame for the editor window.
 *
 * - macOS: `hiddenInset` + pinned traffic lights so the renderer pads the
 *   sidebar toggle and trail to their right (Claude-style).
 * - Windows / Linux: `hidden` + Window Controls Overlay so the custom 32px
 *   title bar is first-class and caption buttons do not cover Settings / Save.
 */
export function editorWindowFrameOptions(
  platform: NodeJS.Platform,
  tone: EditorChromeTone,
): EditorWindowFrameOptions {
  if (platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      /* y centres the ~12px lights in the 32px titlebar. */
      trafficLightPosition: { x: 14, y: 10 },
    };
  }
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlayForTone(tone),
  };
}

/** Apply overlay colours after a theme change (no-op on macOS). */
export function syncEditorTitleBarOverlay(
  platform: NodeJS.Platform,
  setOverlay: ((options: TitleBarOverlay) => void) | null | undefined,
  theme: NotoTheme,
  nativeTheme: Pick<NativeTheme, 'shouldUseDarkColors'>,
): void {
  if (platform === 'darwin' || !setOverlay) return;
  setOverlay(titleBarOverlayForTone(resolveEditorChromeTone(theme, nativeTheme.shouldUseDarkColors)));
}

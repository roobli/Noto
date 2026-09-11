import { describe, expect, it, vi } from 'vitest';
import {
  EDITOR_CHROME_COLORS,
  EDITOR_TITLEBAR_HEIGHT_PX,
  editorWindowFrameOptions,
  resolveEditorChromeTone,
  syncEditorTitleBarOverlay,
  titleBarOverlayForTone,
} from '../../src/main/windows/editor-window-chrome';

describe('editor window chrome', () => {
  it('resolves system theme from the OS preference', () => {
    expect(resolveEditorChromeTone('light', true)).toBe('light');
    expect(resolveEditorChromeTone('dark', false)).toBe('dark');
    expect(resolveEditorChromeTone('system', true)).toBe('dark');
    expect(resolveEditorChromeTone('system', false)).toBe('light');
  });

  it('pins traffic lights on macOS and leaves overlay to Win/Linux', () => {
    expect(editorWindowFrameOptions('darwin', 'light')).toEqual({
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 10 },
    });

    for (const platform of ['win32', 'linux'] as const) {
      expect(editorWindowFrameOptions(platform, 'dark')).toEqual({
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          color: EDITOR_CHROME_COLORS.dark.background,
          symbolColor: EDITOR_CHROME_COLORS.dark.symbol,
          height: EDITOR_TITLEBAR_HEIGHT_PX,
        },
      });
    }
  });

  it('paints the overlay in paper/ink for the active tone', () => {
    expect(titleBarOverlayForTone('light')).toMatchObject({
      color: '#FAF9F6',
      symbolColor: '#34312E',
      height: 32,
    });
  });

  it('syncs the Win/Linux overlay and skips macOS', () => {
    const setOverlay = vi.fn();
    syncEditorTitleBarOverlay('darwin', setOverlay, 'dark', { shouldUseDarkColors: false });
    expect(setOverlay).not.toHaveBeenCalled();

    syncEditorTitleBarOverlay('win32', setOverlay, 'system', { shouldUseDarkColors: true });
    expect(setOverlay).toHaveBeenCalledWith(titleBarOverlayForTone('dark'));
  });
});

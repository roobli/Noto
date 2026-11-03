import { describe, expect, it } from 'vitest';
import { chordOfEvent, displayChord, isCanonicalChord, normalizeChord } from '../../src/shared/shortcuts/chord';

describe('a chord, however it was written', () => {
  it('reads the menu’s accelerators in either order', () => {
    expect(normalizeChord('Shift+CmdOrCtrl+T', 'accelerator', true)).toBe('Mod+Shift+T');
    expect(normalizeChord('CmdOrCtrl+Shift+T', 'accelerator', true)).toBe('Mod+Shift+T');
    expect(normalizeChord('CmdOrCtrl+Alt+Left', 'accelerator', true)).toBe('Mod+Alt+ArrowLeft');
    expect(normalizeChord('Ctrl+CmdOrCtrl+F', 'accelerator', true)).toBe('Mod+Ctrl+F');
    expect(normalizeChord('F11', 'accelerator', false)).toBe('F11');
  });

  it('reads the editor’s key names, the minus key included', () => {
    expect(normalizeChord('Meta-Shift-k', 'prosemirror', true)).toBe('Mod+Shift+K');
    expect(normalizeChord('Meta--', 'prosemirror', true)).toBe('Mod+-');
    expect(normalizeChord('Meta-Alt--', 'prosemirror', true)).toBe('Mod+Alt+-');
    expect(normalizeChord('Ctrl-`', 'prosemirror', true)).toBe('Ctrl+`');
    expect(normalizeChord('Alt-Shift-ArrowLeft', 'prosemirror', true)).toBe('Alt+Shift+ArrowLeft');
    expect(normalizeChord('Shift-Enter', 'prosemirror', true)).toBe('Shift+Enter');
  });

  it('makes Control the same key as Command-or-Control off macOS, and its own key on it', () => {
    expect(normalizeChord('Ctrl+X', 'accelerator', false)).toBe('Mod+X');
    expect(normalizeChord('Ctrl+X', 'accelerator', true)).toBe('Ctrl+X');
    expect(normalizeChord('Cmd+H', 'accelerator', false)).toBeNull();
  });

  it('refuses what is not a chord', () => {
    expect(normalizeChord('CmdOrCtrl+Hyper', 'accelerator', true)).toBeNull();
    expect(normalizeChord('Fn+K', 'accelerator', true)).toBeNull();
    expect(isCanonicalChord('Mod+Shift+T')).toBe(true);
    for (const bad of ['Shift+Mod+T', 'mod+t', 'Mod+', '', 'Mod+Shift+Hyper', 'x'.repeat(41), 7]) {
      expect(isCanonicalChord(bad), String(bad)).toBe(false);
    }
  });

  it('reads a press from the physical key', () => {
    const press = (code: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) =>
      ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
    expect(chordOfEvent(press('KeyP', { metaKey: true, shiftKey: true }), true)).toBe('Mod+Shift+P');
    expect(chordOfEvent(press('KeyP', { ctrlKey: true, shiftKey: true }), false)).toBe('Mod+Shift+P');
    expect(chordOfEvent(press('ArrowUp', { metaKey: true, shiftKey: true }), true)).toBe('Mod+Shift+ArrowUp');
    expect(chordOfEvent(press('Backquote', { ctrlKey: true }), true)).toBe('Ctrl+`');
    expect(chordOfEvent(press('ShiftLeft', { shiftKey: true }), true)).toBeNull();
  });

  it('reads the character typed, as the menu does, so another layout means the same chord', () => {
    // Dvorak puts P where QWERTY has R.
    expect(chordOfEvent({ key: 'P', code: 'KeyR', metaKey: false, ctrlKey: true, altKey: false, shiftKey: true }, false))
      .toBe('Mod+Shift+P');
    // Option turns T into a dagger on macOS: the physical key says what was meant.
    expect(chordOfEvent({ key: '\u2020', code: 'KeyT', metaKey: true, ctrlKey: false, altKey: true, shiftKey: false }, true))
      .toBe('Mod+Alt+T');
    // Shift turns 1 into !.
    expect(chordOfEvent({ key: '!', code: 'Digit1', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true }, true))
      .toBe('Mod+Shift+1');
  });

  it('is written as the platform writes it', () => {
    expect(displayChord('Mod+Alt+Shift+T', true)).toBe('⌥⇧⌘T');
    expect(displayChord('Mod+Ctrl+F', true)).toBe('⌃⌘F');
    expect(displayChord('Mod+Alt+ArrowLeft', false)).toBe('Ctrl+Alt+←');
    expect(displayChord('Mod+Shift+Backspace', false)).toBe('Ctrl+Shift+Backspace');
  });
});

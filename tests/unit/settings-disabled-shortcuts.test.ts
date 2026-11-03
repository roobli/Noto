import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/settings/v1/contracts';
import { coerceSettings, isSettingsWriteRequestV1 } from '../../src/shared/settings/v1/validate';

const write = (disabledShortcuts: unknown) => ({ version: 1, requestId: 'shortcuts-1', patch: { disabledShortcuts } });

describe('switched-off shortcuts in settings', () => {
  it('start empty', () => {
    expect(DEFAULT_SETTINGS.disabledShortcuts).toEqual([]);
  });

  it('take a list of canonical chords, written whole', () => {
    expect(isSettingsWriteRequestV1(write(['Mod+Shift+T', 'Ctrl+M']))).toBe(true);
    expect(isSettingsWriteRequestV1(write([]))).toBe(true);
  });

  it('refuse a chord in another spelling, a repeat, or not a list', () => {
    for (const bad of [['Shift+CmdOrCtrl+T'], ['Mod+B', 'Mod+B'], 'Mod+B', [7], Array.from({ length: 201 }, (_, i) => `F${(i % 24) + 1}`)]) {
      expect(isSettingsWriteRequestV1(write(bad)), JSON.stringify(bad).slice(0, 40)).toBe(false);
    }
  });

  it('keep what they can read from a stored file, and drop the rest', () => {
    expect(coerceSettings({ disabledShortcuts: ['Mod+B', 'nonsense', 'Mod+B', 'Mod+Alt+Shift+T'] }).disabledShortcuts)
      .toEqual(['Mod+B', 'Mod+Alt+Shift+T']);
    expect(coerceSettings({ disabledShortcuts: 'Mod+B' }).disabledShortcuts).toEqual([]);
  });
});

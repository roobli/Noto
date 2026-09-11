/**
 * The numeric settings and the custom stylesheet path.
 *
 * These reach CSS and the filesystem respectively, which is why the range and
 * the shape are contracts rather than suggestions: a line height of 40 makes a
 * window with no way back except editing the settings file by hand, and a
 * relative stylesheet path resolves against whatever the process happens to
 * consider its working directory.
 */

import { describe, expect, it } from 'vitest';
import {
  clampRailWidth,
  clampSetting,
  DEFAULT_SETTINGS,
  NOTO_SETTINGS_VERSION,
  RAIL_WIDTH_FALLBACK_MAX,
  RAIL_WIDTH_SCREEN_FRACTION,
  railWidthMaxForScreen,
  SETTING_RANGES,
} from '../../src/shared/settings/v1/contracts';
import { coerceSettings, isSettingsWriteRequestV1 } from '../../src/shared/settings/v1/validate';

const write = (patch: unknown) => isSettingsWriteRequestV1({
  version: NOTO_SETTINGS_VERSION, requestId: 'settings-write:1', patch,
});

describe('numeric settings', () => {
  it('clamps a stored value into its range rather than losing the file', () => {
    expect(clampSetting('fontSize', 4)).toBe(SETTING_RANGES.fontSize.min);
    expect(clampSetting('fontSize', 400)).toBe(SETTING_RANGES.fontSize.max);
    expect(clampSetting('lineHeight', 1.8)).toBe(1.8);
  });

  it('falls back for a value that is not a finite number', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '18', null, undefined, {}]) {
      expect(clampSetting('fontSize', bad)).toBe(DEFAULT_SETTINGS.fontSize);
    }
  });

  it('reads a settings file written by an older build, giving new keys defaults', () => {
    const old = { theme: 'dark', autoSave: false };
    expect(coerceSettings(old)).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark', autoSave: false });
  });

  it('gives the three substitutions the answer the one switch used to hold', () => {
    // The reader turned typography off once. Splitting one switch into three is
    // not a reason to turn it back on for them.
    const old = coerceSettings({ theme: 'dark', smartTypography: false });
    expect(old.smartQuotes).toBe(false);
    expect(old.smartDashes).toBe(false);
    expect(old.smartEllipsis).toBe(false);
  });

  it('coerces an out-of-range stored value instead of refusing the whole file', () => {
    const stored = coerceSettings({ fontSize: 999, lineHeight: 0, widthMode: 'wide' });
    expect(stored.fontSize).toBe(SETTING_RANGES.fontSize.max);
    expect(stored.lineHeight).toBe(SETTING_RANGES.lineHeight.min);
    expect(stored.widthMode).toBe('wide');
  });

  it('reads web images as on unless the file says otherwise', () => {
    expect(coerceSettings({}).remoteImages).toBe(true);
    expect(coerceSettings({ remoteImages: false }).remoteImages).toBe(false);
    expect(coerceSettings({ remoteImages: 'no' }).remoteImages).toBe(true);
    expect(write({ remoteImages: false })).toBe(true);
    expect(write({ remoteImages: 'no' })).toBe(false);
  });

  it('refuses an out-of-range write rather than silently storing something else', () => {
    expect(write({ fontSize: 18 })).toBe(true);
    expect(write({ fontSize: SETTING_RANGES.fontSize.max + 1 })).toBe(false);
    expect(write({ fontSize: SETTING_RANGES.fontSize.min - 1 })).toBe(false);
    expect(write({ lineHeight: Number.NaN })).toBe(false);
    expect(write({ widthMode: 'wider' })).toBe(false);
    expect(write({ widthMode: 'full' })).toBe(true);
  });
});

describe('the custom stylesheet path', () => {
  it('accepts an absolute path and clearing it', () => {
    expect(write({ customCssPath: '/Users/someone/theme.css' })).toBe(true);
    expect(write({ customCssPath: '' })).toBe(true);
    expect(write({ customCssPath: 'C:\\Users\\someone\\theme.css' })).toBe(true);
  });

  it('refuses a relative path, an over-long one, and one carrying control characters', () => {
    expect(write({ customCssPath: 'theme.css' })).toBe(false);
    expect(write({ customCssPath: './theme.css' })).toBe(false);
    expect(write({ customCssPath: `/${'a'.repeat(1_100)}` })).toBe(false);
    expect(write({ customCssPath: '/tmp/theme.css\nrm -rf' })).toBe(false);
    expect(write({ customCssPath: '/tmp/theme\0.css' })).toBe(false);
  });

  it('drops an unusable stored path back to none', () => {
    expect(coerceSettings({ customCssPath: 'relative.css' }).customCssPath).toBe('');
    expect(coerceSettings({ customCssPath: 42 }).customCssPath).toBe('');
  });
});

describe('rail width range', () => {
  it('keeps a soft absolute ceiling for persistence, not a hard drag cap', () => {
    expect(SETTING_RANGES.railWidth.min).toBe(190);
    expect(SETTING_RANGES.railWidth.max).toBe(1800);
    expect(RAIL_WIDTH_FALLBACK_MAX).toBe(720);
    expect(RAIL_WIDTH_SCREEN_FRACTION).toBe(0.35);
    expect(clampSetting('railWidth', 640)).toBe(640);
    expect(clampSetting('railWidth', 900)).toBe(900);
    expect(clampSetting('railWidth', 2000)).toBe(1800);
    expect(write({ railWidth: 720 })).toBe(true);
    expect(write({ railWidth: 1800 })).toBe(true);
    expect(write({ railWidth: 1801 })).toBe(false);
  });

  it('caps the live drag max at 35% of the window width', () => {
    expect(railWidthMaxForScreen(1000)).toBe(350);
    expect(railWidthMaxForScreen(1920)).toBe(672);
    expect(railWidthMaxForScreen(400)).toBe(190); // floor(140) below min
    expect(railWidthMaxForScreen(Number.NaN)).toBe(RAIL_WIDTH_FALLBACK_MAX);
    expect(railWidthMaxForScreen(0)).toBe(RAIL_WIDTH_FALLBACK_MAX);
  });

  it('clamps an applied rail width into the live window range', () => {
    expect(clampRailWidth(500, 1000)).toBe(350);
    expect(clampRailWidth(100, 1000)).toBe(190);
    expect(clampRailWidth(300, 1000)).toBe(300);
    expect(clampRailWidth(Number.NaN, 1000)).toBe(DEFAULT_SETTINGS.railWidth);
  });
});

describe('document font family', () => {
  it('defaults to the Serif preset with no custom family', () => {
    expect(DEFAULT_SETTINGS.proseFace).toBe('serif');
    expect(DEFAULT_SETTINGS.proseFontFamily).toBe('');
    expect(coerceSettings({}).proseFontFamily).toBe('');
  });

  it('accepts a system family name and refuses quotes or oversize', () => {
    expect(write({ proseFontFamily: 'Songti SC' })).toBe(true);
    expect(write({ proseFontFamily: '' })).toBe(true);
    expect(write({ proseFontFamily: 'Bad"Name' })).toBe(false);
    expect(write({ proseFontFamily: 'x'.repeat(81) })).toBe(false);
  });
});

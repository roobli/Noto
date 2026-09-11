/**
 * Settings validation.
 *
 * A settings file is user-writable and survives upgrades, so it is exactly the
 * kind of input that arrives malformed. Every field is checked individually and
 * an unusable one falls back to its default rather than failing the whole read,
 * because losing one preference is better than starting with none.
 */

import {
  clampSetting,
  DEFAULT_SETTINGS,
  NOTO_SETTINGS_VERSION,
  SETTING_RANGES,
  WIDTH_MODES,
  type NotoNumericSetting,
  type NotoSettingsV1,
  type NotoTheme,
  type SettingsReplyV1,
  type SettingsRequestV1,
  type SettingsResultV1,
  type SettingsWriteRequestV1,
  type ThemeCssReplyV1,
  type WidthModeV1,
  IMAGE_DESTINATIONS,
  type ImageDestinationV1,
  PROSE_FACES,
  PROSE_FONT_FAMILY_MAX,
  type ProseFaceV1,
  TREE_SORTS,
  type SystemFontsReplyV1,
  type TreeSortV1,
  type RemoteStatusReplyV1,
} from './contracts';

const requestId = /^[A-Za-z0-9._:-]{1,96}$/;
const themes: readonly NotoTheme[] = ['light', 'dark', 'system'];
const isWidthMode = (value: unknown): value is WidthModeV1 =>
  (WIDTH_MODES as readonly unknown[]).includes(value);
const numericKeys = Object.keys(SETTING_RANGES) as NotoNumericSetting[];
const isNumericKey = (key: string): key is NotoNumericSetting =>
  (numericKeys as string[]).includes(key);

/**
 * A stylesheet path.
 *
 * Absolute, because a relative one is resolved against whatever the process
 * happens to consider its working directory. Bounded, and free of the NUL and
 * newline that would let a path smuggle a second argument into anything that
 * later logs or shells it.
 */
const isCssPath = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length <= 1024
  && !/[\0\r\n]/.test(value)
  && (value === '' || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value));

/** A font family name from the system list, or empty for the preset stack. */
const isProseFontFamily = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length <= PROSE_FONT_FAMILY_MAX
  && !/[\0\r\n"']/.test(value);

/**
 * The custom folder a picture is copied into.
 *
 * Relative to the note, or absolute. The traversal check here is not the guard:
 * main resolves the folder and refuses anything that does not land inside a
 * root it already trusts, which is the check that matters because it follows
 * symbolic links. This one refuses the obvious case at the boundary so a
 * setting that could never work is not stored in the first place.
 */
const isImageFolder = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length <= 512
  && !/[\0\r\n]/.test(value)
  && !value.split(/[\\/]/).includes('..');

const numeric = (value: Record<string, unknown>, key: NotoNumericSetting): number =>
  clampSetting(key, value[key]);

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof NotoSettingsV1)[];

/** One of the three substitutions, falling back to the switch they used to share. */
function substitution(value: Record<string, unknown>, key: 'smartQuotes' | 'smartDashes' | 'smartEllipsis'): boolean {
  if (typeof value[key] === 'boolean') return value[key];
  if (typeof value.smartTypography === 'boolean') return value.smartTypography;
  return DEFAULT_SETTINGS[key];
}

/** Read whatever is usable, and fall back for whatever is not. */
export function coerceSettings(value: unknown): NotoSettingsV1 {
  if (!record(value)) return DEFAULT_SETTINGS;
  return {
    theme: themes.includes(value.theme as NotoTheme) ? value.theme as NotoTheme : DEFAULT_SETTINGS.theme,
    proseFace: PROSE_FACES.includes(value.proseFace as ProseFaceV1)
      ? value.proseFace as ProseFaceV1
      : DEFAULT_SETTINGS.proseFace,
    proseFontFamily: isProseFontFamily(value.proseFontFamily)
      ? value.proseFontFamily
      : DEFAULT_SETTINGS.proseFontFamily,
    treeSort: TREE_SORTS.includes(value.treeSort as TreeSortV1)
      ? value.treeSort as TreeSortV1
      : DEFAULT_SETTINGS.treeSort,
    quickOpenWidth: value.quickOpenWidth === 'wide' ? 'wide' : DEFAULT_SETTINGS.quickOpenWidth,
    remoteControl: typeof value.remoteControl === 'boolean'
      ? value.remoteControl
      : DEFAULT_SETTINGS.remoteControl,
    markHighlight: typeof value.markHighlight === 'boolean' ? value.markHighlight : DEFAULT_SETTINGS.markHighlight,
    markSuperscript: typeof value.markSuperscript === 'boolean'
      ? value.markSuperscript
      : DEFAULT_SETTINGS.markSuperscript,
    markSubscript: typeof value.markSubscript === 'boolean' ? value.markSubscript : DEFAULT_SETTINGS.markSubscript,
    sidenotes: typeof value.sidenotes === 'boolean' ? value.sidenotes : DEFAULT_SETTINGS.sidenotes,
    fontSize: numeric(value, 'fontSize'),
    lineHeight: numeric(value, 'lineHeight'),
    widthMode: isWidthMode(value.widthMode) ? value.widthMode : DEFAULT_SETTINGS.widthMode,
    /* The three were one switch called `smartTypography`. A file written by
       the older build carries only that, and its answer stands for all three
       rather than being thrown away. */
    smartQuotes: substitution(value, 'smartQuotes'),
    smartDashes: substitution(value, 'smartDashes'),
    smartEllipsis: substitution(value, 'smartEllipsis'),
    spellCheck: typeof value.spellCheck === 'boolean' ? value.spellCheck : DEFAULT_SETTINGS.spellCheck,
    remoteImages: typeof value.remoteImages === 'boolean' ? value.remoteImages : DEFAULT_SETTINGS.remoteImages,
    codeLineNumbers: typeof value.codeLineNumbers === 'boolean'
      ? value.codeLineNumbers
      : DEFAULT_SETTINGS.codeLineNumbers,
    codeIndentGuides: typeof value.codeIndentGuides === 'boolean'
      ? value.codeIndentGuides
      : DEFAULT_SETTINGS.codeIndentGuides,
    codeTabMarkers: typeof value.codeTabMarkers === 'boolean'
      ? value.codeTabMarkers
      : DEFAULT_SETTINGS.codeTabMarkers,
    timelines: typeof value.timelines === 'boolean'
      ? value.timelines
      : DEFAULT_SETTINGS.timelines,
    codeViewer: typeof value.codeViewer === 'boolean'
      ? value.codeViewer
      : DEFAULT_SETTINGS.codeViewer,
    autoPair: typeof value.autoPair === 'boolean' ? value.autoPair : DEFAULT_SETTINGS.autoPair,
    todoCheckTime: typeof value.todoCheckTime === 'boolean'
      ? value.todoCheckTime
      : DEFAULT_SETTINGS.todoCheckTime,
    focusMode: typeof value.focusMode === 'boolean' ? value.focusMode : DEFAULT_SETTINGS.focusMode,
    typewriterMode: typeof value.typewriterMode === 'boolean'
      ? value.typewriterMode
      : DEFAULT_SETTINGS.typewriterMode,
    sidebarOnLaunch: typeof value.sidebarOnLaunch === 'boolean'
      ? value.sidebarOnLaunch
      : DEFAULT_SETTINGS.sidebarOnLaunch,
    railWidth: numeric(value, 'railWidth'),
    autoSave: typeof value.autoSave === 'boolean' ? value.autoSave : DEFAULT_SETTINGS.autoSave,
    autoSaveDelayMs: numeric(value, 'autoSaveDelayMs'),
    customCssPath: isCssPath(value.customCssPath)
      ? value.customCssPath
      : DEFAULT_SETTINGS.customCssPath,
    alwaysOnTop: typeof value.alwaysOnTop === 'boolean'
      ? value.alwaysOnTop
      : DEFAULT_SETTINGS.alwaysOnTop,
    reloadExternalChanges: typeof value.reloadExternalChanges === 'boolean'
      ? value.reloadExternalChanges
      : DEFAULT_SETTINGS.reloadExternalChanges,
    imageDestination: IMAGE_DESTINATIONS.includes(value.imageDestination as ImageDestinationV1)
      ? value.imageDestination as ImageDestinationV1
      : DEFAULT_SETTINGS.imageDestination,
    imageCustomFolder: isImageFolder(value.imageCustomFolder)
      ? value.imageCustomFolder
      : DEFAULT_SETTINGS.imageCustomFolder,
    imageEscapeUrl: typeof value.imageEscapeUrl === 'boolean'
      ? value.imageEscapeUrl
      : DEFAULT_SETTINGS.imageEscapeUrl,
    fileTags: typeof value.fileTags === 'boolean'
      ? value.fileTags
      : DEFAULT_SETTINGS.fileTags,
  };
}

/**
 * A patch from the renderer.
 *
 * Stricter than a read: an unknown key or a wrong type is rejected outright
 * rather than dropped, because a write that silently does nothing is worse than
 * one that reports failure.
 */
export function isSettingsWriteRequestV1(value: unknown): value is SettingsWriteRequestV1 {
  if (!record(value) || value.version !== NOTO_SETTINGS_VERSION
    || typeof value.requestId !== 'string' || !requestId.test(value.requestId)
    || !record(value.patch)) return false;

  const patch = value.patch;
  const keys = Object.keys(patch);
  if (keys.length === 0 || keys.length > SETTING_KEYS.length) return false;
  return keys.every((key) => {
    if (!SETTING_KEYS.includes(key as keyof NotoSettingsV1)) return false;
    if (key === 'theme') return themes.includes(patch.theme as NotoTheme);
    if (key === 'widthMode') return isWidthMode(patch.widthMode);
    if (key === 'proseFace') return PROSE_FACES.includes(patch.proseFace as ProseFaceV1);
    if (key === 'proseFontFamily') return isProseFontFamily(patch.proseFontFamily);
    if (key === 'treeSort') return TREE_SORTS.includes(patch.treeSort as TreeSortV1);
    if (key === 'quickOpenWidth') return patch.quickOpenWidth === 'default' || patch.quickOpenWidth === 'wide';
    if (key === 'customCssPath') return isCssPath(patch.customCssPath);
    if (key === 'imageDestination') return IMAGE_DESTINATIONS.includes(patch.imageDestination as ImageDestinationV1);
    if (key === 'imageCustomFolder') return isImageFolder(patch.imageCustomFolder);
    // Out of range is refused rather than clamped: a write says what it wants,
    // and silently storing something else is the kind of disagreement that
    // shows up later as a control that will not move.
    if (isNumericKey(key)) {
      const candidate = patch[key];
      const range = SETTING_RANGES[key];
      return typeof candidate === 'number' && Number.isFinite(candidate)
        && candidate >= range.min && candidate <= range.max;
    }
    return typeof patch[key] === 'boolean';
  });
}

export function isRemoteStatusReplyV1(value: unknown): value is RemoteStatusReplyV1 {
  return record(value) && Object.keys(value).length === 5
    && value.version === NOTO_SETTINGS_VERSION
    && typeof value.listening === 'boolean'
    && (value.port === null || (typeof value.port === 'number' && Number.isSafeInteger(value.port)))
    && typeof value.token === 'string' && value.token.length <= 256
    && typeof value.problem === 'string' && value.problem.length <= 512;
}

export function isRemoteStatusResultV1(
  value: unknown,
  expectedRequestId: string,
): value is SettingsResultV1<RemoteStatusReplyV1> {
  if (!record(value) || value.requestId !== expectedRequestId) return false;
  if (value.ok === true) return isRemoteStatusReplyV1(value.value);
  return value.ok === false && record(value.error)
    && typeof value.error.code === 'string' && typeof value.error.message === 'string';
}

export function isSettingsRequestV1(value: unknown): value is SettingsRequestV1 {
  return record(value) && value.version === NOTO_SETTINGS_VERSION
    && Object.keys(value).length === 2
    && typeof value.requestId === 'string' && requestId.test(value.requestId);
}

export function isSettingsReplyV1(value: unknown): value is SettingsReplyV1 {
  if (!record(value) || value.version !== NOTO_SETTINGS_VERSION || !record(value.settings)) return false;
  const settings = value.settings;
  return themes.includes(settings.theme as NotoTheme)
    && isWidthMode(settings.widthMode)
    && numericKeys.every((key) => typeof settings[key] === 'number' && Number.isFinite(settings[key]))
    && typeof settings.smartQuotes === 'boolean'
    && typeof settings.smartDashes === 'boolean'
    && typeof settings.smartEllipsis === 'boolean'
    && typeof settings.spellCheck === 'boolean'
    && typeof settings.remoteImages === 'boolean'
    && typeof settings.codeLineNumbers === 'boolean'
    && typeof settings.codeIndentGuides === 'boolean'
    && typeof settings.codeTabMarkers === 'boolean'
    && typeof settings.timelines === 'boolean'
    && typeof settings.codeViewer === 'boolean'
    && typeof settings.sidenotes === 'boolean'
    && typeof settings.fileTags === 'boolean'
    && typeof settings.autoPair === 'boolean'
    && typeof settings.todoCheckTime === 'boolean'
    && typeof settings.focusMode === 'boolean'
    && typeof settings.typewriterMode === 'boolean'
    && typeof settings.sidebarOnLaunch === 'boolean'
    && typeof settings.autoSave === 'boolean'
    && typeof settings.imageEscapeUrl === 'boolean'
    && typeof settings.reloadExternalChanges === 'boolean'
    && typeof settings.alwaysOnTop === 'boolean'
    && IMAGE_DESTINATIONS.includes(settings.imageDestination as ImageDestinationV1)
    && isImageFolder(settings.imageCustomFolder)
    && isCssPath(settings.customCssPath)
    && PROSE_FACES.includes(settings.proseFace as ProseFaceV1)
    && isProseFontFamily(settings.proseFontFamily);
}

export function isSystemFontsReplyV1(value: unknown): value is SystemFontsReplyV1 {
  return record(value) && value.version === NOTO_SETTINGS_VERSION
    && Array.isArray(value.families)
    && value.families.length <= 800
    && value.families.every((name) => typeof name === 'string' && name.length > 0
      && name.length <= PROSE_FONT_FAMILY_MAX && !/[\0\r\n"']/.test(name));
}

export function isSystemFontsResultV1(
  value: unknown,
  expectedRequestId: string,
): value is SettingsResultV1<SystemFontsReplyV1> {
  if (!record(value) || value.requestId !== expectedRequestId) return false;
  if (value.ok === true) return isSystemFontsReplyV1(value.value);
  return value.ok === false && record(value.error)
    && typeof value.error.code === 'string' && typeof value.error.message === 'string';
}

export function isSettingsResultV1(
  value: unknown,
  expectedRequestId: string,
): value is SettingsResultV1<SettingsReplyV1> {
  if (!record(value) || value.requestId !== expectedRequestId) return false;
  if (value.ok === true) return isSettingsReplyV1(value.value);
  return value.ok === false && record(value.error)
    && typeof value.error.code === 'string' && typeof value.error.message === 'string';
}

export function isThemeCssReplyV1(value: unknown): value is ThemeCssReplyV1 {
  return record(value) && value.version === NOTO_SETTINGS_VERSION
    && typeof value.css === 'string' && typeof value.problem === 'string';
}

export function isThemeCssResultV1(
  value: unknown,
  expectedRequestId: string,
): value is SettingsResultV1<ThemeCssReplyV1> {
  if (!record(value) || value.requestId !== expectedRequestId) return false;
  if (value.ok === true) return isThemeCssReplyV1(value.value);
  return value.ok === false && record(value.error)
    && typeof value.error.code === 'string' && typeof value.error.message === 'string';
}

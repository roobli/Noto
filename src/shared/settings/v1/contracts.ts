/**
 * User settings.
 *
 * Deliberately short. Every setting here changes something the user can see,
 * and each one is a promise to keep working: a preference that outlives its
 * feature becomes dead weight in a file we still have to read and migrate.
 *
 * Main owns the stored value so the choice survives a reload and applies to
 * every window, and so the renderer never writes to disk directly.
 */

export const NOTO_SETTINGS_VERSION = 1 as const;

export const SETTINGS_CHANNELS = {
  read: 'noto:v1:settings:read',
  write: 'noto:v1:settings:write',
  changed: 'noto:v1:settings:changed',
  /** Reads the stylesheet at `customCssPath`. Main owns the path; the renderer
   *  never names a file, so this cannot be pointed at anything else. */
  themeCss: 'noto:v1:settings:theme-css',
  /** What the remote control is doing, and a way to ask for a new token. */
  remoteStatus: 'noto:v1:settings:remote-status',
  remoteRegenerate: 'noto:v1:settings:remote-regenerate',
} as const;

/** `system` follows the operating system, which is the honest default. */
export type NotoTheme = 'light' | 'dark' | 'system';

/**
 * Numeric settings, with the range each one is clamped to.
 *
 * Bounds rather than free numbers because these reach CSS: a line height of 40
 * or a text size of 400 does not produce an unusual document, it produces an
 * unusable window with no way back except editing the settings file by hand.
 * The floor is as important as the ceiling for the same reason.
 */
export const SETTING_RANGES = Object.freeze({
  fontSize: { min: 13, max: 26, step: 1 },
  lineHeight: { min: 1.3, max: 2.2, step: 0.02 },
  autoSaveDelayMs: { min: 400, max: 10_000, step: 100 },
  /* A vault six levels deep spends 90px of the rail on indentation before the
     first character of a filename. 248px was chosen against a shallow fixture
     and leaves five siblings all reading "Done_TaskGro…" in a real one, so the
     width has to be the reader's to set. Cap was 520; deep RooB-style trees
     still truncated at that width, so the drag range now reaches 720. */
  railWidth: { min: 190, max: 720, step: 1 },
} as const);

export type NotoNumericSetting = keyof typeof SETTING_RANGES;

/**
 * The three widths of the writing column, in the order `Cmd+]` walks them.
 *
 * Modes rather than a number, because the width is not a number the reader
 * owns: it is a share of whatever canvas is left beside the rail, capped so a
 * paragraph never runs across a 27-inch display. The share and the cap for each
 * mode live in the stylesheet, where the canvas width is known, and each one is
 * `min(canvas - gutters, cap)`. That last clause is the rule the whole thing
 * exists for: the column is never wider than the canvas it sits in, so the
 * document never scrolls sideways, whatever the mode and however narrow the
 * window.
 *
 * `default` is the reading column, up to 860px, which is the width of Typora's
 * own page. `wide` is 78% of the canvas held between 1000px and 1180px, for a
 * code block that runs past the reading column. `full` is everything beside
 * the rail, up to 1680px. Ported from the author's `wider` plugin for Typora,
 * whose numbers were tuned against a real vault.
 */
export const WIDTH_MODES = ['default', 'wide', 'full'] as const;

export type WidthModeV1 = (typeof WIDTH_MODES)[number];

/**
 * The next mode in `direction`, wrapping at either end.
 *
 * A ring rather than a line, as in the plugin: the chord is a single motion
 * ("make it wider") and a press that does nothing at the end of the range reads
 * as a key that is broken rather than as a limit reached.
 */
export function stepWidthMode(current: WidthModeV1, direction: 1 | -1): WidthModeV1 {
  const at = Math.max(0, WIDTH_MODES.indexOf(current));
  return WIDTH_MODES[(at + direction + WIDTH_MODES.length) % WIDTH_MODES.length];
}

/**
 * Where a pasted or dropped picture is put, which is the only choice in the
 * image pane that changes what lands in the vault.
 *
 * `upload` is Typora's "Upload image": the picture goes to PicGo.app, which
 * this vault already uses for 2,486 of its pictures, and the note refers to the
 * address that comes back. It is written beside the note first and that copy
 * is removed once the address arrives, so a paste while PicGo is not running
 * leaves a picture in the vault rather than nothing at all.
 *
 * Typora offers the same choices and its own default is `assets`, a folder beside
 * the note. That is the one that keeps a note portable: the note and its
 * pictures move together, and nothing lands loose in the folder the reader is
 * looking at. `note-assets` is the same idea with a folder per note, for a
 * vault where one note owns forty screenshots. `folder` writes beside the note.
 * `custom` is for a vault that already has a pictures folder and wants it used.
 */
export const IMAGE_DESTINATIONS = ['assets', 'note-assets', 'folder', 'custom', 'upload'] as const;

export type ImageDestinationV1 = (typeof IMAGE_DESTINATIONS)[number];

/**
 * The faces a document can be set in.
 *
 * Typora's Appearance pane offers a font, and a reader of Chinese cares
 * which: a Song face for reading, a Hei face for the screen, a mono face
 * for a note that is mostly code. Named rather than free text, because a
 * name the machine does not have is a note set in Times and no way to see
 * why; each of these carries the fallbacks the theme already lists.
 */
export const PROSE_FACES = ['serif', 'sans', 'mono'] as const;

export type ProseFaceV1 = (typeof PROSE_FACES)[number];

/** How the file tree is ordered. Typora's sidebar offers the same choice. */
export const TREE_SORTS = ['name', 'name-desc', 'modified', 'modified-old'] as const;

export type TreeSortV1 = (typeof TREE_SORTS)[number];

export interface NotoSettingsV1 {
  readonly theme: NotoTheme;
  /** The order of the rows in the file tree. See `TREE_SORTS`. */
  readonly treeSort: TreeSortV1;
  /**
   * The inline syntax Typora adds to markdown, each on its own switch.
   *
   * `==highlight==` is safe anywhere, but `^x^` and `~x~` are a caret and a
   * tilde in ordinary prose as often as they are a mark, and a note full of
   * file names or maths is better off with them read as the characters they
   * are. Typora's Markdown pane offers the same three.
   */
  /**
   * Whether the editor can be driven from outside it.
   *
   * Off until it is switched on, and the status line says while it is on.
   * The port and the token live in main, which is what listens.
   */
  /**
   * How wide quick open is drawn, which the bracket keys change while it is
   * open. A preference because a reader who wants the wide one wants it every
   * time, as they do for the document's own column.
   */
  readonly quickOpenWidth: 'default' | 'wide';
  readonly remoteControl: boolean;
  readonly markHighlight: boolean;
  readonly markSuperscript: boolean;
  readonly markSubscript: boolean;
  /**
   * Draw `<span class="sidenote">` as a numbered margin note.
   *
   * On by default, as the author's Typora `sidenote` plugin is. Off leaves
   * the tags as ordinary inline HTML source.
   */
  readonly sidenotes: boolean;
  /** Which face the document is set in. See `PROSE_FACES`. */
  readonly proseFace: ProseFaceV1;
  /** Document text size in CSS pixels. */
  readonly fontSize: number;
  /** Unitless line height for document text. */
  readonly lineHeight: number;
  /** How much of the canvas the text column takes. See `WIDTH_MODES`. */
  readonly widthMode: WidthModeV1;
  /** Turn quotes and dashes into their typographic forms as you type. */
  /*
   * The three substitutions, each on its own switch.
   *
   * They were one, and one is the wrong number: a reader who wants an em dash
   * typed for them very often does not want their quotes curled, because a
   * curled quote inside a code span or a shell command is wrong in a way a
   * dash never is. Typora keeps them apart on its Edit menu for the same
   * reason.
   */
  readonly smartQuotes: boolean;
  readonly smartDashes: boolean;
  readonly smartEllipsis: boolean;
  readonly spellCheck: boolean;
  /**
   * Show images that live on the web.
   *
   * On by default, because a third of the author's notes embed one and a
   * picture that does not appear is a broken note. Every one is a request to
   * the server that holds it, though, which is why it is a switch and why the
   * switch says so. Local images are not affected: they are served by main
   * from the open folder and never leave the machine.
   */
  readonly remoteImages: boolean;
  /**
   * Number the lines of every code block.
   *
   * On by default, as the author's own Typora is set. The gutter is as wide
   * as each block's line count needs, which is the `fence-enhance` plugin's
   * rule rather than Typora's fixed width.
   */
  readonly codeLineNumbers: boolean;
  /**
   * Vertical rules at each tab stop of a code line's indentation.
   *
   * On by default, as the author's `fence-enhance` plugin is set. Drawn on the
   * indentation itself, so a document of ten thousand code lines gains no
   * elements for them.
   */
  readonly codeIndentGuides: boolean;
  /**
   * Mark each tab character inside a code block with a quiet arrow.
   *
   * On by default, completing the author's `fence-enhance` port: line numbers,
   * language, copy, indent guides, and now the tab markers. Drawn on the tab
   * itself, so a document gains no elements for lines that hold none.
   */
  readonly codeTabMarkers: boolean;
  /**
   * Draw a `timeline` fence as a vertical chronology.
   *
   * On by default, matching the author's Typora timeline plugin. Off leaves
   * the fence as ordinary source.
   */
  readonly timelines: boolean;
  /**
   * Open non-Markdown text and code files in a read-only viewer.
   *
   * On by default, matching the author's typora-plugin-lite `code-viewer`.
   * Off leaves the tree and Open path as Markdown-only.
   */
  readonly codeViewer: boolean;
  /**
   * Close a bracket or a quote as it is opened.
   *
   * On, as the author's Typora is set. It never pairs in the middle of a word,
   * so an apostrophe stays an apostrophe, and typing a closing bracket where
   * one already sits walks past it rather than doubling it.
   */
  readonly autoPair: boolean;
  /**
   * Append ` ✅ YYYY-MM-DD` when a task is checked.
   *
   * On by default: the author's todo-manager writes the check time into the
   * note so a finished item stays dated without a plugin. Off leaves ticking
   * as a bare `[x]`.
   */
  readonly todoCheckTime: boolean;
  /**
   * Dim every block but the one the caret is in.
   *
   * Typora calls this focus mode. It is off by default: it is a thing you
   * reach for when a draft is fighting you, not a way to read.
   */
  readonly focusMode: boolean;
  /**
   * Keep the line being typed at the middle of the window.
   *
   * Typora calls this typewriter mode. Off by default for the same reason,
   * and because it moves the page under the reader, which is startling until
   * it is asked for.
   */
  readonly typewriterMode: boolean;
  /** Show the workspace tree when the app starts. */
  readonly sidebarOnLaunch: boolean;
  /** Width of the navigation rail, in CSS pixels. Dragged, not typed. */
  readonly railWidth: number;
  /**
   * Save on a timer after typing stops.
   *
   * Off by default. Noto refuses a save whose file has changed underneath it,
   * and an automatic save turns that refusal into something that happens while
   * nobody is looking, so it is a choice rather than a default.
   */
  readonly autoSave: boolean;
  readonly autoSaveDelayMs: number;
  /**
   * Absolute path to a stylesheet layered over the theme, or '' for none.
   *
   * A path rather than the stylesheet itself: a theme is a file someone edits
   * in their own editor and reloads, not a blob pasted into a preferences
   * field.
   */
  readonly customCssPath: string;
  /** Keep the window above every other, for writing beside something else. */
  readonly alwaysOnTop: boolean;
  /**
   * Take an external edit into a note with no unsaved changes, without asking.
   *
   * There is deliberately no second setting for the other case. A note with
   * unsaved changes is never replaced silently whatever this says, because
   * never losing what the reader wrote is not a preference.
   */
  readonly reloadExternalChanges: boolean;
  /** Where a pasted or dropped picture is written. See `IMAGE_DESTINATIONS`. */
  readonly imageDestination: ImageDestinationV1;
  /** The folder `custom` uses, relative to the note when it is not absolute. */
  readonly imageCustomFolder: string;
  /** Percent-encode the reference, so a space in a folder name still resolves. */
  readonly imageEscapeUrl: boolean;
  /**
   * Show a note's frontmatter tags and let them open other notes that share one.
   *
   * On by default: the author's vault already carries `tags:` on nearly a
   * hundred notes, and the brief for file-tags was multi-file linking by tag
   * without needing a plugin to read the file. Off hides the chips and the
   * Browse Tags command's panel still works from the menu only when on.
   */
  readonly fileTags: boolean;
}

export const DEFAULT_SETTINGS: NotoSettingsV1 = Object.freeze({
  theme: 'system',
  // A step under the author's theme, which reads at 16px in Typora: set beside
  // it, Noto's 16 looked a size louder, and 15 is where the two windows match
  // to his eye. The leading is the theme's.
  proseFace: 'serif',
  treeSort: 'name',
  quickOpenWidth: 'default',
  remoteControl: false,
  markHighlight: true,
  markSuperscript: true,
  markSubscript: true,
  sidenotes: true,
  fontSize: 15,
  lineHeight: 1.58,
  widthMode: 'default',
  // On by default because it is what a writing tool should do, and it is
  // reversible per document by undoing the substitution.
  smartQuotes: true,
  smartDashes: true,
  smartEllipsis: true,
  spellCheck: true,
  remoteImages: true,
  codeLineNumbers: true,
  codeIndentGuides: true,
  codeTabMarkers: true,
  timelines: true,
  codeViewer: true,
  autoPair: true,
  todoCheckTime: true,
  focusMode: false,
  typewriterMode: false,
  sidebarOnLaunch: false,
  railWidth: 272,
  autoSave: false,
  autoSaveDelayMs: 1_200,
  customCssPath: '',
  // Typora's own default, and the one that keeps a note portable: the note and
  // its pictures move together.
  alwaysOnTop: false,
  reloadExternalChanges: true,
  imageDestination: 'assets',
  imageCustomFolder: './images',
  imageEscapeUrl: true,
  fileTags: true,
});

/** Clamp to the declared range and drop anything that is not a real number. */
export function clampSetting(key: NotoNumericSetting, value: unknown): number {
  const range = SETTING_RANGES[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SETTINGS[key];
  return Math.min(range.max, Math.max(range.min, value));
}

export interface SettingsRequestV1 {
  readonly version: typeof NOTO_SETTINGS_VERSION;
  readonly requestId: string;
}

export interface SettingsWriteRequestV1 extends SettingsRequestV1 {
  /** Only the keys being changed, so two writers cannot clobber each other. */
  readonly patch: Partial<NotoSettingsV1>;
}

export interface SettingsReplyV1 {
  readonly version: typeof NOTO_SETTINGS_VERSION;
  readonly settings: NotoSettingsV1;
}

export type SettingsResultV1<T> =
  | { readonly ok: true; readonly requestId: string; readonly value: T }
  | {
      readonly ok: false;
      readonly requestId: string;
      readonly error: { readonly code: string; readonly message: string };
    };

export interface ThemeCssReplyV1 {
  readonly version: typeof NOTO_SETTINGS_VERSION;
  /** The stylesheet's text, or '' when no path is set or it cannot be read. */
  readonly css: string;
  /** What went wrong, for the preferences row to show. '' when it did not. */
  readonly problem: string;
}

/** Past this, a stylesheet is a mistake rather than a theme. */
export const THEME_CSS_MAX_BYTES = 512 * 1024;

/**
 * What the remote control is doing right now.
 *
 * The token is here because the reader has to be able to give it to whatever
 * they are driving the editor from, and it is only ever sent to this app's
 * own window over the channel the preload defines.
 */
export interface RemoteStatusReplyV1 {
  readonly version: typeof NOTO_SETTINGS_VERSION;
  readonly listening: boolean;
  readonly port: number | null;
  readonly token: string;
  /** Empty unless it could not start, in which case this says why. */
  readonly problem: string;
}

export interface NotoSettingsApiV1 {
  read(request: SettingsRequestV1): Promise<SettingsResultV1<SettingsReplyV1>>;
  write(request: SettingsWriteRequestV1): Promise<SettingsResultV1<SettingsReplyV1>>;
  readThemeCss(request: SettingsRequestV1): Promise<SettingsResultV1<ThemeCssReplyV1>>;
  remoteStatus(request: SettingsRequestV1): Promise<SettingsResultV1<RemoteStatusReplyV1>>;
  regenerateRemoteToken(request: SettingsRequestV1): Promise<SettingsResultV1<RemoteStatusReplyV1>>;
  onChanged(listener: (event: SettingsReplyV1) => void): () => void;
}

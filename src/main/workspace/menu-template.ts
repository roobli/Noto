/**
 * What the application menu contains, as a description rather than a menu.
 *
 * Separated from building the real menu so the platform differences can be
 * checked. macOS expects an application menu holding About and Quit while
 * Windows and Linux expect those under File and Help, and Redo is bound
 * differently on each. Those are claims about behaviour, and while the platform
 * was read from `process.platform` in the middle of the builder there was no
 * way to test any of them except by running on three machines.
 *
 * Nothing here imports a value from Electron, only types, so it can be built
 * and inspected outside a running app.
 */

import type { TreeSortV1 } from '../../shared/settings/v1/contracts';
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';
import type { RecentFileV1, WorkspaceMenuCommandV1 } from '../../shared/workspace/v1/contracts';
import { EXPORT_TARGETS, exportShape, needsPandoc } from './export-document';

/** The two Noto draws itself, and the formats Pandoc writes, in menu order. */
const RENDERED_EXPORTS = EXPORT_TARGETS.filter((target) => !needsPandoc(target));
const PANDOC_EXPORTS = EXPORT_TARGETS.filter(needsPandoc);

export interface MenuActions {
  /** Choose the folder shown in the sidebar. */
  openFolder: () => void;
  /** Close whichever document is in front. */
  closeTab: () => void;
  /** Open again the document closed most recently. */
  reopenClosed: () => void;
  openDialog: () => void;
  openPath: (filePath: string) => void;
  /** Convert a document that is not markdown and open the result. */
  importDocument: () => void;
  /** The system print dialog for the window, which prints the note alone. */
  print: () => void;
  /** Paste the clipboard's text, read as markdown, with any richer form ignored. */
  pastePlain: () => void;
  /** Use the stylesheet at this path, or none for the built-in look. */
  chooseTheme: (themePath: string) => void;
  /** Show the themes folder in the file manager, so one can be added. */
  openThemeFolder: () => void;
  clearRecent: () => void;
  /** Quiet check against the chosen GitHub Releases channel. */
  checkUpdates: () => void;
}

export interface MenuTemplateOptions {
  readonly platform: NodeJS.Platform;
  /** Shown as the application menu's title on macOS. */
  readonly appName: string;
  readonly recent: readonly RecentFileV1[];
  readonly actions: MenuActions;
  /** Sends a command to the renderer, which owns the editor's contents. */
  readonly sendCommand: (command: WorkspaceMenuCommandV1) => void;
  readonly openExternal: (url: string) => void;
  /**
   * The two things in this menu that show a tick.
   *
   * Passed in rather than remembered here, so the menu is a pure function of
   * what it is given and the state has exactly one home.
   */
  readonly state?: {
    readonly readOnly: boolean;
    readonly alwaysOnTop: boolean;
    /** What the note in front will be written with. Per document, not a setting. */
    readonly lineEnding?: 'lf' | 'crlf' | 'mixed';
    readonly finalNewline?: boolean;
    /** The order the file tree is in, which is a setting rather than a document's. */
    readonly treeSort?: TreeSortV1;
    /** The stylesheets on offer, and the one in use, for the Themes menu. */
    readonly themes?: readonly { readonly path: string; readonly label: string }[];
    readonly themePath?: string;
  };
}

function recentSubmenu(
  recent: readonly RecentFileV1[],
  actions: MenuActions,
): MenuItemConstructorOptions {
  const items: MenuItemConstructorOptions[] = recent.length === 0
    ? [{ label: 'No recent documents', enabled: false }]
    : recent.map((file) => ({
        label: file.name,
        toolTip: file.path,
        click: () => actions.openPath(file.path),
      }));
  if (recent.length > 0) {
    items.push({ type: 'separator' }, { label: 'Clear menu', click: () => actions.clearRecent() });
  }
  return { label: 'Open Recent', submenu: items };
}

export function buildMenuTemplate(options: MenuTemplateOptions): MenuItemConstructorOptions[] {
  const { platform, appName, recent, actions, sendCommand, openExternal } = options;
  const state = options.state ?? { readOnly: false, alwaysOnTop: false };
  const lineEnding = state.lineEnding ?? 'lf';
  const finalNewline = state.finalNewline ?? true;
  const treeSort = state.treeSort ?? 'name';
  const themes = state.themes ?? [];
  const themePath = state.themePath ?? '';
  const mac = platform === 'darwin';

  // Each command item carries its command as its id, so the menu can be driven
  // programmatically. Native accelerators are not reachable from an automated
  // keystroke, and testing the accelerator instead of the item would prove less.
  const command = (
    label: string,
    accelerator: string | undefined,
    value: WorkspaceMenuCommandV1,
  ): MenuItemConstructorOptions => ({
    id: value,
    label,
    ...(accelerator === undefined ? {} : { accelerator }),
    click: () => sendCommand(value),
  });

  const fileMenu: MenuItemConstructorOptions = {
    label: '&File',
    submenu: [
      command('New Note', 'CmdOrCtrl+N', 'new-file'),
      { id: 'open-dialog', label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => actions.openDialog() },
      // Not Option and Command with O: Typora gives that pair to Ordered List,
      // and a menu accelerator wins over the editor's own keys. Opening a
      // folder happens once a session; making a list happens all day.
      { id: 'open-folder', label: 'Open Folder…', accelerator: 'CmdOrCtrl+Alt+Shift+O', click: () => actions.openFolder() },
      // The fastest way into a vault of a few thousand notes, so it sits with
      // the other ways of opening one rather than under a search menu.
      command('Quick Open…', 'CmdOrCtrl+P', 'quick-open'),
      // The author's own palette answers to Command-period, and a hand that
      // has learned it should not have to learn another. Hidden from the menu
      // so the item shows one chord rather than two, and bound all the same.
      {
        id: 'quick-open-period',
        label: 'Quick Open',
        accelerator: 'CmdOrCtrl+.',
        visible: false,
        click: () => sendCommand('quick-open'),
      },
      // Closed in main rather than sent to the renderer: main owns which
      // documents are open, so asking the renderer which one is in front would
      // race against the tab list arriving there.
      { id: 'close-tab', label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => actions.closeTab() },
      { id: 'reopen-closed', label: 'Reopen Closed File', accelerator: 'Shift+CmdOrCtrl+T', click: () => actions.reopenClosed() },
      recentSubmenu(recent, actions),
      command(
        mac ? 'Reveal in Finder' : platform === 'win32' ? 'Reveal in File Explorer' : 'Reveal in File Manager',
        'CmdOrCtrl+Shift+R',
        'reveal-document',
      ),
      { type: 'separator' },
      // Not a renderer command: the dialog, the conversion and the file all
      // belong to main, exactly as Open does, so nothing about it has to cross
      // the boundary and come back.
      { id: 'import-document', label: 'Import…', click: () => actions.importDocument() },
      {
        label: 'Export',
        submenu: [
          // The two Noto renders itself, because what they are for is how the
          // note looks. Everything below is a conversion of the markdown.
          ...RENDERED_EXPORTS.map((target) =>
            command(`${exportShape(target).label}…`, undefined, `export-${target}` as WorkspaceMenuCommandV1)),
          { type: 'separator' },
          ...PANDOC_EXPORTS.map((target) =>
            command(`${exportShape(target).label}…`, undefined, `export-${target}` as WorkspaceMenuCommandV1)),
        ],
      },
      // Typora's Print, and the Mac's: the window prints itself with the
      // chrome hidden by the print stylesheet, so nothing crosses the
      // boundary and the dialog is the system's own on this window.
      { id: 'print', label: 'Print…', accelerator: 'CmdOrCtrl+Alt+P', click: () => actions.print() },
      { type: 'separator' },
      command('Reload from Disk', 'CmdOrCtrl+R', 'reload-from-disk'),
      { type: 'separator' },
      command('Save', 'CmdOrCtrl+S', 'save'),
      command('Save a Copy…', 'CmdOrCtrl+Shift+S', 'save-as'),
      { type: 'separator' },
      // Quit belongs to the application menu on macOS, so File closes instead.
      // Close Tab has Command-W; the window closes on Typora's Shift-Command-W.
      mac ? { role: 'close', label: 'Close Window', accelerator: 'Shift+CmdOrCtrl+W' } : { role: 'quit' },
    ],
  };

  const editMenu: MenuItemConstructorOptions = {
    label: '&Edit',
    submenu: [
      // Not the undo and redo roles. Those call `webContents.undo`, which runs
      // the browser's own undo against the contenteditable and never reaches
      // ProseMirror's history, so an edit would appear to be un-undoable.
      command('Undo', 'CmdOrCtrl+Z', 'undo'),
      command('Redo', mac ? 'Shift+CmdOrCtrl+Z' : 'CmdOrCtrl+Y', 'redo'),
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      // Typora's, on its chord: the text on the clipboard read as markdown,
      // with the rich form ignored. Main reads the clipboard for it.
      { id: 'paste-plain', label: 'Paste as Plain Text', accelerator: 'Shift+CmdOrCtrl+V', click: () => actions.pastePlain() },
      { role: 'selectAll' },
      // Typora's own three, on its chords.
      command('Select Word', 'CmdOrCtrl+D', 'select-word'),
      command('Select Line', 'CmdOrCtrl+L', 'select-line'),
      command('Jump to Selection', 'CmdOrCtrl+J', 'jump-to-selection'),
      command('Select Styled Scope', 'CmdOrCtrl+E', 'select-scope'),
      { type: 'separator' },
      // Plain copy already puts markdown on the clipboard, which is what a
      // markdown editor should do. These are the three other things a reader
      // might mean, in the order Typora lists them.
      command('Copy as Plain Text', undefined, 'copy-as-plain'),
      command('Copy as Markdown', 'CmdOrCtrl+Shift+C', 'copy-as-markdown'),
      command('Copy as HTML', undefined, 'copy-as-html'),
      { type: 'separator' },
      {
        // Per document, like Typora: what this file is written with, not a
        // preference about what new files should be.
        label: 'Line Endings',
        submenu: [
          {
            id: 'line-endings-lf',
            label: 'Unix Line Endings (LF)',
            type: 'radio',
            checked: lineEnding === 'lf',
            click: () => sendCommand('line-endings-lf'),
          },
          {
            id: 'line-endings-crlf',
            label: 'Windows Line Endings (CRLF)',
            type: 'radio',
            checked: lineEnding === 'crlf',
            click: () => sendCommand('line-endings-crlf'),
          },
          { type: 'separator' },
          {
            id: 'toggle-final-newline',
            label: 'Insert Final New Line on Save',
            type: 'checkbox',
            checked: finalNewline,
            click: () => sendCommand('toggle-final-newline'),
          },
        ],
      },
      { type: 'separator' },
      command('Find…', 'CmdOrCtrl+F', 'find'),
      command('Find Next', 'CmdOrCtrl+G', 'find-next'),
      command('Find Previous', 'CmdOrCtrl+Shift+G', 'find-previous'),
      command('Find and Replace…', 'CmdOrCtrl+Alt+F', 'find-replace'),
      // The name every editor gives this, so nobody has to look for it.
      command('Find in Notes…', 'CmdOrCtrl+Shift+F', 'search-content'),
      // Command and K belongs to the hyperlink, in Typora and in every editor
      // that has both. The palette takes the other near universal chord.
      command('Command Palette…', 'CmdOrCtrl+Shift+P', 'command-palette'),
      { type: 'separator' },
      command('Settings…', 'CmdOrCtrl+,', 'settings'),
    ],
  };

  /**
   * Typora's Paragraph menu, so the block shapes are somewhere a hand can find
   * them. Every item runs the same editor command its shortcut runs, and the
   * shortcuts are Typora's own.
   */
  const paragraphMenu: MenuItemConstructorOptions = {
    label: '&Paragraph',
    submenu: [
      command('Heading 1', 'CmdOrCtrl+1', 'block-heading-1'),
      command('Heading 2', 'CmdOrCtrl+2', 'block-heading-2'),
      command('Heading 3', 'CmdOrCtrl+3', 'block-heading-3'),
      command('Heading 4', 'CmdOrCtrl+4', 'block-heading-4'),
      command('Heading 5', 'CmdOrCtrl+5', 'block-heading-5'),
      command('Heading 6', 'CmdOrCtrl+6', 'block-heading-6'),
      command('Paragraph', 'CmdOrCtrl+0', 'block-paragraph'),
      { type: 'separator' },
      command('Increase Heading Level', 'CmdOrCtrl+=', 'block-heading-up'),
      command('Decrease Heading Level', 'CmdOrCtrl+-', 'block-heading-down'),
      { type: 'separator' },
      command('Move Up', 'Alt+Up', 'move-up'),
      command('Move Down', 'Alt+Down', 'move-down'),
      { type: 'separator' },
      // The keys for these live in the editor, where Command-] also steps
      // the page width outside a list; the menu names the list half.
      command('Increase Indent', undefined, 'indent-more'),
      command('Decrease Indent', undefined, 'indent-less'),
      { type: 'separator' },
      {
        label: 'Table',
        submenu: [
          command('Insert Table', 'CmdOrCtrl+Alt+T', 'table-insert'),
          { type: 'separator' },
          command('Add Row Above', undefined, 'table-row-above'),
          command('Add Row Below', undefined, 'table-row-below'),
          command('Add Column Before', undefined, 'table-column-before'),
          command('Add Column After', undefined, 'table-column-after'),
          { type: 'separator' },
          command('Align Column Left', undefined, 'table-align-left'),
          command('Align Column Center', undefined, 'table-align-center'),
          command('Align Column Right', undefined, 'table-align-right'),
          command('Unalign Column', undefined, 'table-align-none'),
          { type: 'separator' },
          command('Move Column Left', 'Alt+Shift+Left', 'move-column-left'),
          command('Move Column Right', 'Alt+Shift+Right', 'move-column-right'),
          { type: 'separator' },
          command('Delete Row', undefined, 'table-row-delete'),
          command('Delete Column', undefined, 'table-column-delete'),
          command('Delete Table', undefined, 'table-delete'),
          { type: 'separator' },
          command('Copy Table', undefined, 'table-copy'),
          command('Prettify Table', undefined, 'table-prettify'),
        ],
      },
      { type: 'separator' },
      command('Code Fences', 'CmdOrCtrl+Alt+C', 'block-code'),
      command('Timeline', undefined, 'insert-timeline'),
      command('Math Block', 'CmdOrCtrl+Alt+B', 'block-math'),
      command('Quote', 'CmdOrCtrl+Alt+Q', 'block-quote'),
      command('Ordered List', 'CmdOrCtrl+Alt+O', 'block-ordered-list'),
      command('Unordered List', 'CmdOrCtrl+Alt+U', 'block-bullet-list'),
      command('Task List', 'CmdOrCtrl+Alt+X', 'block-task-list'),
      {
        label: 'Task Status',
        submenu: [
          command('Toggle Task Status', 'Control+X', 'task-toggle'),
          command('Mark as Complete', undefined, 'task-complete'),
          command('Mark as Incomplete', undefined, 'task-incomplete'),
          { type: 'separator' },
          command('Sort Tasks', undefined, 'sort-tasks'),
        ],
      },
      command('Horizontal Line', 'CmdOrCtrl+Alt+-', 'block-rule'),
      {
        // The five GitHub alerts, which the author's notes use and which the
        // editor already draws. Switching kinds replaces the marker rather
        // than adding a second one, so these behave as one setting.
        label: 'Callout',
        submenu: [
          command('Note', undefined, 'block-alert-note'),
          command('Tip', undefined, 'block-alert-tip'),
          command('Important', undefined, 'block-alert-important'),
          command('Warning', undefined, 'block-alert-warning'),
          command('Caution', undefined, 'block-alert-caution'),
        ],
      },
      { type: 'separator' },
      // The four Typora's Paragraph menu inserts and Noto could not write
      // without opening the source, in the order it lists them.
      command('Footnote', undefined, 'insert-footnote'),
      command('Table of Contents', undefined, 'insert-toc'),
      command('YAML Front Matter', undefined, 'insert-frontmatter'),
      command('Link Reference', undefined, 'insert-link-reference'),
    ],
  };

  /*
   * Inline marks have their own menu, as they do in Typora, which keeps
   * Paragraph for the block a thing is and Format for how its words are drawn.
   * Bold, italic, code and strike had their keys from the first day and were
   * never on a menu at all, so the only way to learn them was to already know
   * them.
   */
  const formatMenu: MenuItemConstructorOptions = {
    label: 'F&ormat',
    submenu: [
      command('Strong', 'CmdOrCtrl+B', 'mark-strong'),
      command('Emphasis', 'CmdOrCtrl+I', 'mark-emphasis'),
      command('Underline', 'CmdOrCtrl+U', 'mark-underline'),
      // Typora's chord for code; Command-E is its Select Styled Scope.
      command('Code', 'Control+`', 'mark-code'),
      command('Strike', 'CmdOrCtrl+Shift+X', 'mark-strike'),
      command('Highlight', 'CmdOrCtrl+Shift+H', 'mark-highlight'),
      command('Inline Math', 'Control+M', 'mark-math'),
      command('Sidenote', 'CmdOrCtrl+Alt+S', 'insert-sidenote'),
      { type: 'separator' },
      command('Hyperlink…', 'CmdOrCtrl+K', 'insert-link'),
      command('Image…', 'CmdOrCtrl+Shift+I', 'insert-image'),
      { type: 'separator' },
      command('Clear Format', 'CmdOrCtrl+Shift+Backspace', 'clear-format'),
      command('Comment', undefined, 'insert-comment'),
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: '&View',
    submenu: [
      command('Toggle Sidebar', 'CmdOrCtrl+Shift+L', 'toggle-sidebar'),
      command('Toggle Outline', 'CmdOrCtrl+Shift+O', 'toggle-outline'),
      {
        // Typora sorts its sidebar the same three ways, each reversible.
        label: 'Sort Files By',
        submenu: [
          { id: 'tree-sort-name', label: 'Name', type: 'radio', checked: treeSort === 'name', click: () => sendCommand('tree-sort-name') },
          { id: 'tree-sort-name-desc', label: 'Name, reversed', type: 'radio', checked: treeSort === 'name-desc', click: () => sendCommand('tree-sort-name-desc') },
          { id: 'tree-sort-modified', label: 'Recently changed first', type: 'radio', checked: treeSort === 'modified', click: () => sendCommand('tree-sort-modified') },
          { id: 'tree-sort-modified-old', label: 'Longest untouched first', type: 'radio', checked: treeSort === 'modified-old', click: () => sendCommand('tree-sort-modified-old') },
        ],
      },
      command('Collapse All Folders', undefined, 'tree-collapse-all'),
      { type: 'separator' },
      {
        // Typora's own: the stylesheets in a folder, one of them in use.
        label: 'Themes',
        submenu: [
          {
            id: 'theme-none',
            label: 'Noto',
            type: 'radio',
            checked: themePath === '',
            click: () => actions.chooseTheme(''),
          },
          ...(themes.length > 0 ? [{ type: 'separator' as const }] : []),
          ...themes.map((theme) => ({
            label: theme.label,
            type: 'radio' as const,
            checked: theme.path === themePath,
            click: () => actions.chooseTheme(theme.path),
          })),
          { type: 'separator' },
          { label: 'Open Themes Folder', click: () => actions.openThemeFolder() },
        ],
      },
      // Typora's chord shows the whole note as text; the block-only view
      // is this editor's own and moves to a chord of its own.
      command('Source Code Mode', 'CmdOrCtrl+/', 'source-code-mode'),
      command('Toggle Block Source', 'CmdOrCtrl+Alt+/', 'toggle-source'),
      {
        id: 'toggle-read-only',
        label: 'Read-Only Mode',
        type: 'checkbox',
        checked: state.readOnly,
        click: () => sendCommand('toggle-read-only'),
      },
      {
        id: 'toggle-always-on-top',
        label: 'Always on Top',
        type: 'checkbox',
        checked: state.alwaysOnTop,
        click: () => sendCommand('toggle-always-on-top'),
      },
      { type: 'separator' },
      // Typora's two writing modes. It gives neither a shortcut, and neither
      // wants one: they are settled once for a session, not reached for mid
      // sentence.
      command('Focus Mode', undefined, 'toggle-focus-mode'),
      command('Typewriter Mode', undefined, 'toggle-typewriter'),
      { type: 'separator' },
      // The writing width, stepped from the keyboard. The setting is a slider
      // in preferences; these are the same value under the fingers, which is
      // where you actually want it while a paragraph is refusing to sit right.
      /*
       * No accelerator, for the same reason Focus and Typewriter have none:
       * the width is settled once for a session, not reached for mid sentence.
       * These had Command and a bracket, which the editor also gives to list
       * indentation, and a native accelerator is handled before the document
       * sees the key, so indenting a list item did nothing at all.
       */
      /*
       * Shown, not registered.
       *
       * A native accelerator is handled before the document sees the key, so
       * claiming Command and a bracket here would kill list indentation, which
       * is what the same pair means inside a list. The editor decides between
       * the two by where the caret is; these items only say so, which is how
       * the chord stays discoverable without being stolen.
       */
      {
        id: 'widen',
        label: 'Wider',
        accelerator: 'CmdOrCtrl+]',
        registerAccelerator: false,
        click: () => sendCommand('widen'),
      },
      {
        id: 'narrow',
        label: 'Narrower',
        accelerator: 'CmdOrCtrl+[',
        registerAccelerator: false,
        click: () => sendCommand('narrow'),
      },
      { type: 'separator' },
      // Zoom sits on Shift as it does in Typora, which leaves plain Command
      // with the plus and the minus for walking a block up and down the
      // heading scale. A menu accelerator wins over the editor's own keys, so
      // leaving zoom on its default would have made those two do nothing.
      { role: 'resetZoom', accelerator: 'CmdOrCtrl+Shift+0' },
      { role: 'zoomIn', accelerator: 'CmdOrCtrl+Shift+=' },
      { role: 'zoomOut', accelerator: 'CmdOrCtrl+Shift+-' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };

  /* Where you were, and where you were going. The trail is three notes each
     way, from the author's plugin; the chord is the one it used. */
  const goMenu: MenuItemConstructorOptions = {
    label: '&Go',
    submenu: [
      command('Back', 'CmdOrCtrl+Alt+Left', 'navigate-back'),
      command('Forward', 'CmdOrCtrl+Alt+Right', 'navigate-forward'),
      { type: 'separator' },
      command('Browse Tags…', 'CmdOrCtrl+Shift+T', 'browse-tags'),
    ],
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: '&Window',
    submenu: mac
      ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
      : [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }],
  };

  const helpMenu: MenuItemConstructorOptions = {
    role: 'help',
    submenu: [
      // A reader who does not know a feature exists never opens the menu it
      // lives on, so the list of what there is has a place of its own.
      command('What Noto Can Do', 'CmdOrCtrl+Shift+/', 'shortcuts'),
      { type: 'separator' },
      {
        label: 'Check for Updates…',
        click: () => actions.checkUpdates(),
      },
      {
        label: 'Noto on GitHub',
        click: () => openExternal('https://github.com/roobli/Noto'),
      },
      // About lives in the application menu on macOS, so Help carries it only
      // on the platforms that have nowhere else to put it.
      ...(mac
        ? []
        : [{ type: 'separator' } as MenuItemConstructorOptions, { role: 'about' } as MenuItemConstructorOptions]),
    ],
  };

  return [
    ...(mac
      ? [{
          label: appName,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        } as MenuItemConstructorOptions]
      : []),
    fileMenu,
    editMenu,
    paragraphMenu,
    formatMenu,
    viewMenu,
    goMenu,
    windowMenu,
    helpMenu,
  ];
}

/** Every command id the template can emit, for checking against the contract. */
export function menuCommandIds(template: readonly MenuItemConstructorOptions[]): string[] {
  const found: string[] = [];
  const walk = (items: readonly MenuItemConstructorOptions[]) => {
    for (const item of items) {
      if (typeof item.id === 'string') found.push(item.id);
      const submenu = item.submenu;
      if (Array.isArray(submenu)) walk(submenu);
    }
  };
  walk(template);
  return found;
}

export type { BrowserWindow };

import { describe, expect, it } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { buildMenuTemplate, menuCommandIds } from '../../src/main/workspace/menu-template';
import { WORKSPACE_MENU_COMMANDS } from '../../src/shared/workspace/v1/contracts';
import type { RecentFileV1, WorkspaceMenuCommandV1 } from '../../src/shared/workspace/v1/contracts';

const noop = () => undefined;

function template(platform: NodeJS.Platform, recent: readonly RecentFileV1[] = []) {
  return buildMenuTemplate({
    platform,
    appName: 'Noto',
    recent,
    actions: {
      openFolder: noop,
      closeTab: noop,
      openDialog: noop,
      openPath: noop,
      importDocument: noop,
      print: noop,
      pastePlain: noop,
      reopenClosed: noop,
      chooseTheme: noop,
      openThemeFolder: noop,
      clearRecent: noop,
      checkUpdates: noop,
    },
    sendCommand: noop,
    openExternal: noop,
  });
}

const labels = (items: readonly MenuItemConstructorOptions[]) =>
  items.map((item) => item.label ?? item.role ?? item.type);

function menu(items: readonly MenuItemConstructorOptions[], label: string) {
  const found = items.find((item) => item.label === label || item.role === label);
  if (!found || !Array.isArray(found.submenu)) throw new Error(`no ${label} menu`);
  return found.submenu;
}

/** Every role and id anywhere in the tree, for presence checks. */
function everything(items: readonly MenuItemConstructorOptions[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly MenuItemConstructorOptions[]) => {
    for (const item of list) {
      if (item.role) out.push(item.role);
      if (typeof item.id === 'string') out.push(item.id);
      if (Array.isArray(item.submenu)) walk(item.submenu);
    }
  };
  walk(items);
  return out;
}

describe('the menu follows each platform', () => {
  it('gives macOS an application menu holding About and Quit', () => {
    const mac = template('darwin');
    expect(labels(mac)[0]).toBe('Noto');
    const appMenu = menu(mac, 'Noto');
    expect(labels(appMenu)).toContain('about');
    expect(labels(appMenu)).toContain('quit');
    expect(labels(appMenu)).toContain('services');
  });

  it('gives Windows and Linux no application menu', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const items = template(platform);
      expect(labels(items)[0]).toBe('&File');
      expect(items.some((item) => item.label === 'Noto')).toBe(false);
    }
  });

  it('puts Quit under File off macOS, and Close on it', () => {
    expect(labels(menu(template('win32'), '&File'))).toContain('quit');
    expect(labels(menu(template('linux'), '&File'))).toContain('quit');
    // On macOS Quit lives in the application menu, so File closes the window.
    // Named, because Close Tab has Command-W and this is the other close.
    const file = menu(template('darwin'), '&File');
    expect(labels(file)).toContain('Close Window');
    expect(labels(file)).not.toContain('quit');
    const closeWindow = file.find((item) => item.label === 'Close Window');
    expect(closeWindow?.role).toBe('close');
    expect(closeWindow?.accelerator).toBe('Shift+CmdOrCtrl+W');
  });

  it('puts About under Help only where there is no application menu', () => {
    expect(labels(menu(template('win32'), 'help'))).toContain('about');
    expect(labels(menu(template('darwin'), 'help'))).not.toContain('about');
  });

  it('binds Redo the way each platform expects', () => {
    const redo = (platform: NodeJS.Platform) =>
      menu(template(platform), '&Edit').find((item) => item.id === 'redo')?.accelerator;
    expect(redo('darwin')).toBe('Shift+CmdOrCtrl+Z');
    expect(redo('win32')).toBe('CmdOrCtrl+Y');
    expect(redo('linux')).toBe('CmdOrCtrl+Y');
  });

  it('offers Front only on macOS, and Close in the window menu elsewhere', () => {
    expect(labels(menu(template('darwin'), '&Window'))).toContain('front');
    expect(labels(menu(template('win32'), '&Window'))).not.toContain('front');
    expect(labels(menu(template('win32'), '&Window'))).toContain('close');
  });
});

describe('the menu and the renderer agree on commands', () => {
  /**
   * Every command the menu can send has to be one the renderer knows.
   *
   * This is the drift that has actually happened here: a `find` item existed in
   * the menu for a while with nothing on the other side handling it, so the
   * item was live and did nothing.
   */
  // The contract's own list, not a copy of it. A copy is what let `widen` and
  // `narrow` reach the menu while the preload validator silently dropped them.
  const known: readonly WorkspaceMenuCommandV1[] = WORKSPACE_MENU_COMMANDS;

  it('emits only commands the contract defines', () => {
    const ids = menuCommandIds(template('darwin'));
    // Items handled inside main rather than sent to the renderer.
    // Import belongs here too: the dialog, the conversion and the file are all
    // main's, so nothing about it has to cross the boundary and come back.
    const mainOnly = new Set([
      'open-dialog', 'open-folder', 'close-tab', 'import-document', 'print', 'paste-plain',
      'reopen-closed', 'theme-none',
      // A second chord for a command the menu already names once.
      'quick-open-period',
    ]);
    const sent = ids.filter((id) => !mainOnly.has(id));
    for (const id of sent) {
      expect(known).toContain(id as WorkspaceMenuCommandV1);
    }
  });

  it('offers every command the contract defines', () => {
    const ids = new Set(menuCommandIds(template('darwin')));
    for (const command of known) {
      expect(ids.has(command)).toBe(true);
    }
  });

  it('carries the same commands on every platform', () => {
    const forPlatform = (platform: NodeJS.Platform) => menuCommandIds(template(platform)).sort();
    expect(forPlatform('win32')).toEqual(forPlatform('darwin'));
    expect(forPlatform('linux')).toEqual(forPlatform('darwin'));
  });
});

describe('the recent list', () => {
  const files: RecentFileV1[] = [
    { path: '/notes/one.md', name: 'one.md', openedAt: 2 },
    { path: '/notes/two.md', name: 'two.md', openedAt: 1 },
  ];

  it('says so when empty, rather than showing an empty submenu', () => {
    const recent = menu(template('darwin'), '&File').find((item) => item.label === 'Open Recent');
    expect(Array.isArray(recent?.submenu)).toBe(true);
    const items = recent?.submenu as MenuItemConstructorOptions[];
    expect(items[0].label).toBe('No recent documents');
    expect(items[0].enabled).toBe(false);
  });

  it('lists the files and offers to clear them', () => {
    const recent = menu(template('darwin', files), '&File').find((item) => item.label === 'Open Recent');
    const items = recent?.submenu as MenuItemConstructorOptions[];
    expect(items.map((item) => item.label)).toEqual(['one.md', 'two.md', undefined, 'Clear menu']);
    // The full path is the tooltip, since two files can share a name.
    expect(items[0].toolTip).toBe('/notes/one.md');
  });
});

describe('everything the shell needs is reachable', () => {
  it('offers the surfaces the product promises', () => {
    const present = new Set(everything(template('darwin')));
    for (const id of ['open-dialog', 'open-folder', 'save', 'save-as', 'find', 'find-replace',
      'toggle-outline', 'toggle-sidebar', 'settings', 'close-tab']) {
      expect(present.has(id)).toBe(true);
    }
  });
});

describe("the author's own chord", () => {
  it('opens quick open on Command-period, without showing a second item', () => {
    const file = menu(template('darwin'), '&File');
    const second = file.find((item) => item.id === 'quick-open-period');
    expect(second?.accelerator).toBe('CmdOrCtrl+.');
    expect(second?.visible).toBe(false);
    // And the item people read still carries the ordinary chord.
    expect(file.find((item) => item.id === 'quick-open')?.accelerator).toBe('CmdOrCtrl+P');
  });
});

describe('the Themes menu', () => {
  const withThemes = (themePath: string) => buildMenuTemplate({
    platform: 'darwin',
    appName: 'Noto',
    recent: [],
    actions: {
      openFolder: noop, closeTab: noop, openDialog: noop, openPath: noop, importDocument: noop,
      print: noop, pastePlain: noop, reopenClosed: noop, chooseTheme: noop, openThemeFolder: noop,
      clearRecent: noop,
      checkUpdates: noop,
    },
    sendCommand: noop,
    openExternal: noop,
    state: {
      readOnly: false,
      alwaysOnTop: false,
      themePath,
      themes: [
        { path: '/themes/claude-like.css', label: 'Claude like' },
        { path: '/themes/newsprint.css', label: 'Newsprint' },
      ],
    },
  });

  const themeItems = (template: ReturnType<typeof buildMenuTemplate>) => {
    const view = menu(template, '&View');
    const themes = view.find((item) => item.label === 'Themes');
    if (!themes || !Array.isArray(themes.submenu)) throw new Error('no Themes menu');
    return themes.submenu;
  };

  it('lists the stylesheets it was given, with the built-in look first', () => {
    const items = themeItems(withThemes(''));
    expect(items.map((item) => item.label ?? item.type))
      .toEqual(['Noto', 'separator', 'Claude like', 'Newsprint', 'separator', 'Open Themes Folder']);
  });

  it('ticks the one in use, and the built-in look when there is none', () => {
    const ticked = (template: ReturnType<typeof buildMenuTemplate>) =>
      themeItems(template).filter((item) => item.checked).map((item) => item.label);
    expect(ticked(withThemes(''))).toEqual(['Noto']);
    expect(ticked(withThemes('/themes/newsprint.css'))).toEqual(['Newsprint']);
  });
});

describe('Help carries a quiet update check', () => {
  it('lists Check for Updates on every platform', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const help = menu(template(platform), 'help');
      expect(labels(help)).toContain('Check for Updates…');
    }
  });
});

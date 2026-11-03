import { describe, expect, it } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { buildMenuTemplate, menuShortcuts, withoutShortcuts } from '../../src/main/workspace/menu-template';
import { guardedBindings, notoBindings } from '../../src/renderer/editor/noto/keymap';
import { buildShortcutRows, conflictsOf } from '../../src/renderer/shortcuts/catalog';
import { normalizeChord } from '../../src/shared/shortcuts/chord';
import { markdownPaddingManifest, rendererProofManifest, titleShiftManifest } from '../../src/shared/plugins/proof-manifests';

const template = (mac: boolean) => buildMenuTemplate({
  platform: mac ? 'darwin' : 'win32',
  appName: 'Noto',
  recent: [],
  actions: {
    openFolder: () => {}, refreshFolder: () => {}, closeTab: () => {}, openDialog: () => {}, openPath: () => {}, importDocument: () => {},
    clearRecent: () => {}, print: () => {}, pastePlain: () => {}, reopenClosed: () => {}, chooseTheme: () => {},
    openThemeFolder: () => {}, checkUpdates: () => {},
  },
  sendCommand: () => {},
  openExternal: () => {},
});

const plugins = [rendererProofManifest, titleShiftManifest, markdownPaddingManifest];

describe('the Shortcuts pane’s list', () => {
  const rows = buildShortcutRows({ menu: menuShortcuts(template(true), true), plugins, mac: true });
  const row = (label: string) => rows.find((candidate) => candidate.label === label);

  it('names every key the editor answers to', () => {
    const listed = new Set(rows.map((candidate) => candidate.chord));
    const unlisted = Object.keys(notoBindings({ mac: true }))
      .map((key) => normalizeChord(key, 'prosemirror', true))
      .filter((chord) => chord !== null && !listed.has(chord));
    expect(unlisted).toEqual([]);
  });

  it('has no key held by two things on macOS', () => {
    expect([...conflictsOf(rows)]).toEqual([]);
  });

  it('gives Browse Tags a key of its own, apart from Reopen Closed File', () => {
    expect(row('Browse Tags')?.chord).toBe('Mod+Alt+Shift+T');
    expect(row('Reopen Closed File')?.chord).toBe('Mod+Shift+T');
  });

  it('says where each comes from', () => {
    expect(row('Strong')?.sources).toEqual(['menu', 'editor']);
    expect(row('Command Palette')?.sources).toContain('window');
    expect(row('Code Fences')?.sources).toContain('menu');
    const promote = rows.find((candidate) => candidate.key.startsWith('plugin:') && candidate.chord === 'Mod+Shift+ArrowUp');
    expect(promote).toMatchObject({ sources: ['plugin'], plugin: 'Title Shift', locked: false });
    expect(row('Copy')).toMatchObject({ locked: true, chord: 'Mod+C' });
  });

  it('flags two rows on one key', () => {
    const clashing = buildShortcutRows({
      menu: [
        { id: 'a', label: 'One', menu: 'File', chord: 'Mod+Shift+T', locked: false, hidden: false },
        { id: 'b', label: 'Two', menu: 'Go', chord: 'Mod+Shift+T', locked: false, hidden: false },
      ],
      plugins: [],
      mac: true,
    });
    expect(conflictsOf(clashing).get('menu:a')).toEqual(['Two']);
  });
});

describe('a switched-off chord', () => {
  const accelerator = (items: readonly MenuItemConstructorOptions[], id: string): unknown => {
    for (const item of items) {
      if (item.id === id) return item.accelerator;
      if (Array.isArray(item.submenu)) {
        const found = accelerator(item.submenu, id);
        if (found !== null) return found;
      }
    }
    return null;
  };

  it('comes off the menu item, and a role keeps its own', () => {
    const stripped = withoutShortcuts(template(true), new Set(['Mod+B', 'Mod+C']), true);
    expect(accelerator(stripped, 'mark-strong')).toBeUndefined();
    expect(accelerator(stripped, 'save')).toBe('CmdOrCtrl+S');
    expect(menuShortcuts(stripped, true).find((item) => item.id === 'role:copy')?.chord).toBe('Mod+C');
  });

  it('stops a role sharing it from claiming it, as Close shares Close Tab\u2019s key off macOS', () => {
    const find = (items: readonly MenuItemConstructorOptions[], role: string): MenuItemConstructorOptions | null => {
      for (const item of items) {
        if (item.role === role && item.id === undefined) return item;
        if (Array.isArray(item.submenu)) {
          const found = find(item.submenu, role);
          if (found) return found;
        }
      }
      return null;
    };
    const stripped = withoutShortcuts(template(false), new Set(['Mod+W']), false);
    expect(accelerator(stripped, 'close-tab')).toBeUndefined();
    expect(find(stripped, 'close')?.registerAccelerator).toBe(false);
  });

  it('passes the key on in the editor, read at the moment of the press', () => {
    let off = new Set<string>();
    const bindings = guardedBindings({ mac: true, isDisabled: (chord) => off.has(chord) });
    const bold = bindings['Meta-b'];
    expect(bold).toBeDefined();
    // Off, Command-B is swallowed, so the browser does not bold the text
    // itself; Option-Up is passed on, so the caret moves as it would anyway.
    off = new Set(['Mod+B', 'Alt+ArrowUp']);
    expect(bold?.({} as never)).toBe(true);
    expect(bindings['Alt-ArrowUp']?.({} as never)).toBe(false);
  });
});

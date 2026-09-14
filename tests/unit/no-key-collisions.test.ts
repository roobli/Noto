import { describe, expect, it } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { buildMenuTemplate } from '../../src/main/workspace/menu-template';
import { notoBindings } from '../../src/renderer/editor/noto/keymap';

/**
 * A native accelerator is handled before the document ever sees the key, so a
 * chord claimed by both the menu and the editor belongs to the menu and the
 * editor's binding is dead. That happened once: the menu gave Command and a
 * bracket to the page width while the editor gave the same pair to list
 * indentation, and indenting a list item from the keyboard did nothing.
 */
/**
 * The chords the menu actually takes.
 *
 * `registerAccelerator: false` puts the chord on the item as a label without
 * claiming the key, which is how an item can say what the shortcut is while
 * leaving the editor to decide what it does. Those are not claims and must not
 * be counted as any: counting them would forbid the one arrangement that lets
 * a chord mean one thing in a list and another outside it.
 */
function accelerators(items: readonly MenuItemConstructorOptions[]): string[] {
  const found: string[] = [];
  for (const item of items) {
    if (typeof item.accelerator === 'string' && item.registerAccelerator !== false) {
      found.push(item.accelerator);
    }
    const submenu = item.submenu;
    if (Array.isArray(submenu)) found.push(...accelerators(submenu));
  }
  return found;
}

/** Every chord an item shows, claimed or merely displayed. */
function displayed(items: readonly MenuItemConstructorOptions[]): string[] {
  const found: string[] = [];
  for (const item of items) {
    if (typeof item.accelerator === 'string') found.push(item.accelerator);
    const submenu = item.submenu;
    if (Array.isArray(submenu)) found.push(...displayed(submenu));
  }
  return found;
}

/** `CmdOrCtrl+Shift+H` in the menu is `Meta-Shift-h` in the editor. */
function asChord(accelerator: string, mac: boolean): string {
  return accelerator
    .split('+')
    .map((part) => {
      if (part === 'CmdOrCtrl' || part === 'Command') return mac ? 'Meta' : 'Ctrl';
      if (part === 'Control') return 'Ctrl';
      if (part === 'Alt' || part === 'Option') return 'Alt';
      if (part === 'Shift') return 'Shift';
      return part.length === 1 ? part.toLowerCase() : part;
    })
    .join('-');
}

describe('no key is claimed twice', () => {
  const built = (mac: boolean) => buildMenuTemplate({
    platform: mac ? 'darwin' : 'win32',
    appName: 'Noto',
    recent: [],
    actions: {
      openFolder: () => {}, closeTab: () => {}, openDialog: () => {},
      openPath: () => {},
    importDocument: () => {}, clearRecent: () => {}, print: () => {}, pastePlain: () => {}, reopenClosed: () => {}, chooseTheme: () => {}, openThemeFolder: () => {},
      checkUpdates: () => {},
    },
    sendCommand: () => {},
    openExternal: () => {},
  });

  for (const mac of [true, false]) {
    it(`by two menu items, on ${mac ? 'macOS' : 'the other platforms'}`, () => {
      // Only one of them can ever fire, and which one is not worth finding out.
      // Command and K was given to both the palette and the hyperlink.
      const seen = new Map<string, number>();
      for (const accelerator of accelerators(built(mac))) {
        seen.set(accelerator, (seen.get(accelerator) ?? 0) + 1);
      }
      expect([...seen].filter(([, count]) => count > 1)).toEqual([]);
    });

    it(`by the menu and the editor, where they would do different things, on ${mac ? 'macOS' : 'the other platforms'}`, () => {
      /*
       * Sharing a chord is normal and fine where both sides run the same
       * command: the accelerator fires, the menu sends the command, and the
       * editor's own binding is simply never reached.
       *
       * It is a fault only where the two mean different things, because then
       * the editor's binding is dead and nothing says so. The page width had
       * Command and a bracket while the editor gave the same pair to list
       * indentation, so a list could not be indented from the keyboard at all.
       */
      const chords = new Set(Object.keys(notoBindings({ mac })));
      const contested = ['Meta-]', 'Meta-[', 'Ctrl-]', 'Ctrl-['].filter((chord) => chords.has(chord));
      const claimed = accelerators(built(mac)).map((accelerator) => asChord(accelerator, mac));
      expect(claimed.filter((chord) => contested.includes(chord))).toEqual([]);

      // And the pair is still offered, as a label, so the reader can find it.
      // Without this the test would pass just as well if the item said nothing
      // at all, which is the state this was written to get out of.
      const shown = displayed(built(mac)).map((accelerator) => asChord(accelerator, mac));
      expect(shown.filter((chord) => contested.includes(chord)).sort())
        .toEqual([...contested].sort());
    });
  }
});

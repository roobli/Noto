/**
 * Every shortcut the app answers to, as one list for the Shortcuts pane.
 *
 * Read from where the keys are bound rather than kept beside them: the menu's
 * accelerators as main built the menu, the editor's keymap as it is, and each
 * plugin's manifest. A key the menu and the editor both bind to the same
 * action is one row with both sources, since the menu answers first and the
 * editor's binding is only what a test or another platform reaches. A list
 * written out by hand is how the old help panel came to say Back and Forward
 * were on the bracket keys.
 */
import type { MenuShortcutV1 } from '../../shared/settings/v1/contracts';
import { normalizeChord } from '../../shared/shortcuts/chord';
import { notoBindings } from '../editor/noto/keymap';

export type ShortcutSource = 'menu' | 'editor' | 'window' | 'plugin';

export interface ShortcutRow {
  /** Unique within the list, for React and for tests. */
  readonly key: string;
  /** Canonical chord: what is stored when the row is switched off. */
  readonly chord: string;
  readonly label: string;
  readonly group: string;
  readonly sources: readonly ShortcutSource[];
  /** The plugin's name, for a plugin's row. */
  readonly plugin?: string;
  /** A key the app cannot do without, or the operating system's: no switch. */
  readonly locked: boolean;
  /** A second chord the menu answers to without showing it. */
  readonly hidden: boolean;
}

export interface PluginHotkeySource {
  readonly id: string;
  readonly name: string;
  readonly commands: readonly { readonly id: string; readonly title: string }[];
  readonly hotkeys: readonly { readonly command: string; readonly keys: string }[];
}

/**
 * What the editor's keys do where no menu item names them, keyed in
 * ProseMirror's spelling with `Mod`. A binding the menu also holds takes the
 * menu's name instead, so only these need words of their own.
 */
const EDITOR_ONLY: Readonly<Record<string, { label: string; group: string; locked?: boolean }>> = {
  'Mod-Shift-k': { label: 'Code Fences', group: 'Paragraph' },
  'Mod-Shift-q': { label: 'Quote', group: 'Paragraph' },
  'Ctrl-Shift-`': { label: 'Strike', group: 'Format' },
  'Mod-y': { label: 'Redo', group: 'Edit' },
  'Mod-Shift-z': { label: 'Redo', group: 'Edit' },
  Enter: { label: 'New paragraph, or split the block', group: 'In the page', locked: true },
  'Shift-Enter': { label: 'Line break', group: 'In the page', locked: true },
  'Mod-Enter': { label: 'Line break', group: 'In the page', locked: true },
  Backspace: { label: 'Delete, or lift a block at its start', group: 'In the page', locked: true },
  Tab: { label: 'Next table cell, or indent a list item', group: 'In the page', locked: true },
  'Shift-Tab': { label: 'Previous table cell, or outdent a list item', group: 'In the page', locked: true },
};

/** The order groups are shown in: the menu bar's, then what lives outside it. */
const GROUP_ORDER = ['File', 'Edit', 'Paragraph', 'Format', 'View', 'Go', 'Window', 'Help', 'In the page', 'Plugins'];

export function groupRank(group: string): number {
  const index = GROUP_ORDER.indexOf(group);
  // The app's own menu, named after the app on macOS, holds only the
  // system's Hide and Quit, so it comes last rather than first.
  return index === -1 ? GROUP_ORDER.length : index;
}

export function buildShortcutRows(input: {
  readonly menu: readonly MenuShortcutV1[];
  readonly plugins: readonly PluginHotkeySource[];
  readonly mac: boolean;
}): ShortcutRow[] {
  const { menu, plugins, mac } = input;
  const editorChords = new Set<string>();
  for (const key of Object.keys(notoBindings({ mac }))) {
    const chord = normalizeChord(key, 'prosemirror', mac);
    if (chord) editorChords.add(chord);
  }

  const rows: ShortcutRow[] = [];
  const covered = new Set<string>();
  for (const item of menu) {
    const sources: ShortcutSource[] = ['menu'];
    if (editorChords.has(item.chord)) sources.push('editor');
    if (item.id === 'command-palette') sources.push('window');
    rows.push({
      key: `menu:${item.id}`,
      chord: item.chord,
      label: item.label,
      group: item.menu,
      sources,
      locked: item.locked,
      hidden: item.hidden,
    });
    covered.add(item.chord);
  }

  for (const [key, info] of Object.entries(EDITOR_ONLY)) {
    const chord = normalizeChord(key, 'prosemirror', mac);
    if (!chord || covered.has(chord) || !editorChords.has(chord)) continue;
    rows.push({
      key: `editor:${chord}`, chord, label: info.label, group: info.group,
      sources: ['editor'], locked: info.locked === true, hidden: false,
    });
    covered.add(chord);
  }

  rows.push({
    key: 'window:Escape', chord: 'Escape', label: 'Close the panel, dialog or palette in front',
    group: 'In the page', sources: ['window'], locked: true, hidden: false,
  });

  for (const plugin of plugins) {
    for (const hotkey of plugin.hotkeys) {
      const chord = normalizeChord(hotkey.keys, 'accelerator', mac);
      if (!chord) continue;
      const title = plugin.commands.find((command) => command.id === hotkey.command)?.title ?? hotkey.command;
      rows.push({
        key: `plugin:${plugin.id}:${hotkey.command}`, chord, label: title, group: 'Plugins',
        sources: ['plugin'], plugin: plugin.name, locked: false, hidden: false,
      });
    }
  }
  return rows;
}

/**
 * Rows that share a chord with another row, and the labels they share it
 * with. Two rows on one chord means one of them can never be reached.
 */
export function conflictsOf(rows: readonly ShortcutRow[]): ReadonlyMap<string, readonly string[]> {
  const byChord = new Map<string, ShortcutRow[]>();
  for (const row of rows) byChord.set(row.chord, [...(byChord.get(row.chord) ?? []), row]);
  const conflicts = new Map<string, string[]>();
  for (const sharing of byChord.values()) {
    if (sharing.length < 2) continue;
    for (const row of sharing) {
      conflicts.set(row.key, sharing.filter((other) => other !== row).map((other) => other.label));
    }
  }
  return conflicts;
}

/** The words a row's sources are named by in the pane. */
export function sourceText(row: ShortcutRow): string {
  const names: Record<ShortcutSource, string> = { menu: 'Menu', editor: 'Editor', window: 'Window', plugin: 'Plugin' };
  const words = row.sources.map((source) => names[source]);
  if (row.plugin) words[words.indexOf('Plugin')] = `Plugin · ${row.plugin}`;
  return words.join(' · ');
}

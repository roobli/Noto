import { describe, expect, it } from 'vitest';
import type { Menu, MenuItem } from 'electron';
import { listMenuCommands, runMenuCommand } from '../../src/main/workspace/menu-commands';
import { acceleratorLabel } from '../../src/shared/commands/accelerator-label';

type Fake = { readonly [key: string]: unknown; readonly submenu?: { readonly items: readonly Fake[] } };
const item = (fields: Fake): MenuItem => {
  const { submenu, ...rest } = fields;
  return {
    visible: true, enabled: true, type: 'normal', label: '', id: '', checked: false,
    ...rest,
    submenu: submenu ? ({ items: submenu.items.map(item) } as unknown as Menu) : undefined,
  } as unknown as MenuItem;
};
const menu = (items: readonly Fake[]): Pick<Menu, 'items'> => ({ items: items.map(item) });

describe('the application menu as commands', () => {
  // Daily-use audit finding 15: the palette held a few commands, and "focus" found nothing.
  it('lists every item that does something, with where it sits and its keys', () => {
    const listed = listMenuCommands(menu([
      { label: 'File', submenu: { items: [
        { id: 'new-file', label: 'New Note', accelerator: 'CmdOrCtrl+N' },
        { type: 'separator' },
        { id: 'save-as', label: 'Save a Copy…', accelerator: 'CmdOrCtrl+Shift+S' },
      ] } },
      { label: 'View', submenu: { items: [
        { id: 'focus-mode', label: 'Focus Mode', type: 'checkbox', checked: true, accelerator: 'F8' },
        { id: 'hidden-thing', label: 'Hidden', visible: false },
        { id: 'off-now', label: 'Off Now', enabled: false },
        { label: 'No id' },
      ] } },
    ]));
    expect(listed).toEqual([
      { id: 'new-file', title: 'New Note', path: 'File', accelerator: 'CmdOrCtrl+N', enabled: true, checked: null },
      { id: 'save-as', title: 'Save a Copy', path: 'File', accelerator: 'CmdOrCtrl+Shift+S', enabled: true, checked: null },
      { id: 'focus-mode', title: 'Focus Mode', path: 'View', accelerator: 'F8', enabled: true, checked: true },
      { id: 'off-now', title: 'Off Now', path: 'View', accelerator: null, enabled: false, checked: null },
    ]);
  });

  it('runs a command by clicking its item, and refuses one that is off or gone', () => {
    let clicked = 0;
    const items = new Map<string, MenuItem>([
      ['on', item({ id: 'on', click: () => { clicked += 1; } } as Fake)],
      ['off', item({ id: 'off', enabled: false, click: () => { clicked += 10; } } as Fake)],
    ]);
    const bar = { getMenuItemById: (id: string) => items.get(id) ?? null };
    expect(runMenuCommand(bar, 'on')).toBe(true);
    expect(runMenuCommand(bar, 'off')).toBe(false);
    expect(runMenuCommand(bar, 'nowhere')).toBe(false);
    expect(clicked).toBe(1);
  });
});

describe('keys as the platform writes them', () => {
  it('on a Mac', () => {
    expect(acceleratorLabel('CmdOrCtrl+Shift+P', true)).toBe('⇧⌘P');
    expect(acceleratorLabel('CmdOrCtrl+Alt+T', true)).toBe('⌥⌘T');
    expect(acceleratorLabel('Control+`', true)).toBe('⌃`');
    expect(acceleratorLabel('Alt+Up', true)).toBe('⌥↑');
    expect(acceleratorLabel('CmdOrCtrl+=', true)).toBe('⌘=');
    expect(acceleratorLabel('F8', true)).toBe('F8');
  });

  it('elsewhere', () => {
    expect(acceleratorLabel('CmdOrCtrl+Shift+P', false)).toBe('Ctrl+Shift+P');
    expect(acceleratorLabel('Alt+Shift+X', false)).toBe('Alt+Shift+X');
    expect(acceleratorLabel('CmdOrCtrl+Plus', false)).toBe('Ctrl++');
  });
});

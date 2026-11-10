/**
 * The application menu as a list of commands, for the command palette.
 *
 * The menu is where every command already has its name, its place and its
 * keys, and where it is enabled or not right now. The palette used to hold a
 * separate, short list (export, git, a few more), so most of what Noto can do
 * was reachable by mouse only and typing "focus" found nothing (daily-use
 * audit, finding 15). Listing the menu and running a choice by clicking the
 * same item makes the menu the one registry: a command added there is in the
 * palette, with its keys, and cannot behave differently in the two.
 */

import type { Menu, MenuItem } from 'electron';
import type { WorkspaceMenuCommandV1Entry } from '../../shared/workspace/v1/contracts';

/** Menu items that open the menu's own furniture rather than do something. */
const SKIPPED_ROLES = new Set(['services', 'recentdocuments', 'window', 'help', 'about', 'hide', 'hideothers', 'unhide', 'front']);

/** Every item with an id that does something, depth first in menu order, with the labels above it. */
export function listMenuCommands(menu: Pick<Menu, 'items'> | null): WorkspaceMenuCommandV1Entry[] {
  const out: WorkspaceMenuCommandV1Entry[] = [];
  const seen = new Set<string>();
  const walk = (items: readonly MenuItem[], above: readonly string[]) => {
    for (const item of items) {
      if (!item.visible || item.type === 'separator') continue;
      const label = item.label.replace(/&/g, '');
      if (item.submenu) {
        walk(item.submenu.items, [...above, label]);
        continue;
      }
      if (!item.id || seen.has(item.id) || (item.role && SKIPPED_ROLES.has(item.role.toLowerCase()))) continue;
      if (label.length === 0) continue;
      seen.add(item.id);
      out.push({
        id: item.id,
        title: label.replace(/…$/, ''),
        path: above.join(' › '),
        accelerator: typeof item.accelerator === 'string' && item.accelerator.length > 0 ? item.accelerator : null,
        enabled: item.enabled,
        checked: item.type === 'checkbox' || item.type === 'radio' ? item.checked : null,
      });
    }
  };
  if (menu) walk(menu.items, []);
  return out;
}

/**
 * Choose the item with this id as the menu would. False when there is no such
 * item, or it is off now.
 *
 * The renderer can reach every item that has an id, which is exactly what a
 * reader can click; role items (Quit, Close, About) have no id and stay out
 * of reach. A menu item whose safety rests on a confirmation in its own click
 * handler is fine here; one that relies on being reachable only by a person's
 * click must not be given an id.
 */
export function runMenuCommand(menu: Pick<Menu, 'getMenuItemById'> | null, id: string): boolean {
  const item = menu?.getMenuItemById(id) ?? null;
  if (!item || !item.enabled || !item.visible) return false;
  item.click();
  return true;
}

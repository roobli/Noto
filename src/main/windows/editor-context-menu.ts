/**
 * The menu a right click raises in the editor.
 *
 * Built in main because that is where the clipboard roles and the spell
 * checker's suggestions live: a renderer can draw a menu but cannot ask what
 * the dictionary thinks of a word, and reimplementing cut and paste as
 * renderer commands loses the platform's own behaviour.
 *
 * Only what the click is actually about. A menu that always shows the same
 * eleven items teaches nobody anything, so the spelling section is drawn only
 * over a misspelled word, and the link and image sections only over a link or
 * an image.
 */

import { randomUUID } from 'node:crypto';
import { sendPasteText } from '../workspace/menu';
import { isTrustedRendererSender } from '../ipc/trusted-renderer';
import { NOTO_WORKSPACE_VERSION, WORKSPACE_CHANNELS, type WorkspaceContextItemV1 } from '../../shared/workspace/v1/contracts';
import { isWorkspaceContextReplyV1 } from '../../shared/workspace/v1/validate';
import {
  Menu, clipboard, ipcMain,
  type BrowserWindow, type ContextMenuParams, type IpcMainEvent, type MenuItemConstructorOptions,
} from 'electron';

/** Suggestions past this many are guesses rather than corrections. */
const MAX_SUGGESTIONS = 5;

/**
 * How long a right click waits for the window to say what its plugins add.
 * The answer is a lookup in the page, a few milliseconds; past this the menu
 * opens without them rather than feel late.
 */
const PLUGIN_ITEMS_WAIT_MS = 250;

export function buildEditorContextMenu(
  window: BrowserWindow,
  params: ContextMenuParams,
  pluginItems: readonly WorkspaceContextItemV1[] = [],
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];
  const { editFlags } = params;

  if (params.misspelledWord) {
    const suggestions = params.dictionarySuggestions.slice(0, MAX_SUGGESTIONS);
    for (const word of suggestions) {
      items.push({ label: word, click: () => window.webContents.replaceMisspelling(word) });
    }
    if (suggestions.length === 0) {
      items.push({ label: 'No spelling suggestions', enabled: false });
    }
    items.push({ type: 'separator' });
    items.push({
      label: 'Add to Dictionary',
      click: () => window.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
    });
    items.push({ type: 'separator' });
  }

  // What the click is about, as the plugins under it see it: a sidenote, a
  // selection to note. Chosen, it runs as an editor command in the window.
  if (pluginItems.length > 0) {
    for (const item of pluginItems) {
      items.push({
        label: item.title,
        click: () => window.webContents.send(WORKSPACE_CHANNELS.contextCommand, {
          version: NOTO_WORKSPACE_VERSION, command: item.command,
        }),
      });
    }
    items.push({ type: 'separator' });
  }

  if (params.linkURL) {
    items.push({ label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) });
    items.push({ type: 'separator' });
  }

  if (params.mediaType === 'image' && params.srcURL) {
    items.push({ label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) });
    items.push({ type: 'separator' });
  }

  items.push({ role: 'cut', enabled: editFlags.canCut });
  items.push({ role: 'copy', enabled: editFlags.canCopy });
  items.push({ role: 'paste', enabled: editFlags.canPaste });
  // The markdown a note is made of is text, so pasting a styled fragment as
  // text is what you want far more often than the fragment's own markup.
  items.push({ label: 'Paste as Plain Text', enabled: editFlags.canPaste, click: () => sendPasteText(window) });
  items.push({ type: 'separator' });
  items.push({ role: 'selectAll', enabled: editFlags.canSelectAll });

  return items;
}

/** Ask the window what its plugins add at the click; none, if it does not answer in time. */
function askPluginItems(window: BrowserWindow, params: ContextMenuParams): Promise<readonly WorkspaceContextItemV1[]> {
  if (!params.isEditable || window.isDestroyed() || window.webContents.isDestroyed()) return Promise.resolve([]);
  const requestId = `context:${randomUUID()}`;
  return new Promise((resolve) => {
    const done = (items: readonly WorkspaceContextItemV1[]) => {
      clearTimeout(timer);
      ipcMain.removeListener(WORKSPACE_CHANNELS.contextItemsReply, listener);
      resolve(items);
    };
    const listener = (event: IpcMainEvent, value: unknown) => {
      if (!isTrustedRendererSender(window, event) || !isWorkspaceContextReplyV1(value)) return;
      if (value.requestId === requestId) done(value.items);
    };
    const timer = setTimeout(() => done([]), PLUGIN_ITEMS_WAIT_MS);
    ipcMain.on(WORKSPACE_CHANNELS.contextItemsReply, listener);
    window.webContents.send(WORKSPACE_CHANNELS.contextItems, {
      version: NOTO_WORKSPACE_VERSION, requestId, x: params.x, y: params.y,
    });
  });
}

export function installEditorContextMenu(window: BrowserWindow): void {
  window.webContents.on('context-menu', (_event, params) => {
    // Not over the chrome: the rail and the title bar have their own answers,
    // and a clipboard menu over a tree row would be a menu about nothing.
    if (!params.isEditable && !params.selectionText && !params.linkURL && params.mediaType !== 'image') return;
    void askPluginItems(window, params).then((pluginItems) => {
      if (window.isDestroyed()) return;
      Menu.buildFromTemplate(buildEditorContextMenu(window, params, pluginItems)).popup({ window });
    });
  });
}

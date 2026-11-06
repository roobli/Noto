import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, ContextMenuParams } from 'electron';
import { buildEditorContextMenu } from '../../src/main/windows/editor-context-menu';

vi.mock('electron', () => ({
  Menu: { buildFromTemplate: vi.fn() },
  clipboard: { writeText: vi.fn() },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
}));

const send = vi.fn();
const window = {
  webContents: { replaceMisspelling: vi.fn(), send, session: { addWordToSpellCheckerDictionary: vi.fn() } },
} as unknown as BrowserWindow;

function params(overrides: Partial<ContextMenuParams> = {}): ContextMenuParams {
  return {
    isEditable: true,
    selectionText: '',
    misspelledWord: '',
    dictionarySuggestions: [],
    linkURL: '',
    srcURL: '',
    mediaType: 'none',
    editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
    ...overrides,
  } as unknown as ContextMenuParams;
}

const labels = (items: ReturnType<typeof buildEditorContextMenu>) =>
  items.map((item) => item.label ?? item.role ?? item.type);

describe('the editor context menu', () => {
  it('offers the clipboard and nothing else over ordinary text', () => {
    expect(labels(buildEditorContextMenu(window, params())))
      .toEqual(['cut', 'copy', 'paste', 'Paste as Plain Text', 'separator', 'selectAll']);
  });

  it('leads with the spelling suggestions over a misspelled word', () => {
    const items = buildEditorContextMenu(window, params({
      misspelledWord: 'teh', dictionarySuggestions: ['the', 'ten', 'tea'],
    }));
    expect(labels(items).slice(0, 6))
      .toEqual(['the', 'ten', 'tea', 'separator', 'Add to Dictionary', 'separator']);
  });

  it('says so when the dictionary has nothing to offer', () => {
    const items = buildEditorContextMenu(window, params({ misspelledWord: 'qwertyx' }));
    expect(labels(items)[0]).toBe('No spelling suggestions');
    expect(items[0].enabled).toBe(false);
  });

  it('keeps the suggestion list short enough to read', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const items = buildEditorContextMenu(window, params({ misspelledWord: 'x', dictionarySuggestions: many }));
    expect(labels(items).indexOf('separator')).toBe(5);
  });

  it('offers a link and an image their own address', () => {
    expect(labels(buildEditorContextMenu(window, params({ linkURL: 'https://example.com' })))[0])
      .toBe('Copy Link Address');
    expect(labels(buildEditorContextMenu(window, params({ mediaType: 'image', srcURL: 'noto://asset/x' })))[0])
      .toBe('Copy Image Address');
  });

  it('greys the actions the selection cannot do', () => {
    const items = buildEditorContextMenu(window, params({
      editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true } as never,
    }));
    expect(items.find((item) => item.role === 'cut')?.enabled).toBe(false);
    expect(items.find((item) => item.role === 'paste')?.enabled).toBe(true);
  });

  it('leads with what the plugins under the click offer, and sends the choice back as its command', () => {
    const items = buildEditorContextMenu(window, params(), [{ title: 'Add Sidenote', command: 'sidenotes.insert' }]);
    expect(labels(items).slice(0, 3)).toEqual(['Add Sidenote', 'separator', 'cut']);
    (items[0]!.click as () => void)();
    expect(send).toHaveBeenCalledWith('noto:v1:workspace:context-command', { version: 1, command: 'sidenotes.insert' });
  });
});

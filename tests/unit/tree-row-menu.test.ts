import { describe, expect, it, vi } from 'vitest';
import { buildSelectionMenu, buildTreeRowMenu, revealLabel, trashLabel } from '../../src/main/workspace/tree-row-menu';

/**
 * A native menu holds the input loop until it is dismissed and no automated
 * pointer can reach one, so what a row offers is read from the template rather
 * than from the screen. The editor's own context menu is tested the same way.
 */
const actions = () => ({
  open: vi.fn(),
  info: vi.fn(),
  newNote: vi.fn(),
  newFolder: vi.fn(),
  rename: vi.fn(),
  duplicate: vi.fn(),
  move: vi.fn(),
  trash: vi.fn(),
  reveal: vi.fn(),
  copyPath: vi.fn(),
});
const labels = (items: readonly { label?: string; type?: string }[]) =>
  items.map((item) => (item.type === 'separator' ? '---' : item.label));

describe('the menu on a row of the tree', () => {
  it('offers a file the three things a file can do', () => {
    const items = buildTreeRowMenu('/vault/note.md', 'file', actions(), 'darwin');
    expect(labels(items)).toEqual([
      'Open', 'Get Info',
      '---', 'Rename…', 'Duplicate', 'Move to…',
      '---', 'Reveal in Finder', 'Copy Path',
      // Alone below a rule, furthest from Open: it is the only action here
      // with no undo.
      '---', 'Move to Trash',
    ]);
  });

  it('offers a folder a new note in it, rather than offering to open it', () => {
    // A click already opens a folder, and a new note otherwise lands in the
    // folder's root, which is rarely the folder the reader is looking at.
    const items = buildTreeRowMenu('/vault/sub', 'directory', actions(), 'darwin');
    expect(labels(items)).toEqual([
      'New Note Here', 'New Folder Here', 'Get Info',
      '---', 'Rename…', 'Duplicate', 'Move to…',
      '---', 'Reveal in Finder', 'Copy Path',
      '---', 'Move to Trash',
    ]);
  });

  it('turns the info pane to the folder that was pressed', () => {
    const spies = actions();
    const items = buildTreeRowMenu('/vault/sub', 'directory', spies, 'darwin');
    (items.find((candidate) => candidate.id === 'tree-info')?.click as () => void)();
    expect(spies.info).toHaveBeenCalledWith('/vault/sub');
  });

  it('makes the new note in the folder that was pressed', () => {
    const spies = actions();
    const items = buildTreeRowMenu('/vault/sub', 'directory', spies, 'darwin');
    const item = items.find((candidate) => candidate.id === 'tree-new-note');
    (item?.click as () => void)();
    expect(spies.newNote).toHaveBeenCalledWith('/vault/sub');
  });

  it('offers several chosen rows what can be done to all of them, trash last and alone', () => {
    const run = { move: vi.fn(), trash: vi.fn(), copyPaths: vi.fn() };
    const items = buildSelectionMenu(3, run, 'darwin');
    expect(labels(items)).toEqual(['Move 3 Items to…', 'Copy Paths', '---', 'Move 3 Items to Trash']);
    (items.find((item) => item.id === 'tree-many-trash')?.click as () => void)();
    expect(run.trash).toHaveBeenCalledTimes(1);
    expect(labels(buildSelectionMenu(2, run, 'win32')).at(-1)).toBe('Move 2 Items to Recycle Bin');
  });

  it('calls the trash what each system calls it', () => {
    expect(trashLabel('darwin')).toBe('Move to Trash');
    expect(trashLabel('win32')).toBe('Move to Recycle Bin');
    expect(trashLabel('linux')).toBe('Move to Rubbish Bin');
  });

  it('tells the trash action what kind of row it was, so the question can say so', () => {
    const spies = actions();
    const folder = buildTreeRowMenu('/vault/sub', 'directory', spies, 'darwin');
    (folder.find((candidate) => candidate.id === 'tree-trash')?.click as () => void)();
    expect(spies.trash).toHaveBeenCalledWith('/vault/sub', 'directory');
  });

  it('calls the file manager what each system calls it', () => {
    expect(revealLabel('darwin')).toBe('Reveal in Finder');
    expect(revealLabel('win32')).toBe('Reveal in File Explorer');
    expect(revealLabel('linux')).toBe('Reveal in File Manager');
  });

  it('acts on the path it was built with, and no other', () => {
    const spies = actions();
    const items = buildTreeRowMenu('/vault/note.md', 'file', spies, 'darwin');
    const click = (id: string) => {
      const item = items.find((candidate) => candidate.id === id);
      if (!item?.click) throw new Error(`no item ${id}`);
      (item.click as () => void)();
    };
    click('tree-open');
    click('tree-reveal');
    click('tree-copy-path');
    click('tree-rename');
    click('tree-duplicate');
    click('tree-move');
    expect(spies.open).toHaveBeenCalledWith('/vault/note.md');
    expect(spies.reveal).toHaveBeenCalledWith('/vault/note.md');
    expect(spies.copyPath).toHaveBeenCalledWith('/vault/note.md');
    expect(spies.rename).toHaveBeenCalledWith('/vault/note.md');
    expect(spies.duplicate).toHaveBeenCalledWith('/vault/note.md');
    expect(spies.move).toHaveBeenCalledWith('/vault/note.md');
  });
});

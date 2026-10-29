import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

const resultRoot = path.join(process.cwd(), 'test-results', 'entry-actions');

async function launch(name: string): Promise<{
  app: ElectronApplication; page: Page; vault: string; workspace: string;
}> {
  const workspace = path.join(resultRoot, name);
  await rm(workspace, { recursive: true, force: true });
  const vault = path.join(workspace, 'vault');
  await mkdir(path.join(vault, 'sub'), { recursive: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  await writeFile(path.join(vault, 'note.md'), '# Note\n\nThe body.\n', 'utf8');
  await writeFile(path.join(vault, 'other.md'), '# Other\n', 'utf8');
  await writeFile(path.join(vault, 'sub', 'deeper.md'), '# Deeper\n', 'utf8');
  await mkdir(path.join(workspace, 'outside'), { recursive: true });
  await writeFile(path.join(workspace, 'outside', 'secret.md'), '# Not in the vault\n', 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, vault],
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
  return { app, page, vault, workspace };
}

/** Ask main to act on a row, the way the tree does after a menu choice. */
async function act(
  page: Page,
  action: 'rename' | 'duplicate' | 'trash' | 'new-folder' | 'move' | 'move-into',
  target: string,
  name: string | null = null,
  destination: string | null = null,
): Promise<unknown> {
  return page.evaluate(async ([a, t, n, d]) => {
    const result = await window.notoWorkspace.manageEntry({
      version: 1,
      requestId: `entry:${Math.random().toString(36).slice(2)}`,
      action: a as 'rename',
      target: t as string,
      name: n as string | null,
      destination: d as string | null,
    });
    return result.ok ? result.value : { transport: result.error.message };
  }, [action, target, name, destination]);
}

const names = async (directory: string) => (await readdir(directory)).sort();

test.describe('acting on a row of the tree', () => {
  test('renames a note, and the file on disk is the one that moved', async () => {
    const { app, page, vault } = await launch('rename');
    try {
      const reply = await act(page, 'rename', path.join(vault, 'note.md'), 'Renamed.md');
      expect(reply).toMatchObject({ done: true });
      expect(await names(vault)).toEqual(['Renamed.md', 'other.md', 'sub']);
      expect(await readFile(path.join(vault, 'Renamed.md'), 'utf8')).toBe('# Note\n\nThe body.\n');
    } finally {
      await app.close();
    }
  });

  test('calls an open note by its new name once it is renamed, wherever it is shown', async () => {
    const { app, page, vault } = await launch('rename-open');
    try {
      await page.getByTestId('tree-file').filter({ hasText: 'note.md' }).click();
      await expect(page.locator('.titlebar')).toContainText('note.md');

      expect(await act(page, 'rename', path.join(vault, 'note.md'), 'Renamed.md')).toMatchObject({ done: true });
      await expect(page.locator('.titlebar')).toContainText('Renamed.md');

      // Brought forward again from the tree, it is still the renamed note,
      // in the title bar and in the window's own title.
      await page.getByTestId('tree-file').filter({ hasText: 'other.md' }).click();
      await expect(page.locator('.titlebar')).toContainText('other.md');
      await page.getByTestId('tree-file').filter({ hasText: 'Renamed.md' }).click();
      await expect(page.locator('.titlebar')).toContainText('Renamed.md');
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()))
        .toBe('Renamed.md');
    } finally {
      await app.close();
    }
  });

  test('keeps the extension when none was typed, so the note stays findable', async () => {
    const { app, page, vault } = await launch('rename-extension');
    try {
      await act(page, 'rename', path.join(vault, 'note.md'), 'Ideas');
      // A note called `Ideas` would not appear in a tree that lists only what
      // it can open, and could not be opened again.
      expect(await names(vault)).toContain('Ideas.md');
    } finally {
      await app.close();
    }
  });

  test('refuses a name that is already taken rather than writing over it', async () => {
    const { app, page, vault } = await launch('rename-exists');
    try {
      const reply = await act(page, 'rename', path.join(vault, 'note.md'), 'other.md');
      expect(reply).toMatchObject({ done: false, reason: 'exists' });
      expect(await readFile(path.join(vault, 'other.md'), 'utf8')).toBe('# Other\n');
      expect(await names(vault)).toEqual(['note.md', 'other.md', 'sub']);
    } finally {
      await app.close();
    }
  });

  test('refuses a name that is a path, however it is spelled', async () => {
    const { app, page, vault } = await launch('rename-path');
    try {
      for (const name of ['../escaped.md', 'sub/inside.md', '..']) {
        // Refused at the preload boundary, before the message is even sent,
        // so the answer is a rejected request rather than a reply. Either way
        // it is not `done`, which is what the file on disk depends on.
        const reply = await act(page, 'rename', path.join(vault, 'note.md'), name);
        expect(reply).not.toMatchObject({ done: true });
      }
      expect(await names(vault)).toEqual(['note.md', 'other.md', 'sub']);
    } finally {
      await app.close();
    }
  });

  test('refuses to touch anything outside the open folder, however it is named', async () => {
    const { app, page, vault, workspace } = await launch('outside');
    const outside = path.join(workspace, 'outside', 'secret.md');
    try {
      // Directly, by climbing, and through a link planted inside the vault.
      await symlink(outside, path.join(vault, 'link.md'));
      for (const target of [outside, path.join(vault, '..', 'outside', 'secret.md'), path.join(vault, 'link.md')]) {
        expect(await act(page, 'trash', target)).toMatchObject({ done: false, reason: 'outside-root' });
      }
      expect(await readFile(outside, 'utf8')).toBe('# Not in the vault\n');
    } finally {
      await app.close();
    }
  });

  test('duplicates a note beside itself, numbering the later copies', async () => {
    const { app, page, vault } = await launch('duplicate');
    try {
      expect(await act(page, 'duplicate', path.join(vault, 'note.md'))).toMatchObject({ done: true });
      expect(await act(page, 'duplicate', path.join(vault, 'note.md'))).toMatchObject({ done: true });
      expect(await names(vault)).toEqual(['note (copy) 2.md', 'note (copy).md', 'note.md', 'other.md', 'sub']);
      expect(await readFile(path.join(vault, 'note (copy).md'), 'utf8')).toBe('# Note\n\nThe body.\n');
    } finally {
      await app.close();
    }
  });

  test('duplicates a folder with what is inside it', async () => {
    const { app, page, vault } = await launch('duplicate-folder');
    try {
      expect(await act(page, 'duplicate', path.join(vault, 'sub'))).toMatchObject({ done: true });
      expect(await names(path.join(vault, 'sub (copy)'))).toEqual(['deeper.md']);
    } finally {
      await app.close();
    }
  });

  test('makes a folder where it was asked to, and refuses a second of the same name', async () => {
    const { app, page, vault } = await launch('new-folder');
    try {
      expect(await act(page, 'new-folder', path.join(vault, 'sub'), 'Notes')).toMatchObject({ done: true });
      expect(await names(path.join(vault, 'sub'))).toEqual(['Notes', 'deeper.md']);
      expect(await act(page, 'new-folder', path.join(vault, 'sub'), 'Notes'))
        .toMatchObject({ done: false, reason: 'exists' });
    } finally {
      await app.close();
    }
  });

  test('moves a note to the trash rather than deleting it', async () => {
    const { app, page, vault } = await launch('trash');
    try {
      expect(await act(page, 'trash', path.join(vault, 'other.md'))).toMatchObject({ done: true });
      expect(await names(vault)).toEqual(['note.md', 'sub']);
    } finally {
      await app.close();
    }
  });

  test('moves a note into another folder, and refuses one outside the vault', async () => {
    const { app, page, vault, workspace } = await launch('move');
    const outside = path.join(workspace, 'outside');
    try {
      // The destination comes from a folder dialog, which can reach the whole
      // disk. Answer it without opening one.
      const answerWith = async (folder: string) => app.evaluate(({ dialog }, chosen) => {
        (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog =
          async () => ({ canceled: false, filePaths: [chosen] });
      }, folder);

      await answerWith(path.join(vault, 'sub'));
      expect(await act(page, 'move', path.join(vault, 'note.md'))).toMatchObject({ done: true });
      expect(await names(path.join(vault, 'sub'))).toEqual(['deeper.md', 'note.md']);
      expect(await names(vault)).toEqual(['other.md', 'sub']);

      // Only the part of the disk inside the vault is somewhere this may write.
      await answerWith(outside);
      expect(await act(page, 'move', path.join(vault, 'other.md')))
        .toMatchObject({ done: false, reason: 'outside-root' });
      expect(await names(vault)).toEqual(['other.md', 'sub']);
    } finally {
      await app.close();
    }
  });

  test('refuses to move a folder inside itself, which would lose what is in it', async () => {
    const { app, page, vault } = await launch('move-into-itself');
    try {
      await app.evaluate(({ dialog }, chosen) => {
        (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog =
          async () => ({ canceled: false, filePaths: [chosen] });
      }, path.join(vault, 'sub'));
      expect(await act(page, 'move', path.join(vault, 'sub')))
        .toMatchObject({ done: false, reason: 'into-itself' });
      expect(await names(path.join(vault, 'sub'))).toEqual(['deeper.md']);
    } finally {
      await app.close();
    }
  });

  test('will not act on the open folder itself', async () => {
    const { app, page, vault } = await launch('root');
    try {
      expect(await act(page, 'trash', vault)).toMatchObject({ done: false, reason: 'outside-root' });
      expect(await act(page, 'rename', vault, 'Renamed')).toMatchObject({ done: false });
      expect(await names(vault)).toEqual(['note.md', 'other.md', 'sub']);
    } finally {
      await app.close();
    }
  });
});

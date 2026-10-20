import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

/**
 * End to end coverage for the product shell against the packaged application.
 *
 * These replace the retired specs that drove the app through build-variant test
 * controls and CLI mode flags. Nothing here reaches a test-only channel,
 * because none exists: the app is exercised the way a user does.
 */

const root = path.resolve(__dirname, '../..');


const resultRoot = path.join(root, 'test-results/shell-packaged');

const SAMPLE = [
  '# Noto',
  '',
  'A paragraph of ordinary prose.',
  '',
  '## Features',
  '',
  '| Feature | State |',
  '| --- | --- |',
  '| Tables | editable |',
  '',
  '- [ ] open a file',
  '- [x] render a table',
  '',
  '$$',
  'E = mc^2',
  '$$',
  '',
  '```ts',
  'const answer = 42;',
  '```',
  '',
].join('\n');

/**
 * Line navigation is not the same key everywhere. macOS uses Command with an
 * arrow; Windows and Linux use Home and End. Getting this wrong leaves the
 * caret where it started and the test asserts against the wrong document.
 */
const LINE_START = process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home';
const LINE_END = process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End';

interface RunningApp {
  app: ElectronApplication;
  page: Page;
  issues: string[];
}

/**
 * Invoke an application menu item by id.
 *
 * A synthetic keystroke reaches the renderer, not the native menu, so pressing
 * the accelerator would prove nothing about the menu. Clicking the real item
 * exercises the wiring a user actually triggers.
 */
async function invokeMenu(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ Menu }, itemId) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | null => {
      for (const item of items) {
        if (item.id === itemId) return item;
        const nested = item.submenu ? find(item.submenu.items) : null;
        if (nested) return nested;
      }
      return null;
    };
    const menu = Menu.getApplicationMenu();
    const target = menu ? find(menu.items) : null;
    if (!target) throw new Error(`No menu item with id ${itemId}`);
    target.click();
  }, id);
}

async function launch(workspace: string, openPath?: string): Promise<RunningApp> {
  const userData = path.join(workspace, 'user-data');
  await mkdir(userData, { recursive: true });
  const args = [`--user-data-dir=${userData}`, `--NTO_EVIDENCE_DIR=${path.join(workspace, 'evidence')}`];
  if (openPath) args.push(`--open=${openPath}`);

  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args,
    env: { ...process.env, NTO_EVIDENCE_DIR: path.join(workspace, 'evidence') },
  });
  const page = await app.firstWindow();
  const issues: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') issues.push(message.text());
  });
  page.on('pageerror', (error) => issues.push(error.message));
  await page.waitForSelector('[data-testid="noto-app"]', { state: 'visible', timeout: 30_000 });
  // The window is shown on `ready-to-show`, so elements can exist with no
  // layout for a moment. Waiting for the surface this launch will actually
  // present keeps that race out of every individual test.
  await page.waitForSelector(
    openPath ? '[data-testid="noto-editor"]' : '[data-testid="empty-state"]',
    { state: 'visible', timeout: 30_000 },
  );
  return { app, page, issues };
}

test.describe('Noto product shell', () => {
  test('starts with no document and offers a way to open one', async () => {
    const workspace = path.join(resultRoot, 'empty-state');
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true });

    const { app, page, issues } = await launch(workspace);
    try {
      // The point of the whole shell: a user with no CLI flags sees a way in.
      await expect(page.getByTestId('empty-state')).toBeVisible();
      await expect(page.getByTestId('empty-open')).toBeVisible();
      await expect(page.getByTestId('file-state')).toHaveText('No document');
      expect(issues).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('opens a document, renders every construct, and edits it', async () => {
    const workspace = path.join(resultRoot, 'open-and-edit');
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true });
    const file = path.join(workspace, 'sample.md');
    await writeFile(file, SAMPLE, 'utf8');

    const { app, page, issues } = await launch(workspace, file);
    try {
      await expect(page.getByTestId('noto-editor')).toBeVisible();
      await expect(page.getByTestId('file-state')).toHaveText('Opened');

      // Every construct that the previous editor froze as read-only source is
      // now a real node in the document.
      const editor = page.locator('.ProseMirror');
      await expect(editor.locator('h1')).toHaveText('Noto');
      await expect(editor.locator('table')).toHaveCount(1);
      await expect(editor.locator('th')).toHaveCount(2);
      await expect(editor.locator('li.noto-task-item')).toHaveCount(2);
      await expect(editor.locator('li.noto-task-item[data-checked="true"]')).toHaveCount(1);
      await expect(editor.locator('.noto-math-block')).toHaveCount(1);
      await expect(editor.locator('pre[data-lang="ts"]')).toHaveCount(1);

      // Typing marks the document dirty and enables saving. Clicking near the
      // left edge puts the caret at the start deterministically; clicking the
      // element's centre lands mid-word and varies with layout.
      await editor.locator('p').first().click({ position: { x: 1, y: 8 } });
      await page.keyboard.press(LINE_START);
      await page.keyboard.type('Edited. ');
      await expect(page.getByTestId('file-state')).toHaveText('Unsaved changes');

      const saveButton = page.getByTestId('save-button');
      await expect(saveButton).toBeEnabled();
      await saveButton.click();
      await expect(page.getByTestId('file-state')).toHaveText('Saved');

      // Byte fidelity: only the edited paragraph changed. Everything else,
      // including the table, the math and the fence, is untouched.
      const saved = await readFile(file, 'utf8');
      expect(saved).toBe(SAMPLE.replace('A paragraph of ordinary prose.', 'Edited. A paragraph of ordinary prose.'));
      expect(issues).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('shows an outline built from the document headings', async () => {
    const workspace = path.join(resultRoot, 'outline');
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true });
    const file = path.join(workspace, 'sample.md');
    await writeFile(file, SAMPLE, 'utf8');

    const { app, page, issues } = await launch(workspace, file);
    try {
      // Below 900px the rail lies over the document; pin a width where it is a column.
      await page.setViewportSize({ width: 1280, height: 860 });
      // Outline is a view inside the rail now, so the rail has to be showing
      // before its tab can be picked. The menu item opens both at once.
      await page.getByTestId('sidebar-toggle').click();
      await page.getByTestId('outline-toggle').click();
      const outline = page.getByTestId('outline-panel');
      await expect(outline).toBeVisible();
      // Asserting the whole list at once reports what was actually rendered
      // when it disagrees, instead of only that one entry was missing.
      await expect(outline.locator('.outline-entry')).toHaveText(['Noto', 'Features']);
      expect(issues).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('remembers the document and offers it as recent on the next launch', async () => {
    const workspace = path.join(resultRoot, 'recent');
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true });
    const file = path.join(workspace, 'remembered.md');
    await writeFile(file, SAMPLE, 'utf8');

    const first = await launch(workspace, file);
    await expect(first.page.getByTestId('file-state')).toHaveText('Opened');
    await first.app.close();

    // Same user-data directory, no path this time: the recent list is the only
    // way the document can appear.
    const second = await launch(workspace);
    try {
      await expect(second.page.getByTestId('empty-state')).toBeVisible();
      await expect(second.page.getByRole('button', { name: /remembered\.md/ })).toBeVisible();
      expect(second.issues).toEqual([]);
    } finally {
      await second.app.close();
    }
  });

  test('highlights fenced code without embedding an editor per fence', async () => {
    const workspace = path.join(resultRoot, 'highlight');
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true });
    const file = path.join(workspace, 'code.md');
    await writeFile(file, '```ts\nexport const answer: number = 42;\n```\n\n```python\ndef f():\n    return "x"\n```\n', 'utf8');

    const { app, page, issues } = await launch(workspace, file);
    try {
      const editor = page.locator('.ProseMirror');
      await expect(editor.locator('pre')).toHaveCount(2);
      // Tokens are decorations over the one editor, not nested editors.
      await expect(editor.locator('pre').first().locator('.token.keyword').first()).toBeVisible();
      await expect(editor.locator('pre').nth(1).locator('.token.string').first()).toBeVisible();
      await expect(editor.locator('.CodeMirror, .cm-editor')).toHaveCount(0);
      expect(issues).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('toggles one block into raw markdown and back', async () => {
    const workspace = path.join(resultRoot, 'source-toggle');
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true });
    const file = path.join(workspace, 'toggle.md');
    const original = '# Title\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n';
    await writeFile(file, original, 'utf8');

    const { app, page, issues } = await launch(workspace, file);
    try {
      const editor = page.locator('.ProseMirror');
      await expect(editor.locator('table')).toHaveCount(1);

      // Put the caret in the table. The active-block decoration is how the
      // editor reports where the caret actually is, so waiting on it removes
      // the race between the click landing and the selection moving.
      await editor.locator('td').first().click();
      // `columnResizing` wraps tables in a node view, so the active-block
      // decoration lands on that wrapper rather than on the table element.
      await expect(editor.locator('.noto-active-block table')).toHaveCount(1);

      await invokeMenu(app, 'toggle-source');

      const source = editor.locator('.noto-source-block');
      await expect(source).toHaveCount(1);
      await expect(source).toContainText('| a | b |');
      // Only that block changed; the heading is still rendered.
      await expect(editor.locator('h1')).toHaveText('Title');
      await expect(editor.locator('table')).toHaveCount(0);

      // Toggling back restores the rendered table.
      await invokeMenu(app, 'toggle-source');
      await expect(editor.locator('table')).toHaveCount(1);
      await expect(editor.locator('.noto-source-block')).toHaveCount(0);

      // The document is unchanged, so a save writes the original bytes back.
      expect(await readFile(file, 'utf8')).toBe(original);
      expect(issues).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('applies markdown input rules while typing', async () => {
    const workspace = path.join(resultRoot, 'input-rules');
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true });
    const file = path.join(workspace, 'typing.md');
    // An empty document has exactly one empty paragraph, so the caret position
    // after clicking is unambiguous and the assertions cannot drift with layout.
    await writeFile(file, '', 'utf8');

    const { app, page, issues } = await launch(workspace, file);
    try {
      const editor = page.locator('.ProseMirror');
      await editor.click();
      await page.keyboard.type('## A heading');
      await expect(editor.locator('h2')).toHaveText('A heading');

      await page.keyboard.press('Enter');
      await page.keyboard.type('- [ ] a task');
      await expect(editor.locator('li.noto-task-item')).toHaveCount(1);
      await expect(editor.locator('li.noto-task-item[data-checked="false"]')).toHaveCount(1);

      // The same block rules that run on load also run while typing.
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await page.keyboard.type('> a quote');
      await expect(editor.locator('blockquote')).toHaveCount(1);
      expect(issues).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

/**
 * Opening a document the way a person does.
 *
 * Every other test here hands the app a path on the command line or calls the
 * workspace IPC directly, because that is convenient. Neither is the route a
 * user takes, and the product requirement is explicit that a file is opened
 * through the interface rather than a flag. These two cover the only paths that
 * exist for someone with no document open: the button and the recent list.
 */
test.describe('opening through the interface', () => {
  test('opens a document from the empty state button', async () => {
    const workspace = path.join(resultRoot, 'open-dialog');
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true });
    const file = path.join(workspace, 'chosen.md');
    await writeFile(file, SAMPLE, 'utf8');

    // No path, so the app starts empty and the button is the only way in.
    const { app, page, issues } = await launch(workspace);
    try {
      await expect(page.getByTestId('empty-state')).toBeVisible();

      // The dialog itself cannot be driven from a test, so it is answered.
      // Everything after it is the real path: the workspace opens the file, the
      // store accepts it and the editor renders it.
      await app.evaluate(({ dialog }, target) => {
        (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog =
          async () => ({ canceled: false, filePaths: [target] });
      }, file);

      await page.getByTestId('empty-open').click();

      await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('.ProseMirror h1')).toHaveText('Noto');
      await expect(page.locator('.ProseMirror')).toContainText('A paragraph of ordinary prose.');
      await expect(page.getByTestId('empty-state')).toHaveCount(0);
      expect(issues).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('opens a document by clicking it in the recent list', async () => {
    const workspace = path.join(resultRoot, 'recent-click');
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true });
    const file = path.join(workspace, 'revisited.md');
    await writeFile(file, SAMPLE, 'utf8');

    // First run records it as recent.
    const first = await launch(workspace, file);
    await expect(first.page.getByTestId('file-state')).toHaveText('Opened');
    await first.app.close();

    const { app, page, issues } = await launch(workspace);
    try {
      const entry = page.getByRole('button', { name: /revisited\.md/ });
      await expect(entry).toBeVisible();
      await entry.click();

      await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('.ProseMirror h1')).toHaveText('Noto');
      await expect(page.locator('.ProseMirror')).toContainText('A paragraph of ordinary prose.');
      expect(issues).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

/**
 * The behaviour the product is named for: markdown syntax is visible on the
 * block you are editing and nowhere else. It had no test, and it was changed
 * recently, so a regression would have been invisible.
 */
test.describe('syntax markers follow the caret', () => {
  const markerOpacity = (page: Page, selector: string) => page.evaluate((target) => {
    const element = globalThis.document.querySelector(target);
    return element ? globalThis.getComputedStyle(element, '::before').opacity : null;
  }, selector);

  test('shows a heading its marker only while the caret is inside it', async () => {
    const workspace = path.join(resultRoot, 'markers');
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true });
    const file = path.join(workspace, 'markers.md');
    await writeFile(file, SAMPLE, 'utf8');

    const { app, page } = await launch(workspace, file);
    try {
      // Nothing focused yet, so no block is being edited and no marker shows.
      // ProseMirror puts the selection at the start on open, which is why this
      // has to be gated on focus rather than on the selection alone.
      expect(await markerOpacity(page, '.ProseMirror h1')).toBe('0');

      await page.locator('.ProseMirror h1').click();
      await expect(page.locator('.ProseMirror h1')).toHaveClass(/noto-active-block/);
      // The marker fades in over 120ms, so this waits for it to arrive rather
      // than sampling somewhere in the middle of the transition.
      await expect.poll(() => markerOpacity(page, '.ProseMirror h1')).toBe('1');

      // Move to a different block: the heading gives its marker back.
      await page.locator('.ProseMirror p').first().click();
      await expect(page.locator('.ProseMirror h1')).not.toHaveClass(/noto-active-block/);
      await expect.poll(() => markerOpacity(page, '.ProseMirror h1')).toBe('0');
    } finally {
      await app.close();
    }
  });
});

test.describe('the outline navigates', () => {
  test('moves the caret to the heading that was clicked', async () => {
    const workspace = path.join(resultRoot, 'outline-click');
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true });
    const file = path.join(workspace, 'outline.md');
    await writeFile(file, SAMPLE, 'utf8');

    const { app, page, issues } = await launch(workspace, file);
    try {
      await page.setViewportSize({ width: 1280, height: 860 });
      await invokeMenu(app, 'toggle-outline');
      const outline = page.getByTestId('outline-panel');
      await expect(outline).toBeVisible();

      // Entries were previously only asserted to exist. Clicking one is what
      // the panel is for.
      await outline.getByRole('button', { name: 'Features' }).click();

      // The clicked heading becomes the block being edited.
      await expect(page.locator('.ProseMirror h2')).toHaveClass(/noto-active-block/);
      expect(issues).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

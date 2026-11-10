import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

/*
 * A fence's language: read from the code when the fence names none, shown as
 * a guess in the corner, and chosen from a list that filters as it is typed.
 * The file changes only when the reader chooses.
 */
test('read a fence that names no language, and choose its language from the list', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'fence-language');
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const file = path.join(workspace, 'note.md');
  const text = '# Languages\n\n```\nkubectl get pods -A\n```\n\n```python\nprint(1)\n```\n';
  await writeFile(file, text, 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${file}`],
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
    await page.setViewportSize({ width: 1280, height: 900 });
    const [shell, python] = [page.locator('.ProseMirror pre').first(), page.locator('.ProseMirror pre').nth(1)];

    // The guess colours the code and is said in the corner, marked as one.
    await expect(shell.locator('.token').first()).toBeVisible();
    await shell.hover();
    const label = shell.locator('.noto-fence-lang');
    await expect(label).toHaveAttribute('data-state', 'guess');
    await expect(label).toContainText('Shell');
    await expect(label.locator('.noto-fence-lang-auto')).toHaveText('auto');
    await expect(shell).not.toHaveAttribute('data-lang');

    // Enter keeps the guess: it is the first row, and the one Enter takes.
    await label.click();
    const picker = page.getByTestId('language-picker');
    await expect(picker).toBeVisible();
    const active = picker.locator('.noto-lang-option[aria-selected="true"]');
    await expect(active).toContainText('Shell');
    await expect(active).toContainText('detected');
    await page.keyboard.press('Enter');
    await expect(picker).toHaveCount(0);
    await expect(shell).toHaveAttribute('data-lang', 'bash');
    await expect(label).toHaveAttribute('data-state', 'set');
    await expect(page.locator('.canvas-slot:not([hidden]) .ProseMirror')).toBeFocused();

    // Typing filters by any name, with the letters that matched marked.
    await python.hover();
    await python.locator('.noto-fence-lang').click();
    await page.keyboard.type('jav');
    await expect(active).toContainText('JavaScript');
    await expect(active.locator('mark')).toHaveText('Jav');
    await page.keyboard.press('ArrowDown');
    await expect(active).toHaveAttribute('data-lang', 'java');
    // Escape leaves the fence as it was.
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    await expect(python).toHaveAttribute('data-lang', 'python');

    // A press anywhere else closes the list without a change.
    await python.locator('.noto-fence-lang').click();
    await expect(picker).toBeVisible();
    await page.locator('.ProseMirror h1').click();
    await expect(picker).toHaveCount(0);
    await expect(python).toHaveAttribute('data-lang', 'python');

    await page.getByTestId('save-button').click();
    await expect(page.getByTestId('file-state')).toHaveText('Saved', { timeout: 15_000 });
    expect(await readFile(file, 'utf8')).toBe(text.replace('```\nkubectl', '```bash\nkubectl'));
  } finally {
    await app.close();
  }
});

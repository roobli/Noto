import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

async function invokeMenu(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ Menu }, wanted) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | null => {
      for (const item of items) {
        if (item.id === wanted) return item;
        const nested = item.submenu ? find(item.submenu.items) : null;
        if (nested) return nested;
      }
      return null;
    };
    const target = find(Menu.getApplicationMenu()!.items);
    if (!target) throw new Error(`no menu item ${wanted}`);
    target.click();
  }, id);
}

async function launch(name: string): Promise<{ app: ElectronApplication; page: Page }> {
  const workspace = path.join(process.cwd(), 'test-results', 'quick-syntax', name);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const vault = path.join(workspace, 'vault');
  await mkdir(path.join(vault, 'works', 'jobs'), { recursive: true });
  await mkdir(path.join(vault, 'works', 'journal'), { recursive: true });
  await mkdir(path.join(vault, 'archive'), { recursive: true });
  await writeFile(path.join(vault, 'works', 'plan.md'), '# Plan\n\nThe kestrel plan.\n', 'utf8');
  await writeFile(path.join(vault, 'works', 'jobs', 'hiring.md'), '# Hiring\n\nKestrels again.\n', 'utf8');
  await writeFile(path.join(vault, 'works', 'journal', 'monday.md'), '# Monday\n\nA kestrel Monday.\n', 'utf8');
  await writeFile(path.join(vault, 'archive', 'old.md'), '# Old\n\nAn old kestrel note.\n', 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, vault],
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
  await invokeMenu(app, 'quick-open');
  await expect(page.getByTestId('quick-open')).toBeVisible();
  return { app, page };
}

test.describe('the query language', () => {
  test('type: says what to search, whichever tab is showing', async () => {
    const { app, page } = await launch('type');
    try {
      const input = page.getByTestId('quick-input');
      await expect(page.getByTestId('quick-tab-files')).toHaveAttribute('aria-selected', 'true');

      // A written type outranks the tab, and the tabs say so.
      await input.fill('type:content kestrel');
      await expect(page.getByTestId('quick-tab-content')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('quick-match')).toHaveCount(4, { timeout: 15_000 });

      await input.fill('type:folder jo');
      await expect(page.getByTestId('quick-tab-folders')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('quick-folder')).toHaveCount(2);

      // The words matched are the words, never the operator.
      await input.fill('type:file plan');
      await expect(page.getByTestId('quick-result')).toHaveCount(1);
      await expect(page.getByTestId('quick-result').first().locator('.quick-name')).toHaveText('plan');

      // Its aliases are the plugin's own.
      await input.fill('type:c kestrel');
      await expect(page.getByTestId('quick-tab-content')).toHaveAttribute('aria-selected', 'true');
    } finally {
      await app.close();
    }
  });

  test('scope: says where, and shows as the chip the folders tab sets', async () => {
    const { app, page } = await launch('scope');
    try {
      const input = page.getByTestId('quick-input');
      await input.fill('type:content kestrel');
      await expect(page.getByTestId('quick-match')).toHaveCount(4, { timeout: 15_000 });

      await input.fill('scope:works type:content kestrel');
      await expect(page.getByTestId('quick-scope')).toHaveText('works');
      await expect(page.getByTestId('quick-match')).toHaveCount(3, { timeout: 15_000 });

      await input.fill('scope:works/jobs type:content kestrel');
      await expect(page.getByTestId('quick-match')).toHaveCount(1, { timeout: 15_000 });

      // Pressing the chip takes the written scope out of the box.
      await page.getByTestId('quick-scope').click();
      await expect(input).toHaveValue('type:content kestrel');
      await expect(page.getByTestId('quick-scope')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('finishes an operator, a type and a folder as they are typed', async () => {
    const { app, page } = await launch('complete');
    try {
      const input = page.getByTestId('quick-input');
      const rows = page.getByTestId('quick-complete-row');

      await input.fill('ty');
      await expect(rows).toHaveText(['type:']);
      await page.keyboard.press('Tab');
      await expect(input).toHaveValue('type:');

      // The three types, then one of them taken.
      await expect(rows).toHaveText(['type:file', 'type:folder', 'type:content']);
      await input.fill('type:co');
      await expect(rows).toHaveText(['type:content']);
      await page.keyboard.press('Tab');
      await expect(input).toHaveValue('type:content');
      await expect(page.getByTestId('quick-tab-content')).toHaveAttribute('aria-selected', 'true');

      // A folder, one segment at a time, with how many notes it holds.
      await input.fill('scope:w');
      await expect(rows.first()).toContainText('scope:works/');
      await expect(rows.first()).toContainText('3 notes');
      await page.keyboard.press('Tab');
      await expect(input).toHaveValue('scope:works/');
      await expect(rows).toHaveText([/scope:works\/jobs\//, /scope:works\/journal\//]);
      await page.keyboard.press('Tab');
      await expect(input).toHaveValue('scope:works/jobs/');
      await expect(page.getByTestId('quick-scope')).toHaveText('works/jobs');

      // With nothing to finish, Tab is back to moving along the tabs.
      await input.fill('kestrel');
      await expect(page.getByTestId('quick-complete')).toHaveCount(0);
      await page.keyboard.press('Tab');
      await expect(page.getByTestId('quick-tab-folders')).toHaveAttribute('aria-selected', 'true');
    } finally {
      await app.close();
    }
  });
});

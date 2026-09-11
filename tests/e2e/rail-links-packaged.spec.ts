import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

const GRAPH = {
  schemaVersion: 2,
  generatedAt: '2026-09-01T00:00:00Z',
  root: '/vault',
  notes: [
    {
      relPath: 'topics/embedding.md', title: '微调 embedding 模型',
      explicitLinks: ['topics/batch.md'],
      backlinks: ['journal/monday.md'],
      candidates: [
        { relPath: 'topics/lora.md', title: 'LoRA 指南', score: 88 },
        { relPath: 'topics/batch.md', title: 'batch', score: 70 },
      ],
    },
    { relPath: 'topics/batch.md', title: 'batch 与 epoch', backlinks: ['topics/embedding.md'] },
    { relPath: 'topics/lora.md', title: 'LoRA 微调指南' },
    { relPath: 'journal/monday.md', title: '周一' },
  ],
};

test('the Links view shows what the graph knows and opens a neighbour', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'rail-links');
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  // Links is opt-in; this suite exercises the view itself.
  await writeFile(
    path.join(workspace, 'user-data', 'settings.json'),
    JSON.stringify({ railLinks: true }),
    'utf8',
  );
  const vault = path.join(workspace, 'vault');
  await mkdir(path.join(vault, 'topics'), { recursive: true });
  await mkdir(path.join(vault, 'journal'), { recursive: true });
  await mkdir(path.join(vault, '.note-assistant'), { recursive: true });
  await writeFile(path.join(vault, '.note-assistant', 'graph.json'), JSON.stringify(GRAPH), 'utf8');
  await writeFile(path.join(vault, 'topics', 'embedding.md'), '# 微调 embedding 模型\n\nBody.\n', 'utf8');
  await writeFile(path.join(vault, 'topics', 'batch.md'), '# batch 与 epoch\n\nThe batch note.\n', 'utf8');
  await writeFile(path.join(vault, 'topics', 'lora.md'), '# LoRA\n', 'utf8');
  await writeFile(path.join(vault, 'journal', 'monday.md'), '# 周一\n\nSee [[topics/embedding]].\n', 'utf8');
  await writeFile(path.join(vault, 'stray.md'), '# Not in the graph\n', 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, vault],
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });

    // Before any note is open, the view says so.
    await page.getByTestId('links-toggle').click();
    await expect(page.locator('#rail-view-links')).toContainText('Open a note');

    // Open the note by its folder, then read its three lists.
    await page.getByTestId('rail-files').click();
    await page.getByTestId('tree-directory').filter({ hasText: 'topics' }).click();
    await page.getByTestId('tree-file').filter({ hasText: 'embedding' }).click();
    await page.locator('.canvas-slot:not([hidden]) .ProseMirror').waitFor({ state: 'visible' });
    await page.getByTestId('links-toggle').click();
    const panel = page.getByTestId('links-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('links-backlinks').locator('.rail-hit-name')).toHaveText(['周一']);
    await expect(panel.getByTestId('links-out').locator('.rail-hit-name')).toHaveText(['batch 与 epoch']);
    // Related leaves out the note already linked to, and names by the graph's own title.
    await expect(panel.getByTestId('links-related').locator('.rail-hit-name')).toHaveText(['LoRA 微调指南']);
    await expect(panel.getByTestId('links-backlinks').locator('.rail-hit-folder')).toHaveText(['journal']);

    // A neighbour opens on a click, and the view follows to the new note.
    await panel.getByTestId('links-out').getByTestId('rail-link').click();
    await expect(page.locator('.canvas-slot:not([hidden]) .ProseMirror')).toContainText('The batch note.');
    await expect(panel.getByTestId('links-backlinks').locator('.rail-hit-name')).toHaveText(['微调 embedding 模型']);

    // A note the graph has not met says so.
    await page.getByTestId('rail-files').click();
    await page.getByTestId('tree-file').filter({ hasText: 'stray' }).click();
    await page.getByTestId('links-toggle').click();
    await expect(page.getByTestId('links-status')).toContainText('has not met this note');
  } finally {
    await app.close();
  }
});

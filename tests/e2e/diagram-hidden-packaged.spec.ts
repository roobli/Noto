/**
 * A diagram asked for while its note is not in front is drawn once it is.
 *
 * Each note keeps its own page, and a note behind another is hidden. Mermaid
 * measures every box and label as it lays a chart out, and in a hidden page
 * each measures zero; a chart with labelled arrows then failed with "Could
 * not find a suitable point for the given distance", and the failure stayed
 * when the note came back, since nothing asked for the drawing again.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

const CHART = [
  '# Map', '', '```mermaid', 'flowchart TB',
  '    ext["Outside callers"]', '    api["api<br/>auth and billing"]', '    svc["service<br/>reads and audit"]',
  '    idx[("index<br/>global")]', '    db[("database<br/>audit")]', '    job["loader"]', '    src[("source")]',
  '    ext -->|"API key"| api', '    api ==>|"proxy, search<br/>lookup"| svc', '    svc ==> idx', '    svc -->|"write"| db',
  '    idx ~~~ job', '    src --> job', '    job -->|"whole rows<br/>with marks"| idx', '    db -.->|"reads"| svc',
  '    linkStyle 1 stroke:#2f5fb3,stroke-width:3px', '```', '', 'After.', '',
].join('\n');

test('a diagram asked for while its note was behind another is drawn when it comes to the front', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'diagram-hidden');
  await rm(workspace, { recursive: true, force: true });
  const vault = path.join(workspace, 'vault');
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  await mkdir(vault, { recursive: true });
  await writeFile(path.join(vault, 'map.md'), CHART, 'utf8');
  await writeFile(path.join(vault, 'other.md'), '# Other\n\nText.\n', 'utf8');
  const app = await electron.launch({ executablePath: packagedExecutable(), args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, vault] });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
    const open = (name: string) => page.getByTestId('tree-file').filter({ hasText: name }).click();
    // Away again before the chart has been drawn, so it is laid out behind the other note.
    await open('map.md');
    await page.waitForTimeout(80);
    await open('other.md');
    await page.waitForTimeout(3000);
    await open('map.md');
    const diagram = page.locator('.canvas-slot:not([hidden]) pre.noto-fence[data-lang="mermaid"] .noto-diagram');
    await expect(diagram).toHaveAttribute('data-state', 'rendered', { timeout: 15_000 });
    await expect(diagram.locator('.noto-diagram-status')).toHaveText('');
    await expect.poll(() => diagram.locator('iframe').evaluate((frame) => frame.getBoundingClientRect().height)).toBeGreaterThan(100);
  } finally {
    await app.close();
  }
});

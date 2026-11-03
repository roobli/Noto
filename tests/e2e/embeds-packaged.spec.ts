import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';
import { packagedExecutable } from './packaged-app';

test('a web page a note embeds waits to be asked, then loads in a sandbox', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'embeds');
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const vault = path.join(workspace, 'vault');
  await mkdir(vault, { recursive: true });
  await writeFile(path.join(vault, 'a-embed.md'), [
    '# Embeds', '',
    '<iframe src="https://example.invalid/page" width="1300" height="300" frameborder="0"></iframe>', '',
    '<div style="position: relative; overflow: hidden; width: 600px; height: 420px;">',
    '<iframe width="260%" height="250%" src="https://example.invalid/wide" style="position: absolute; transform: scale(0.4); left: -480px; top: -310px;"></iframe>',
    '</div>', '',
    'After.', '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(vault, 'b-other.md'), '# Other\n\n<iframe src="https://example.invalid/other"></iframe>\n', 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, vault],
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.waitForSelector('[data-testid="file-tree"]', { state: 'visible', timeout: 30_000 });
    const asked: string[] = [];
    page.on('request', (request) => { if (request.url().includes('example.invalid')) asked.push(request.url()); });

    await page.getByTestId('tree-file').filter({ hasText: 'a-embed' }).click();
    const editor = page.locator('.canvas-slot:not([hidden]) .ProseMirror');
    // Off by default: a card naming the page, no frame, and nothing asked for.
    const first = editor.locator('.noto-embed').first();
    await expect(first).toHaveAttribute('data-state', 'off');
    await expect(first.locator('.noto-embed-host')).toHaveText('example.invalid');
    await expect(editor.locator('iframe')).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(asked).toEqual([]);

    // Held to the column, though the note asked for 1300 pixels.
    const widths = await first.evaluate((box) => ({
      box: box.getBoundingClientRect().width,
      column: (box.closest('.ProseMirror') as HTMLElement).getBoundingClientRect().width,
    }));
    expect(widths.box).toBeLessThanOrEqual(widths.column);

    // The clipping box around the scaled page keeps its place and its clip.
    const wrapper = await editor.locator('.noto-html-drawn > div:not(.noto-embed)').first().evaluate((element) => {
      const style = getComputedStyle(element);
      return { position: style.position, overflow: style.overflow };
    });
    expect(wrapper).toEqual({ position: 'relative', overflow: 'hidden' });

    // Asked for, the page loads in a frame that cannot take the window anywhere.
    await first.locator('.noto-embed-load').click();
    const frame = first.locator('iframe.noto-embed-frame');
    await expect(frame).toHaveAttribute('src', 'https://example.invalid/page');
    const sandbox = (await frame.getAttribute('sandbox')) ?? '';
    expect(sandbox).toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-top-navigation');
    await expect(first).toHaveAttribute('data-state', 'live');
    // And the window lets the frame go there: a navigation the main process
    // refused would never have asked the network.
    await expect.poll(() => asked).toContain('https://example.invalid/page');
    expect(await frame.evaluate((element) => (element as HTMLIFrameElement).name)).toBe('noto-embed');

    // With embeds on, another note's page loads by itself.
    const wrote = await page.evaluate(async () => (window as unknown as {
      notoSettings: { write(request: unknown): Promise<{ ok: boolean }> };
    }).notoSettings.write({ version: 1, requestId: 'e2e-embeds-on', patch: { webEmbeds: true } }));
    expect(wrote.ok).toBe(true);
    await page.getByTestId('tree-file').filter({ hasText: 'b-other' }).click();
    await expect(page.getByTestId('document-identity')).toContainText('b-other');
    await expect(page.locator('.canvas-slot:not([hidden]) .ProseMirror iframe.noto-embed-frame'))
      .toHaveAttribute('src', 'https://example.invalid/other');
  } finally {
    await app.close();
  }
});

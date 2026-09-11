import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Empty state restraint', () => {
  it('keeps the first screen to open actions, a short line, and quiet Recent', async () => {
    const app = await readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = await readFile(new URL('../../src/renderer/styles/noto-editor.scss', import.meta.url), 'utf8');
    const empty = app.slice(
      app.indexOf('data-testid="empty-state"'),
      app.indexOf('</section>', app.indexOf('data-testid="empty-state"')) + 10,
    );

    expect(empty).toContain('empty-lead');
    expect(empty).toContain('Open a folder or a file.');
    expect(empty).toContain('empty-open-folder');
    expect(empty).toContain('Open folder…');
    expect(empty).toContain('empty-open');
    expect(empty).toContain('Open file…');
    expect(empty).not.toMatch(/<h1\b|No document open/i);
    expect(empty).not.toMatch(/Remote|Plugins|plugin|graph|MOC|wiki|vault sync/i);
    expect(empty).toContain('recent.slice(0, 5)');
    expect(empty).toContain('recent-row');
    expect(empty).not.toContain('file-row');
    expect(empty).not.toContain('aside-heading');

    expect(css).toContain('.empty-state .empty-lead');
    expect(css).toContain('.empty-state .recent-row');
    expect(css).not.toMatch(/\.empty-state h1\b/);
  });
});

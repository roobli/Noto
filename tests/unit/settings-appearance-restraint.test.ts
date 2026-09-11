import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Settings Appearance restraint', () => {
  it('keeps the glance surface and refuses colour dials; buries Remote/Plugins', async () => {
    const settings = await readFile(new URL('../../src/renderer/Settings.tsx', import.meta.url), 'utf8');
    const app = await readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = await readFile(new URL('../../src/renderer/styles/app.scss', import.meta.url), 'utf8');
    const empty = app.slice(app.indexOf('data-testid="empty-state"'), app.indexOf('</section>', app.indexOf('data-testid="empty-state"')) + 10);
    const titlebar = app.slice(app.indexOf('<header className="titlebar">'), app.indexOf('</header>', app.indexOf('<header className="titlebar">')) + 10);

    const appearance = settings.slice(
      settings.indexOf("section === 'appearance'"),
      settings.indexOf("section === 'editor'"),
    );
    expect(appearance).toContain('Theme');
    expect(appearance).toContain('Text size');
    expect(appearance).toContain('Line height');
    expect(appearance).toContain('Page width');
    expect(settings).toContain('Custom stylesheet');
    expect(appearance).toContain('ThemeFile');
    expect(appearance).toContain('pref-group">Window');
    // Glance controls land before Window chrome.
    expect(appearance.indexOf('Theme')).toBeLessThan(appearance.indexOf('pref-group">Window'));
    expect(appearance.indexOf('setting-font-size')).toBeLessThan(appearance.indexOf('pref-group">Window'));
    expect(appearance.indexOf('setting-custom-css')).toBeLessThan(appearance.indexOf('pref-group">Window'));
    expect(appearance).not.toMatch(/type=["']color["']/);
    expect(appearance).not.toMatch(/color-dial|accent-picker|Colour dial|Color dial/i);

    expect(settings).toContain("buried: true");
    expect(settings).toContain('pref-nav-sep');
    expect(settings).toContain('is-buried');
    expect(css).toContain('.pref-section.is-buried');

    expect(empty).not.toMatch(/Remote|Plugins|plugin/i);
    expect(titlebar).toContain('settings-toggle');
    expect(titlebar).not.toMatch(/pref-plugins|plugins-toggle|Remote/);
  });

  it('lets Cmd+, and Esc leave Settings for typing', async () => {
    const app = await readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('restoreSettingsExitFocus(editorRef.current, settingsButtonRef.current)');
    expect(app).toContain('if (prefsRef.current.open) closeSettings()');
    expect(app).toContain('Cmd+, again is muscle memory for leave');
  });
});

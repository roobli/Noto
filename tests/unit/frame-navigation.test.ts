import { describe, expect, it } from 'vitest';
import { frameNavigationAllowed, type FrameLike } from '../../src/main/windows/frame-navigation';

const top: FrameLike = { name: '', parent: null };
const embed: FrameLike = { name: 'noto-embed', parent: top };
const insideEmbed: FrameLike = { name: 'ad', parent: { name: 'player', parent: embed } };
const diagram: FrameLike = { name: '', parent: top };

describe('where a frame of the editor window may go', () => {
  it('keeps the window on the app’s own pages', () => {
    expect(frameNavigationAllowed('noto://bundle/index.html', true, top)).toBe(true);
    expect(frameNavigationAllowed('https://example.com/', true, top)).toBe(false);
  });

  it('lets a page a note embeds, and the frames it makes, follow the web', () => {
    expect(frameNavigationAllowed('https://www.bilibili.com/video/1', false, embed)).toBe(true);
    expect(frameNavigationAllowed('https://ads.example/', false, insideEmbed)).toBe(true);
    expect(frameNavigationAllowed('about:blank', false, insideEmbed)).toBe(true);
  });

  it('never lets an embedded page onto the app’s pages, which share the app’s origin', () => {
    for (const url of ['noto://bundle/diagram.html', 'noto://bundle/index.html', 'file:///etc/passwd', 'http://example.com/', 'javascript:alert(1)']) {
      expect(frameNavigationAllowed(url, false, embed), url).toBe(false);
      expect(frameNavigationAllowed(url, false, insideEmbed), url).toBe(false);
    }
  });

  it('keeps the app’s own frames, a diagram, inside the app', () => {
    expect(frameNavigationAllowed('noto://bundle/diagram.html', false, diagram)).toBe(true);
    expect(frameNavigationAllowed('https://example.com/', false, diagram)).toBe(false);
    expect(frameNavigationAllowed('https://example.com/', false, null)).toBe(false);
  });
});

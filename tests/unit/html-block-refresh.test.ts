/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import type { Node as ProseNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { HtmlBlockView } from '../../src/renderer/editor/noto/html-view';
import type { ImageContext } from '../../src/renderer/editor/noto/image-source';
import type { Refreshable } from '../../src/renderer/editor/noto/image-view';

// Pictures inside drawn markup resolve their addresses against the editor's
// image context. When that context changes under an open note (web images
// switched, a folder opened), the editor asks every registered view to draw
// again; markup that is not asked keeps the addresses of the old context.

const TYPE = { name: 'html_block' };
const block = (text: string) => ({ type: TYPE, textContent: text }) as unknown as ProseNode;

function mount(text: string, start: ImageContext) {
  let context = start;
  const registry = new Set<Refreshable>();
  const view = new HtmlBlockView(block(text), {} as EditorView, () => 0, () => context, registry);
  const refresh = (next: ImageContext) => {
    context = next;
    for (const item of registry) item.refresh();
  };
  const sources = () => [...view.dom.querySelectorAll('.noto-html-drawn img')].map((img) => img.getAttribute('src'));
  return { view, registry, refresh, sources };
}

const WEB = '<div align="center"><img src="https://example.invalid/x.png" alt="web"></div>';
const LOCAL = '<div align="center"><img src="pics/a.png" alt="local"></div>';

describe('drawn HTML follows a changed image context', () => {
  it('drops a web picture\u2019s address when web images are switched off', () => {
    const { refresh, sources } = mount(WEB, { documentDir: '/vault', remote: true });
    expect(sources()).toEqual(['https://example.invalid/x.png']);
    refresh({ documentDir: '/vault', remote: false });
    expect(sources()).toEqual([null]);
  });

  it('gives it back when they are switched on', () => {
    const { refresh, sources } = mount(WEB, { documentDir: '/vault', remote: false });
    expect(sources()).toEqual([null]);
    refresh({ documentDir: '/vault', remote: true });
    expect(sources()).toEqual(['https://example.invalid/x.png']);
  });

  it('resolves a relative picture once the note has a folder', () => {
    const { refresh, sources } = mount(LOCAL, { documentDir: null, remote: true });
    expect(sources()).toEqual([null]);
    refresh({ documentDir: '/vault', remote: true });
    expect(sources()[0]).toMatch(/^noto:\/\/asset\//);
  });

  it('leaves the registry when destroyed', () => {
    const { view, registry } = mount(WEB, { documentDir: '/vault', remote: true });
    view.destroy();
    expect(registry.size).toBe(0);
  });
});

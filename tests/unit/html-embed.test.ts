/**
 * @vitest-environment happy-dom
 * @vitest-environment-options {"settings": {"disableIframePageLoading": true}}
 *
 * A web page a note embeds with <iframe>: what the cleaning leaves of it.
 */

import { describe, expect, it } from 'vitest';
import type { Node as ProseNode } from 'prosemirror-model';
import { Decoration, type EditorView } from 'prosemirror-view';
import { sanitizeToHtml, worthDrawing } from '../../src/renderer/editor/noto/html-sanitize';
import { HtmlBlockView } from '../../src/renderer/editor/noto/html-view';
import type { Refreshable } from '../../src/renderer/editor/noto/image-view';

describe('a web page a note embeds', () => {
  it('becomes a placeholder naming the page, never a frame', () => {
    const html = sanitizeToHtml('<iframe src="https://www.bilibili.com/" width="1300" height="700" frameborder="0" scrolling="yes"></iframe>');
    expect(html).not.toContain('<iframe');
    expect(html).toContain('class="noto-embed"');
    expect(html).toContain('data-embed-src="https://www.bilibili.com/"');
    expect(html).toContain('width: 1300px');
    expect(html).toContain('height: 700px');
    // Held to the column, since it is not placed absolutely.
    expect(html).toContain('data-embed-fit="true"');
  });

  it('takes only an https page, and nothing that would run or reach the app', () => {
    for (const src of ['http://example.com/', 'javascript:alert(1)', 'noto://app/index.html', 'file:///etc/passwd', 'https://user:secret@example.com/', '/relative', '']) {
      expect(sanitizeToHtml(`<iframe src="${src}"></iframe>`), src).toBe('');
    }
  });

  it('takes no page on this machine or the local network, however the address is spelled', () => {
    for (const src of [
      'https://localhost:8443/', 'https://app.localhost/', 'https://127.0.0.1/', 'https://0x7f.1/', 'https://2130706433/',
      'https://192.168.1.1/admin', 'https://8.8.8.8/', 'https://[::1]/', 'https://printer.local/', 'https://nas.lan/',
      'https://router/', 'https://wiki.internal/', 'https://box.home.arpa/',
    ]) {
      expect(sanitizeToHtml(`<iframe src="${src}"></iframe>`), src).toBe('');
    }
    expect(sanitizeToHtml('<iframe src="https://www.bilibili.com/"></iframe>')).toContain('noto-embed');
  });

  it('keeps the box and the scaling of the author\u2019s CSDN trick', () => {
    const html = sanitizeToHtml([
      '<div style="position: relative; overflow: hidden; width: 600px; height: 420px; margin: 0 auto;border: 1px solid black;">',
      '<iframe width="260%" height="250%" scrolling="yes" src="https://www.csdn.net/" frameborder="0"',
      ' style="position: absolute; transform: scale(0.4); left: -480px; top: -310px;"></iframe></div>',
    ].join(''));
    expect(html).toContain('position: relative');
    expect(html).toContain('overflow: hidden');
    expect(html).toContain('width: 260%');
    expect(html).toContain('transform: scale(0.4)');
    expect(html).toContain('left: -480px');
    // Placed absolutely, so it keeps its size rather than being held to the column.
    expect(html).not.toContain('data-embed-fit');
  });

  it('reads an address that leaves out its scheme, as embed codes often do, as https', () => {
    const html = sanitizeToHtml("<iframe height='265' src='//codepen.io/a/embed/OxVywj/?height=265' allowfullscreen='true' style='width: 100%;'></iframe>");
    expect(html).toContain('data-embed-src="https://codepen.io/a/embed/OxVywj/?height=265"');
    // A note does not grant the page anything, full screen included.
    expect(html).not.toContain('fullscreen');
    expect(html).toContain('height: 265px');
  });

  it('counts a block that holds only an embed as worth drawing', () => {
    expect(worthDrawing('<iframe src="https://www.baidu.com/"></iframe>')).toBe(true);
    expect(worthDrawing('<iframe src="javascript:alert(1)"></iframe>')).toBe(false);
  });
});


describe('an embedded page in a block being edited', () => {
  const TYPE = { name: 'html_block' };
  const block = (text: string) => ({ type: TYPE, textContent: text }) as unknown as ProseNode;
  const editing = [Decoration.node(0, 1, { class: 'noto-html-editing' }, { htmlEditing: true })];
  const frames = (view: HtmlBlockView) => [...view.dom.querySelectorAll('iframe')];

  function mount(text: string) {
    return new HtmlBlockView(block(text), {} as EditorView, () => 0, () => ({ documentDir: '/vault', remote: true, embeds: true }), new Set<Refreshable>());
  }

  it('loads nothing while its address is typed, and the finished one once the caret leaves', () => {
    const view = mount('<iframe src="https://example.com/"></iframe>');
    expect(frames(view).map((frame) => frame.getAttribute('src'))).toEqual(['https://example.com/']);
    for (const typed of ['<iframe src="https://e', '<iframe src="https://ex', '<iframe src="https://example.org/"></iframe>']) {
      view.update(block(typed), editing);
      expect(frames(view), typed).toHaveLength(0);
    }
    view.update(block('<iframe src="https://example.org/"></iframe>'), []);
    expect(frames(view).map((frame) => frame.getAttribute('src'))).toEqual(['https://example.org/']);
    expect(frames(view)[0]?.name).toBe('noto-embed');
    expect(frames(view)[0]?.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms');
  });

  it('keeps a loaded page loaded when the caret only passes through', () => {
    const view = mount('<iframe src="https://example.com/"></iframe>');
    const loaded = frames(view)[0];
    view.update(block('<iframe src="https://example.com/"></iframe>'), editing);
    view.update(block('<iframe src="https://example.com/"></iframe>'), []);
    expect(frames(view)[0]).toBe(loaded);
  });
});

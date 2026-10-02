/**
 * @vitest-environment happy-dom
 *
 * Fence tools (language + copy) mount on demand; the shared datalist binds
 * only when the language field is focused. Remount must not pay that cost.
 */
import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { docFromSpans } from '../../src/shared/markdown/v3/pm/from-mdast';
import { splitBlocks } from '../../src/shared/markdown/v3/blocks';
import { FenceView } from '../../src/renderer/editor/noto/fence-view';

function fenceDoc(markdown: string) {
  return docFromSpans(splitBlocks(markdown).spans);
}

function mountFence(markdown = '```ts\nconst x = 1;\n```\n'): {
  view: EditorView;
  fence: FenceView;
  node: ReturnType<typeof fenceDoc> extends infer D ? D extends { child: (i: number) => infer N } ? N : never : never;
} {
  const doc = fenceDoc(markdown);
  let fenceNode = doc.child(0);
  for (let index = 0; index < doc.childCount; index += 1) {
    if (doc.child(index).type.name === 'code_block') {
      fenceNode = doc.child(index);
      break;
    }
  }
  const mountPoint = document.createElement('div');
  document.body.append(mountPoint);
  const state = EditorState.create({ doc });
  const view = new EditorView(mountPoint, { state });
  const fence = new FenceView(fenceNode, view, () => 0);
  view.dom.append(fence.dom);
  return { view, fence, node: fenceNode as never };
}

describe('FenceView chrome', () => {
  it('mounts without tools or a datalist binding', () => {
    const { view, fence } = mountFence();
    expect(fence.dom.querySelector('.noto-fence-tools')).toBeNull();
    expect(fence.dom.querySelector('.noto-fence-lang')).toBeNull();
    expect(fence.dom.querySelector('.noto-fence-copy')).toBeNull();
    expect(fence.dom.querySelector('.noto-fence-gutter')?.textContent).toBe('1');
    expect(document.getElementById('noto-fence-languages')).toBeNull();
    fence.destroy();
    view.destroy();
  });

  it('builds tools on pointerenter and binds the datalist only on language focus', () => {
    const { view, fence } = mountFence();
    fence.dom.dispatchEvent(new Event('pointerenter'));
    const tools = fence.dom.querySelector('.noto-fence-tools');
    const language = fence.dom.querySelector('.noto-fence-lang') as HTMLInputElement | null;
    const copy = fence.dom.querySelector('.noto-fence-copy');
    expect(tools).not.toBeNull();
    expect(language).not.toBeNull();
    expect(copy).not.toBeNull();
    expect(language!.value).toBe('ts');
    expect(language!.getAttribute('list')).toBeNull();
    expect(document.getElementById('noto-fence-languages')).toBeNull();

    language!.dispatchEvent(new Event('focus'));
    expect(language!.getAttribute('list')).toBe('noto-fence-languages');
    expect(document.getElementById('noto-fence-languages')).toBeInstanceOf(HTMLDataListElement);

    // Second enter is a no-op; tools stay the same node.
    fence.dom.dispatchEvent(new Event('pointerenter'));
    expect(fence.dom.querySelector('.noto-fence-tools')).toBe(tools);

    fence.destroy();
    view.destroy();
  });

  it('builds tools on focusin so the caret path can reach them', () => {
    const { view, fence } = mountFence('```\nplain\n```\n');
    expect(fence.dom.querySelector('.noto-fence-tools')).toBeNull();
    fence.dom.dispatchEvent(new Event('focusin'));
    expect(fence.dom.querySelector('.noto-fence-lang')).not.toBeNull();
    fence.destroy();
    view.destroy();
  });
});

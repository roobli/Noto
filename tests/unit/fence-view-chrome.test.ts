/**
 * @vitest-environment happy-dom
 *
 * Fence tools (the language label and copy) mount on demand, so remount
 * does not pay for them.
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
  it('mounts without tools', () => {
    const { view, fence } = mountFence();
    expect(fence.dom.querySelector('.noto-fence-tools')).toBeNull();
    expect(fence.dom.querySelector('.noto-fence-lang')).toBeNull();
    expect(fence.dom.querySelector('.noto-fence-copy')).toBeNull();
    expect(fence.dom.querySelector('.noto-fence-gutter')?.textContent).toBe('1');
    fence.destroy();
    view.destroy();
  });

  it('builds tools on pointerenter, with the language by its name', () => {
    const { view, fence } = mountFence();
    fence.dom.dispatchEvent(new Event('pointerenter'));
    const tools = fence.dom.querySelector('.noto-fence-tools');
    const language = fence.dom.querySelector<HTMLButtonElement>('.noto-fence-lang');
    expect(tools).not.toBeNull();
    expect(fence.dom.querySelector('.noto-fence-copy')).not.toBeNull();
    expect(language?.textContent).toBe('TypeScript');
    expect(language?.dataset.state).toBe('set');

    // Second enter is a no-op; tools stay the same node.
    fence.dom.dispatchEvent(new Event('pointerenter'));
    expect(fence.dom.querySelector('.noto-fence-tools')).toBe(tools);

    fence.destroy();
    view.destroy();
  });

  it('names what the code reads as when the fence names nothing, marked as a guess', () => {
    const { view, fence } = mountFence('```\nkubectl get pods -A\n```\n');
    fence.dom.dispatchEvent(new Event('pointerenter'));
    const language = fence.dom.querySelector<HTMLButtonElement>('.noto-fence-lang');
    expect(language?.dataset.state).toBe('guess');
    expect(language?.querySelector('.noto-fence-lang-name')?.textContent).toBe('Shell');
    expect(language?.querySelector('.noto-fence-lang-auto')?.textContent).toBe('auto');
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

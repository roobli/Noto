/**
 * @vitest-environment happy-dom
 *
 * The rail's tree is mounted before a folder is open and stays mounted when one
 * opens. Its hooks must not depend on whether there is a folder, or React
 * throws on the render that brings the folder in and the whole window goes
 * blank.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FileTree, type FileTreeProps } from '../../src/renderer/FileTree';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const props = (root: string | null): FileTreeProps => ({
  root,
  rootName: root === null ? null : 'vault',
  activePath: null,
  list: async () => [],
  onOpenFile: () => undefined,
  onRowMenu: () => undefined,
  onChooseFolder: () => undefined,
  onMoveEntry: () => undefined,
});

describe('the file tree across a folder opening', () => {
  let mounted: Root | null = null;
  let host: HTMLElement | null = null;

  afterEach(() => {
    act(() => mounted?.unmount());
    host?.remove();
    mounted = null;
    host = null;
  });

  it('goes from no folder to a folder without changing its hooks', async () => {
    host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    mounted = root;
    act(() => root.render(createElement(FileTree, props(null))));
    expect(host.querySelector('[data-testid="choose-folder"]')).not.toBeNull();

    await act(async () => root.render(createElement(FileTree, props('/vault'))));
    expect(host.querySelector('[data-testid="choose-folder"]')).toBeNull();
    expect(host.querySelector('[data-testid="file-tree"]')).not.toBeNull();
  });
});

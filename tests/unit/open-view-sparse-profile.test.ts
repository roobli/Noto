/**
 * @vitest-environment happy-dom
 *
 * Sparse docView open profile. Run with:
 *   PROFILE_SPARSE_DOC=1 pnpm vitest run tests/unit/open-view-sparse-profile.test.ts
 */
import { it } from 'vitest';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { splitBlocks } from '../../src/shared/markdown/v3/blocks';
import { docFromSpans } from '../../src/shared/markdown/v3/pm/from-mdast';
import { fenceNodeViews } from '../../src/renderer/editor/noto/fence-view';
import { mathNodeViews } from '../../src/renderer/editor/noto/math-view';
import { tableNodeViews } from '../../src/renderer/editor/noto/table-view';
import {
  countRealIndices,
  mergeStubAwareNodeViews,
  stubbingEnabled,
  viewportStubKey,
  viewportStubPlugin,
} from '../../src/renderer/editor/noto/viewport-stub';
import {
  countSparseDomChildren,
  isRangeSpacer,
} from '../../src/renderer/editor/noto/sparse-doc-view';

const enabled = process.env.PROFILE_SPARSE_DOC === '1';
const corpus = path.resolve(__dirname, '../../out/bench/corpus');
const outDir = path.resolve(__dirname, '../../out/bench');

function specialised() {
  return {
    ...mathNodeViews(),
    ...fenceNodeViews(),
    ...tableNodeViews(),
  };
}

function mount(doc: ReturnType<typeof docFromSpans>): EditorView {
  const scroller = document.createElement('div');
  scroller.style.overflowY = 'auto';
  scroller.style.height = '600px';
  const host = document.createElement('div');
  host.className = 'noto-editor-host';
  host.style.fontSize = '16px';
  const mountPoint = document.createElement('div');
  host.append(mountPoint);
  scroller.append(host);
  document.body.append(scroller);
  const state = EditorState.create({ doc, plugins: [viewportStubPlugin()] });
  return new EditorView(mountPoint, {
    state,
    nodeViews: mergeStubAwareNodeViews(specialised()),
  });
}

it.skipIf(!enabled)('profiles sparse EditorView open', { timeout: 600_000 }, async () => {
  const lines: string[] = [];
  await mkdir(outDir, { recursive: true });

  for (const name of ['large', 'huge'] as const) {
    const bytes = await readFile(path.join(corpus, `${name}.md`));
    const text = bytes.toString('utf8');
    lines.push(`\n${name} (${bytes.length.toLocaleString()} bytes)`);

    const beganParse = performance.now();
    const doc = docFromSpans(splitBlocks(text).spans);
    lines.push(`  docFromSpans ${(performance.now() - beganParse).toFixed(0).padStart(6)} ms  blocks=${doc.childCount} stubbing=${stubbingEnabled(doc.childCount)}`);

    document.body.replaceChildren();
    // Quiet open
    const began = performance.now();
    const view = mount(doc);
    const openMs = performance.now() - began;
    const stub = viewportStubKey.getState(view.state)!;
    const docView = (view as unknown as { docView: { children: unknown[] } }).docView;
    const spacerCount = docView.children.filter((c) => isRangeSpacer(c)).length;
    const realDescCount = docView.children.length - spacerCount;
    lines.push(`  view open (sparse)     ${openMs.toFixed(0).padStart(6)} ms`);
    lines.push(`  domChildren=${countSparseDomChildren(view)}  descChildren=${docView.children.length}  spacers=${spacerCount}  realDescs=${realDescCount}  pluginReal=${countRealIndices(stub, doc.childCount)}`);
    lines.push(`  scrollHeight≈${(view.dom as HTMLElement).scrollHeight}  heightSum≈${Array.from(stub.heights).reduce((a, b) => a + b, 0).toFixed(0)}`);

    // Second open (warm / quiet)
    view.destroy();
    document.body.replaceChildren();
    const began2 = performance.now();
    const view2 = mount(doc);
    const open2 = performance.now() - began2;
    lines.push(`  view open (2nd)        ${open2.toFixed(0).padStart(6)} ms`);
    view2.destroy();
  }

  const report = lines.join('\n') + '\n';
  await writeFile(path.join(outDir, 'open-view-sparse.txt'), report, 'utf8');
  // eslint-disable-next-line no-console
  console.log(report);
});

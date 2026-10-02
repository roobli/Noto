/**
 * @vitest-environment happy-dom
 *
 * Residual view-open / remount probes after specialised stubbing and surgical
 * membership remount. Skipped by default. Run:
 *
 *   PROFILE_RESIDUAL=1 pnpm vitest run tests/unit/open-view-residual-profile.test.ts
 *
 * Writes `out/bench/open-view-residual.txt`. Linux agent numbers only.
 */
import { it } from 'vitest';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
import { splitBlocks } from '../../src/shared/markdown/v3/blocks';
import { docFromSpans } from '../../src/shared/markdown/v3/pm/from-mdast';
import { fenceNodeViews } from '../../src/renderer/editor/noto/fence-view';
import { mathNodeViews } from '../../src/renderer/editor/noto/math-view';
import { tableNodeViews } from '../../src/renderer/editor/noto/table-view';
import {
  countRealIndices,
  mergeStubAwareNodeViews,
  viewportStubKey,
  viewportStubPlugin,
} from '../../src/renderer/editor/noto/viewport-stub';

const enabled = process.env.PROFILE_RESIDUAL === '1';
const corpus = path.resolve(__dirname, '../../out/bench/corpus');
const outDir = path.resolve(__dirname, '../../out/bench');

function specialised() {
  return { ...mathNodeViews(), ...fenceNodeViews(), ...tableNodeViews() };
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

function setViewport(view: EditorView, from: number, to: number): void {
  view.dispatch(view.state.tr.setMeta(viewportStubKey, { viewport: { from, to } }));
}

it.skipIf(!enabled)('profiles residual open floor and remount', { timeout: 900_000 }, async () => {
  const lines: string[] = [];
  await mkdir(outDir, { recursive: true });

  for (const name of ['large', 'huge'] as const) {
    const bytes = await readFile(path.join(corpus, `${name}.md`));
    const doc = docFromSpans(splitBlocks(bytes.toString('utf8')).spans);
    lines.push(`\n=== ${name} blocks=${doc.childCount} ===`);

    const mid = Math.floor(doc.childCount / 2);
    const from = mid - 30;
    const to = mid + 30;
    let position = 0;
    for (let index = 0; index < from; index += 1) position += doc.child(index).nodeSize;
    const decos: Decoration[] = [];
    let pos = position;
    for (let index = from; index <= to; index += 1) {
      const child = doc.child(index);
      const end = pos + child.nodeSize;
      decos.push(Decoration.node(pos, end, { class: 'noto-stub-real' }));
      pos = end;
    }
    let began = performance.now();
    for (let run = 0; run < 20; run += 1) DecorationSet.create(doc, decos);
    lines.push(`DecorationsSet.create 61-deco ×20 ${(performance.now() - began).toFixed(1)} ms`);

    document.body.replaceChildren();
    began = performance.now();
    const view = mount(doc);
    lines.push(`open ${(performance.now() - began).toFixed(0)} ms  real=${countRealIndices(viewportStubKey.getState(view.state)!, doc.childCount)}`);

    setViewport(view, 0, 5);
    began = performance.now();
    setViewport(view, from, to);
    lines.push(`remount mid ${(performance.now() - began).toFixed(1)} ms`);

    began = performance.now();
    setViewport(view, from, to);
    lines.push(`remount mid again (same) ${(performance.now() - began).toFixed(1)} ms`);

    began = performance.now();
    setViewport(view, from + 1, to + 1);
    lines.push(`remount slide +1 ${(performance.now() - began).toFixed(1)} ms`);

    view.destroy();
    document.body.replaceChildren();
  }

  const report = `${lines.join('\n')}\n`;
  await writeFile(path.join(outDir, 'open-view-residual.txt'), report, 'utf8');
  // eslint-disable-next-line no-console
  console.log(report);
});

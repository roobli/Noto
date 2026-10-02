/**
 * @vitest-environment happy-dom
 *
 * Before/after microbench for specialised viewport stubbing on corpus open.
 *
 * Skipped by default. Run with:
 *
 *   PROFILE_SPECIALISED_STUB=1 pnpm vitest run tests/unit/open-view-specialised-profile.test.ts
 *
 * Writes `out/bench/open-view-specialised.txt`. Linux agent numbers, not the
 * macOS packaged baseline — compare before/after on one machine only.
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
  STUBBABLE_TYPES,
  countRealIndices,
  isIndexStubbed,
  mergeStubAwareNodeViews,
  stubbableNodeViews,
  stubbingEnabled,
  viewportStubKey,
  viewportStubPlugin,
} from '../../src/renderer/editor/noto/viewport-stub';

const enabled = process.env.PROFILE_SPECIALISED_STUB === '1';
const corpus = path.resolve(__dirname, '../../out/bench/corpus');
const outDir = path.resolve(__dirname, '../../out/bench');

function specialised() {
  return {
    ...mathNodeViews(),
    ...fenceNodeViews(),
    ...tableNodeViews(),
  };
}

/** Legacy merge: specialised overrides stubbable → fences/tables/math always real. */
function legacyNodeViews() {
  return {
    ...stubbableNodeViews(),
    ...specialised(),
  };
}

function countAlwaysReal(doc: ReturnType<typeof docFromSpans>, stub: NonNullable<ReturnType<typeof viewportStubKey.getState>>) {
  let alwaysReal = 0;
  let stubbable = 0;
  const byType: Record<string, number> = {};
  for (let index = 0; index < doc.childCount; index += 1) {
    const name = doc.child(index).type.name;
    byType[name] = (byType[name] ?? 0) + 1;
    if (STUBBABLE_TYPES.includes(name as never)) stubbable += 1;
    else alwaysReal += 1;
  }
  // Off-viewport specialised stubs under the wrapped merge.
  let specialisedStubbed = 0;
  for (let index = 0; index < doc.childCount; index += 1) {
    const name = doc.child(index).type.name;
    if (name === 'code_block' || name === 'table' || name === 'math_block') {
      if (isIndexStubbed(stub, index, name)) specialisedStubbed += 1;
    }
  }
  return { alwaysReal, stubbable, byType, specialisedStubbed, real: countRealIndices(stub, doc.childCount) };
}

function mount(doc: ReturnType<typeof docFromSpans>, nodeViews: Record<string, unknown>): EditorView {
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
  return new EditorView(mountPoint, { state, nodeViews: nodeViews as never });
}

it.skipIf(!enabled)('profiles EditorView open with specialised stubbing', { timeout: 600_000 }, async () => {
  const lines: string[] = [];
  await mkdir(outDir, { recursive: true });

  for (const name of ['large', 'huge'] as const) {
    const bytes = await readFile(path.join(corpus, `${name}.md`));
    const text = bytes.toString('utf8');
    lines.push(`\n${name} (${bytes.length.toLocaleString()} bytes)`);

    const beganParse = performance.now();
    const doc = docFromSpans(splitBlocks(text).spans);
    lines.push(`  docFromSpans ${(performance.now() - beganParse).toFixed(0).padStart(6)} ms  blocks=${doc.childCount} stubbing=${stubbingEnabled(doc.childCount)}`);

    // Legacy: specialised always-real (pre-change merge order).
    document.body.replaceChildren();
    const beganLegacy = performance.now();
    const legacyView = mount(doc, legacyNodeViews());
    const legacyMs = performance.now() - beganLegacy;
    const legacyStub = viewportStubKey.getState(legacyView.state)!;
    const legacyCounts = countAlwaysReal(doc, legacyStub);
    lines.push(`  view: legacy specialised-always-real ${legacyMs.toFixed(0).padStart(6)} ms  real=${legacyCounts.real} specialisedStubbed=${legacyCounts.specialisedStubbed}`);
    legacyView.destroy();

    // New: wrapped specialised stubbing.
    document.body.replaceChildren();
    const beganWrapped = performance.now();
    const wrappedView = mount(doc, mergeStubAwareNodeViews(specialised()));
    const wrappedMs = performance.now() - beganWrapped;
    const wrappedStub = viewportStubKey.getState(wrappedView.state)!;
    const wrappedCounts = countAlwaysReal(doc, wrappedStub);
    lines.push(`  view: wrapped specialised-stubbing  ${wrappedMs.toFixed(0).padStart(6)} ms  real=${wrappedCounts.real} specialisedStubbed=${wrappedCounts.specialisedStubbed}`);
    lines.push(`  byType=${JSON.stringify(wrappedCounts.byType)}`);
    lines.push(`  ratio legacy/wrapped ${(legacyMs / wrappedMs).toFixed(2)}x`);
    wrappedView.destroy();
  }

  const report = lines.join('\n') + '\n';
  await writeFile(path.join(outDir, 'open-view-specialised.txt'), report, 'utf8');
  // eslint-disable-next-line no-console
  console.log(report);
});

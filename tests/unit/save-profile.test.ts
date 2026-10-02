import { it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { EditorState, TextSelection } from 'prosemirror-state';
import { splitBlocks } from '../../src/shared/markdown/v3/blocks';
import { docFromSpans } from '../../src/shared/markdown/v3/pm/from-mdast';
import { parseDocument, toWire } from '../../src/shared/markdown/v3/document';
import { toLf } from '../../src/shared/markdown/v3/line-endings';
import { serializeDocument } from '../../src/shared/markdown/v3/serialize';
import { captureTransaction, type PristineBlock } from '../../src/renderer/editor/noto/capture';
import { createOriginPlugin, getBlockOrigins } from '../../src/renderer/editor/noto/origin-plugin';
import { useSha256 } from '../../src/shared/sha256';
import { compactTransaction } from '../../src/shared/markdown/v3/revision-patch';

// Match desktop main so serialize timings reflect the native hash path.
useSha256((value) => createHash('sha256').update(value).digest('hex'));

/**
 * Splits the save path into the remaining proportional candidates from
 * docs/performance/measurements.md: the renderer capture walk, structured
 * clone of the expanded units vs the compact wire form (`compactTransaction`),
 * and serializeDocument (identity and one-block edit).
 *
 * Skipped by default. Run with:
 *
 *     PROFILE_SAVE=1 pnpm vitest run tests/unit/save-profile.test.ts
 */
const corpus = path.resolve(__dirname, '../../out/bench/corpus');
const enabled = process.env.PROFILE_SAVE === '1';

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function timeMs(run: () => void, runs = 3): number {
  const samples: number[] = [];
  // Warm once so first-run JIT noise does not dominate medians.
  run();
  for (let i = 0; i < runs; i += 1) {
    const began = performance.now();
    run();
    samples.push(performance.now() - began);
  }
  return median(samples);
}

it.skipIf(!enabled)('profiles the phases of saving a document', { timeout: 600_000 }, async () => {
  const lines: string[] = [];
  const names = process.env.PROFILE_SAVE_DOCS?.split(',') ?? ['small', 'medium', 'large', 'huge'];

  for (const name of names) {
    const file = path.join(corpus, `${name}.md`);
    const bytes = await readFile(file);
    const parsed = parseDocument(bytes);
    if (parsed.status !== 'parsed') throw new Error(`${name}: parse failed`);
    const document = parsed.document;
    const wire = toWire(document);
    const spans = splitBlocks(wire.text).spans;
    const doc = docFromSpans(spans);
    const pristine = new Map<string, PristineBlock>();
    doc.forEach((node, _offset, index) => {
      const origin = wire.origins[index];
      const span = spans[index];
      if (origin && span) pristine.set(origin.blockId, { node, markdown: toLf(span.markdown) });
    });
    const state = EditorState.create({ doc, plugins: [createOriginPlugin(wire.origins)] });

    // One-character edit in the middle so capture still walks every block but
    // only serializes one — the common "touch then save" case the doc names.
    let position = 0;
    const mid = Math.floor(doc.childCount / 2);
    for (let i = 0; i < mid; i += 1) position += doc.child(i).nodeSize;
    const edited = state.apply(state.tr.insertText('X', position + 1));

    const captureInput = {
      doc: edited.doc,
      origins: getBlockOrigins(edited),
      document: wire,
      pristine,
    };

    lines.push(`\n${name} (${bytes.length.toLocaleString()} bytes, ${doc.childCount.toLocaleString()} blocks)`);

    const captureMs = timeMs(() => {
      captureTransaction(captureInput);
    });
    lines.push(`  capture walk (1 edit)       ${captureMs.toFixed(0).padStart(6)} ms`);

    const { transaction } = captureTransaction(captureInput);
    if (transaction.mode !== 'blocks') throw new Error('expected blocks');

    const cloneMs = timeMs(() => {
      structuredClone(transaction);
    });
    const compact = compactTransaction(transaction, wire);
    const compactCloneMs = timeMs(() => {
      structuredClone(compact);
    });
    lines.push(`  structuredClone(full units) ${cloneMs.toFixed(0).padStart(6)} ms`);
    lines.push(`  structuredClone(compact)    ${compactCloneMs.toFixed(0).padStart(6)} ms`);
    lines.push(`    units=${transaction.units.length.toLocaleString()}  compactEntries=${compact.mode === 'blocks' ? compact.units.length : '?'}  markdown≠null=${transaction.units.filter((u) => u.markdown !== null).length}`);

    // Unchanged identity save: every unit pristine. This is the autosave /
    // undo-back-to-clean path that still rebuilds the whole output string today.
    const identity = captureTransaction({
      doc: state.doc,
      origins: getBlockOrigins(state),
      document: wire,
      pristine,
    });
    const identitySerializeMs = timeMs(() => {
      const result = serializeDocument(document, identity.transaction);
      if (result.status !== 'serialized') throw new Error(result.message);
    });
    lines.push(`  serialize identity save     ${identitySerializeMs.toFixed(0).padStart(6)} ms`);

    const editSerializeMs = timeMs(() => {
      const result = serializeDocument(document, transaction);
      if (result.status !== 'serialized') throw new Error(result.message);
    });
    lines.push(`  serialize 1-block edit      ${editSerializeMs.toFixed(0).padStart(6)} ms`);

    // Approximate the string-build half of identity serialize by replaying the
    // same slice+join pattern serializeBlocks uses for pristine units.
    const stringBuildMs = timeMs(() => {
      const parts: string[] = [];
      if (document.leading) parts.push(document.leading);
      for (let index = 0; index < document.blocks.length; index += 1) {
        if (index > 0) {
          const prev = document.blocks[index - 1];
          const cur = document.blocks[index];
          parts.push(document.text.slice(prev.end, cur.start));
        }
        const block = document.blocks[index];
        parts.push(document.text.slice(block.start, block.end));
      }
      if (document.trailing) parts.push(document.trailing);
      const outputText = parts.join('');
      void (outputText === document.text);
    });
    lines.push(`  string build + compare       ${stringBuildMs.toFixed(0).padStart(6)} ms`);

    // Capture walk with zero edits (every node.eq hits).
    const pristineCaptureMs = timeMs(() => {
      captureTransaction({
        doc: state.doc,
        origins: getBlockOrigins(state),
        document: wire,
        pristine,
      });
    });
    lines.push(`  capture walk (0 edits)      ${pristineCaptureMs.toFixed(0).padStart(6)} ms`);
  }

  const out = path.resolve(__dirname, '../../out/bench/save-profile.txt');
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${lines.join('\n')}\n`, 'utf8');
  console.log(lines.join('\n'));
});

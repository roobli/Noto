import { it } from 'vitest';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { blockSpansFromWire, splitBlocks, splitBlocksMicromark } from '../../src/shared/markdown/v3/blocks';
import { docFromSpans } from '../../src/shared/markdown/v3/pm/from-mdast';
import { parseDocument, toWire } from '../../src/shared/markdown/v3/document';
import { outlineFromDocument, outlineOf } from '../../src/renderer/outline';
import { setMarkdownEngineForTests } from '../../src/shared/markdown/v3/engine-flag';
import {
  parseBlocksStructural,
  splitBlocksViaRoobli,
  enrichSpansInRange,
  resolveDeferredOpenSpans,
  createEnrichFlags,
  enrichNextDeferredInRange,
  enrichRangeFromVisibleInclusive,
  OPEN_VIEWPORT_ENRICH_BUDGET,
} from '../../src/shared/markdown/v3/roobli-md-adapter';

/**
 * Splits the open path into its phases, on demand.
 *
 * Noto loses to Typora at half a megabyte, and "the double parse" was the
 * suspected cause, but that phrase covers three different jobs: scanning text
 * into block spans, producing mdast, and building ProseMirror nodes. Optimising
 * the wrong one is the usual way this goes wrong, so this measures them apart.
 *
 * In the app the renderer `splitBlocks` phase now runs inside a module Worker
 * so it no longer freezes the UI thread; this profile still times the same
 * work on the test thread, because the cost of the parse itself is what we
 * need when comparing sizes, not which thread paid it.
 *
 * The outline used to pay for another full `splitBlocks` on the UI thread at
 * open. `outlineFromDocument` reuses main's kinds and offsets instead; both
 * paths are timed here so the win stays visible.
 *
 * Open now also ships mdast `nodes` on the wire. `blockSpansFromWire` rebuilds
 * spans without a second micromark pass; that path is timed against the old
 * renderer `splitBlocks` so the dual-parse removal stays measurable on Linux.
 *
 * Flagged `@roobli/md` open: native structural split is cheap; bulk enrich
 * removed the N× penalty. Lazy open ships `enrich: 'none'` on main then
 * `enrichSpansInRange` for a first-paint window (critical path). Remainder
 * is viewport / idle chunked (`enrichNextDeferredInRange`) — timed here
 * against a full remainder pass and bulk. See
 * docs/performance/open-path-first-cut.md.
 *
 * Skipped by default because it is a measurement, not an assertion, and it
 * needs the generated corpus. Run it with:
 *
 *     PROFILE_OPEN=1 pnpm vitest run tests/unit/open-profile.test.ts
 */
const corpus = path.resolve(__dirname, '../../out/bench/corpus');
const enabled = process.env.PROFILE_OPEN === '1';

it.skipIf(!enabled)('profiles the phases of opening a document', { timeout: 300_000 }, async () => {
  const lines: string[] = [];
  const time = <T>(label: string, run: () => T): T => {
    const began = performance.now();
    const value = run();
    lines.push(`  ${label.padEnd(36)} ${(performance.now() - began).toFixed(0).padStart(6)} ms`);
    return value;
  };

  for (const name of ['small', 'medium', 'large']) {
    const file = path.join(corpus, `${name}.md`);
    const bytes = await readFile(file);
    const text = bytes.toString('utf8');
    lines.push(`\n${name} (${bytes.length.toLocaleString()} bytes)`);

    setMarkdownEngineForTests('micromark');
    // What the main process does, which is already finished by the time the
    // renderer starts its own copy of the same work.
    const parsed = time('main: parseDocument', () => parseDocument(bytes));
    if (parsed.status !== 'parsed') throw new Error(parsed.message);
    const wire = toWire(parsed.document);

    // Same work the open-path Worker used to run on every open; still timed so
    // the dual-parse cost stays visible next to the wire-nodes path.
    const spans = time('renderer: splitBlocks (old)', () => splitBlocks(bytes.toString('utf8')).spans);
    time('renderer: docFromSpans', () => docFromSpans(spans));

    // New path: rebuild spans from nodes main already shipped (plus IPC clone).
    time('ipc: clone wire+nodes', () => { structuredClone(wire); });
    const fromWire = time('renderer: fromWire nodes', () => blockSpansFromWire(wire));
    if (!fromWire) throw new Error('expected nodes on open wire');
    time('renderer: docFromWire', () => docFromSpans(fromWire));

    // Outline on open: the old path reparsed; the new path reuses the wire.
    time('outline: outlineOf (old)', () => outlineOf(wire.text));
    time('outline: fromDocument', () => outlineFromDocument(wire));

    // Flagged engine open phases (bulk cut + lazy first-paint window).
    setMarkdownEngineForTests('roobli-md');
    time('roobli: structural', () => { parseBlocksStructural(text); });
    time('roobli: enrich none', () => { splitBlocksViaRoobli(text, { enrich: 'none' }); });
    time('roobli: enrich per-span', () => { splitBlocksViaRoobli(text, { enrich: 'per-span' }); });
    time('roobli: enrich bulk', () => { splitBlocksViaRoobli(text, { enrich: 'bulk' }); });
    time('roobli: lazy critical', () => {
      const none = splitBlocksViaRoobli(text, { enrich: 'none' });
      resolveDeferredOpenSpans(none.spans, text, { deferred: true });
    });
    time('roobli: lazy remainder (full)', () => {
      const none = splitBlocksViaRoobli(text, { enrich: 'none' });
      const prepared = resolveDeferredOpenSpans(none.spans, text, { deferred: true });
      if (prepared.remainderFrom !== null) {
        enrichSpansInRange(prepared.spans, text, {
          from: prepared.remainderFrom,
          to: prepared.spans.length,
        });
      }
    });
    time('roobli: viewport enrich tick', () => {
      const none = splitBlocksViaRoobli(text, { enrich: 'none' });
      const prepared = resolveDeferredOpenSpans(none.spans, text, { deferred: true });
      if (prepared.remainderFrom === null) return;
      const flags = createEnrichFlags(prepared.spans.length, prepared.remainderFrom, prepared.spans);
      // Mid-document scroll into stand-ins (typical after open at top).
      const mid = Math.min(
        prepared.spans.length - 1,
        Math.max(prepared.remainderFrom, Math.floor(prepared.spans.length * 0.4)),
      );
      const visible = enrichRangeFromVisibleInclusive(mid, mid + 40, prepared.spans.length);
      enrichNextDeferredInRange(prepared.spans, text, flags, visible, {
        budget: OPEN_VIEWPORT_ENRICH_BUDGET,
      });
    });
    time('roobli: idle enrich tick', () => {
      const none = splitBlocksViaRoobli(text, { enrich: 'none' });
      const prepared = resolveDeferredOpenSpans(none.spans, text, { deferred: true });
      if (prepared.remainderFrom === null) return;
      const flags = createEnrichFlags(prepared.spans.length, prepared.remainderFrom, prepared.spans);
      enrichNextDeferredInRange(
        prepared.spans,
        text,
        flags,
        { from: prepared.remainderFrom, to: prepared.spans.length },
        { budget: OPEN_VIEWPORT_ENRICH_BUDGET },
      );
    });
    time('roobli: parseDocument (deferred)', () => {
      const result = parseDocument(bytes);
      if (result.status !== 'parsed') throw new Error(result.message);
      if (result.document.nodesEnrichment !== 'deferred') {
        throw new Error('expected deferred nodesEnrichment');
      }
    });
    time('micromark: splitBlocksMicromark', () => { splitBlocksMicromark(text); });
  }

  setMarkdownEngineForTests(null);

  const out = path.resolve(__dirname, '../../out/bench/open-profile.txt');
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${lines.join('\n')}\n`, 'utf8');
  console.log(lines.join('\n'));
});

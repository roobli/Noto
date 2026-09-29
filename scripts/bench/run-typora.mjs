/**
 * Measures Typora opening the same corpus Noto is measured against.
 *
 * The product claim is comparative, so it needs Typora's numbers on identical
 * files rather than an assertion. Three earlier attempts to time Typora from
 * outside the process all failed: sampling the process tree misses the work
 * done in prewarmed helpers, screen capture needs a recording permission that
 * is not available here, and a system wide CPU delta is swamped by everything
 * else on the machine.
 *
 * This takes a different route. Typora is running the typora-plugin-lite
 * remote control plugin, which answers JSON-RPC from its renderer. That gives a
 * clock inside the process being measured.
 *
 * What is timed, precisely: from issuing the open request to the renderer being
 * free again. The second half matters and is the reason this is not simply a
 * load timer. While Typora is parsing and laying out a large document its
 * renderer thread is busy, so it cannot answer RPC; the calls block. The moment
 * round trips return to their idle latency, the thread that would service a
 * keystroke is available again.
 *
 * That is deliberately the closest available analogue to what run-noto.mjs
 * measures, which is the request to open until the editor is on screen holding
 * the document. Neither number is a paint timestamp. Both are "the app has done
 * the work and is ready for you again".
 *
 * The remaining asymmetry is stated rather than hidden: Noto's figure requires
 * content to be in the DOM, while Typora's requires only that its renderer has
 * gone idle. If anything that favours Typora, so a Noto win here is a real one
 * and a Noto loss is genuine.
 */
import path from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The Typora remote-control client is not part of this repository. Point
// TYPORA_REMOTE_CLIENT at a local copy of `typora-remote-client.mjs`.
const clientPath = process.env.TYPORA_REMOTE_CLIENT;
if (!clientPath) {
  console.error('Set TYPORA_REMOTE_CLIENT to the path of typora-remote-client.mjs.');
  process.exit(2);
}
const { TyporaRemoteControlClient } = await import(pathToFileURL(path.resolve(clientPath)).href);

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusRoot = path.resolve(here, '../../out/bench/corpus');

/** Anything longer than this and the answer is "too slow to sit through". */
const OPEN_TIMEOUT_MS = 180_000;

/**
 * The plugin wraps whatever it returns in document markers, so a loaded
 * document reports its own byte count plus this. Measured, not guessed: a
 * 66,061 byte file comes back as 66,153 characters.
 */
const WRAPPER_CHARS = 92;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Round trip time of the cheapest call that has to reach the renderer. */
async function probe(client) {
  const began = Date.now();
  await client.getContext();
  return Date.now() - began;
}

/**
 * Idle latency of this machine and this Typora, measured rather than assumed,
 * because the threshold for "busy" has to be relative to it.
 */
async function baseline(client) {
  const samples = [];
  for (let i = 0; i < 12; i += 1) samples.push(await probe(client));
  return Math.max(median(samples), 2);
}

/**
 * Opens a file and waits until Typora is actually holding it.
 *
 * The completion test is that the document Typora reports back is as long as
 * the file on disk. That is worth spelling out, because the obvious signal is
 * wrong: `filePath` flips to the new document almost immediately, well before
 * any content exists behind it, so timing against the path would report an
 * 8 MB file opening in half a second. It does not. Requiring the bytes to be
 * there is what makes this measure loading rather than intent.
 */
async function openAndWait(client, target, bytes) {
  const expected = bytes + WRAPPER_CHARS;
  const startedAt = Date.now();
  // Not awaited, because on a large document the reply is not the event of
  // interest and can land long before the content does.
  const request = client.openFile(target).catch(() => {});

  let arrived = false;
  while (Date.now() - startedAt < OPEN_TIMEOUT_MS) {
    try {
      if (!arrived) {
        // Cheap poll first. Asking for the document itself transfers the whole
        // file over the socket, so it is not something to do every 50 ms
        // against a multi-megabyte document.
        const context = await client.getContext();
        arrived = context?.filePath === target;
        if (!arrived) continue;
      }

      const document = await client.getDocument();
      const length = document?.markdown?.length ?? 0;
      // Line endings can differ by a byte per line between disk and the
      // renderer, so this asks for substantially all of it rather than an
      // exact match.
      if (length >= expected * 0.98) {
        await request;
        return { ms: Date.now() - startedAt, timedOut: false, length };
      }
    } catch {
      // A renderer inside a long synchronous parse drops the session. That is
      // evidence of work in progress, so it is not a failure; keep waiting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await request;
  return { ms: Date.now() - startedAt, timedOut: true, length: 0 };
}

async function main() {
  const corpus = JSON.parse(await readFile(path.join(corpusRoot, 'manifest.json'), 'utf8'));
  const runs = Number(process.env.BENCH_RUNS ?? 2);
  const only = process.env.BENCH_ONLY?.split(',');

  const client = await TyporaRemoteControlClient.connectFromLocalSettings();
  const results = [];
  try {
    console.log(`idle round trip ${await baseline(client)} ms\n`);

    // Every measured open starts from this, never from another corpus file.
    // Resetting to the smallest corpus document instead looks reasonable and
    // quietly ruins the smallest document's own result: the reset opens the
    // very file about to be measured, so the measurement finds it already
    // loaded and reports single digit milliseconds.
    const scratch = path.resolve(here, '../../out/bench/scratch-reset.md');
    await writeFile(scratch, '# reset\n\nOpened between measurements.\n', 'utf8');
    const scratchBytes = 38;

    for (const entry of corpus) {
      if (only && !only.includes(entry.name)) continue;
      const samples = [];
      let timedOut = false;
      for (let run = 0; run < runs; run += 1) {
        await openAndWait(client, scratch, scratchBytes);
        const outcome = await openAndWait(client, entry.file, entry.bytes);
        samples.push(outcome.ms);
        timedOut = timedOut || outcome.timedOut;
      }
      const openMs = Math.round(median(samples));
      results.push({ name: entry.name, bytes: entry.bytes, openMs, timedOut, runs, samples });
      console.log(
        `${entry.name.padEnd(7)} open ${String(openMs).padStart(7)} ms`
          + (timedOut ? '  (never finished loading)' : ''),
      );
    }
  } finally {
    client.close();
  }

  // Merged rather than overwritten, so the slow documents can be measured in a
  // separate pass from the fast ones without discarding either.
  const out = path.resolve(here, '../../out/bench/typora.json');
  let merged = [];
  try {
    merged = JSON.parse(await readFile(out, 'utf8')).results ?? [];
  } catch {
    // First run.
  }
  for (const result of results) {
    const existing = merged.findIndex((entry) => entry.name === result.name);
    if (existing >= 0) merged[existing] = result;
    else merged.push(result);
  }
  await writeFile(out, `${JSON.stringify({ measuredAt: new Date().toISOString(), results: merged }, null, 2)}\n`, 'utf8');
  console.log(`\nwrote ${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

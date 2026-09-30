/**
 * Measures Noto on the benchmark corpus.
 *
 * Four numbers per document, chosen because they are what a writer actually
 * waits on:
 *
 *   open       launching with the file until the document is on screen and usable
 *   type       a keystroke in the middle of the document until the glyph paints
 *   idle-lag   longest main-thread stall after typing stops, until idle settles
 *   save       an edit to one block until the bytes are on disk
 *
 * The interesting one used to be save. Noto reuses the original bytes of every
 * block the caret never entered, so save should stay flat as the document grows
 * rather than scaling with it. A benchmark that only measured open would miss
 * that entirely, and open is the number least under our control since it is
 * dominated by first paint.
 *
 * Idle-lag exists because of a different failure mode. When typing pauses,
 * Chromium and our own deferred work (spell check, word count) schedule tasks
 * from idle callbacks. Those can freeze the window for tens of seconds on a
 * large note without any keystroke itself being slow — the ColdModeSpellCheck
 * freeze on the 8 MB document was 37 seconds twice, and the packaged benchmark
 * failed because the Save click never landed. Keystroke time alone cannot catch
 * that; this number can.
 */

import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { e2eExecutable, e2eLaunchArgs } from './e2e-executable.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CORPUS = path.join(ROOT, 'out/bench/corpus');
const WORKSPACE = path.join(ROOT, 'out/bench/workspace');

/**
 * Skip idle-lag with BENCH_IDLE_LAG=0. Default on: the settle wait is about a
 * second when healthy, and the metric is cheap relative to open on large/huge.
 */
const MEASURE_IDLE_LAG = process.env.BENCH_IDLE_LAG !== '0';

function executable() {
  return e2eExecutable(ROOT);
}

/** Median is reported rather than mean, so one scheduling hiccup cannot skew it. */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * After the last keystroke, find the longest main-thread stall until the
 * renderer goes quiet.
 *
 * Polls with setTimeout(0): each gap between consecutive timer firings is a
 * stall the user would feel. Deferred work (spell check idle, word count after
 * COUNT_DELAY_MS) starts a few hundred milliseconds after typing stops, so the
 * probe waits at least MIN_OBSERVE_MS before it is allowed to declare quiet.
 * It stops once a QUIET_MS stretch has had no stall above STALL_MS, or when
 * MAX_OBSERVE_MS elapses — long enough to report a freeze like the 37 s
 * ColdModeSpellCheck case without hanging the harness forever.
 *
 * Long Tasks API entries, when the runtime exposes them, are folded in so a
 * single long task that lands between two polls cannot hide.
 */
async function measureIdleLagMs(page) {
  return page.evaluate(async () => {
    const MIN_OBSERVE_MS = 900;
    const QUIET_MS = 500;
    const STALL_MS = 50;
    const MAX_OBSERVE_MS = 60_000;

    const longTasks = [];
    let observer = null;
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTasks.push(entry.duration);
        }
      });
      observer.observe({ type: 'longtask', buffered: true });
    } catch {
      // Long Tasks API is best-effort; the setTimeout probe is the contract.
    }

    // One short burst so deferred "typing stopped" work is definitely armed,
    // even if the outer keystroke loop already typed. Cheap on a healthy build.
    const pm = document.querySelector('.ProseMirror');
    if (pm instanceof HTMLElement) pm.focus();
    for (let stroke = 0; stroke < 4; stroke += 1) {
      document.execCommand('insertText', false, 'y');
    }

    const started = performance.now();
    let last = started;
    let maxGap = 0;
    let quietSince = started;

    while (performance.now() - started < MAX_OBSERVE_MS) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const now = performance.now();
      const gap = now - last;
      last = now;
      if (gap > maxGap) maxGap = gap;
      if (gap >= STALL_MS) quietSince = now;
      else if (
        now - started >= MIN_OBSERVE_MS
        && now - quietSince >= QUIET_MS
      ) {
        break;
      }
    }

    if (observer) observer.disconnect();
    const maxLongTask = longTasks.length ? Math.max(...longTasks) : 0;
    return Math.max(maxGap, maxLongTask);
  });
}

async function measure(entry, repetitions) {
  const opens = [];
  const types = [];
  const idleLags = [];
  const saves = [];

  for (let run = 0; run < repetitions; run += 1) {
    const workspace = path.join(WORKSPACE, `${entry.name}-${run}`);
    await mkdir(path.join(workspace, 'user-data'), { recursive: true });
    const file = path.join(workspace, `${entry.name}.md`);
    await copyFile(entry.file, file);

    // Launch empty, then open through the workspace, which is how a document
    // is actually opened: from the menu, the file tree or a recent entry. The
    // command line flag is a test convenience and takes a different path
    // through startup, so timing it would measure something users never do.
    const app = await electron.launch({
      executablePath: executable(),
      args: e2eLaunchArgs(path.join(workspace, 'user-data')),
    });
    const page = await app.firstWindow();
    try {
      await page.waitForSelector('[data-testid="empty-state"]', { state: 'visible', timeout: 60_000 });

      const startedAt = Date.now();
      await page.evaluate(async (target) => {
        await window.notoWorkspace.openPath({
          version: 1,
          requestId: `bench-${Date.now()}`,
          path: target,
        });
      }, file);

      // Open is complete when the editor is on screen with the document in it,
      // not merely when the window exists.
      await page.waitForSelector('.ProseMirror', { state: 'visible', timeout: 120_000 });
      await page.waitForFunction(
        () => (document.querySelector('.ProseMirror')?.childElementCount ?? 0) > 1,
        undefined,
        { timeout: 120_000 },
      );
      opens.push(Date.now() - startedAt);

      // Typing: click into a paragraph halfway down and time a keystroke to paint.
      const paragraphs = page.locator('.ProseMirror > p');
      const count = await paragraphs.count();
      if (count > 2) {
        const target = paragraphs.nth(Math.floor(count / 2));
        await target.click();
        const samples = [];
        for (let stroke = 0; stroke < 12; stroke += 1) {
          samples.push(await page.evaluate(async () => {
            const begin = performance.now();
            document.execCommand('insertText', false, 'x');
            await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
            return performance.now() - begin;
          }));
        }
        // The first stroke carries one-off costs, so it is dropped.
        types.push(median(samples.slice(1)));
      }

      // Idle lag: longest main-thread block after typing stops. Measured before
      // Save so a freeze cannot be mistaken for a slow write.
      if (MEASURE_IDLE_LAG) {
        idleLags.push(await measureIdleLagMs(page));
      }

      // Save: one block is dirty, the rest are pristine.
      const saveStartedAt = Date.now();
      await page.getByTestId('save-button').click();
      await page.waitForFunction(
        () => document.querySelector('[data-testid="file-state"]')?.textContent === 'Saved',
        undefined,
        { timeout: 120_000 },
      );
      saves.push(Date.now() - saveStartedAt);
    } finally {
      await app.close();
    }
  }

  const result = {
    name: entry.name,
    bytes: entry.bytes,
    blocks: entry.blocks,
    openMs: Math.round(median(opens)),
    typeMs: Number(median(types).toFixed(2)),
    saveMs: Math.round(median(saves)),
    runs: repetitions,
  };
  if (MEASURE_IDLE_LAG && idleLags.length > 0) {
    result.idleLagMs = Math.round(median(idleLags));
  }
  return result;
}

async function main() {
  const repetitions = Number(process.env.BENCH_RUNS ?? 3);
  const only = process.env.BENCH_ONLY?.split(',').filter(Boolean);
  const manifest = JSON.parse(await readFile(path.join(CORPUS, 'manifest.json'), 'utf8'));
  const results = [];
  for (const entry of manifest) {
    if (only && !only.includes(entry.name)) continue;
    const result = await measure(entry, repetitions);
    results.push(result);
    const idle = result.idleLagMs != null
      ? `  idle-lag ${String(result.idleLagMs).padStart(6)} ms`
      : '';
    process.stdout.write(
      `${result.name.padEnd(7)} ${String(Math.round(result.bytes / 1024)).padStart(5)} KiB  `
      + `${String(result.blocks).padStart(6)} blocks  `
      + `open ${String(result.openMs).padStart(6)} ms  `
      + `type ${String(result.typeMs).padStart(7)} ms`
      + `${idle}  `
      + `save ${String(result.saveMs).padStart(5)} ms\n`,
    );
  }
  const report = path.join(ROOT, 'out/bench/noto.json');
  await writeFile(report, `${JSON.stringify({ measuredAt: new Date().toISOString(), results }, null, 2)}\n`);
  process.stdout.write(`\nwrote ${report}\n`);
}

await main();

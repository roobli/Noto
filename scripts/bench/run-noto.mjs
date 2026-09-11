/**
 * Measures Noto on the benchmark corpus.
 *
 * Three numbers per document, chosen because they are what a writer actually
 * waits on:
 *
 *   open    launching with the file until the document is on screen and usable
 *   type    a keystroke in the middle of the document until the glyph paints
 *   save    an edit to one block until the bytes are on disk
 *
 * The interesting one is save. Noto reuses the original bytes of every block
 * the caret never entered, so save should stay flat as the document grows
 * rather than scaling with it. A benchmark that only measured open would miss
 * that entirely, and open is the number least under our control since it is
 * dominated by first paint.
 */

import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { e2eExecutable, e2eLaunchArgs } from './e2e-executable.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CORPUS = path.join(ROOT, 'out/bench/corpus');
const WORKSPACE = path.join(ROOT, 'out/bench/workspace');

function executable() {
  return e2eExecutable(ROOT);
}

/** Median is reported rather than mean, so one scheduling hiccup cannot skew it. */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function measure(entry, repetitions) {
  const opens = [];
  const types = [];
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

  return {
    name: entry.name,
    bytes: entry.bytes,
    blocks: entry.blocks,
    openMs: Math.round(median(opens)),
    typeMs: Number(median(types).toFixed(2)),
    saveMs: Math.round(median(saves)),
    runs: repetitions,
  };
}

async function main() {
  const repetitions = Number(process.env.BENCH_RUNS ?? 3);
  const manifest = JSON.parse(await readFile(path.join(CORPUS, 'manifest.json'), 'utf8'));
  const results = [];
  for (const entry of manifest) {
    const result = await measure(entry, repetitions);
    results.push(result);
    process.stdout.write(
      `${result.name.padEnd(7)} ${String(Math.round(result.bytes / 1024)).padStart(5)} KiB  `
      + `${String(result.blocks).padStart(6)} blocks  `
      + `open ${String(result.openMs).padStart(6)} ms  `
      + `type ${String(result.typeMs).padStart(7)} ms  `
      + `save ${String(result.saveMs).padStart(5)} ms\n`,
    );
  }
  const report = path.join(ROOT, 'out/bench/noto.json');
  await writeFile(report, `${JSON.stringify({ measuredAt: new Date().toISOString(), results }, null, 2)}\n`);
  process.stdout.write(`\nwrote ${report}\n`);
}

await main();

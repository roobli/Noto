/**
 * Splits the cost of a keystroke into the part we control and the part we do
 * not.
 *
 * A keypress does two things: ProseMirror applies a transaction and updates the
 * DOM, which is our JavaScript, and then the engine lays the page out and
 * paints it, which is not. Knowing which of the two dominates decides where to
 * look, and guessing has already cost one wrong fix.
 *
 * For large documents the stubbing scroller only keeps a window of real blocks
 * in the DOM. Measuring "the middle" means scrolling `.canvas-scroll` until the
 * stub viewport covers mid-document, then typing into a real block there —
 * not clicking the middle of the few real `<p>` nodes still mounted at the top.
 *
 * Also reports stub host dataset and a short scroll-frame probe.
 */

import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { e2eExecutable, e2eLaunchArgs } from './e2e-executable.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const workspace = path.join(ROOT, 'out/bench/typing-probe');

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const executable = e2eExecutable(ROOT);
process.stdout.write(`e2e binary: ${executable}\n`);

for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ['medium', 'large']) {
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const file = path.join(workspace, `${name}.md`);
  await copyFile(path.join(ROOT, 'out/bench/corpus', `${name}.md`), file);

  const app = await electron.launch({
    executablePath: executable,
    args: e2eLaunchArgs(path.join(workspace, 'user-data')),
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="empty-state"]', { state: 'visible', timeout: 60_000 });
  await page.evaluate((target) => window.notoWorkspace.openPath({
    version: 1, requestId: 'typing-probe', path: target,
  }), file);
  await page.waitForSelector('.ProseMirror', { state: 'visible', timeout: 180_000 });
  await page.waitForTimeout(1000);

  // Scroll mid, settle until a non-stub block is on screen, place caret there
  // with a real mouse click (DOM click alone leaves selection at the top).
  const scrolled = await page.evaluate(async () => {
    const scroll = document.querySelector('.canvas-scroll');
    if (!(scroll instanceof HTMLElement)) return { ok: false, reason: 'no-canvas-scroll' };
    let visible = null;
    let click = null;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const mid = Math.floor((scroll.scrollHeight - scroll.clientHeight) * 0.5);
      scroll.scrollTop = mid;
      for (let i = 0; i < 8; i += 1) await new Promise((r) => requestAnimationFrame(r));
      await new Promise((r) => setTimeout(r, 16));
      const sc = scroll.getBoundingClientRect();
      const pm = document.querySelector('.ProseMirror');
      if (!(pm instanceof HTMLElement)) break;
      for (const child of pm.children) {
        if (!(child instanceof HTMLElement)) continue;
        if (child.classList.contains('noto-block-stub')) continue;
        const box = child.getBoundingClientRect();
        if (box.height <= 0) continue;
        if (box.bottom > sc.top + 4 && box.top < sc.bottom - 4) {
          visible = {
            tag: child.tagName,
            className: child.className,
            text: (child.textContent || '').slice(0, 40),
          };
          click = {
            x: box.left + Math.min(24, Math.max(4, box.width / 2)),
            y: (box.top + box.bottom) / 2,
          };
          break;
        }
      }
      if (visible) break;
    }
    const host = document.querySelector('.noto-editor-host');
    return {
      ok: true,
      scrollTop: scroll.scrollTop,
      visible,
      click,
      stub: host instanceof HTMLElement ? {
        enabled: host.dataset.stubEnabled ?? null,
        real: host.dataset.stubReal ?? null,
        selection: host.dataset.stubSelection ?? null,
        count: host.dataset.stubCount ?? null,
      } : null,
      realParagraphs: document.querySelectorAll('.ProseMirror > p').length,
      stubs: document.querySelectorAll('.noto-block-stub').length,
    };
  });
  process.stdout.write(`         scrolled: ${JSON.stringify({ ...scrolled, click: scrolled.click ? 'yes' : null })}\n`);

  if (scrolled.click) {
    await page.mouse.click(scrolled.click.x, scrolled.click.y);
    await page.waitForTimeout(120);
  }

  const samples = await page.evaluate(async () => {
    const script = [];
    const paint = [];
    const pm = document.querySelector('.ProseMirror');
    if (pm instanceof HTMLElement) pm.focus();
    for (let stroke = 0; stroke < 14; stroke += 1) {
      const begin = performance.now();
      document.execCommand('insertText', false, 'x');
      const afterScript = performance.now();
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      const afterFrame = performance.now();
      script.push(afterScript - begin);
      paint.push(afterFrame - afterScript);
    }
    return { script, paint };
  });

  const scrollSamples = await page.evaluate(async () => {
    const element = document.querySelector('.canvas-scroll');
    if (!(element instanceof HTMLElement)) return { large: [], small: [] };
    const run = async (fraction) => {
      const times = [];
      const step = Math.max(20, Math.floor(element.clientHeight * fraction));
      for (let i = 0; i < 12; i += 1) {
        const begin = performance.now();
        element.scrollTop = Math.min(
          element.scrollHeight - element.clientHeight,
          element.scrollTop + step,
        );
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
        times.push(performance.now() - begin);
      }
      return times;
    };
    const small = await run(0.25);
    const large = await run(0.75);
    return { small, large };
  });

  const stubAfter = await page.evaluate(() => {
    const host = document.querySelector('.noto-editor-host');
    if (!(host instanceof HTMLElement)) return null;
    return {
      enabled: host.dataset.stubEnabled ?? null,
      real: host.dataset.stubReal ?? null,
      selection: host.dataset.stubSelection ?? null,
      count: host.dataset.stubCount ?? null,
      realParagraphs: document.querySelectorAll('.ProseMirror > p').length,
      stubs: document.querySelectorAll('.noto-block-stub').length,
    };
  });

  const script = median(samples.script.slice(3));
  const paint = median(samples.paint.slice(3));
  const scrollSmall = scrollSamples.small.length ? median(scrollSamples.small.slice(2)) : null;
  const scrollLarge = scrollSamples.large.length ? median(scrollSamples.large.slice(2)) : null;
  process.stdout.write(
    `${name.padEnd(7)} script ${script.toFixed(1).padStart(7)} ms   `
    + `layout and paint ${paint.toFixed(1).padStart(7)} ms   `
    + `total ${(script + paint).toFixed(1).padStart(7)} ms`,
  );
  if (scrollSmall != null) process.stdout.write(`   scroll-frame(0.25) ${scrollSmall.toFixed(1).padStart(7)} ms`);
  if (scrollLarge != null) process.stdout.write(`   scroll-frame(0.75) ${scrollLarge.toFixed(1).padStart(7)} ms`);
  process.stdout.write('\n');
  if (stubAfter) {
    process.stdout.write(
      `         stub enabled=${stubAfter.enabled ?? 'off'} viewport=${stubAfter.real ?? '-'} `
      + `selection=${stubAfter.selection ?? '-'} stubbed=${stubAfter.count ?? '0'} `
      + `domP=${stubAfter.realParagraphs} domStub=${stubAfter.stubs}\n`,
    );
  }

  await app.close();
}

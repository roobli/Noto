/**
 * Where the packaged app is, on whichever platform the tests are running.
 *
 * Every spec used to spell out `Noto-darwin-arm64/Noto.app/Contents/MacOS/Noto`
 * itself. That works on one developer's machine and fails everywhere else, so
 * the Windows and Linux legs of the CI matrix could only ever have failed: they
 * would look for a macOS bundle that the run had not produced.
 *
 * Forge names the output directory after the platform and architecture it built
 * for, and puts the executable in a different place on each. Both facts live
 * here so a spec never has to know either.
 */

import path from 'node:path';
import type { Locator, Page } from '@playwright/test';

export type PackageVariant = 'e2e' | 'release';

/** The executable inside a package directory, which differs per platform. */
export function executableRelativePath(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return path.join('Noto.app', 'Contents', 'MacOS', 'Noto');
  if (platform === 'win32') return 'Noto.exe';
  // Lower case on Linux, matching `executableName` in the Forge config.
  return 'noto';
}

/** The directory Forge writes a package to, for example `Noto-linux-x64`. */
export function packageDirectory(
  variant: PackageVariant = 'e2e',
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return path.join(process.cwd(), 'out', variant, `Noto-${platform}-${arch}`);
}

/** Full path to the packaged executable the tests should launch. */
export function packagedExecutable(
  variant: PackageVariant = 'e2e',
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return path.join(packageDirectory(variant, platform, arch), executableRelativePath(platform));
}

/** The asar the packaged app loads, used by the release surface checks. */
export function packagedAsar(
  variant: PackageVariant = 'e2e',
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const root = packageDirectory(variant, platform, arch);
  return platform === 'darwin'
    ? path.join(root, 'Noto.app', 'Contents', 'Resources', 'app.asar')
    : path.join(root, 'resources', 'app.asar');
}

/**
 * The modifier key for the platform.
 *
 * Command on macOS, Control elsewhere, which is the same distinction the
 * application menu makes with `CmdOrCtrl`.
 */
export const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/**
 * Moving the caret to the start of the line.
 *
 * macOS uses Command with an arrow where other platforms use Home, so a test
 * that types at a known position has to ask for the right one.
 */
export const LINE_START = process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home';

/**
 * Click to place the caret, and wait until the editor knows where it is.
 *
 * A click lets the browser put the caret where it landed, and ProseMirror
 * learns of the new position a moment later. A test can press a key inside
 * that moment; a person cannot. Keys pressed in it are handled against the
 * selection the editor still holds from before the click, usually at the top
 * of the document, and the test fails for a reason that has nothing to do
 * with what it is testing.
 *
 * The wait used to be for the browser's own `selectionchange`, which is the
 * wrong signal: it fires when the browser moves the caret, not when the
 * editor has taken it, and on a slower machine the gap between those two is
 * wide enough to lose a keystroke in. Twenty-five tests failed that way on
 * the Linux runner while passing on the machine they were written on.
 *
 * The editor says where it thinks the caret is, on its host, and marks the
 * block holding it. This waits for the block that was clicked to be that
 * block, which is true whether or not the position changed, and gives up
 * after a moment rather than failing here: a test that then fails should say
 * what it was actually asserting.
 */
export async function placeCaret(page: Page, target: Locator): Promise<void> {
  await target.click();
  try {
    await target.evaluate((node) => new Promise<void>((resolve, reject) => {
      const block = node.closest('.ProseMirror > *') ?? node;
      const settled = () => block.classList.contains('noto-active-block')
        || block.querySelector('.noto-active-block') !== null
        || node.closest('.noto-active-block') !== null;
      if (settled()) { resolve(); return; }
      const observer = new MutationObserver(() => { if (settled()) { observer.disconnect(); resolve(); } });
      observer.observe(node.ownerDocument.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
      setTimeout(() => { observer.disconnect(); reject(new Error('caret did not settle')); }, 2000);
    }));
  } catch {
    // The editor never marked it. The assertions that follow are what say so.
  }
}

/**
 * Put the caret at the start of `target` via the Selection API, after focusing
 * the editor.
 *
 * Home / Meta+ArrowLeft does not always reach a packaged macOS window (it can
 * scroll or race after click). A bare Range without focusing ProseMirror is
 * also ignored: the view only reads DOM selection when it has focus
 * (`hasFocusAndSelection`), which left packaged macOS CI stuck at the click
 * position (block-edges: expected data-caret "1", got "5").
 */
export async function placeCaretAtStart(page: Page, target: Locator): Promise<void> {
  await placeCaret(page, target);
  await target.evaluate((node) => {
    const root = node.closest('.ProseMirror');
    if (!(root instanceof HTMLElement)) throw new Error('no ProseMirror root');
    // Focus before and after the Range so PM's hasFocusAndSelection sees it
    // (packaged macOS sometimes drops the first focus around click settle).
    root.focus();
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const text = walker.nextNode();
    if (!text) throw new Error('no text to put the caret in');
    const range = document.createRange();
    range.setStart(text, 0);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    root.focus();
    // Nudge ProseMirror to re-read the DOM selection on flaky runners.
    document.dispatchEvent(new Event('selectionchange'));
  });
}

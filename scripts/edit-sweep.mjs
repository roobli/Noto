/**
 * The product's core promise, checked against a folder of real notes: edit one
 * block of a note and every other block comes back byte identical.
 *
 * Written because the unit tests could not have found what this found. They
 * run the parser and the serializer against markdown somebody wrote for a
 * test; this runs the packaged application against notes somebody wrote for
 * themselves, types one letter into a block, saves, and reads the file back.
 * That is how the paragraph-flattening fault turned up, which had been joining
 * every line of a hand-wrapped paragraph on the first keystroke.
 *
 * Usage:
 *   node scripts/edit-sweep.mjs [count] [kind] <folder>
 *   kind is one of p, h, li, td, code, quote; the default is p.
 *   folder is required and must hold Markdown.
 *
 * The folder is never touched. Each note is copied to a scratch directory
 * first and the copy is what gets edited.
 *
 * What it reports:
 *   NOEDIT   the letter never landed, so the note proved nothing
 *   REWROTE  the file is not the original with one letter in it, and by how
 *            many lines, counted as a multiset so that a blank line inserted
 *            beside the edit does not report every line after it as changed
 *
 * Some REWROTE lines are expected. A table, a list and a quote are each one
 * block, so editing any part of one re-serializes all of it, and the gap
 * beside an edited block is made canonical on purpose. Read the count: one or
 * two lines is the separator, the size of the block is the block.
 */
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require_ = createRequire(path.join(process.cwd(), 'package.json'));
const { _electron: electron } = require_('@playwright/test');
const OUT = process.env.SWEEP_OUT ?? path.join(process.cwd(), 'test-results', 'edit-sweep');
mkdirSync(OUT, { recursive: true });
const ROOT = process.argv[4];
if (!ROOT) {
  console.error('Pass the folder to sweep as the fourth argument.');
  process.exit(2);
}
const LIMIT = Number(process.argv[2] ?? 40);
const WORK = path.join(OUT, 'edit-work');

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    let s; try { s = statSync(full); } catch { continue; }
    if (s.isDirectory()) yield* walk(full); else if (name.endsWith('.md')) yield full;
  }
}
const files = []; for (const f of walk(ROOT)) { files.push(f); if (files.length > 7000) break; }
const step = Math.max(1, Math.floor(files.length / LIMIT));
const sample = files.filter((_, i) => i % step === 0).slice(0, LIMIT);

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

/** Lines present in `a` that `b` no longer has, counting duplicates. */
function lost(a, b) {
  const have = new Map();
  for (const line of b.split('\n')) have.set(line, (have.get(line) ?? 0) + 1);
  const gone = [];
  for (const line of a.split('\n')) {
    const n = have.get(line) ?? 0;
    if (n === 0) gone.push(line);
    else have.set(line, n - 1);
  }
  return gone;
}

const KIND_LABEL = process.argv[3] ?? 'p';

const app = await electron.launch({
  executablePath: path.join(process.cwd(), 'out/e2e/Noto-darwin-arm64/Noto.app/Contents/MacOS/Noto'),
  args: [`--user-data-dir=${path.join(OUT, 'ud-edit')}`, WORK],
});
const page = await app.firstWindow();
await page.waitForSelector('[data-testid="noto-app"]', { state: 'visible', timeout: 30000 });
await page.setViewportSize({ width: 1200, height: 800 });

const problems = [];
let checked = 0;
for (const [index, source] of sample.entries()) {
  let original; try { original = readFileSync(source, 'utf8'); } catch { continue; }
  if (original.trim().length === 0) continue;
  const copy = path.join(WORK, `note-${index}.md`);
  writeFileSync(copy, original);

  const opened = await page.evaluate(async (p) => {
    try { await window.notoWorkspace.openPath({ version: 1, requestId: 'edit-' + Math.random(), path: p }); return null; }
    catch (e) { return String((e && (e.message || e.reason)) || e); }
  }, copy).catch((e) => String(e));
  if (opened) { problems.push(`OPENFAIL note-${index} ${opened.slice(0, 60)}`); continue; }
  await page.waitForTimeout(260);

  // A real click, the way a reader places the caret. Setting a DOM range by
  // hand makes the editor re-read the paragraph from the DOM, which is not
  // what typing does and reports differences the product does not have.
  // Which kind of block to type into, given on the command line: a paragraph,
  // a heading, a list item, a table cell or a line of code. Each is a
  // different path through the serializer.
  const KIND = process.argv[3] ?? 'p';
  const SELECTORS = {
    p: '.canvas-slot:not([hidden]) .ProseMirror > p',
    h: '.canvas-slot:not([hidden]) .ProseMirror :is(h1, h2, h3)',
    li: '.canvas-slot:not([hidden]) .ProseMirror li p',
    td: '.canvas-slot:not([hidden]) .ProseMirror td',
    code: '.canvas-slot:not([hidden]) .ProseMirror .noto-fence-code',
    quote: '.canvas-slot:not([hidden]) .ProseMirror blockquote p',
  };
  const target = page.locator(SELECTORS[KIND]).filter({ hasText: /\S/ }).first();
  const typed = await target.click({ timeout: 4000 }).then(() => true).catch(() => false);
  if (!typed) continue;
  await page.waitForTimeout(200);
  await page.keyboard.type('ZZQQ');
  await page.waitForTimeout(120);
  // Save is a menu accelerator, which only the menu item can fire.
  await app.evaluate(({ Menu }) => {
    const find = (items) => { for (const i of items) { if (i.id === 'save') return i; const n = i.submenu ? find(i.submenu.items) : null; if (n) return n; } return null; };
    find(Menu.getApplicationMenu().items)?.click();
  }).catch(() => {});
  await page.waitForTimeout(500);

  const saved = readFileSync(copy, 'utf8');
  checked += 1;
  if (!saved.includes('ZZQQ')) { problems.push(`NOEDIT note-${index} ${path.basename(source)}`); }
  else {
    // Exact: the file must be the original with one marker inserted. Anything
    // else is the serializer rewriting something, and the count of differing
    // lines says how much.
    const undone = saved.replace('ZZQQ', '');
    if (undone !== original) {
      // Counted as a multiset, so a blank line inserted beside the edit does
      // not report every line after it as changed. The separator between two
      // blocks is deliberately made canonical when one of them is edited, and
      // that is one line, not two hundred.
      const gone = lost(original, undone);
      const gained = lost(undone, original);
      if (gone.length > 0 || gained.length > 1) {
        problems.push(`REWROTE ${source.slice(ROOT.length + 1)} -${gone.length} +${gained.length} :: ${JSON.stringify(gone.slice(0, 1))}`);
      }
    }
  }
  await app.evaluate(({ Menu }) => {
    const find = (items) => { for (const i of items) { if (i.id === 'close-tab') return i; const n = i.submenu ? find(i.submenu.items) : null; if (n) return n; } return null; };
    find(Menu.getApplicationMenu().items)?.click();
  }).catch(() => {});
  await page.waitForTimeout(120);
}
// Notes without a block of the kind asked for are skipped silently, so the
// count of what was actually edited and the count of what was looked at are
// different numbers and saying only the first was misleading.
console.log(`EDITED ${checked} of ${sample.length} notes (the rest had no ${KIND_LABEL}), ${problems.length} problems`);
for (const p of problems.slice(0, 20)) console.log(p);
await app.close();

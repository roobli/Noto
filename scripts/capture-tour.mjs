/**
 * Capture the tour pictures the README and the documentation site show.
 *
 * The README's "Around the window" table and the site's "A closer look"
 * gallery are screenshots of the packaged app. They used to be taken by hand
 * with a throwaway script, so the first UI change after them made them stale
 * and nothing could take them again. This takes all of them from one fixed
 * vault (`tests/fixtures/tour-vault`) and one fixed set of preferences, so a
 * change to the window is followed by running this, not by remembering how
 * the last pictures were made.
 *
 * Run it against a fresh package; an old one shows an old window:
 *
 *   pnpm package:e2e
 *   node scripts/capture-tour.mjs                         # into test-results/tour
 *   node scripts/capture-tour.mjs --write                 # also into docs/images
 *   node scripts/capture-tour.mjs --write --docs=../Noto.docs
 *
 * Every picture is checked before it is written: 1280x800, no horizontal
 * overflow, and the README (and, with --docs, the site gallery) refers to it
 * with the alt text below. The alt text lives here once so the two places
 * that show a picture cannot describe it differently.
 *
 * Not part of the test suite. The pure checks are unit tested; the capture
 * itself needs a display and a package.
 */

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), '..');

export const SHOT_SIZE = Object.freeze({ width: 1280, height: 800 });

/**
 * One entry per picture, in the order the site gallery shows them.
 *
 * `site` is the file under Noto.docs `docs/public/images`, `readme` the file
 * under this repository's `docs/images` when the README shows it too.
 */
export const TOUR_SHOTS = Object.freeze([
  {
    name: 'quick-open',
    site: 'tour-quick-open.png',
    readme: 'noto-quick-open.png',
    alt: 'Quick open over the file rail with three cache notes in the results',
  },
  {
    name: 'command-palette',
    site: 'tour-command-palette.png',
    readme: 'noto-command-palette.png',
    alt: 'The command palette listing export formats over a cache sizing note',
  },
  {
    name: 'outline',
    site: 'tour-outline.png',
    readme: 'noto-outline.png',
    alt: 'The outline in the rail beside a cache sizing note',
  },
  {
    name: 'find',
    site: 'tour-find.png',
    alt: 'The find bar over a cache sizing note, with Cache highlighted and 1 of 5 matches',
  },
  {
    name: 'source',
    site: 'tour-source.png',
    readme: 'noto-source.png',
    alt: 'The cache sizing note shown as Markdown source beside the file rail',
  },
  {
    name: 'settings',
    site: 'tour-settings.png',
    alt: 'The Appearance settings panel with theme, text size, page width and custom stylesheet',
  },
].map((shot) => Object.freeze(shot)));

/** Light, rail open, focus mode off: focus mode persists and would hide the rail. */
const SETTINGS = Object.freeze({ theme: 'light', focusMode: false, sidebarOnLaunch: true });

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The width and height a PNG declares in its IHDR chunk. */
export function pngSize(buffer) {
  if (buffer.length < 24
    || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)
    || buffer.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('not a PNG');
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Every `![alt](src)` in a Markdown text, in order. Links are not images. */
export function imageReferences(markdown) {
  return [...markdown.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)]
    .map((match) => ({ alt: match[1], src: match[2] }));
}

async function sizeProblem(file, label) {
  let size;
  try {
    size = pngSize(await readFile(file));
  } catch (error) {
    return `${label} cannot be read as a PNG (${error.code ?? error.message})`;
  }
  return size.width === SHOT_SIZE.width && size.height === SHOT_SIZE.height
    ? null
    : `${label} is ${size.width}x${size.height}, expected ${SHOT_SIZE.width}x${SHOT_SIZE.height}`;
}

/** What is wrong between the README and the tour pictures it shows, if anything. */
export async function readmeProblems(readme, repositoryRoot) {
  const references = imageReferences(readme);
  const problems = [];
  for (const shot of TOUR_SHOTS) {
    if (!shot.readme) continue;
    const src = `docs/images/${shot.readme}`;
    const reference = references.find((candidate) => candidate.src === src);
    if (!reference) {
      problems.push(`README does not reference ${src}`);
      continue;
    }
    if (reference.alt !== shot.alt) {
      problems.push(`README alt for ${src} is "${reference.alt}", expected "${shot.alt}"`);
    }
    const problem = await sizeProblem(path.join(repositoryRoot, src), src);
    if (problem) problems.push(problem);
  }
  return problems;
}

/** The same check against the site gallery, which lists `file` and `alt` pairs. */
export async function galleryProblems(gallery, docsRoot) {
  const entries = [...gallery.matchAll(/file:\s*'([^']+)',\s*alt:\s*'([^']*)'/g)]
    .map((match) => ({ file: match[1], alt: match[2] }));
  const problems = [];
  for (const shot of TOUR_SHOTS) {
    const entry = entries.find((candidate) => candidate.file === shot.site);
    if (!entry) {
      problems.push(`gallery does not list ${shot.site}`);
      continue;
    }
    if (entry.alt !== shot.alt) problems.push(`gallery alt for ${shot.site} is "${entry.alt}", expected "${shot.alt}"`);
    const problem = await sizeProblem(path.join(docsRoot, 'docs/public/images', shot.site), shot.site);
    if (problem) problems.push(problem);
  }
  return problems;
}

function executable() {
  const directory = path.join(root, 'out', 'e2e', `Noto-${process.platform}-${process.arch}`);
  if (process.platform === 'darwin') return path.join(directory, 'Noto.app', 'Contents', 'MacOS', 'Noto');
  return path.join(directory, process.platform === 'win32' ? 'Noto.exe' : 'noto');
}

async function invokeMenu(app, id) {
  await app.evaluate(({ Menu }, itemId) => {
    const find = (items) => {
      for (const item of items) {
        if (item.id === itemId) return item;
        const nested = item.submenu ? find(item.submenu.items) : null;
        if (nested) return nested;
      }
      return null;
    };
    const menu = Menu.getApplicationMenu();
    const target = menu ? find(menu.items) : null;
    if (!target) throw new Error(`No menu item with id ${itemId}`);
    target.click();
  }, id);
}

/** What each picture shows, starting from the sizing note open with the rail on files. */
const STAGES = {
  async 'quick-open'(app, page) {
    await invokeMenu(app, 'quick-open');
    await page.getByTestId('quick-input').fill('cache');
    await page.getByTestId('quick-result').nth(2).waitFor();
  },
  async 'command-palette'(app, page) {
    await invokeMenu(app, 'command-palette');
    await page.getByTestId('palette-input').fill('export');
    await page.getByTestId('command-palette').getByText('Export PDF', { exact: false }).first().waitFor();
  },
  async outline(_app, page) {
    await page.getByTestId('outline-toggle').click();
    await page.getByTestId('outline-toggle').and(page.locator('[aria-selected="true"]')).waitFor();
  },
  async find(app, page) {
    await invokeMenu(app, 'find');
    await page.getByTestId('find-input').fill('cache');
    await page.getByTestId('find-status').filter({ hasText: '1 of 5' }).waitFor();
  },
  async source(app, page) {
    await invokeMenu(app, 'source-code-mode');
    await page.getByTestId('source-input').waitFor();
    // The caret would land in the picture; the source should read as a page.
    await page.getByTestId('source-input').evaluate((node) => node.blur());
  },
  async settings(app, page) {
    await invokeMenu(app, 'settings');
    await page.getByTestId('settings-panel').waitFor();
  },
};

/** Wait for every running transition and the fonts, so nothing is caught mid-move. */
async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function capture(shot, workspace, electron) {
  const vault = path.join(workspace, shot.name, 'vault');
  const userData = path.join(workspace, shot.name, 'user-data');
  await cp(path.join(root, 'tests/fixtures/tour-vault'), vault, { recursive: true });
  // Git does not keep an empty folder, and a vault has somewhere for pictures.
  await mkdir(path.join(vault, 'assets'), { recursive: true });
  await mkdir(userData, { recursive: true });
  await writeFile(path.join(userData, 'settings.json'), `${JSON.stringify(SETTINGS, null, 2)}\n`, 'utf8');

  const app = await electron.launch({
    executablePath: executable(),
    args: [`--user-data-dir=${userData}`, `--open=${path.join(vault, 'notes', 'cache-sizing.md')}`],
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
    await page.setViewportSize(SHOT_SIZE);
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, vault);
    await invokeMenu(app, 'open-folder');
    await page.getByTestId('file-tree').waitFor();
    await STAGES[shot.name](app, page);
    await settle(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 0) throw new Error(`${shot.name} overflows the window by ${overflow}px`);
    const picture = await page.screenshot({ animations: 'disabled', caret: 'hide' });
    const size = pngSize(picture);
    if (size.width !== SHOT_SIZE.width || size.height !== SHOT_SIZE.height) {
      throw new Error(`${shot.name} came out ${size.width}x${size.height}`);
    }
    return picture;
  } finally {
    await app.close();
  }
}

async function main(argv) {
  const write = argv.includes('--write');
  const docsFlag = argv.find((argument) => argument.startsWith('--docs='));
  const docsRoot = docsFlag ? path.resolve(docsFlag.slice('--docs='.length)) : null;
  if (docsRoot && !write) throw new Error('--docs only makes sense with --write');

  const { _electron: electron } = await import('@playwright/test');
  const outDir = path.join(root, 'test-results', 'tour');
  const workspace = path.join(outDir, 'workspace');
  await rm(outDir, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });

  for (const shot of TOUR_SHOTS) {
    const picture = await capture(shot, workspace, electron);
    await writeFile(path.join(outDir, shot.site), picture);
    if (write && shot.readme) await writeFile(path.join(root, 'docs/images', shot.readme), picture);
    if (docsRoot) await writeFile(path.join(docsRoot, 'docs/public/images', shot.site), picture);
    console.log(`captured ${shot.name}`);
  }

  const problems = [];
  if (write) problems.push(...await readmeProblems(await readFile(path.join(root, 'README.md'), 'utf8'), root));
  if (docsRoot) {
    const galleryPath = path.join(docsRoot, 'docs/.vitepress/theme/components/ShotGallery.vue');
    problems.push(...await galleryProblems(await readFile(galleryPath, 'utf8'), docsRoot));
  }
  if (problems.length > 0) throw new Error(`Tour pictures disagree with where they are shown:\n${problems.join('\n')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await main(process.argv.slice(2));
}

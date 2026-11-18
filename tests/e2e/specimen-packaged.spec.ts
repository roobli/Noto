import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';
import { packagedExecutable, placeCaret } from './packaged-app';

/*
 * The cases of the Markdown specimen note that Noto drew differently from
 * Typora: coloured words, comments, escaped spaces in a subscript, and the
 * formulas that need the rest of their note.
 */
const SOURCE = [
  '# Specimen',
  '',
  '<span style="color:red">red words</span>, <font color=yellow size=4>gold words</font>, <abbr title="HyperText Markup Language">HTML</abbr>, <q>quoted</q>.',
  '',
  'A sentence with a comment<!-- hidden note --> in it, and X~long\\ text~.',
  '',
  '<!-- a block comment -->',
  '',
  '$$',
  '\\newcommand{\\vect}[1]{\\boldsymbol{#1}}',
  'e^{i\\pi} + 1 = 0 \\label{euler}',
  '$$',
  '',
  'By $\\eqref{euler}$, $\\vect{v}$ and $\\ce{H2O}$; broken $\\frac{1$ here.',
  '',
  'End, then [the next part](#more).',
  '',
  '## More',
  '',
  'Last.',
  '',
].join('\n');

test('the specimen cases Typora draws, drawn the same', async () => {
  const workspace = path.join(process.cwd(), 'test-results', 'specimen');
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'user-data'), { recursive: true });
  const file = path.join(workspace, 'specimen.md');
  await writeFile(file, SOURCE, 'utf8');
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${path.join(workspace, 'user-data')}`, `--open=${file}`],
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('[data-testid="noto-editor"]', { state: 'visible', timeout: 30_000 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await placeCaret(page, page.locator('.ProseMirror p').last());
    const styled = page.locator('.ProseMirror p').nth(0);

    // H02: the words in the colour asked for, legible on this paper; the tags out of sight.
    await expect(styled).toHaveText('red words, gold words, HTML, quoted.', { useInnerText: true });
    // `<q>` draws its quotation marks, as generated text around the words.
    expect(await styled.locator('.noto-inline-quote-open').evaluate((tag) => getComputedStyle(tag, '::after').content)).toBe('open-quote');
    expect(await styled.locator('.noto-inline-quote-open').evaluate((tag) => tag.getBoundingClientRect().width)).toBeGreaterThan(2);
    const colours = await styled.locator('.noto-html-styled').evaluateAll((spans) => spans.map((span) => getComputedStyle(span).color));
    expect(colours[0]).toMatch(/oklch|rgb/);
    expect(colours[0]).not.toBe(colours[1]);
    await expect(styled.locator('.noto-html-abbr')).toHaveAttribute('title', 'HyperText Markup Language');

    // H09 and S05: the comment is not read, the escaped space is a space.
    await expect(page.locator('.ProseMirror p').nth(1)).toHaveText('A sentence with a comment in it, and Xlong text.', { useInnerText: true });
    const block = page.locator('.noto-html-block[data-comment="true"]');
    expect(await block.evaluate((element) => element.getBoundingClientRect().height)).toBe(0);

    // M05 to M08: labels, shared macros and chemistry typeset; a broken formula shows its source.
    const errors = page.locator('.noto-math-render[data-state="error"]');
    await expect(errors).toHaveCount(1);
    await expect(errors.locator('.noto-math-written')).toHaveText('\\frac{1');
    await expect(page.locator('.noto-math-block .katex-html .tag')).toHaveText('(1)');
    await expect(page.locator('.noto-math-inline').first()).toContainText('(1)');

    // L03: a link to a heading of this note takes the caret there.
    await page.locator('.ProseMirror a[href="#more"]').click({ modifiers: ['Meta'] });
    await expect.poll(() => page.evaluate(() => window.getSelection()?.anchorNode?.parentElement?.closest('h2')?.textContent ?? '')).toBe('More');

    // Drawing changed nothing in the file: an edit elsewhere saves every tag and comment as written.
    await placeCaret(page, page.locator('.ProseMirror p').last());
    await page.keyboard.press('End');
    await page.keyboard.type(' Ok.');
    await page.getByTestId('save-button').click();
    await expect(page.getByTestId('file-state')).toHaveText('Saved', { timeout: 15_000 });
    expect(await readFile(file, 'utf8')).toBe(SOURCE.replace('Last.\n', 'Last. Ok.\n'));
  } finally {
    await app.close();
  }
});

// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { DOMParser as PMDOMParser } from 'prosemirror-model';
import { notoSchema } from '../../src/shared/markdown/v3/pm/schema';
import { sliceToMarkdown } from '../../src/renderer/editor/noto/clipboard';
import { describeTidy, tidyIsWorthSaying, tidyPastedHtml } from '../../src/renderer/editor/noto/paste-clean';

/** What a paste of `html` would write into the note, as markdown, and what the tidy reported. */
function pasted(html: string) {
  const { html: tidied, tidy } = tidyPastedHtml(html);
  const holder = document.createElement('div');
  holder.innerHTML = tidied;
  const slice = PMDOMParser.fromSchema(notoSchema).parseSlice(holder, { preserveWhitespace: true });
  return { markdown: sliceToMarkdown(slice).trim(), tidy, html: tidied };
}

describe('tidying rich text pasted from elsewhere', () => {
  it('keeps a ChatGPT code block as its code and language, without the header or button', () => {
    const html = '<pre class="overflow-visible"><div class="contain-inline-size"><div class="flex">python</div>'
      + '<div class="sticky"><button class="flex gap-1"><svg><path d="M0"/></svg>Copy code</button></div></div>'
      + '<div class="overflow-y-auto"><code class="whitespace-pre! language-python"><span class="hljs-built_in">print</span>'
      + '(<span class="hljs-string">"hi"</span>)\n</code></div></pre>';
    const result = pasted(html);
    expect(result.markdown).toBe('```python\nprint("hi")\n```');
    expect(result.tidy.removed).toEqual(['Copy code']);
    expect(result.tidy.languages).toEqual(['python']);
  });

  it('reads the language from a header word when the code has no class', () => {
    expect(pasted('<pre><div>bash<button>Copy</button></div><code>ls -la</code></pre>').markdown)
      .toBe('```bash\nls -la\n```');
  });

  it('reads the language GitHub writes on the wrapper', () => {
    expect(pasted('<div class="highlight highlight-source-go"><pre>fmt.Println(1)</pre></div>').markdown)
      .toBe('```go\nfmt.Println(1)\n```');
  });

  it('turns KaTeX back into its TeX, inline and displayed', () => {
    const inline = '<p>Area <span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>r</mi></mrow>'
      + '<annotation encoding="application/x-tex">\\pi r^2</annotation></semantics></math></span>'
      + '<span class="katex-html" aria-hidden="true">πr2</span></span> here.</p>';
    const result = pasted(inline);
    expect(result.markdown).toBe('Area $\\pi r^2$ here.');
    expect(result.tidy.formulas).toBe(1);
    const display = '<span class="katex-display"><span class="katex"><math><semantics><mrow></mrow>'
      + '<annotation encoding="application/x-tex">E = mc^2</annotation></semantics></math></span></span>';
    expect(pasted(display).markdown).toBe('$$\nE = mc^2\n$$');
  });

  it('joins what a table cell held on several lines onto one, and keeps the table', () => {
    const html = '<table><thead><tr><th>Item</th><th>Notes</th></tr></thead><tbody><tr><td>A</td>'
      + '<td><p>first line</p><p>second line</p></td></tr><tr><td>B</td><td><ul><li>one</li><li>two</li></ul></td></tr></tbody></table>';
    const result = pasted(html);
    expect(result.markdown.split('\n')).toEqual([
      '| Item | Notes |',
      '| --- | --- |',
      '| A | first line second line |',
      '| B | one; two |',
    ]);
    expect(result.tidy.joinedCells).toBe(2);
  });

  it('reads bold and italic that Google Docs sets by style, and drops its wrapper that is not bold', () => {
    const html = '<b style="font-weight:normal;" id="docs-internal-guid-1"><p><span style="font-weight:700">Bold</span>'
      + ' and <span style="font-style:italic">italic</span> words.</p></b>';
    expect(pasted(html).markdown).toBe('**Bold** and *italic* words.');
  });

  it('turns non-breaking spaces into spaces and drops zero-width ones', () => {
    expect(pasted('<p>a b​c﻿</p>').markdown).toBe('a bc');
  });

  it('leaves Noto’s own copies as they are', () => {
    const own = '<p data-pm-slice="1 1 []">x <strong>y</strong></p>';
    expect(tidyPastedHtml(own).html).toBe(own);
  });

  it('says in one line what it changed, and only when it changed something worth saying', () => {
    const result = pasted('<pre><div>python<button>Copy code</button></div><code class="language-python">x</code></pre>'
      + '<pre><button>Copy code</button><code>y</code></pre>');
    expect(tidyIsWorthSaying(result.tidy)).toBe(true);
    expect(describeTidy(result.tidy)).toBe('Pasted and tidied: took out "Copy code" ×2.');
    expect(tidyIsWorthSaying(pasted('<p>plain <b>words</b></p>').tidy)).toBe(false);
  });
});

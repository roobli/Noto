/**
 * Rich text pasted from elsewhere, made into what a markdown note can hold.
 *
 * A page copied from ChatGPT, GitHub, a documentation site or Google Docs is
 * HTML written for that page: code blocks wrapped in headers with a language
 * label and a Copy button, formulas drawn by KaTeX as towers of spans, table
 * cells holding paragraphs and lists, bold set by a style on a span, and
 * non-breaking and zero-width characters between words. Parsed as it is, the
 * button text lands in the note, a fence loses its language, a formula comes
 * in as its drawing twice over, and a table cell splits.
 *
 * So the HTML is tidied before the editor reads it, and the tidy reports what
 * it changed, so the reader can be told and can take the plain text instead.
 * Noto's own copies are left alone: they are already the document's shape.
 */

/** What tidying changed, as the reader would put it. */
export interface PasteTidy {
  /** Text of the controls taken out, such as `Copy code`. */
  readonly removed: readonly string[];
  /** Languages read for code blocks. */
  readonly languages: readonly string[];
  /** Formulas turned back into their TeX. */
  readonly formulas: number;
  /** Table cells whose paragraphs, breaks or lists were joined onto one line. */
  readonly joinedCells: number;
}

export const NO_TIDY: PasteTidy = { removed: [], languages: [], formulas: 0, joinedCells: 0 };

/** Whether the reader should hear about a tidy: anything beyond spaces and attributes. */
export function tidyIsWorthSaying(tidy: PasteTidy): boolean {
  return tidy.removed.length > 0 || tidy.formulas > 0 || tidy.joinedCells > 0;
}

/** The tidy in one line for the status line. */
export function describeTidy(tidy: PasteTidy): string {
  const parts: string[] = [];
  if (tidy.removed.length > 0) {
    const counts = new Map<string, number>();
    for (const label of tidy.removed) counts.set(label, (counts.get(label) ?? 0) + 1);
    const named = [...counts].slice(0, 3).map(([label, count]) => (count > 1 ? `"${label}" ×${count}` : `"${label}"`));
    parts.push(`took out ${named.join(', ')}${counts.size > 3 ? ' and more' : ''}`);
  }
  if (tidy.formulas > 0) parts.push(`kept ${tidy.formulas === 1 ? 'a formula' : `${tidy.formulas} formulas`} as TeX`);
  if (tidy.joinedCells > 0) parts.push(`joined the lines of ${tidy.joinedCells === 1 ? 'a table cell' : `${tidy.joinedCells} table cells`}`);
  const sentence = parts.join('; ');
  return `Pasted and tidied: ${sentence}.`;
}

/** Characters with no width that ride along with copied text. ZWJ and ZWNJ stay: emoji and scripts need them. */
const INVISIBLE = /[​﻿]/g;
const NBSP = / /g;

/** Elements that are never content. */
const DROPPED = 'style, script, meta, link, title, noscript, template, nav';
/** Controls drawn around content: their text is the page's, not the reader's. */
const CONTROLS = 'button, [role="button"], select, textarea, svg';
/** Attributes kept, per element; everything else is the source page's styling or state. */
const KEPT: Record<string, readonly string[]> = {
  a: ['href', 'title'],
  img: ['src', 'alt', 'title'],
  pre: ['data-lang'],
  ol: ['start'],
  input: ['type', 'checked'],
  td: ['style'],
  th: ['style'],
};
const MONO = /mono|courier|consolas|menlo|monaco/i;
const LANGUAGE = /^[A-Za-z0-9+#.-]{1,24}$/;

/** Tidy pasted HTML; Noto's own copies come back as they are. */
export function tidyPastedHtml(html: string): { html: string; tidy: PasteTidy } {
  if (html.includes('data-pm-slice')) return { html, tidy: NO_TIDY };
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const body = doc.body;
  const removed: string[] = [];
  const languages: string[] = [];
  let formulas = 0;
  let joinedCells = 0;

  body.querySelectorAll(DROPPED).forEach((element) => element.remove());

  // Formulas first, while KaTeX's drawing and its hidden TeX are both there.
  for (const rendered of [...body.querySelectorAll('.katex-display, .katex, math')]) {
    if (!rendered.isConnected) continue;
    const tex = rendered.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim();
    if (!tex) continue;
    const display = rendered.classList.contains('katex-display') || rendered.getAttribute('display') === 'block';
    const holder = doc.createElement(display ? 'div' : 'span');
    holder.className = display ? 'noto-math-block' : 'noto-math-inline';
    holder.textContent = tex;
    rendered.replaceWith(holder);
    formulas += 1;
  }

  // Code blocks: the code alone, with its language when the page said one.
  for (const pre of [...body.querySelectorAll('pre')]) {
    // The buttons first, so their words are never read as code or as a label.
    for (const control of [...pre.querySelectorAll(CONTROLS)]) {
      const label = control.textContent?.trim();
      if (label && label.length <= 40 && control.tagName.toLowerCase() !== 'svg') removed.push(label);
      control.remove();
    }
    const code = pre.querySelector('code');
    const text = (code ?? pre).textContent ?? '';
    // What the block held besides its code: a header with the language, say.
    let header = '';
    if (code) {
      const copy = pre.cloneNode(true) as Element;
      copy.querySelector('code')?.remove();
      header = (copy.textContent ?? '').trim();
    }
    const language = languageOf(pre, code, header);
    if (header && header !== language) {
      const rest = language && header.startsWith(language) ? header.slice(language.length).trim() : header;
      if (rest && rest.length <= 40) removed.push(rest);
    }
    const clean = doc.createElement('code');
    clean.textContent = text.replace(NBSP, ' ').replace(INVISIBLE, '').replace(/\n$/, '');
    pre.replaceChildren(clean);
    for (const attribute of [...pre.attributes]) pre.removeAttribute(attribute.name);
    if (language) {
      pre.setAttribute('data-lang', language);
      languages.push(language);
    }
  }

  // The page's own controls and the icons on them.
  for (const control of [...body.querySelectorAll(CONTROLS)]) {
    if (!control.isConnected) continue;
    const label = control.textContent?.trim();
    if (label && label.length <= 40 && control.tagName.toLowerCase() !== 'svg') removed.push(label);
    control.remove();
  }
  body.querySelectorAll('[aria-hidden="true"]').forEach((element) => element.remove());
  // An input is kept only as a task's checkbox.
  body.querySelectorAll('input').forEach((input) => {
    if (input.getAttribute('type') !== 'checkbox' || !input.closest('li')) input.remove();
  });

  // Formatting set by style rather than by tag, as Google Docs writes it.
  for (const span of [...body.querySelectorAll<HTMLElement>('span, b, font')]) {
    const style = span.style;
    const weight = style.fontWeight;
    const wrappers: string[] = [];
    if (weight === 'bold' || Number(weight) >= 600) wrappers.push('strong');
    if (style.fontStyle === 'italic') wrappers.push('em');
    if (style.textDecoration.includes('line-through')) wrappers.push('s');
    if (MONO.test(style.fontFamily)) wrappers.push('code');
    // Google Docs wraps the whole copy in a `<b>` that is not bold.
    const notBold = span.tagName.toLowerCase() === 'b' && (weight === 'normal' || weight === '400');
    if (wrappers.length === 0 && !notBold) continue;
    let inner: Node[] = [...span.childNodes];
    for (const tag of wrappers.reverse()) {
      const wrapper = doc.createElement(tag);
      wrapper.append(...inner);
      inner = [wrapper];
    }
    span.replaceWith(...inner);
  }

  // A markdown table cell is one line: what a page put on several is joined.
  for (const cell of [...body.querySelectorAll('td, th')]) {
    let joined = false;
    cell.querySelectorAll('ul, ol').forEach((list) => {
      const items = [...list.querySelectorAll(':scope > li')].map((item) => item.textContent?.trim() ?? '').filter(Boolean);
      list.replaceWith(doc.createTextNode(items.join('; ')));
      joined = true;
    });
    cell.querySelectorAll('br').forEach((br) => { br.replaceWith(doc.createTextNode(' ')); joined = true; });
    const blocks = [...cell.querySelectorAll('p, div, h1, h2, h3, h4, h5, h6, blockquote, pre')];
    if (blocks.length > 1) joined = true;
    for (const block of blocks) {
      if (!block.isConnected) continue;
      block.replaceWith(...block.childNodes, doc.createTextNode(' '));
    }
    if (joined) joinedCells += 1;
    const align = (cell as HTMLElement).style.textAlign;
    cell.removeAttribute('style');
    if (align === 'left' || align === 'center' || align === 'right') cell.setAttribute('style', `text-align: ${align}`);
  }

  // Attributes, and the characters that only got in the way.
  for (const element of [...body.querySelectorAll('*')]) {
    const tag = element.tagName.toLowerCase();
    if (tag === 'td' || tag === 'th') continue;
    const keep = KEPT[tag] ?? [];
    const math = element.classList.contains('noto-math-block') || element.classList.contains('noto-math-inline');
    for (const attribute of [...element.attributes]) {
      if (keep.includes(attribute.name) || (math && attribute.name === 'class')) continue;
      element.removeAttribute(attribute.name);
    }
  }
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue ?? '';
    const next = value.replace(NBSP, ' ').replace(INVISIBLE, '');
    if (next !== value) node.nodeValue = next;
  }

  return { html: body.innerHTML, tidy: { removed, languages, formulas, joinedCells } };
}

/** A code block's language, from wherever the page wrote it. */
function languageOf(pre: Element, code: Element | null, header: string): string {
  const fromClass = (element: Element | null) => {
    const match = element?.className.toString().match(/(?:^|\s)(?:language|lang)-([A-Za-z0-9+#.-]+)/);
    return match?.[1] ?? '';
  };
  const named = pre.getAttribute('data-lang') ?? pre.getAttribute('data-language') ?? code?.getAttribute('data-language')
    ?? (fromClass(code) || fromClass(pre));
  if (named && LANGUAGE.test(named)) return named.toLowerCase();
  // GitHub: `<div class="highlight highlight-source-python"><pre>`.
  const github = pre.closest('[class*="highlight-source-"]')?.className.toString().match(/highlight-source-([A-Za-z0-9+#.-]+)/);
  if (github?.[1]) return github[1].toLowerCase();
  // ChatGPT and similar: a header before the code whose first word is the language.
  const word = (header.split(/\s+/)[0] ?? '').replace(/(Copy|Edit|Run).*$/i, '');
  return LANGUAGE.test(word) && /[a-z]/i.test(word) ? word.toLowerCase() : '';
}

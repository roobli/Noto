/**
 * The safe half of the HTML a note holds, ready to be drawn.
 *
 * A note in this vault carries HTML that markdown has no spelling for: a
 * table with a merged cell, a `<details>` a reader can fold open, a picture
 * centred in a `<div align>`. Typora draws all of it; this drew every one of
 * them as a slab of grey source, which is honest and is not what the author
 * wanted to look at.
 *
 * Drawing a note's HTML means putting the note's own markup into the
 * application's page, so what is drawn is decided here rather than by the
 * browser: an element not on the list is dropped and its children kept, an
 * attribute not on the list is dropped, and a style declaration is kept only
 * when both its property and its value are ones this file names. Scripts,
 * event handlers, frames, forms and anything that could fetch are gone
 * before the markup is ever attached to the document.
 *
 * Pure, apart from the parsing, so what survives can be tested exactly.
 */

/** Elements drawn as themselves. Everything else is unwrapped or dropped. */
const ALLOWED = new Set([
  'a', 'b', 'blockquote', 'br', 'caption', 'center', 'code', 'col', 'colgroup',
  'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'font',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark',
  'ol', 'p', 'pre', 's', 'samp', 'small', 'span', 'strong', 'sub', 'summary', 'sup',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'var',
]);

/** Dropped whole, with everything inside them: nothing here is content. */
const DISCARDED = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'form', 'input', 'button', 'select', 'option', 'textarea', 'link', 'meta',
  'base', 'title', 'noscript', 'template', 'svg', 'math', 'audio', 'video',
  'source', 'track', 'canvas', 'map', 'area', 'portal', 'slot',
]);

/** Attributes kept, by element, plus the ones any element may carry. */
const COMMON = new Set(['align', 'title', 'dir', 'lang']);
const PER_ELEMENT: Readonly<Record<string, ReadonlySet<string>>> = {
  a: new Set(['href']),
  col: new Set(['span', 'width']),
  colgroup: new Set(['span']),
  details: new Set(['open']),
  font: new Set(['color', 'size', 'face']),
  img: new Set(['src', 'alt', 'width', 'height']),
  ol: new Set(['start', 'type', 'reversed']),
  table: new Set(['border', 'cellpadding', 'cellspacing', 'width']),
  td: new Set(['colspan', 'rowspan', 'valign', 'width']),
  th: new Set(['colspan', 'rowspan', 'valign', 'width', 'scope']),
};

/** Style properties a note may set, all of them presentational and local. */
const STYLE_PROPERTIES = new Set([
  'color', 'background-color', 'background', 'font-weight', 'font-style',
  'font-size', 'font-family', 'text-align', 'text-decoration', 'width',
  'height', 'max-width', 'min-width', 'margin', 'margin-left', 'margin-right',
  'margin-top', 'margin-bottom', 'padding', 'border', 'border-radius',
  'border-color', 'border-width', 'border-style', 'line-height', 'zoom',
  'vertical-align', 'display', 'float', 'opacity', 'letter-spacing',
]);

/**
 * A style value that names nothing outside itself.
 *
 * Letters, digits, the punctuation a length or a colour needs, and the
 * parentheses of `rgb()`. No `url(`, no `\`, no `@`, and nothing that could
 * carry a second declaration, so a value cannot reach the network or escape
 * into a property this file did not allow.
 */
const SAFE_VALUE = /^[-#%.,()/\sA-Za-z0-9]*$/;
const UNSAFE_WORD = /url\s*\(|expression|javascript:|@import|behaviou?r\s*:|-moz-binding/i;

/** Where a link may point. A note's link is a place, never a program. */
const SAFE_HREF = /^(?:https?:|mailto:|#|\/|\.{1,2}\/|[^:]*$)/i;

/**
 * The declarations of a style attribute that survive, as pairs.
 *
 * They are applied through the CSSOM rather than written back as an
 * attribute, because the page's content policy is `style-src 'self'` with no
 * inline styles: a style attribute in a note is inert, and setting each
 * property on the element is both what works and what keeps the whitelist in
 * charge of every value that lands.
 */
export function safeDeclarations(style: string): [string, string][] {
  const kept: [string, string][] = [];
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (!STYLE_PROPERTIES.has(property)) continue;
    if (value.length === 0 || value.length > 120) continue;
    if (UNSAFE_WORD.test(value) || !SAFE_VALUE.test(value)) continue;
    // `position` is not on the list, so nothing here can leave its block; a
    // `display` of anything but the ordinary few is dropped for the same reason.
    if (property === 'display' && !['block', 'inline', 'inline-block', 'flex', 'none', 'table', 'table-cell'].includes(value.toLowerCase())) continue;
    kept.push([property, value]);
  }
  return kept;
}

/** The same, joined, which is what reads well in a test. */
export function safeStyle(style: string): string {
  return safeDeclarations(style).map(([property, value]) => `${property}: ${value}`).join('; ');
}

/** Whether an element survives, is unwrapped, or takes its children with it. */
export type Verdict = 'keep' | 'unwrap' | 'drop';

export function verdictFor(tag: string): Verdict {
  if (DISCARDED.has(tag)) return 'drop';
  if (ALLOWED.has(tag)) return 'keep';
  return 'unwrap';
}

/** A colour word or code a `<font color>` may carry. */
const COLOUR = /^(?:#[0-9a-f]{3,8}|[a-z]{3,20}|rgba?\([\d\s.,%]+\))$/i;

/** Copy what an element may keep onto a fresh one, styles through the CSSOM. */
function copyAttributes(source: Element, copy: HTMLElement): void {
  const tag = copy.tagName.toLowerCase();
  const allowed = PER_ELEMENT[tag];
  for (const attribute of [...source.attributes]) {
    const name = attribute.name.toLowerCase();
    if (name === 'style') {
      for (const [property, value] of safeDeclarations(attribute.value)) {
        copy.style.setProperty(property, value);
      }
      continue;
    }
    if (name === 'href' && tag === 'a') {
      const href = attribute.value.trim();
      if (SAFE_HREF.test(href) && !/^\s*javascript:/i.test(href)) copy.setAttribute('href', href);
      continue;
    }
    // `<font color>` is the old spelling of a colour and the vault still has
    // some; it becomes the property it means rather than an attribute the
    // page would have to be told to honour.
    if (tag === 'font' && name === 'color' && COLOUR.test(attribute.value.trim())) {
      copy.style.setProperty('color', attribute.value.trim());
      continue;
    }
    if (tag === 'font' && name === 'face') {
      const face = attribute.value.trim();
      if (SAFE_VALUE.test(face) && !UNSAFE_WORD.test(face)) copy.style.setProperty('font-family', face);
      continue;
    }
    // Everything else is dropped unless it is named, which takes every
    // `on*` handler, every `data-*`, and `class` and `id` with them: a note
    // must not be able to borrow the application's own styles or anchors.
    if (COMMON.has(name) || (allowed?.has(name) ?? false)) copy.setAttribute(name, attribute.value);
  }
}

/**
 * A document with no window, where the cleaned copy is built.
 *
 * An `<img>` given a `src` while it belongs to the page's own document starts
 * loading at once, attached or not, which is how `new Image()` preloads. The
 * copy keeps the address the note wrote so the image resolver can judge it,
 * so the copy must not belong to the page until that judgement is made, or a
 * web picture is fetched with web images turned off. A document made by
 * `createHTMLDocument` has no browsing context: nothing created in it loads,
 * runs or draws. The caller adopts the fragment once each address is final.
 */
let inert: Document | null = null;
export function inertDocument(): Document {
  inert ??= document.implementation.createHTMLDocument('');
  return inert;
}

/**
 * The fragment a note's HTML becomes, cleaned.
 *
 * Parsed by the browser into a document of its own, which is inert: the
 * parser of `DOMParser` runs no script and fetches nothing, so the walk
 * happens before anything in the markup could act. The copy is built in
 * `inertDocument()` for the same reason; see there.
 */
export function sanitizeHtml(html: string, into: Document = inertDocument()): DocumentFragment {
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const walk = (source: Node, target: Node): void => {
    for (const child of [...source.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        target.appendChild(into.createTextNode(child.nodeValue ?? ''));
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const element = child as Element;
      const verdict = verdictFor(element.tagName.toLowerCase());
      if (verdict === 'drop') continue;
      if (verdict === 'unwrap') { walk(element, target); continue; }
      const copy = into.createElement(element.tagName.toLowerCase());
      copyAttributes(element, copy);
      walk(element, copy);
      target.appendChild(copy);
    }
  };
  const fragment = into.createDocumentFragment();
  walk(parsed.body, fragment);
  return fragment;
}

/** The same, as markup, which is what a test can read. */
export function sanitizeToHtml(html: string, into: Document = inertDocument()): string {
  const holder = into.createElement('div');
  holder.appendChild(sanitizeHtml(html, into));
  return holder.innerHTML;
}

/**
 * Whether a block is worth drawing rather than showing as source.
 *
 * A block of one tag with nothing in it says less drawn than written, and a
 * block that survives the cleaning as nothing at all would draw as a hole.
 */
export function worthDrawing(html: string, into: Document = inertDocument()): boolean {
  const trimmed = html.trim();
  if (trimmed.length === 0 || !trimmed.startsWith('<')) return false;
  const holder = into.createElement('div');
  holder.appendChild(sanitizeHtml(trimmed, into));
  return holder.childElementCount > 0 && (holder.textContent ?? '').trim().length + holder.querySelectorAll('img, br, hr').length > 0;
}

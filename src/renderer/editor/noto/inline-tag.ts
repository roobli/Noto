/**
 * An inline HTML tag a note writes around words, read for what it means.
 *
 * Notes colour and size their words the way Typora's own reference teaches:
 * `<span style="color:red">`, the older `<font color=green size=4>`, and
 * `<abbr title>` for a term. The editor draws the words as the tag asks and
 * hides the tags until the caret is in them, the same reveal every other
 * inline syntax gets; the file keeps every character.
 *
 * Nothing here trusts the note. A tag is read only from a closed list of
 * names, only a closed list of properties survives, and each value is checked
 * against a narrow grammar, so a style attribute cannot position, hide, load
 * or overlay anything. What is left is handed to CSS as custom properties,
 * where the stylesheet decides how a colour is shown (it keeps the hue and
 * moves the lightness until the words can be read on this theme's paper).
 *
 * Pure, so the reading is tested on its own.
 */

/** Bare tags that need no attributes to mean something. */
export const BARE_TAGS: ReadonlySet<string> = new Set([
  'kbd', 'sub', 'sup', 'u', 'mark', 'b', 'strong', 'i', 'em', 's', 'del', 'ins', 'small', 'q', 'cite', 'code',
]);

/** Tags read with their attributes. */
const ATTRIBUTE_TAGS: ReadonlySet<string> = new Set(['span', 'font', 'abbr', 'a']);

export interface InlineTag {
  readonly name: string;
  /** Custom properties for the drawn words, `--note-color: red; …`, or empty. */
  readonly style: string;
  /** A title the words carry on hover, from `<abbr title>` or `<span title>`. */
  readonly title: string | null;
  /** The anchor this tag names, from `id` or `name`, for in-note links. */
  readonly anchor: string | null;
}

const OPEN = /^<([a-z]+)((?:\s+[a-z][a-z0-9-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>`=]+))?)*)\s*>$/i;
const ATTRIBUTE = /([a-z][a-z0-9-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`=]+)))?/gi;

const COLOUR = /^(?:#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|[a-z]{3,20}|(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\([0-9.,%\s/+-]+\))$/i;
const SIZE = /^(?:\d{1,3}(?:\.\d+)?(?:px|pt|em|rem|%)|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger)$/i;
const WEIGHT = /^(?:normal|bold|bolder|lighter|[1-9]00)$/i;
const FONT_STYLE = /^(?:normal|italic|oblique)$/i;
const DECORATION = /^(?:none|underline|overline|line-through)(?:\s+(?:underline|overline|line-through))*$/i;

/** `<font size>` 1 to 7, as browsers size it, relative to the words around it. */
const FONT_SIZES = ['0.625em', '0.8125em', '1em', '1.125em', '1.5em', '2em', '3em'];

function attributes(source: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = match[1]!.toLowerCase();
    if (!found.has(name)) found.set(name, (match[2] ?? match[3] ?? match[4] ?? '').trim());
  }
  return found;
}

/** The declarations of a style attribute that are kept, as custom properties. */
function keptStyle(style: string): string[] {
  const kept: string[] = [];
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim().replace(/\s*!important$/i, '');
    if (value.length === 0 || value.length > 60) continue;
    if (property === 'color' && COLOUR.test(value)) kept.push(`--note-color: ${value}`);
    else if ((property === 'background' || property === 'background-color') && COLOUR.test(value)) kept.push(`--note-fill: ${value}`);
    else if (property === 'font-size' && SIZE.test(value)) kept.push(`--note-size: ${value}`);
    else if (property === 'font-weight' && WEIGHT.test(value)) kept.push(`--note-weight: ${value}`);
    else if (property === 'font-style' && FONT_STYLE.test(value)) kept.push(`--note-slant: ${value}`);
    else if ((property === 'text-decoration' || property === 'text-decoration-line') && DECORATION.test(value)) kept.push(`--note-line: ${value}`);
  }
  return kept;
}

/**
 * The tag an `inline_html` node opens, or null when it is not one this draws.
 *
 * A span with a class is left alone: `sidenote` and `marginnote` belong to the
 * sidenote plugin, and any other class means styling this editor does not have.
 * An `<a>` is read only as an anchor; one with an `href` is a link, which is
 * markdown's job, and stays source.
 */
export function openingTag(value: string): InlineTag | null {
  const match = OPEN.exec(value.trim());
  if (!match) return null;
  const name = match[1]!.toLowerCase();
  const rest = match[2] ?? '';
  if (BARE_TAGS.has(name)) {
    return rest.trim().length === 0 ? { name, style: '', title: null, anchor: null } : null;
  }
  if (!ATTRIBUTE_TAGS.has(name)) return null;
  const found = attributes(rest);
  if (found.has('class')) return null;
  const anchor = found.get('id') || found.get('name') || null;
  const title = found.get('title') || null;
  if (name === 'a') {
    return found.has('href') || anchor === null ? null : { name, style: '', title: null, anchor };
  }
  const style: string[] = keptStyle(found.get('style') ?? '');
  if (name === 'font') {
    const colour = found.get('color');
    if (colour && COLOUR.test(colour)) style.push(`--note-color: ${colour}`);
    const size = Number.parseInt(found.get('size') ?? '', 10);
    if (size >= 1 && size <= 7) style.push(`--note-size: ${FONT_SIZES[size - 1]}`);
  }
  return { name, style: style.join('; '), title, anchor };
}

const CLOSE = /^<\/([a-z]+)\s*>$/i;

/** The name of the tag an `inline_html` node closes, or null. */
export function closingTag(value: string): string | null {
  return CLOSE.exec(value.trim())?.[1]?.toLowerCase() ?? null;
}

/** Whether an `inline_html` node is an HTML comment, which the reader never sees. */
export function isInlineComment(value: string): boolean {
  const text = value.trim();
  return text.startsWith('<!--') && text.endsWith('-->');
}

/**
 * Which block of a note a `#fragment` link points at.
 *
 * A note links to a place in itself the way Typora and GitHub spell it:
 * `[jump](#b12-脚注)` for the heading "B12 脚注", lower case with spaces as
 * hyphens and most punctuation dropped, or the heading text as written. It may
 * also point at an anchor the note placed with `<a id="here">` or
 * `<span id="here">`. Both are answered from the outline and the note's text,
 * so this is pure and tested on its own.
 */

import type { OutlineEntry } from './outline';

/**
 * GitHub's heading slug, which Typora follows: lower case, spaces to hyphens,
 * and every character dropped that is not a letter, a digit, a hyphen, an
 * underscore or a space. CJK text is letters and stays.
 */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function decoded(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

/**
 * The block a fragment names, or null.
 *
 * Tried in order: a heading whose slug is the fragment, a heading whose text is
 * the fragment, and a block that places an anchor with that id. Two headings
 * with one slug are told apart as GitHub does, `-1`, `-2` after the first.
 */
export function blockForFragment(
  fragment: string,
  outline: readonly OutlineEntry[],
  blocks: readonly string[],
): number | null {
  const wanted = decoded(fragment.replace(/^#/, '')).trim();
  if (wanted.length === 0) return null;
  const lower = wanted.toLowerCase();
  const seen = new Map<string, number>();
  for (const entry of outline) {
    const base = headingSlug(entry.text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const slug = count === 0 ? base : `${base}-${count}`;
    if (slug === lower || slug === headingSlug(wanted)) return entry.blockIndex;
  }
  for (const entry of outline) {
    if (entry.text.trim().toLowerCase() === lower) return entry.blockIndex;
  }
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const anchor = new RegExp(`<(?:a|span)\\b[^>]*\\b(?:id|name)\\s*=\\s*["']?${escaped}["'\\s>]`, 'i');
  const index = blocks.findIndex((block) => anchor.test(block));
  return index >= 0 ? index : null;
}

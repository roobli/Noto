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

import { headingForFragment } from '@roobli/md/inline';
import type { OutlineEntry } from './outline';

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
 * Tried in order: a heading the fragment names, by GitHub's slug with its
 * `-1`, `-2` for repeats or by its text (`@roobli/md/inline`, which `md serve`
 * slugs headings with too), then a block that places an anchor with that id.
 */
export function blockForFragment(
  fragment: string,
  outline: readonly OutlineEntry[],
  blocks: readonly string[],
): number | null {
  const heading = headingForFragment(fragment, outline.map((entry) => entry.text));
  if (heading !== null) return outline[heading]!.blockIndex;
  const wanted = decoded(fragment.replace(/^#/, '')).trim();
  if (wanted.length === 0) return null;
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const anchor = new RegExp(`<(?:a|span)\\b[^>]*\\b(?:id|name)\\s*=\\s*["']?${escaped}["'\\s>]`, 'i');
  const index = blocks.findIndex((block) => anchor.test(block));
  return index >= 0 ? index : null;
}

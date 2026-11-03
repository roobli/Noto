/**
 * A note's text as the blocks the editor's top-level nodes come from.
 *
 * Shared by the two places that compare a note block by block: the git
 * gutter in main, against the note as committed, and the unsaved changes in
 * the renderer, against the note as saved. Both have to cut the text the same
 * way the editor does, or a block would be reported changed that is only cut
 * differently. A byte order mark and CRLF line endings are dropped first, so
 * a note saved on Windows does not differ in every block from its own text.
 */

import { parseBlocksStructural } from './roobli-md-adapter';

export function blocksOf(text: string): string[] {
  const body = text.startsWith('\uFEFF') ? text.slice(1) : text;
  return parseBlocksStructural(body.replace(/\r\n?/g, '\n')).spans.map((span) => span.markdown.replace(/\r\n?/g, '\n'));
}

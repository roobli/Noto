/**
 * The part of a path worth showing beside a name the row already states.
 *
 * A vault's paths share long prefixes. Cutting at the end, which is what a
 * plain ellipsis does, leaves every result in a folder reading identically;
 * cutting at the start cuts mid-word. What tells two results apart is the
 * folder the note is in, so the last two folders are kept whole behind one
 * `…`, and the whole path is the row's title.
 */
export function pathTail(relativePath: string, includeLast = false, segments = 2): string {
  const parts = relativePath.split(/[\\/]/).filter((part) => part.length > 0);
  // A note's last part is the file itself, which the row already names; a folder's is the folder.
  if (!includeLast) parts.pop();
  if (parts.length === 0) return 'At the top of the folder';
  if (parts.length <= segments) return parts.join(' / ');
  return `… / ${parts.slice(-segments).join(' / ')}`;
}

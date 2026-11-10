/** Blank lines a save may be asked to leave between two blocks (`NotoUnit.blankLinesBefore`). */
export const MAX_BLANK_LINES = 1000;

/** Blank lines after each block, by ordinal; one for a plain break. */
export type GapLines = (ordinal: number) => number;

/**
 * Blank lines in the whitespace between two blocks: one for a plain break
 * (`\n\n`), more for each extra empty line, none for a single newline or for
 * text that is not whitespace. Shared by the save, which writes them, and the
 * editor, which draws them.
 */
export function blankLinesIn(gap: string): number {
  const lf = gap.replaceAll('\r\n', '\n');
  if (lf.trim() !== '') return 0;
  return Math.max(0, lf.split('\n').length - 2);
}

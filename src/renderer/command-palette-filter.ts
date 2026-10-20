/**
 * Which commands a palette query keeps.
 *
 * Every word of the query has to appear somewhere in the command's title or
 * the name of what offers it, in any order and any case, so `pdf export`,
 * `export pdf` and `title shift demote` each find the one command they mean.
 * The order of the list is kept: built-in export first, then plugins, which
 * is the order the palette has always shown.
 */
export interface PaletteFilterable {
  readonly title: string;
  readonly source: string;
}

export function filterPaletteCommands<T extends PaletteFilterable>(commands: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return [...commands];
  return commands.filter((command) => {
    const haystack = `${command.title} ${command.source}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

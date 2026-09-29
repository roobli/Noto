/**
 * One way of turning what was typed into what is looked for.
 *
 * The find bar in a note and the search across the vault take the same three
 * switches, and they have to mean the same thing in both places: a query that
 * matches in the bar and not in the sidebar would be a bug the reader could
 * not name. So the pattern is built here, once, and both sides use it. It is
 * shared rather than the renderer's because the vault search runs in main.
 */

export interface SearchFlags {
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly regex: boolean;
}

export const PLAIN_FLAGS: SearchFlags = { caseSensitive: false, wholeWord: false, regex: false };

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The expression for a query, or null when there is nothing to look for or
 * the query is a regular expression that does not parse.
 *
 * A literal query is escaped, so someone searching for `Data_Archive (旧)` finds
 * that text and not a group. Whole word wraps the body in word boundaries,
 * which in a Chinese sentence means very little, since there are no spaces
 * to bound; it is offered because Typora offers it and a Latin query in the
 * same vault wants it.
 */
export function patternFor(query: string, flags: SearchFlags): RegExp | null {
  if (query.length === 0) return null;
  const body = flags.regex ? query : escape(query);
  const source = flags.wholeWord ? `\\b(?:${body})\\b` : body;
  try {
    return new RegExp(source, flags.caseSensitive ? 'gu' : 'giu');
  } catch {
    return null;
  }
}

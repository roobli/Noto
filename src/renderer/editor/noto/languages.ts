/**
 * The languages a code fence can name, as the reader picks them.
 *
 * Each entry is what is written after the fence (`id`), the name a reader
 * looks for in a list (`name`), and the other names people type for it
 * (`aliases`). The order is how often a language is fenced in practice, so an
 * empty search lists the likely ones first. The highlighter reads the same
 * names, so choosing one is choosing its colours.
 */

export interface LanguageEntry {
  /** What the fence says: ```` ```python ````. */
  readonly id: string;
  /** What the list shows. */
  readonly name: string;
  /** Other names typed for it, all lower case. */
  readonly aliases: readonly string[];
}

/** What a fence says when the reader chose plain text over a guess. */
export const PLAIN_TEXT = 'text';

export const LANGUAGES: readonly LanguageEntry[] = [
  { id: 'bash', name: 'Shell', aliases: ['sh', 'shell', 'zsh', 'console', 'terminal'] },
  { id: 'python', name: 'Python', aliases: ['py', 'python3'] },
  { id: 'javascript', name: 'JavaScript', aliases: ['js', 'node', 'mjs', 'cjs'] },
  { id: 'typescript', name: 'TypeScript', aliases: ['ts'] },
  { id: 'json', name: 'JSON', aliases: ['jsonc'] },
  { id: 'yaml', name: 'YAML', aliases: ['yml'] },
  { id: 'go', name: 'Go', aliases: ['golang'] },
  { id: 'rust', name: 'Rust', aliases: ['rs'] },
  { id: 'sql', name: 'SQL', aliases: ['mysql', 'postgresql', 'postgres', 'sqlite'] },
  { id: 'html', name: 'HTML', aliases: ['htm', 'vue'] },
  { id: 'css', name: 'CSS', aliases: [] },
  { id: 'markdown', name: 'Markdown', aliases: ['md'] },
  { id: 'diff', name: 'Diff', aliases: ['patch'] },
  { id: 'dockerfile', name: 'Dockerfile', aliases: ['docker'] },
  { id: 'toml', name: 'TOML', aliases: [] },
  { id: 'java', name: 'Java', aliases: [] },
  { id: 'c', name: 'C', aliases: ['h'] },
  { id: 'cpp', name: 'C++', aliases: ['c++', 'cc', 'hpp', 'cxx'] },
  { id: 'csharp', name: 'C#', aliases: ['cs', 'c#'] },
  { id: 'tsx', name: 'TSX', aliases: [] },
  { id: 'jsx', name: 'JSX', aliases: [] },
  { id: 'xml', name: 'XML', aliases: ['svg', 'plist'] },
  { id: 'nginx', name: 'Nginx', aliases: [] },
  { id: 'ini', name: 'INI', aliases: ['cfg', 'dosini'] },
  { id: 'powershell', name: 'PowerShell', aliases: ['ps1', 'pwsh'] },
  { id: 'ruby', name: 'Ruby', aliases: ['rb'] },
  { id: 'php', name: 'PHP', aliases: [] },
  { id: 'lua', name: 'Lua', aliases: [] },
  { id: 'swift', name: 'Swift', aliases: [] },
  { id: 'kotlin', name: 'Kotlin', aliases: ['kt', 'kts'] },
  { id: 'scss', name: 'SCSS', aliases: [] },
  { id: 'makefile', name: 'Makefile', aliases: ['make', 'mk'] },
  { id: 'http', name: 'HTTP', aliases: [] },
  { id: 'haskell', name: 'Haskell', aliases: ['hs'] },
  { id: 'vim', name: 'Vim script', aliases: ['vimscript', 'viml'] },
  { id: 'latex', name: 'LaTeX', aliases: ['tex'] },
  { id: 'graphql', name: 'GraphQL', aliases: ['gql'] },
  { id: 'protobuf', name: 'Protocol Buffers', aliases: ['proto'] },
  { id: 'r', name: 'R', aliases: [] },
  { id: 'perl', name: 'Perl', aliases: ['pl'] },
  { id: 'scala', name: 'Scala', aliases: [] },
  { id: 'dart', name: 'Dart', aliases: [] },
  { id: 'elixir', name: 'Elixir', aliases: ['ex', 'exs'] },
  { id: 'erlang', name: 'Erlang', aliases: ['erl'] },
  { id: 'groovy', name: 'Groovy', aliases: ['gradle'] },
  { id: 'zig', name: 'Zig', aliases: [] },
  { id: 'objectivec', name: 'Objective-C', aliases: ['objc', 'objective-c'] },
  { id: 'lisp', name: 'Lisp', aliases: ['elisp', 'emacs-lisp'] },
  { id: 'json5', name: 'JSON5', aliases: [] },
  { id: 'properties', name: 'Properties', aliases: [] },
  { id: 'regex', name: 'Regular expression', aliases: ['regexp'] },
  { id: 'mermaid', name: 'Mermaid diagram', aliases: [] },
  { id: 'flow', name: 'Flowchart', aliases: [] },
  { id: 'sequence', name: 'Sequence diagram', aliases: [] },
  { id: 'timeline', name: 'Timeline', aliases: [] },
  { id: PLAIN_TEXT, name: 'Plain text', aliases: ['plain', 'plaintext', 'txt', 'none'] },
];

const BY_NAME = new Map<string, LanguageEntry>();
for (const entry of LANGUAGES) {
  BY_NAME.set(entry.id, entry);
  for (const alias of entry.aliases) if (!BY_NAME.has(alias)) BY_NAME.set(alias, entry);
}

/** The entry a fence's language names, whichever of its names it uses. */
export function languageEntry(lang: string): LanguageEntry | null {
  return BY_NAME.get(lang.trim().toLowerCase()) ?? null;
}

/** What to call a fence's language on screen: its name, or what the fence says. */
export function languageName(lang: string): string {
  return languageEntry(lang)?.name ?? lang.trim();
}

export interface LanguageSuggestion {
  readonly entry: LanguageEntry;
  /** Which of its names matched: shown beside the name when it is not the name. */
  readonly matched: string;
  /** Whether `matched` is the entry's name rather than one of its ids. */
  readonly onName: boolean;
  /** Indices of the matched characters in `matched`, to be marked. */
  readonly marks: readonly number[];
  readonly score: number;
}

/** How well `candidate` answers `query`, both lower case, and which characters did. */
function match(candidate: string, query: string): { score: number; marks: number[] } | null {
  const run = (from: number) => Array.from({ length: query.length }, (_, index) => from + index);
  if (candidate === query) return { score: 100, marks: run(0) };
  if (candidate.startsWith(query)) return { score: 80, marks: run(0) };
  // At the start of a word inside it: "script" in "Vim script".
  const word = candidate.search(new RegExp(`(?<=[\\s\\-+#.])${escapeRegExp(query)}`));
  if (word > 0) return { score: 60, marks: run(word) };
  const inside = candidate.indexOf(query);
  if (inside > 0) return { score: 40, marks: run(inside) };
  // The letters in order: "tsc" in "typescript".
  const marks: number[] = [];
  let at = 0;
  for (const letter of query) {
    const found = candidate.indexOf(letter, at);
    if (found < 0) return null;
    marks.push(found);
    at = found + 1;
  }
  return { score: 20, marks };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The languages that answer what the reader typed, best first.
 *
 * Every name of an entry is tried, its list name and its ids, and the best
 * match stands for it. Equal matches keep the list's order, which is how
 * common each language is.
 */
export function suggestLanguages(query: string): LanguageSuggestion[] {
  const wanted = query.trim().toLowerCase();
  if (wanted.length === 0) {
    return LANGUAGES.map((entry) => ({ entry, matched: entry.id, onName: false, marks: [], score: 0 }));
  }
  const found: Array<LanguageSuggestion & { order: number }> = [];
  LANGUAGES.forEach((entry, order) => {
    let best: LanguageSuggestion | null = null;
    const names: Array<[string, boolean]> = [[entry.name, true], [entry.id, false], ...entry.aliases.map((alias): [string, boolean] => [alias, false])];
    for (const [name, onName] of names) {
      const hit = match(name.toLowerCase(), wanted);
      if (hit && (!best || hit.score > best.score)) best = { entry, matched: name, onName, marks: hit.marks, score: hit.score };
    }
    if (best) found.push({ ...best, order });
  });
  found.sort((left, right) => right.score - left.score || left.order - right.order);
  return found.map(({ order: _order, ...suggestion }) => suggestion);
}

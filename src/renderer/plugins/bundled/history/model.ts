/**
 * What the History and Properties tabs say, worked out without a window.
 */

import type { NoteCommit } from '../../slots';

const time = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const day = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });
const dayYear = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' });

function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** When, as a list of commits says it: "Today 10:12", "Yesterday 23:40", "Nov 4, 23:40", "Nov 4, 2025". */
export function when(at: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days === 0) return `Today ${time.format(at)}`;
  if (days === 1) return `Yesterday ${time.format(at)}`;
  if (new Date(at).getFullYear() === new Date(now).getFullYear()) return `${day.format(at)}, ${time.format(at)}`;
  return dayYear.format(at);
}

/** A day in a sentence: "today", "yesterday", "3 days ago", "Nov 4", "Nov 4, 2025". */
export function dayIn(at: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(at).getFullYear() === new Date(now).getFullYear() ? day.format(at) : dayYear.format(at);
}

export const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString('en')} ${count === 1 ? one : many}`;

/** Lines added and taken away: "+40 -6". */
export function lines(added: number | null, removed: number | null): string {
  if (added === null || removed === null) return '';
  return `+${added.toLocaleString('en')} -${removed.toLocaleString('en')}`;
}

/** The second line of a commit's row. */
export function commitDetail(commit: NoteCommit, now = Date.now()): string {
  const parts = [when(commit.time, now), commit.author];
  const counted = lines(commit.added, commit.removed);
  if (commit.change === 'added') parts.push(counted ? `created, ${counted}` : 'created');
  // A move that changed nothing says so on its own line; +0 -0 would only repeat it.
  else if (counted && !(commit.change === 'renamed' && commit.added === 0 && commit.removed === 0)) parts.push(counted);
  if (commit.tooling) parts.push('index only');
  else if (commit.sweeping) parts.push('across the folder');
  return parts.join(' · ');
}

/** The timeline's words for the commits track: "4 commits, last yesterday". */
export function commitsSummary(commits: readonly NoteCommit[], more: boolean, now = Date.now()): string {
  if (commits.length === 0) return '';
  const count = more ? `${commits.length.toLocaleString('en')}+ commits` : plural(commits.length, 'commit');
  return `${count}, last ${dayIn(commits[0]!.time, now)}`;
}

/** A frontmatter field as the Properties tab shows it. */
export interface Field {
  readonly key: string;
  readonly value: string;
}

/** Unquote a YAML scalar the plain ways people write them. */
function scalar(raw: string): string {
  const value = raw.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * The top-level fields of a note's frontmatter, in the order written.
 *
 * Not a YAML parser: it reads what notes hold (`key: value`, a list under a
 * key, `[a, b]`), which is what a person reading a note's properties needs.
 * A nested map is shown as its lines joined.
 */
export function frontmatterFields(text: string): Field[] {
  const match = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/.exec(text);
  if (!match) return [];
  const fields: { key: string; parts: string[]; inline: string }[] = [];
  for (const line of match[1]!.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const top = /^([^\s#:][^:]*):(?:\s+(.*))?$/.exec(line);
    if (top) {
      fields.push({ key: top[1]!.trim(), parts: [], inline: (top[2] ?? '').trim() });
      continue;
    }
    const last = fields[fields.length - 1];
    if (!last) continue;
    const item = /^\s+-\s*(.*)$/.exec(line);
    last.parts.push(scalar(item ? item[1]! : line.trim()));
  }
  return fields.map(({ key, parts, inline }) => {
    let value = inline;
    if (/^\[.*\]$/.test(inline)) value = inline.slice(1, -1).split(',').map(scalar).filter(Boolean).join(', ');
    else if (inline) value = scalar(inline);
    else value = parts.filter(Boolean).join(', ');
    return { key, value };
  });
}

export interface TextCounts {
  readonly words: number;
  readonly headings: number;
  readonly tables: number;
  readonly codeBlocks: number;
  readonly noteLinks: number;
  readonly webLinks: number;
}

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/gu;

/**
 * Counts of the note's body. Words are counted as a reader would: Chinese,
 * Japanese and Korean a character each, other text by the spaces between.
 * Frontmatter and code are not words.
 */
export function textCounts(text: string): TextCounts {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/, '');
  const fences = body.match(/^\s{0,3}(`{3,}|~{3,})/gm)?.length ?? 0;
  const prose = body.replace(/^\s{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s{0,3}\1[^\n]*$/gm, ' ').replace(/`[^`\n]*`/g, ' ');
  const cjk = prose.match(CJK)?.length ?? 0;
  // A link's target is where it goes, not what it says.
  const said = prose.replace(/\]\([^)\n]*\)/g, ']').replace(/<[a-z][a-z0-9+.-]*:[^>\s]*>/gi, ' ');
  const latin = said.replace(CJK, ' ').replace(/[#>*_`|[\]()!-]+/g, ' ').split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
  const lines = prose.split('\n');
  let tables = 0;
  for (let index = 1; index < lines.length; index += 1) {
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index]!) && lines[index - 1]!.includes('|')) tables += 1;
  }
  const wiki = prose.match(/(?<!!)\[\[[^\]\n]+\]\]/g)?.length ?? 0;
  const markdownLinks = [...prose.matchAll(/(?<!!)\[[^\]\n]*\]\(([^)\s]+)[^)]*\)/g)].map((found) => found[1]!);
  const web = markdownLinks.filter((target) => /^[a-z][a-z0-9+.-]*:/i.test(target)).length;
  return {
    words: cjk + latin,
    headings: prose.match(/^\s{0,3}#{1,6}\s/gm)?.length ?? 0,
    tables,
    codeBlocks: Math.floor(fences / 2),
    noteLinks: wiki + markdownLinks.length - web,
    webLinks: web,
  };
}

/** A size in the units a person reads. */
export function size(bytes: number): string {
  if (bytes < 1024) return plural(bytes, 'byte');
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

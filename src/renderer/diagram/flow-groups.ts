/**
 * A flowchart statement that names every node of a group, drawn as an arrow
 * to or from the group itself.
 *
 * `A & B & C --> X & Y` is mermaid's shorthand for every one on the left
 * joined to every one on the right, and mermaid draws each pair: a note of the
 * author's joined the five sources in its billing group to the three tables in
 * its database group, fifteen curves that crossed sixteen times and ran through
 * boxes they had nothing to do with.
 *
 * When one side of such a statement is exactly the nodes of a subgraph, every
 * one of them and no other, that side says "this whole group", and the group
 * has a name the note gave it. So the side is drawn as the group: an arrow from
 * the billing box to each table, under the title the note wrote. It means what
 * the statement means and adds nothing a reader has to guess at.
 *
 * Only a many-to-many statement is rewritten, the one that tangles: a node
 * joined to three, or three to one, is three lines and is drawn as written.
 * And only its sources are drawn as their group, never its targets: an arrow
 * starting at a group reads as "from this group", but one ending on a group
 * box lands wherever the layout puts the box's edge, often far from anything
 * in it, and can be read three ways. Kept as nodes, the targets stay
 * comparable with another statement that reaches only some of them (a service
 * writing two of the three tables). Sources that are only some of a group are
 * drawn as written.
 *
 * A group drawn as an end of an arrow is laid out by mermaid on its own, and
 * mermaid then turns it the other way from the chart: in a left-to-right chart
 * the five sources went from a column to a row 1,071 pixels long,
 * and the whole chart had to be shrunk to half size to fit. Such a group is
 * given the chart's own direction, unless the note gave it one, so it is laid
 * out as it was.
 *
 * Only the plain form is read: node ids joined by `&`, one arrow, no label. A
 * group whose members cannot be told for certain (a node that appears in two
 * groups) is not used. Only the drawing changes; the note's source does not.
 *
 * Pure, so the rewrite can be checked without a frame.
 */

const ID = '[A-Za-z0-9_][A-Za-z0-9_-]*';
const SIDE = `${ID}(?:\\s*&\\s*${ID})*`;
/** One statement on a line: `left arrow right`, optionally ending in `;`. */
const STATEMENT = new RegExp(`^(\\s*)(${SIDE})\\s*(-->|---|-\\.->|-\\.-|==>|===)\\s*(${SIDE})\\s*;?\\s*$`);
const SUBGRAPH = new RegExp(`^\\s*subgraph\\s+(${ID})(?=\\s*(?:\\[|$))`);
/** Words that start a line without naming a node. */
const KEYWORDS = new Set(['subgraph', 'end', 'direction', 'style', 'classDef', 'class', 'click', 'linkStyle', 'flowchart', 'graph']);

/** Whether the source is a flowchart, the only kind rewritten here. */
export function isFlowchart(source: string): boolean {
  return /^\s*(?:%%.*\n\s*)*(?:---\n[\s\S]*?\n---\n\s*)?(?:flowchart|graph)\b/.test(source);
}

/** The node ids a line mentions, with every label, shape and quoted text taken out first. */
function idsIn(line: string): string[] {
  const bare = line
    .replace(/%%.*$/, '')
    .replace(/"[^"]*"/g, ' ')
    .replace(/\|[^|]*\|/g, ' ')
    .replace(/@\{[^}]*\}/g, ' ')
    .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|>[^\]\n]*\]/g, ' ')
    .replace(/--\s[^-]*?\s-->|==\s[^=]*?\s==>|-\.\s[^.]*?\s\.->/g, ' --> ');
  const first = bare.trim().split(/\s+/)[0] ?? '';
  if (KEYWORDS.has(first)) return [];
  return bare.split(/-->|---|-\.->|-\.-|==>|===|&|;|\s+/)
    .map((token) => token.trim())
    .filter((token) => new RegExp(`^${ID}$`).test(token) && !KEYWORDS.has(token));
}

/**
 * Each subgraph's nodes, nested groups' included, by the subgraph's id. A
 * group with a node that is also in another group, not one nested in it, is
 * left out: mermaid's own rule for where such a node goes is not one to guess.
 */
export function subgraphMembers(source: string): Map<string, ReadonlySet<string>> {
  const own = new Map<string, Set<string>>();
  const parent = new Map<string, string | null>();
  const stack: string[] = [];
  for (const line of source.split('\n')) {
    const opened = SUBGRAPH.exec(line);
    if (opened) {
      const id = opened[1]!;
      parent.set(id, stack[stack.length - 1] ?? null);
      own.set(id, own.get(id) ?? new Set());
      stack.push(id);
      continue;
    }
    if (/^\s*subgraph\b/.test(line)) { stack.push(''); continue; }
    if (/^\s*end\s*;?\s*$/.test(line)) { stack.pop(); continue; }
    const current = stack[stack.length - 1];
    if (!current) continue;
    for (const id of idsIn(line)) own.get(current)!.add(id);
  }
  const groups = new Set(own.keys());
  const all = new Map<string, Set<string>>();
  for (const id of own.keys()) {
    const members = new Set<string>();
    const collect = (group: string) => {
      for (const node of own.get(group) ?? []) if (!groups.has(node)) members.add(node);
      for (const [child, up] of parent) if (up === group) collect(child);
    };
    collect(id);
    all.set(id, members);
  }
  // A node claimed by two groups where neither holds the other makes both unreliable.
  const ancestors = (group: string): Set<string> => {
    const out = new Set<string>();
    for (let at = parent.get(group) ?? null; at; at = parent.get(at) ?? null) out.add(at);
    return out;
  };
  const unreliable = new Set<string>();
  const ids = [...own.keys()];
  for (let a = 0; a < ids.length; a += 1) {
    for (let b = a + 1; b < ids.length; b += 1) {
      const [x, y] = [ids[a]!, ids[b]!];
      if (ancestors(x).has(y) || ancestors(y).has(x)) continue;
      for (const node of own.get(x)!) if (own.get(y)!.has(node)) { unreliable.add(x); unreliable.add(y); }
    }
  }
  const result = new Map<string, ReadonlySet<string>>();
  for (const [id, members] of all) if (!unreliable.has(id) && members.size >= 2) result.set(id, members);
  return result;
}

/** The flowchart with every side of a plain statement that names a whole group drawn as that group. */
export function drawWholeGroups(source: string): string {
  if (!isFlowchart(source)) return source;
  const groups = subgraphMembers(source);
  if (groups.size === 0) return source;
  const groupFor = (side: string): string | null => {
    const ids = side.split('&').map((id) => id.trim());
    if (ids.length < 2) return null;
    const wanted = new Set(ids);
    for (const [group, members] of groups) {
      if (members.size === wanted.size && [...members].every((node) => wanted.has(node))) return group;
    }
    return null;
  };
  const used = new Set<string>();
  const lines = source.split('\n').map((line) => {
    const match = STATEMENT.exec(line);
    if (!match) return line;
    const [, indent, left, arrow, right] = match as unknown as [string, string, string, string, string];
    // Many to many only, and only the sources become their group: every arrow still ends on a named box.
    if (left.split('&').length < 2 || right.split('&').length < 2) return line;
    const from = groupFor(left);
    if (!from) return line;
    used.add(from);
    return `${indent}${from} ${arrow} ${right.trim()}`;
  });
  if (used.size === 0) return source;
  const chart = /^\s*(?:%%.*\n\s*)*(?:flowchart|graph)[ \t]+(TB|TD|BT|RL|LR)\b/m.exec(source)?.[1] ?? 'TB';
  const direction = chart === 'TD' ? 'TB' : chart;
  return keepDirection(lines, used, direction).join('\n');
}

/** Each group in `used` without a `direction` of its own, given the chart's, on the line after it opens. */
function keepDirection(lines: readonly string[], used: ReadonlySet<string>, direction: string): string[] {
  const out: string[] = [];
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at]!;
    out.push(line);
    const opened = SUBGRAPH.exec(line);
    if (!opened || !used.has(opened[1]!)) continue;
    // Its own direction, if it states one before anything else nests in it, wins.
    let depth = 0;
    let stated = false;
    for (let next = at + 1; next < lines.length; next += 1) {
      const inner = lines[next]!;
      if (/^\s*subgraph\b/.test(inner)) depth += 1;
      else if (/^\s*end\s*;?\s*$/.test(inner)) { if (depth === 0) break; depth -= 1; }
      else if (depth === 0 && /^\s*direction\s+(TB|TD|BT|RL|LR)\b/.test(inner)) { stated = true; break; }
    }
    if (!stated) out.push(`${/^\s*/.exec(line)![0]}    direction ${direction}`);
  }
  return out;
}

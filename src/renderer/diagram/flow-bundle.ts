/**
 * A flowchart's many-to-many lines, drawn as one bundle through a junction.
 *
 * `A & B & C --> X & Y` is mermaid's shorthand for every one of the left
 * joined to every one of the right: six lines here, fifteen for five sources
 * and three targets. Mermaid draws each, and its layout cannot keep fifteen
 * curves apart: they cross one another and run through boxes they have
 * nothing to do with. The author's Credits note drew 21 lines with 16
 * crossings and 9 passes through a box.
 *
 * The same statement is drawn as the left joined to a small junction and the
 * junction joined to the right: five plus three lines instead of fifteen. It
 * says exactly what the shorthand says, every left reaches every right, and
 * is how a person draws a fan-in that fans out again. Only the drawing
 * changes; the note's source is untouched.
 *
 * Only the plain form is read: node ids on both sides, at least two of each,
 * an arrow with no label. Anything else, a node declared with its shape in the
 * statement, a labelled arrow, is left as written.
 *
 * Pure, so the rewrite can be checked without a frame.
 */

/** The arrows read, by kind: the line drawn to the junction and the one drawn on from it. */
const ARROWS: Readonly<Record<string, { readonly toJunction: string; readonly fromJunction: string }>> = {
  '-->': { toJunction: '---', fromJunction: '-->' },
  '---': { toJunction: '---', fromJunction: '---' },
  '-.->': { toJunction: '-.-', fromJunction: '-.->' },
  '-.-': { toJunction: '-.-', fromJunction: '-.-' },
  '==>': { toJunction: '===', fromJunction: '==>' },
  '===': { toJunction: '===', fromJunction: '===' },
};

const ID = '[A-Za-z0-9_][A-Za-z0-9_-]*';
const SIDE = `${ID}(?:\\s*&\\s*${ID})+`;
/** One statement on a line: `sources arrow targets`, optionally ending in `;`. */
const STATEMENT = new RegExp(`^(\\s*)(${SIDE})\\s*(-->|---|-\\.->|-\\.-|==>|===)\\s*(${SIDE})\\s*;?\\s*$`);

/** Whether the source is a flowchart, the only kind whose lines are bundled. */
export function isFlowchart(source: string): boolean {
  return /^\s*(?:%%.*\n\s*)*(?:---\n[\s\S]*?\n---\n\s*)?(?:flowchart|graph)\b/.test(source);
}

/** The flowchart with every plain many-to-many statement drawn through a junction. */
export function bundleFanOuts(source: string): string {
  if (!isFlowchart(source)) return source;
  let count = 0;
  const junctions: string[] = [];
  const lines = source.split('\n').map((line) => {
    const match = STATEMENT.exec(line);
    if (!match) return line;
    const [, indent, left, arrow, right] = match as unknown as [string, string, string, string, string];
    const sources = left.split('&').map((id) => id.trim());
    const targets = right.split('&').map((id) => id.trim());
    const kind = ARROWS[arrow]!;
    count += 1;
    const junction = `noto_junction_${count}`;
    junctions.push(junction);
    return `${indent}${sources.join(' & ')} ${kind.toJunction} ${junction} ${kind.fromJunction} ${targets.join(' & ')}`;
  });
  if (junctions.length === 0) return source;
  // A junction is a point, not a box: mermaid's small filled circle, declared
  // once at the end where it cannot change the order the note's nodes are laid
  // out in.
  for (const junction of junctions) lines.push(`    ${junction}@{ shape: sm-circ }`);
  return lines.join('\n');
}

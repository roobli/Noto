/**
 * Fenced code, as CommonMark fences it: a run of three or more backticks or
 * tildes opens a block, and only a run of the same character, at least as
 * long and with nothing after it, closes that block. Main uses it to say
 * whether a window of a note begins inside code; Quick Open's preview uses
 * it to draw the window.
 *
 * Any indent is accepted, not CommonMark's three spaces: a fence inside a list
 * item is indented further, and a preview reading it as code is right.
 */

export interface Fence {
  readonly char: '`' | '~';
  readonly length: number;
}

/** The fence `line` opens, or null. A backtick fence's info string may not hold a backtick. */
export function fenceOpens(line: string): Fence | null {
  const match = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const run = match[1]!;
  if (run[0] === '`' && match[2]!.includes('`')) return null;
  return { char: run[0] as Fence['char'], length: run.length };
}

/** Whether `line` closes `fence`. */
export function fenceCloses(line: string, fence: Fence): boolean {
  const match = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
  return match !== null && match[1]![0] === fence.char && match[1]!.length >= fence.length;
}

/** The fence still open after `lines`, or null when they end outside code. */
export function fenceAfter(lines: readonly string[]): Fence | null {
  let open: Fence | null = null;
  for (const line of lines) {
    if (open === null) open = fenceOpens(line);
    else if (fenceCloses(line, open)) open = null;
  }
  return open;
}

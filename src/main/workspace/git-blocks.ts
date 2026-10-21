/**
 * The open note's blocks against the note as last committed.
 *
 * The same read-only system git as the tree's marks (`git-marks.ts`), with
 * the same rules: `execFile`, a timeout, no optional locks, no fsmonitor, and
 * absent rather than an error whenever the answer is not cheap or not there.
 * A note outside a repository, untracked, only staged, or in a repository
 * with no commit yet has no committed version, so it has no gutter; the tree
 * already calls a new note new.
 *
 * Compared with the note as saved, not as typed. Git's own view of the note
 * is the file on disk, and the diff then runs once per save rather than once
 * per keystroke, so typing costs nothing for it.
 */

import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { parseBlocksStructural } from '../../shared/markdown/v3/roobli-md-adapter';
import { diffBlocks, type GitBlockDiffV1 } from '../../shared/git/block-diff';
import { GitRunError, type GitRunner } from './git-marks';

/**
 * Past this size, on either side, a note has no gutter. Splitting and
 * aligning a note this big costs tens of milliseconds in main, and a note of
 * a megabyte is a log or an export far more often than something read block
 * by block.
 */
export const GUTTER_MAX_BYTES = 1024 * 1024;

const SHOW_TIMEOUT_MS = 3_000;

/** The arguments for the committed blob, read-only plumbing with no filters. */
export function showArguments(name: string): string[] {
  return ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'cat-file', 'blob', `HEAD:./${name}`];
}

/**
 * The note's text at HEAD, or null when it has none.
 *
 * `HEAD:./name`, run in the note's own directory, lets git resolve the path
 * relative to where the note is, so a note in a subfolder of a repository, a
 * worktree or a path with spaces needs no prefix arithmetic here.
 */
export async function committedText(run: GitRunner, file: string): Promise<string | null> {
  let real: string;
  try {
    real = await realpath(file);
  } catch {
    return null;
  }
  try {
    const text = await run(showArguments(path.basename(real)), path.dirname(real), SHOW_TIMEOUT_MS);
    if (text.length > GUTTER_MAX_BYTES) return null;
    return text;
  } catch (error) {
    if (error instanceof GitRunError) return null;
    throw error;
  }
}

/** A note's text as the blocks the editor's top-level nodes come from. */
export function blocksOf(text: string): string[] {
  const body = text.startsWith('\uFEFF') ? text.slice(1) : text;
  return parseBlocksStructural(body.replace(/\r\n?/g, '\n')).spans.map((span) => span.markdown.replace(/\r\n?/g, '\n'));
}

/** The diff for a note, or null when it has no committed version to compare with. */
export async function gitBlockDiff(
  run: GitRunner,
  file: string,
  current: readonly string[],
  currentBytes: number,
): Promise<GitBlockDiffV1 | null> {
  if (currentBytes > GUTTER_MAX_BYTES) return null;
  const committed = await committedText(run, file);
  if (committed === null) return null;
  return diffBlocks(blocksOf(committed), current);
}

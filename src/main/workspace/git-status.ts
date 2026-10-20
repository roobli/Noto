/**
 * What `git status` says about the notes in the open folder, as data.
 *
 * Pure on purpose: no process, no filesystem. The runner in `git-marks.ts`
 * hands this the bytes `git status --porcelain=v2 -z` printed, and everything
 * that decides what a row in the tree shows is here where a unit test can
 * reach it.
 *
 * Noto shows what changed in your notes and is never a git client, so three
 * states are all there is: a note that differs from the last commit, a note
 * the last commit does not have, and a note the last commit has and the disk
 * does not. Staged or not is git's distinction, not a reader's.
 */

import type { WorkspaceGitChangeV1 } from '../../shared/workspace/v1/contracts';

/** How a note differs from the last commit. */
export type GitChangeV1 = WorkspaceGitChangeV1;

/** One path as git reported it, relative to the repository's top level. */
export interface GitStatusEntryV1 {
  /** Repository-relative, with forward slashes, exactly as git printed it. */
  readonly path: string;
  readonly change: GitChangeV1;
}

/**
 * Turn an XY pair into one of the three states, or null for "no difference
 * from HEAD a reader would see".
 *
 * X is the index against HEAD and Y the work tree against the index. A note
 * added and then deleted again before any commit (`AD`) exists in neither
 * HEAD nor on disk, so there is nothing to mark.
 */
export function changeFromXY(xy: string): GitChangeV1 | null {
  const x = xy[0] ?? '.';
  const y = xy[1] ?? '.';
  if (x === 'A' && y === 'D') return null;
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'A') return 'new';
  if (x === '.' && y === '.') return null;
  return 'modified';
}

/**
 * The fields before the path, per record kind. The path is everything after
 * the last of them and may itself contain spaces; with `-z` it is never quoted.
 */
const FIELDS_BEFORE_PATH: Readonly<Record<string, number>> = {
  // 1 XY sub mH mI mW hH hI <path>
  '1': 8,
  // 2 XY sub mH mI mW hH hI Xscore <path>\0<origPath>
  '2': 9,
  // u XY sub m1 m2 m3 mW h1 h2 h3 <path>
  u: 10,
};

/** The text after the `count`th space, which is where the path starts. */
function afterFields(record: string, count: number): string | null {
  let index = -1;
  for (let seen = 0; seen < count; seen += 1) {
    index = record.indexOf(' ', index + 1);
    if (index === -1) return null;
  }
  return record.slice(index + 1);
}

/**
 * Parse `git status --porcelain=v2 -z` output.
 *
 * A rename or copy (`2`) is two NUL-terminated fields, the new path and then
 * the old one. Reported as the note at its new path being new and the old
 * path deleted, since that is how both look against HEAD by path, and it is
 * what the gutter will find when it asks HEAD for the new path. Unmerged
 * paths read as modified. Ignored paths (`!`) and header lines (`#`) are
 * skipped. A record this does not understand is skipped rather than guessed.
 */
export function parsePorcelainV2(output: string): GitStatusEntryV1[] {
  const records = output.split('\0');
  const entries: GitStatusEntryV1[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 2) continue;
    const kind = record[0];
    if (kind === '?') {
      entries.push({ path: record.slice(2), change: 'new' });
      continue;
    }
    const fields = FIELDS_BEFORE_PATH[kind];
    if (fields === undefined || record[1] !== ' ') continue;
    const xy = record.slice(2, 4);
    const filePath = afterFields(record, fields);
    if (kind === '2') {
      // The original path is the next record, whatever happens to this one.
      const original = records[index + 1];
      index += 1;
      if (filePath === null || original === undefined) continue;
      if (xy[1] !== 'D') entries.push({ path: filePath, change: 'new' });
      // A copy (`C`) leaves the original where it was.
      if (xy[0] === 'R') entries.push({ path: original, change: 'deleted' });
      continue;
    }
    if (filePath === null) continue;
    const change = kind === 'u' ? 'modified' : changeFromXY(xy);
    if (change !== null) entries.push({ path: filePath, change });
  }
  return entries;
}

/**
 * The open folder's place inside its repository, as a pathspec.
 *
 * `prefix` is what `git rev-parse --show-prefix` prints from the folder: the
 * folder relative to the top level with a trailing slash, or empty when the
 * folder is the top level. `:(top,literal)` makes the pathspec relative to
 * the top level whatever the working directory, and stops a folder called
 * `[draft]` or `*` from being read as a glob.
 */
export function vaultPathspec(prefix: string): string {
  const trimmed = prefix.replace(/\/+$/, '');
  return trimmed === '' ? ':(top)' : `:(top,literal)${trimmed}`;
}

/**
 * Entries under the open folder, with paths relative to it.
 *
 * The pathspec already limits git to the folder; this is the second half,
 * turning repository-relative paths into folder-relative ones, and the check
 * that nothing outside the prefix slips through. `keep` decides which files
 * count, which for the tree is the ones Noto edits.
 */
export function scopeToVault(
  entries: readonly GitStatusEntryV1[],
  prefix: string,
  keep: (relativePath: string) => boolean,
): GitStatusEntryV1[] {
  const base = prefix === '' || prefix.endsWith('/') ? prefix : `${prefix}/`;
  const scoped: GitStatusEntryV1[] = [];
  for (const entry of entries) {
    if (!entry.path.startsWith(base)) continue;
    const relative = entry.path.slice(base.length);
    // A directory record, which `-uall` should never print, or the folder itself.
    if (relative === '' || relative.endsWith('/')) continue;
    if (!keep(relative)) continue;
    scoped.push({ path: relative, change: entry.change });
  }
  return scoped;
}

/** What the tree draws: a state per note, and the folders holding changes. */
export interface GitMarksV1 {
  /** Folder-relative note path to its state. Deleted notes are here too. */
  readonly files: ReadonlyMap<string, GitChangeV1>;
  /** Folder-relative directories that hold a change somewhere below them. */
  readonly folders: ReadonlySet<string>;
}

/**
 * Marks for the tree from folder-relative entries.
 *
 * A deleted note has no row to mark, since the tree lists the disk. Its
 * folders still say something inside changed, which is where a reader looking
 * for it will look. The open folder itself is not marked: in a repository
 * with any change at all it always would be, which says nothing.
 */
export function marksFrom(entries: readonly GitStatusEntryV1[]): GitMarksV1 {
  const files = new Map<string, GitChangeV1>();
  const folders = new Set<string>();
  for (const entry of entries) {
    // A path reported twice (a rename's old path that is also untracked
    // again, say) keeps the state that exists on disk.
    const known = files.get(entry.path);
    if (known === undefined || known === 'deleted') files.set(entry.path, entry.change);
    for (let slash = entry.path.indexOf('/'); slash !== -1; slash = entry.path.indexOf('/', slash + 1)) {
      folders.add(entry.path.slice(0, slash));
    }
  }
  return { files, folders };
}

/**
 * Which note a `[[wiki link]]` means.
 *
 * The author's own vault pipeline resolves a target against the folder the
 * note lives in first, then against the vault's root, and only then falls
 * back to matching the file's name anywhere. This had only the last two, so
 * `[[lab网络规划/00_索引]]` written in `E_works/acme/00_索引.md`
 * matched nothing: it is neither a path from the root nor a bare name, and
 * the folder it is relative to was never consulted.
 *
 * Pure, over the index the renderer already holds, so the rules can be
 * tested against the shapes the vault actually contains.
 */

export interface WikiCandidate {
  readonly path: string;
  readonly relativePath: string;
  readonly name: string;
}

/** A `/`-joined path with `.` and `..` resolved, and no leading slash. */
export function normalisePath(value: string): string {
  const parts: string[] = [];
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') { parts.pop(); continue; }
    parts.push(segment);
  }
  return parts.join('/');
}

const withoutExtension = (value: string): string => value.replace(/\.(?:md|markdown)$/i, '');

/** The comparable form of a path: no extension, no case, forward slashes. */
const key = (value: string): string => withoutExtension(normalisePath(value.replace(/\\/g, '/'))).toLowerCase();

/**
 * The notes a target could mean, best first.
 *
 * The order is the vault pipeline's: the folder the link was written in,
 * then the vault's root, then the name alone. Within the last, a note in the
 * same folder as the link comes before one further away, which is what makes
 * `[[00_索引]]` mean this folder's index rather than one of the eleven others.
 */
export function wikiCandidates(
  target: string,
  fromRelativePath: string | null,
  entries: readonly WikiCandidate[],
): WikiCandidate[] {
  const wanted = target.split('#')[0].trim();
  if (wanted.length === 0) return [];

  const fromDirectory = fromRelativePath === null
    ? ''
    : normalisePath(fromRelativePath.replace(/\\/g, '/')).split('/').slice(0, -1).join('/');

  const byKey = new Map<string, WikiCandidate[]>();
  const byName = new Map<string, WikiCandidate[]>();
  for (const entry of entries) {
    const path = key(entry.relativePath);
    const name = key(entry.name);
    (byKey.get(path) ?? byKey.set(path, []).get(path)!).push(entry);
    (byName.get(name) ?? byName.set(name, []).get(name)!).push(entry);
  }

  const beside = key(`${fromDirectory}/${wanted}`);
  const fromRoot = key(wanted);
  const found: WikiCandidate[] = [];
  const seen = new Set<string>();
  const take = (list: readonly WikiCandidate[] | undefined) => {
    for (const entry of list ?? []) {
      if (seen.has(entry.path)) continue;
      seen.add(entry.path);
      found.push(entry);
    }
  };

  take(byKey.get(beside));
  take(byKey.get(fromRoot));
  // The name alone, nearest first: a note in the folder the link was written
  // in, then one in a folder above it, then the rest.
  const named = [...(byName.get(fromRoot) ?? [])].sort((left, right) =>
    closeness(right.relativePath, fromDirectory) - closeness(left.relativePath, fromDirectory));
  take(named);
  return found;
}

/** How many leading folders two paths share, which is how near they are. */
function closeness(relativePath: string, fromDirectory: string): number {
  const here = fromDirectory.length === 0 ? [] : fromDirectory.toLowerCase().split('/');
  const there = normalisePath(relativePath).toLowerCase().split('/').slice(0, -1);
  let shared = 0;
  while (shared < here.length && shared < there.length && here[shared] === there[shared]) shared += 1;
  // A note in exactly this folder beats one that merely shares a prefix.
  return shared * 2 + (here.length === there.length && shared === here.length ? 1 : 0);
}

/**
 * Path of `target` relative to `baseDir`, both vault-relative with forward
 * slashes. Matches note-assistant `relPathFromDir` for the shapes this vault
 * writes into related blocks and MOC indexes.
 */
export function relPathFromDir(targetRelativePath: string, baseDir: string): string {
  const target = normalisePath(targetRelativePath.replace(/\\/g, '/')).split('/').filter((part) => part.length > 0);
  const base = normalisePath(baseDir.replace(/\\/g, '/')).split('/').filter((part) => part.length > 0);
  let shared = 0;
  while (shared < target.length && shared < base.length && target[shared] === base[shared]) shared += 1;
  const up = base.slice(shared).map(() => '..');
  const down = target.slice(shared);
  return [...up, ...down].join('/') || '.';
}

/**
 * The wiki-link target for a note, as apply-graph and hand-written MOCs write
 * it: relative to the folder of `fromRelativePath`, with no `.md` suffix.
 *
 * `fromRelativePath` is the note being edited (a file path); the folder it
 * lives in is what the target is relative to.
 */
export function wikiTargetFor(targetRelativePath: string, fromRelativePath: string): string {
  const fromDirectory = normalisePath(fromRelativePath.replace(/\\/g, '/')).split('/').slice(0, -1).join('/');
  return withoutExtension(relPathFromDir(targetRelativePath.replace(/\\/g, '/'), fromDirectory));
}

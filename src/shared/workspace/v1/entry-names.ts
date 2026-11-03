/**
 * What a file or folder in the tree may be called, and what a copy is called.
 *
 * Pure, and shared, because the renderer checks a name as it is typed so the
 * refusal is a disabled button rather than an error after the fact, and main
 * checks the same name again because the renderer's check is a convenience and
 * never a guarantee.
 *
 * The rules are the intersection of what the three platforms accept, not what
 * this one does. A note named `con.md` is unopenable on Windows and a name with
 * a backslash in it is a path there, and a vault is a folder people sync
 * between machines.
 */

/** The longest a single name may be. macOS and Linux stop at 255 bytes. */
export const MAX_ENTRY_NAME = 200;

/* Reserved on Windows, whatever extension follows them. */
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** Control characters, and the ones Windows forbids in a name outright. */
const FORBIDDEN = /[\u0000-\u001f\u007f<>:"|?*]/;

/**
 * Whether `name` is one segment that names a file or folder.
 *
 * Counted in characters rather than bytes, deliberately conservative: a
 * Chinese name is three bytes a character and 1,578 of the vault's notes have
 * non-ASCII names, so a byte bound would refuse names people already use.
 */
export function isEntryName(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > MAX_ENTRY_NAME) return false;
  if (name !== name.trim()) return false;
  if (name === '.' || name === '..') return false;
  // A separator would make this a path, and a path is the one thing the
  // renderer is never allowed to send.
  if (/[/\\]/.test(name)) return false;
  if (FORBIDDEN.test(name)) return false;
  // A trailing dot or space is silently dropped by Windows, so a file saved
  // under one comes back under a different name.
  if (name.endsWith('.') || name.endsWith(' ')) return false;
  const stem = name.split('.')[0].toLowerCase();
  if (RESERVED.has(stem)) return false;
  return true;
}

/** The extension including its dot, or an empty string. Never a leading dot. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot);
}

/** The name without its extension. A dotfile is all stem. */
export function stemOf(name: string): string {
  const extension = extensionOf(name);
  return extension === '' ? name : name.slice(0, name.length - extension.length);
}

/**
 * What a copy of `name` is called, given the names already there.
 *
 * `note.md` becomes `note (copy).md`, and a second copy is `note (copy) 2.md`
 * rather than `note (copy) (copy).md`, which is what Typora produces and which
 * is unreadable by the third copy.
 */
export function duplicateName(name: string, taken: ReadonlySet<string>): string {
  const extension = extensionOf(name);
  const stem = stemOf(name);
  const first = `${stem} (copy)${extension}`;
  if (!taken.has(first)) return first;
  for (let index = 2; index < 1_000; index += 1) {
    const candidate = `${stem} (copy) ${index}${extension}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem} (copy) ${taken.size + 1}${extension}`;
}

/**
 * The name a rename should actually use.
 *
 * A note renamed to something without an extension Noto opens keeps the one
 * it had. The tree lists only the extensions it can open and `openPath`
 * refuses the rest, so a note renamed to `ideas`, or to `Meeting 3.5` (whose
 * "extension" is `.5`), would vanish from the tree and could not be opened
 * again: the reader would have lost it without deleting anything. `opens`
 * says whether an extension, with its dot and lower-cased, is one Noto opens.
 */
export function renamedFileName(typed: string, current: string, opens: (extension: string) => boolean): string {
  const typedExtension = extensionOf(typed).toLowerCase();
  const extension = extensionOf(current);
  if (typedExtension !== '' && (opens(typedExtension) || typedExtension === extension.toLowerCase())) return typed;
  return extension === '' ? typed : `${typed}${extension}`;
}

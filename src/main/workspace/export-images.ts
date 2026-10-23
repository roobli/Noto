/**
 * Which pictures a Pandoc export may carry.
 *
 * Pandoc reads every picture a document names, from anywhere the process can
 * read, and writes it into the docx, odt or epub it produces. So a note shared
 * by somebody else, with `![](/Users/me/.ssh/id_ed25519.png)` or
 * `![](../../../private.png)` in it, would quietly put that file inside an export
 * the reader then sends on. Exporting is not a reason to read anything the
 * editor itself would refuse to show.
 *
 * Two things together close that. Pandoc runs with `--sandbox`, so its readers
 * and writers read nothing but the document they are handed. And before that,
 * every picture the note names is judged here by the same containment the
 * asset protocol uses (`resolveAssetPath` over the session's image roots): one
 * that is allowed is written into the document as data, which is the only form
 * a sandboxed Pandoc can still embed, and one that is not is listed, and the
 * export is refused with the list rather than carried out with holes in it.
 *
 * A web picture is never fetched. With remote images off it is refused like a
 * file outside the folder; with them on it is left as the address it is, which
 * the formats that can hold a link keep and the others replace with its text.
 * A picture inside the folder that does not exist is left as written: Pandoc
 * cannot read it either way, and the export shows the same gap the note shows.
 *
 * Raw HTML `<img>` is not rewritten. The sandbox is what keeps Pandoc from
 * reading the file it names, which is the same answer for every reference this
 * does not see.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasImageExtension } from '../../shared/assets/v1/contracts';
import { isInside } from './file-tree';
import { fileFor, mediaTypeFor, MAX_INLINE_BYTES, MAX_INLINE_TOTAL } from './inline-images';

export interface ImagePolicyDeps {
  /** The folder the note lives in, which relative addresses are relative to. */
  readonly noteDirectory: string;
  /** The session's image roots: the open folder and the note's own folder. */
  readonly roots: readonly string[];
  /** The reader's remote-images setting, read in main. */
  readonly remoteImages: boolean;
  /** The asset protocol's guard: the real path to read, or null when refused. */
  readonly resolve: (absolute: string) => Promise<string | null>;
  /** Whether anything is at a path, without following it. */
  readonly exists: (absolute: string) => Promise<boolean>;
  readonly read: (absolute: string) => Promise<Uint8Array>;
}

export type ImageRefusal = 'outside-folder' | 'remote' | 'unsupported' | 'too-large';

export type ImageVerdict =
  | { readonly kind: 'inline'; readonly data: string; readonly bytes: number }
  | { readonly kind: 'keep' }
  | { readonly kind: 'refuse'; readonly why: ImageRefusal };

export interface RefusedImage {
  readonly source: string;
  readonly why: ImageRefusal;
}

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/** A path that names another machine, which nothing here should ever open. */
const isNetworkPath = (value: string): boolean => /^[\\/]{2}/.test(value);

/** The file a `file:` URL names on this machine, or null when it names another. */
function fileUrlPath(source: string): string | null {
  try {
    return fileURLToPath(source);
  } catch {
    return null;
  }
}

/** Decide what one picture reference becomes in the export. */
export async function judgeImage(source: string, deps: ImagePolicyDeps): Promise<ImageVerdict> {
  const trimmed = source.trim();
  if (trimmed.length === 0) return { kind: 'keep' };

  let absolute: string | null;
  const scheme = SCHEME.exec(trimmed)?.[1].toLowerCase();
  if (scheme === 'data') return { kind: 'keep' };
  if (scheme === 'http' || scheme === 'https') {
    return deps.remoteImages ? { kind: 'keep' } : { kind: 'refuse', why: 'remote' };
  }
  if (scheme === 'file') {
    absolute = fileUrlPath(trimmed);
    if (absolute === null) return { kind: 'refuse', why: 'outside-folder' };
  } else if (/^[a-z]:[\\/]/i.test(trimmed)) {
    // A Windows drive path, which looks like a one-letter scheme.
    absolute = trimmed;
  } else {
    if (isNetworkPath(trimmed)) return { kind: 'refuse', why: 'outside-folder' };
    // `fileFor` understands the asset URL the editor writes and decodes a
    // relative path; any other scheme comes back null.
    absolute = fileFor(trimmed, deps.noteDirectory);
    if (absolute === null) return { kind: 'refuse', why: 'unsupported' };
  }

  if (/[\0\r\n]/.test(absolute) || isNetworkPath(absolute)) return { kind: 'refuse', why: 'outside-folder' };
  const lexical = path.resolve(absolute);
  // Decided on the name first, so a reference that is plainly elsewhere is
  // refused without this process ever touching the path it names.
  if (!deps.roots.some((root) => isInside(path.resolve(root), lexical))) {
    return { kind: 'refuse', why: 'outside-folder' };
  }
  if (!hasImageExtension(lexical)) return { kind: 'refuse', why: 'unsupported' };

  const real = await deps.resolve(lexical);
  if (real === null) {
    // Nothing there is a broken picture, as it is in the note. Something there
    // that the guard refused is a link out of the folder.
    return (await deps.exists(lexical)) ? { kind: 'refuse', why: 'outside-folder' } : { kind: 'keep' };
  }
  const media = mediaTypeFor(real);
  if (media === null) return { kind: 'refuse', why: 'unsupported' };

  let bytes: Uint8Array;
  try {
    bytes = await deps.read(real);
  } catch {
    return { kind: 'keep' };
  }
  if (bytes.byteLength > MAX_INLINE_BYTES) return { kind: 'refuse', why: 'too-large' };
  return {
    kind: 'inline',
    data: `data:${media};base64,${Buffer.from(bytes).toString('base64')}`,
    bytes: bytes.byteLength,
  };
}

type Target = [string, string];

/** Every picture target in a Pandoc JSON document, wherever it is nested. */
function imageTargets(node: unknown, found: Target[] = []): Target[] {
  if (Array.isArray(node)) {
    for (const child of node) imageTargets(child, found);
    return found;
  }
  if (node === null || typeof node !== 'object') return found;
  const record = node as { t?: unknown; c?: unknown };
  if (record.t === 'Image' && Array.isArray(record.c)) {
    const target = record.c[2];
    if (Array.isArray(target) && typeof target[0] === 'string') found.push(target as Target);
  }
  for (const value of Object.values(record)) imageTargets(value, found);
  return found;
}

/**
 * Judge every picture in a Pandoc JSON document, in place.
 *
 * Allowed pictures are rewritten to data; the refused ones are returned, each
 * once, in the order they appear. An empty list means the document is safe to
 * hand to Pandoc.
 */
export async function vetDocumentImages(document: unknown, deps: ImagePolicyDeps): Promise<RefusedImage[]> {
  const verdicts = new Map<string, ImageVerdict>();
  const refused: RefusedImage[] = [];
  let total = 0;
  for (const target of imageTargets(document)) {
    const source = target[0];
    let verdict = verdicts.get(source);
    if (verdict === undefined) {
      verdict = await judgeImage(source, deps);
      if (verdict.kind === 'inline') {
        if (total + verdict.bytes > MAX_INLINE_TOTAL) verdict = { kind: 'refuse', why: 'too-large' };
        else total += verdict.bytes;
      }
      verdicts.set(source, verdict);
      if (verdict.kind === 'refuse') refused.push({ source, why: verdict.why });
    }
    if (verdict.kind === 'inline') target[0] = verdict.data;
  }
  return refused;
}

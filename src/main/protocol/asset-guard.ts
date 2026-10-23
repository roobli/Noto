/**
 * Which files the renderer may have as images.
 *
 * The renderer names a path; this decides whether main serves it. The rule is
 * the same containment the file tree already enforces: the file must be inside
 * one of the roots the session trusts, after every symbolic link in the path
 * has been followed. A link inside the folder that points outside it is a way
 * out of the folder, so the real path is what is checked, never the one asked
 * for. And it must look like an image by its name: the app serves pictures,
 * and there is no reason for it to hand the renderer anything else.
 *
 * The order matters as much as the rule. A path is first judged by how it is
 * spelled, and only one that already reads as inside a root is handed to the
 * filesystem, then judged again by where it really leads.
 */

import path from 'node:path';
import { hasImageExtension } from '../../shared/assets/v1/contracts';
import { isInside } from '../workspace/file-tree';

export interface AssetGuardOptions {
  /** Folders the session trusts. Empty means nothing is served. */
  readonly roots: readonly string[];
  /** Follows links; rejects when the file does not exist. */
  readonly realpath: (target: string) => Promise<string>;
}

/** The real path to serve, or null when the request is refused for any reason. */
export async function resolveAssetPath(
  requested: string,
  options: AssetGuardOptions,
): Promise<string | null> {
  if (requested.length === 0 || requested.length > 4096 || /[\0\r\n]/.test(requested)) return null;
  // A UNC or device path (`\\host\share`, `//host/share`, `\\?\`, `\\.\`)
  // names another machine or a raw device. Resolving one on Windows opens a
  // network session that offers the user's credentials before any check could
  // refuse it, so it is refused by its spelling alone.
  if (/^[\\/]{2}/.test(requested)) return null;
  if (!path.isAbsolute(requested)) return null;

  const asked = path.resolve(requested);
  const roots: { readonly spelled: string; readonly real: string }[] = [];
  for (const root of options.roots) {
    const spelled = path.resolve(root);
    try {
      roots.push({ spelled, real: await options.realpath(spelled) });
    } catch {
      // A root that no longer exists trusts nothing.
    }
  }

  // The filesystem is asked about a path only once its spelling already puts
  // it inside a root, so a refused request reveals nothing about what exists
  // outside one.
  if (!roots.some((root) => isInside(root.spelled, asked) || isInside(root.real, asked))) return null;

  let real: string;
  try {
    real = await options.realpath(asked);
  } catch {
    return null;
  }
  if (!hasImageExtension(real)) return null;
  // The spelling is not the file: a link inside a root may lead out of it.
  return roots.some((root) => isInside(root.real, real)) ? real : null;
}

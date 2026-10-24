/**
 * Reading a file the asset guard has already allowed.
 *
 * `resolveAssetPath` judges a path and answers with the real one, and the read
 * happens afterwards. Between the two, anything that can write inside the
 * folder (a sync client, another process) can replace one of the folders on
 * that path with a link to somewhere else, and a read by name would then follow
 * it out of the folder the guard just checked.
 *
 * So the file is opened first and judged afterwards, and only through the open
 * handle is it read. The last component is opened without following a link.
 * Once it is open, the path must still be its own real path, and the file at
 * that path must be the very file that was opened, by device and inode. A
 * folder swapped before the open makes the path lead somewhere else; one
 * swapped and put back makes the file there a different file from the one in
 * hand. Either way nothing is read.
 *
 * This narrows the window to the checks that follow the open rather than
 * closing it: Node has no `openat`, so a path is always walked by name, and a
 * writer that flips a link between two of those calls can still win the race.
 * What it cannot do any more is have a read follow a link it put there after
 * the guard had looked.
 */

import { constants } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';

/** The filesystem calls this makes, so a test can move things between them. */
export interface AssetFs {
  readonly open: (target: string, flags: number) => Promise<FileHandle>;
  readonly realpath: (target: string) => Promise<string>;
  readonly stat: (target: string) => Promise<{ readonly dev: bigint; readonly ino: bigint }>;
}

export const nodeAssetFs: AssetFs = {
  open: (target, flags) => open(target, flags),
  realpath: (target) => realpath(target),
  stat: (target) => stat(target, { bigint: true }),
};

/* Not following a link is POSIX; Windows has no such flag and gets 0. Not
   blocking matters for a FIFO named like a picture, which would otherwise hold
   the open until something wrote to it; it changes nothing for a plain file. */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/**
 * The open file at a real path the guard returned, or null when it is not
 * there or is no longer the file the path names. The caller closes it.
 */
export async function openResolvedAsset(real: string, fs: AssetFs = nodeAssetFs): Promise<FileHandle | null> {
  let handle: FileHandle;
  try {
    handle = await fs.open(real, OPEN_FLAGS);
  } catch {
    return null;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) throw new Error('not a file');
    if (await fs.realpath(real) !== real) throw new Error('path moved');
    const named = await fs.stat(real);
    if (named.dev !== opened.dev || named.ino !== opened.ino) throw new Error('file swapped');
    return handle;
  } catch {
    await handle.close().catch(() => {});
    return null;
  }
}

/** Every byte of a file the guard allowed, read through the handle. Rejects when refused. */
export async function readResolvedAsset(real: string, fs: AssetFs = nodeAssetFs): Promise<Uint8Array> {
  const handle = await openResolvedAsset(real, fs);
  if (handle === null) throw new Error('ASSET_UNREADABLE');
  try {
    return await handle.readFile();
  } finally {
    await handle.close().catch(() => {});
  }
}

import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  lstat,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import type {
  AcceptedFileIdentityV1,
  FileFingerprintV1,
  FileObjectIdentityV1,
} from '../../../shared/file-truth/v1/contracts';
import { currentCapabilities, type PlatformCapabilities } from './platform-capabilities';

/**
 * Points inside a save or recovery where a test can force a failure.
 *
 * Lives with the platform rather than in the IPC contract: it names internal
 * filesystem steps, and nothing outside this process should be able to ask for
 * one. The renderer has no channel that reaches it.
 */
export type FileTruthFailurePointV1 =
  | 'before-temp-write'
  | 'after-write'
  | 'after-flush'
  | 'before-replacement'
  | 'after-replacement-before-journal-completion'
  | 'directory-flush'
  | 'metadata'
  | 'replacement'
  | 'readback'
  | 'journal-write'
  | 'payload-write'
  | 'cleanup'
  | 'temp-close'
  | 'journal-read'
  | 'durable-write'
  | 'durable-sync'
  | 'durable-rename'
  | 'durable-remove'
  | 'before-replace-validation';

export class InjectedFileTruthFailure extends Error {
  constructor(readonly point: FileTruthFailurePointV1) {
    super(`INJECTED_FILE_TRUTH_FAILURE:${point}`);
  }
}

export class FileTruthPlatformOperationError extends Error {
  constructor(message: string, readonly residuePaths: readonly string[], readonly primary: unknown, readonly cleanup: unknown = null) {
    super(message);
  }
}

export class FileTruthFailureInjector {
  private readonly points = new Set<FileTruthFailurePointV1>();
  arm(point: FileTruthFailurePointV1): void { this.points.add(point); }
  clear(): void { this.points.clear(); }
  hit(point: FileTruthFailurePointV1): void {
    if (!this.points.delete(point)) return;
    throw new InjectedFileTruthFailure(point);
  }
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/**
 * Derive the filesystem object identity from a stat result.
 *
 * Unix gives device plus inode. Windows gives volume serial plus file index
 * through the same two fields, and both are meaningful on NTFS. Some filesystems
 * report zero for the inode, which is not an identity at all, so those fall back
 * to the canonical path and say so rather than producing a value that looks
 * authoritative and is not.
 */
export function objectIdentity(dev: bigint, ino: bigint, canonicalPath: string): FileObjectIdentityV1 {
  if (ino === 0n) {
    return { scheme: 'noto-file-object-v1', basis: 'path', opaqueId: sha256(Buffer.from(canonicalPath)) };
  }
  return { scheme: 'noto-file-object-v1', basis: 'inode', opaqueId: sha256(Buffer.from(`${dev}:${ino}`)) };
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
    if (result.bytesWritten <= 0) throw new Error('WRITE_ZERO_PROGRESS');
    offset += result.bytesWritten;
  }
}

export interface CapturedFileV1 {
  readonly identity: AcceptedFileIdentityV1;
  readonly bytes: Uint8Array;
}

export type ExpectedReplaceResultV1 =
  | { readonly status: 'replaced' }
  | { readonly status: 'conflict'; readonly current: FileFingerprintV1 | null };

/**
 * Errors a hard link raises when the volume cannot make one at all, as opposed
 * to refusing this particular link. FAT and exFAT, and some network shares,
 * answer with one of these.
 */
const LINK_UNSUPPORTED = new Set(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EINVAL', 'EXDEV']);

/**
 * The filesystem side of file truth, for every platform Noto ships on.
 *
 * The algorithm is shared; the three places platforms genuinely differ are
 * described by `PlatformCapabilities` and branched on explicitly, so a weaker
 * guarantee is visible in the code rather than implied by a class name.
 */
export class NodeFileTruthPlatform {
  constructor(
    readonly injector = new FileTruthFailureInjector(),
    readonly capabilities: PlatformCapabilities = currentCapabilities(),
  ) {}

  async canonicalPath(filePath: string): Promise<string> {
    const absolute = path.resolve(filePath);
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('UNSUPPORTED_FILE_TYPE');
    return realpath(absolute);
  }

  async capture(filePath: string): Promise<CapturedFileV1> {
    const canonicalPath = await this.canonicalPath(filePath);
    const handle = await open(canonicalPath, 'r');
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) throw new Error('UNSUPPORTED_FILE_TYPE');
      const bytes = Uint8Array.from(await handle.readFile());
      const after = await handle.stat({ bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
        throw new Error('CAPTURE_CHANGED_DURING_READ');
      }
      return {
        bytes,
        identity: {
          version: 1,
          canonicalPath,
          posixMode: Number(before.mode & 0o7777n),
          fingerprint: {
            version: 1,
            object: objectIdentity(before.dev, before.ino, canonicalPath),
            byteLength: Number(before.size),
            mtimeNanoseconds: before.mtimeNs.toString(),
            contentSha256: sha256(bytes),
          },
        },
      };
    } finally {
      await handle.close();
    }
  }

  async fingerprint(filePath: string): Promise<FileFingerprintV1 | null> {
    try { return (await this.capture(filePath)).identity.fingerprint; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  sameFingerprint(left: FileFingerprintV1 | null, right: FileFingerprintV1 | null): boolean {
    return left !== null && right !== null
      && left.object.opaqueId === right.object.opaqueId
      && left.byteLength === right.byteLength
      && left.mtimeNanoseconds === right.mtimeNanoseconds
      && left.contentSha256 === right.contentSha256;
  }

  tempPathFor(originalPath: string, attemptId: string): string {
    const safe = attemptId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48) || randomBytes(12).toString('hex');
    return path.join(path.dirname(originalPath), `.noto-ft1-${safe}.tmp`);
  }

  async createExclusiveTemp(tempPath: string): Promise<FileHandle> {
    return open(tempPath, 'wx', 0o600);
  }

  async writeTemp(handle: FileHandle, bytes: Uint8Array): Promise<void> {
    this.injector.hit('before-temp-write');
    await writeAll(handle, bytes);
    this.injector.hit('after-write');
  }

  async flush(handle: FileHandle): Promise<void> {
    await handle.sync();
    this.injector.hit('after-flush');
  }

  /**
   * Restore the original permissions on the replacement file.
   *
   * Where the platform preserves POSIX modes this is verified, and a mismatch
   * fails the save rather than quietly changing a file's permissions. Where it
   * does not, `chmod` still runs so the read-only attribute is carried over,
   * but the exact-bits check is skipped because it could never pass.
   */
  async applyAndVerifyMode(handle: FileHandle, mode: number): Promise<void> {
    this.injector.hit('metadata');
    await handle.chmod(mode);
    if (this.capabilities.preservesPosixMode) {
      const actual = Number((await handle.stat({ bigint: true })).mode & 0o7777n);
      if (actual !== mode) throw new Error(`MODE_VERIFY_FAILED:${actual.toString(8)}`);
    }
    await handle.sync();
  }

  async replace(tempPath: string, originalPath: string): Promise<void> {
    this.injector.hit('before-replacement');
    this.injector.hit('replacement');
    await rename(tempPath, originalPath);
  }

  /** A hard link, as its own step so a test can stand in for a volume without them. */
  async hardLink(existingPath: string, newPath: string): Promise<void> {
    await link(existingPath, newPath);
  }

  /**
   * Publish the temp at a path that was missing, and only while it still is.
   *
   * A recreate decides the path is missing, then spends several fsyncs making
   * its candidate durable. A rename at the end would replace whatever arrived
   * in between: git switching back, a sync client restoring the file, another
   * editor. A hard link cannot replace anything; it fails with EEXIST instead,
   * which is reported as a conflict and leaves the arrival untouched. The temp
   * name is dropped once the link exists, so the published file is the only
   * name for that inode, as it would be after a rename.
   *
   * Without hard links (FAT, exFAT, some network shares) the path is
   * fingerprinted immediately before a rename. That narrows the window to the
   * gap between those two calls but does not close it; a file created in that
   * gap is still replaced. No portable primitive closes it there.
   */
  async publishIfAbsent(tempPath: string, destinationPath: string): Promise<ExpectedReplaceResultV1> {
    this.injector.hit('before-replacement');
    this.injector.hit('replacement');
    if (this.capabilities.canHardLink) {
      try {
        await this.hardLink(tempPath, destinationPath);
        // Dropping the temp name is cleanup, not publication. If it fails the
        // caller's cleanup removes the temp and reports any residue.
        await rm(tempPath, { force: true }).catch(() => undefined);
        return { status: 'replaced' };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') return { status: 'conflict', current: await this.fingerprintIfReadable(destinationPath) };
        if (!code || !LINK_UNSUPPORTED.has(code)) throw error;
      }
    }
    if (await this.existsAtAll(destinationPath)) {
      return { status: 'conflict', current: await this.fingerprintIfReadable(destinationPath) };
    }
    await rename(tempPath, destinationPath);
    return { status: 'replaced' };
  }

  /** The fingerprint of whatever is at the path, or null when it cannot be read as a note. */
  private async fingerprintIfReadable(filePath: string): Promise<FileFingerprintV1 | null> {
    try { return await this.fingerprint(filePath); } catch { return null; }
  }

  /** Whether anything at all, a symlink or a directory included, occupies the path. */
  private async existsAtAll(filePath: string): Promise<boolean> {
    try { await lstat(filePath); return true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async validateExpectedAndReplace(tempPath: string, originalPath: string, expected: FileFingerprintV1, beforeReplace?: () => void): Promise<ExpectedReplaceResultV1> {
    this.injector.hit('before-replace-validation');
    const current = await this.fingerprint(originalPath);
    if (!this.sameFingerprint(expected, current)) return { status: 'conflict', current };
    beforeReplace?.();
    await this.replace(tempPath, originalPath);
    return { status: 'replaced' };
  }

  async publishExclusive(tempPath: string, destinationPath: string, expected: Uint8Array,
    expectedMode: number): Promise<AcceptedFileIdentityV1> {
    let published = false;
    try {
      this.injector.hit('before-replacement');
      this.injector.hit('replacement');
      await link(tempPath, destinationPath);
      published = true;
      await this.syncDirectory(path.dirname(destinationPath));
      const accepted = await this.verifyReadback(destinationPath, expected, expectedMode);
      await rm(tempPath);
      await this.syncDirectoryRaw(path.dirname(destinationPath));
      return accepted;
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      try { await rm(tempPath, { force: true }); } catch (cleanup) { cleanupErrors.push(cleanup); }
      try { await this.syncDirectoryRaw(path.dirname(destinationPath)); } catch (cleanup) { cleanupErrors.push(cleanup); }
      const residues: string[] = [];
      for (const candidate of [tempPath, ...(published ? [destinationPath] : [])]) {
        try { if (await this.exists(candidate)) residues.push(candidate); }
        catch (cleanup) { cleanupErrors.push(cleanup); residues.push(candidate); }
      }
      throw new FileTruthPlatformOperationError(
        `COPY_PUBLISH_FAILED:${error instanceof Error ? error.message : 'unknown'}${cleanupErrors.length ? `; cleanup:${cleanupErrors.map((item) => item instanceof Error ? item.message : 'unknown').join('|')}` : ''}`,
        residues,
        error,
        cleanupErrors.length ? new AggregateError(cleanupErrors, 'COPY_PUBLISH_CLEANUP_FAILED') : null,
      );
    }
  }

  async closeHandle(handle: FileHandle): Promise<void> {
    await handle.close();
    this.injector.hit('temp-close');
  }

  async syncDirectory(directory: string): Promise<void> {
    this.injector.hit('directory-flush');
    await this.syncDirectoryRaw(directory);
  }

  private async syncDirectoryRaw(directory: string): Promise<void> {
    // Windows cannot open a directory as a file. Its rename is atomic and the
    // filesystem journals the metadata, so there is nothing to flush by hand.
    if (!this.capabilities.canSyncDirectory) return;
    const handle = await open(directory, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }

  async verifyReadback(filePath: string, expected: Uint8Array, expectedMode: number): Promise<AcceptedFileIdentityV1> {
    this.injector.hit('readback');
    const captured = await this.capture(filePath);
    if (captured.bytes.byteLength !== expected.byteLength || sha256(captured.bytes) !== sha256(expected)) {
      throw new Error('READBACK_BYTES_MISMATCH');
    }
    // Only assert the mode where the platform actually round trips it.
    if (this.capabilities.preservesPosixMode && captured.identity.posixMode !== expectedMode) {
      throw new Error('READBACK_MODE_MISMATCH');
    }
    return captured.identity;
  }

  async writeDurableFile(filePath: string, bytes: Uint8Array, mode = 0o600): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temp = `${filePath}.tmp-${randomBytes(8).toString('hex')}`;
    let handle: FileHandle | null = null;
    let primary: unknown = null;
    try {
      handle = await open(temp, 'wx', mode);
      this.injector.hit('durable-write');
      await writeAll(handle, bytes);
      this.injector.hit('durable-sync');
      await handle.sync();
      await handle.chmod(mode);
      await handle.sync();
    } catch (error) {
      primary = error;
    }
    if (handle) {
      try { await handle.close(); }
      catch (error) { primary ??= error; }
    }
    if (!primary) {
      try {
        this.injector.hit('durable-rename');
        await rename(temp, filePath);
        await this.syncDirectoryRaw(path.dirname(filePath));
        return;
      } catch (error) {
        primary = error;
      }
    }
    let cleanup: unknown = null;
    try { this.injector.hit('durable-remove'); await rm(temp, { force: true }); }
    catch (error) { cleanup = error; }
    let residue: string[];
    try { residue = await this.exists(temp) ? [temp] : []; }
    catch (error) {
      cleanup = cleanup ? new AggregateError([cleanup, error], 'DURABLE_CLEANUP_AND_RESIDUE_CHECK_FAILED') : error;
      residue = [temp];
    }
    throw new FileTruthPlatformOperationError(
      `DURABLE_FILE_FAILED:${primary instanceof Error ? primary.message : 'unknown'}${cleanup ? `; cleanup:${cleanup instanceof Error ? cleanup.message : 'unknown'}` : ''}`,
      residue,
      primary,
      cleanup,
    );
  }

  async readBytes(filePath: string, injectJournalRead = false): Promise<Uint8Array> {
    if (injectJournalRead) this.injector.hit('journal-read');
    return Uint8Array.from(await readFile(filePath));
  }
  async remove(filePath: string): Promise<void> { this.injector.hit('cleanup'); await rm(filePath, { force: true }); }
  async removeWithoutInjection(filePath: string): Promise<void> { await rm(filePath, { force: true }); }
  async exists(filePath: string): Promise<boolean> {
    try { await this.statPath(filePath); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }

  protected async statPath(filePath: string) { return stat(filePath); }

  async listOwnedTemps(originalPath: string): Promise<string[]> {
    const directory = path.dirname(originalPath);
    return (await readdir(directory)).filter((name) => /^\.noto-ft1-[A-Za-z0-9_-]+\.tmp$/.test(name))
      .map((name) => path.join(directory, name));
  }

  async listDurableInternalTemps(directory: string): Promise<string[]> {
    return (await readdir(directory)).filter((name) => /\.(?:journal\.json|payload)\.tmp-[a-f0-9]+$/.test(name))
      .map((name) => path.join(directory, name));
  }

  async listRecoveryArtifacts(directory: string, pathKey: string): Promise<string[]> {
    if (!await this.exists(directory)) return [];
    return (await readdir(directory))
      .filter((name) => name === `${pathKey}.journal.json`
        || (name.startsWith(`${pathKey}.`) && name.endsWith('.payload')))
      .map((name) => path.join(directory, name));
  }

  async replaceExternally(filePath: string, bytes: Uint8Array): Promise<void> {
    const current = await stat(filePath);
    const external = path.join(path.dirname(filePath), `.external-${randomBytes(8).toString('hex')}.tmp`);
    await writeFile(external, bytes, { mode: current.mode & 0o7777 });
    await rename(external, filePath);
  }
}

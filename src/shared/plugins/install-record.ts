import { hasExactKeys, isRecord } from '../ipc/validate';

/**
 * What Noto keeps beside a plugin the reader installed: where it came from,
 * the digest of the code it installed, and how far the reader trusts it.
 *
 * Kept in `.noto/record.json` inside the plugin's folder. A folder dropped
 * into the plugins folder by hand has no record and runs sandboxed. Full
 * trust is granted to one digest of the code: change the code, by an update
 * or by hand, and the plugin is sandboxed again until it is trusted anew.
 */
export const INSTALL_RECORD_SCHEMA_VERSION = 1 as const;

export type PluginTrust = 'sandboxed' | 'full';

export type InstallSourceV1 =
  | { readonly kind: 'folder'; readonly path: string }
  | { readonly kind: 'github'; readonly owner: string; readonly repo: string; readonly ref: string; readonly path: string }
  | { readonly kind: 'marketplace'; readonly owner: string; readonly repo: string; readonly ref: string; readonly path: string; readonly index: string };

export interface InstallRecordV1 {
  readonly schemaVersion: typeof INSTALL_RECORD_SCHEMA_VERSION;
  readonly id: string;
  readonly version: string;
  readonly source: InstallSourceV1;
  /** sha256 of `main.js` as installed, lowercase hex. */
  readonly mainDigest: string;
  readonly installedAt: string;
  readonly trust: PluginTrust;
  /** The digest full trust was granted to, or null. */
  readonly trustedDigest: string | null;
}

const DIGEST = /^[0-9a-f]{64}$/;
const GITHUB_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;
const REF = /^[A-Za-z0-9._/-]{1,200}$/;
const REPO_PATH = /^(?:[A-Za-z0-9._-]{1,100}(?:\/[A-Za-z0-9._-]{1,100}){0,9})?$/;

export function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

/** A repo path segment list with no climbing out, as a GitHub source names it. */
export function isRepoPath(value: unknown): value is string {
  return typeof value === 'string' && REPO_PATH.test(value) && !value.split('/').some((part) => part === '.' || part === '..');
}

export function isGithubName(value: unknown): value is string {
  return typeof value === 'string' && GITHUB_NAME.test(value) && !value.endsWith('.git');
}

export function isGitRef(value: unknown): value is string {
  return typeof value === 'string' && REF.test(value) && !value.includes('..') && !value.startsWith('/') && !value.endsWith('/');
}

function isSource(value: unknown): value is InstallSourceV1 {
  if (!isRecord(value)) return false;
  if (value.kind === 'folder') {
    return hasExactKeys(value, ['kind', 'path']) && typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 4096;
  }
  const remote = isGithubName(value.owner) && isGithubName(value.repo) && isGitRef(value.ref) && isRepoPath(value.path);
  if (value.kind === 'github') return hasExactKeys(value, ['kind', 'owner', 'repo', 'ref', 'path']) && remote;
  if (value.kind === 'marketplace') {
    return hasExactKeys(value, ['kind', 'owner', 'repo', 'ref', 'path', 'index']) && remote
      && typeof value.index === 'string' && value.index.length > 0 && value.index.length <= 201;
  }
  return false;
}

export function isInstallRecordV1(value: unknown): value is InstallRecordV1 {
  return isRecord(value)
    && hasExactKeys(value, ['schemaVersion', 'id', 'version', 'source', 'mainDigest', 'installedAt', 'trust', 'trustedDigest'])
    && value.schemaVersion === INSTALL_RECORD_SCHEMA_VERSION
    && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 128
    && typeof value.version === 'string' && value.version.length > 0 && value.version.length <= 256
    && isSource(value.source)
    && isDigest(value.mainDigest)
    && typeof value.installedAt === 'string' && value.installedAt.length <= 40
    && (value.trust === 'sandboxed' || value.trust === 'full')
    && (value.trustedDigest === null || isDigest(value.trustedDigest));
}

/** How far a plugin is trusted right now: fully only while its code is the code that was trusted. */
export function effectiveTrust(record: InstallRecordV1 | null, mainDigest: string): PluginTrust {
  return record !== null && record.trust === 'full' && record.trustedDigest === mainDigest ? 'full' : 'sandboxed';
}

/** Where a plugin came from, in the few words Plugin Center shows. */
export function describeSource(source: InstallSourceV1 | null): string {
  if (source === null) return 'Plugins folder';
  if (source.kind === 'folder') return 'Folder';
  if (source.kind === 'github') return `GitHub · ${source.owner}/${source.repo}`;
  return `Marketplace · ${source.owner}/${source.repo}`;
}

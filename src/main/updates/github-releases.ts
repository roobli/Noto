/**
 * Channel-aware look at GitHub Releases for Noto.
 *
 * Stable skips every prerelease. Testing takes the newest non-draft release,
 * prerelease or not, so an explicit tester still receives a later stable cut.
 */

import semver from 'semver';
import { UPDATE_GITHUB, type UpdateChannelV1 } from '../../shared/updates/v1/contracts';

export interface GithubReleaseAsset {
  readonly name: string;
  readonly browser_download_url: string;
  readonly size: number;
}

export interface GithubReleaseSummary {
  readonly tag: string;
  readonly version: string;
  readonly prerelease: boolean;
  readonly htmlUrl: string;
  readonly publishedAt: string;
  readonly assets: readonly GithubReleaseAsset[];
}

interface RawRelease {
  readonly tag_name?: unknown;
  readonly prerelease?: unknown;
  readonly draft?: unknown;
  readonly html_url?: unknown;
  readonly published_at?: unknown;
  readonly assets?: unknown;
}

function versionFromTag(tag: string): string | null {
  const trimmed = tag.trim();
  const body = trimmed.startsWith('v') || trimmed.startsWith('V') ? trimmed.slice(1) : trimmed;
  return semver.valid(body) ? body : null;
}

function parseRelease(raw: RawRelease): GithubReleaseSummary | null {
  if (raw.draft === true) return null;
  if (typeof raw.tag_name !== 'string' || typeof raw.html_url !== 'string') return null;
  const version = versionFromTag(raw.tag_name);
  if (!version) return null;
  const assets: GithubReleaseAsset[] = [];
  if (Array.isArray(raw.assets)) {
    for (const entry of raw.assets) {
      if (!entry || typeof entry !== 'object') continue;
      const asset = entry as Record<string, unknown>;
      if (typeof asset.name !== 'string' || typeof asset.browser_download_url !== 'string') continue;
      assets.push({
        name: asset.name,
        browser_download_url: asset.browser_download_url,
        size: typeof asset.size === 'number' ? asset.size : 0,
      });
    }
  }
  return {
    tag: raw.tag_name,
    version,
    prerelease: raw.prerelease === true,
    htmlUrl: raw.html_url,
    publishedAt: typeof raw.published_at === 'string' ? raw.published_at : '',
    assets,
  };
}

/**
 * Newest release that belongs on `channel`, or null when the channel is empty.
 *
 * GitHub returns newest first. We still compare with semver so a mis-ordered
 * page cannot hand an older build to someone already past it.
 */
export async function latestReleaseForChannel(
  channel: UpdateChannelV1,
  currentVersion: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GithubReleaseSummary | null> {
  const url = `https://api.github.com/repos/${UPDATE_GITHUB.owner}/${UPDATE_GITHUB.repo}/releases?per_page=40`;
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Noto-Updater',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub releases returned ${response.status}.`);
  }
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) throw new Error('GitHub releases payload was not a list.');

  let best: GithubReleaseSummary | null = null;
  for (const entry of payload) {
    if (!entry || typeof entry !== 'object') continue;
    const release = parseRelease(entry as RawRelease);
    if (!release) continue;
    if (channel === 'stable' && release.prerelease) continue;
    if (!best || semver.rcompare(release.version, best.version) < 0) {
      best = release;
    }
  }
  if (!best) return null;
  const current = semver.valid(currentVersion);
  if (current && !semver.gt(best.version, current)) return null;
  return best;
}

/** Pick a download for this OS from release assets, when auto-install cannot run. */
export function preferredAssetUrl(
  release: GithubReleaseSummary,
  platform: NodeJS.Platform,
  arch: string,
): string | null {
  const names = release.assets.map((asset) => asset.name.toLowerCase());
  const pick = (...predicates: ((name: string) => boolean)[]): string | null => {
    for (const predicate of predicates) {
      const index = names.findIndex(predicate);
      if (index >= 0) return release.assets[index].browser_download_url;
    }
    return null;
  };

  if (platform === 'darwin') {
    const arm = arch === 'arm64';
    return pick(
      (name) => name.includes('macos') && name.endsWith('.zip') && (arm ? name.includes('arm64') : name.includes('x64')),
      (name) => name.includes('darwin') && name.endsWith('.zip') && (arm ? name.includes('arm64') : name.includes('x64')),
      (name) => name.endsWith('.zip') && name.includes('mac'),
    );
  }
  if (platform === 'win32') {
    return pick(
      (name) => name.startsWith('notosetup') && name.endsWith('.exe'),
      (name) => name.endsWith('.exe') && !name.includes('unblock'),
    );
  }
  // Linux: prefer deb on Debian-like guesses; rpm otherwise. Fallback either.
  return pick(
    (name) => name.endsWith('.deb'),
    (name) => name.endsWith('.rpm'),
  );
}

import { describe, expect, it, vi } from 'vitest';
import { latestReleaseForChannel, preferredAssetUrl } from '../../src/main/updates/github-releases';

function release(partial: {
  tag_name: string;
  prerelease?: boolean;
  draft?: boolean;
  html_url?: string;
  assets?: { name: string; browser_download_url: string; size?: number }[];
}) {
  return {
    draft: false,
    prerelease: false,
    html_url: `https://github.com/roobli/Noto/releases/tag/${partial.tag_name}`,
    published_at: '2026-09-14T00:00:00Z',
    assets: [],
    ...partial,
  };
}

describe('update channels against GitHub Releases', () => {
  it('Stable ignores prereleases even when they are newer', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => [
        release({ tag_name: 'v0.0.2-alpha.18', prerelease: true }),
        release({ tag_name: 'v0.0.1', prerelease: false }),
      ],
    })) as unknown as typeof fetch;

    const found = await latestReleaseForChannel('stable', '0.0.1', fetchImpl);
    expect(found).toBeNull();
  });

  it('Stable offers a newer formal release', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => [
        release({ tag_name: 'v0.0.2-alpha.18', prerelease: true }),
        release({ tag_name: 'v0.1.0', prerelease: false }),
      ],
    })) as unknown as typeof fetch;

    const found = await latestReleaseForChannel('stable', '0.0.1', fetchImpl);
    expect(found?.version).toBe('0.1.0');
  });

  it('Testing includes alphas and picks the newest semver', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => [
        release({ tag_name: 'v0.0.2-alpha.17', prerelease: true }),
        release({ tag_name: 'v0.0.2-alpha.18', prerelease: true }),
        release({ tag_name: 'v0.0.1', prerelease: false }),
      ],
    })) as unknown as typeof fetch;

    const found = await latestReleaseForChannel('testing', '0.0.2-alpha.17', fetchImpl);
    expect(found?.version).toBe('0.0.2-alpha.18');
  });

  it('returns null when already on the newest matching build', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => [
        release({ tag_name: 'v0.0.2-alpha.18', prerelease: true }),
      ],
    })) as unknown as typeof fetch;

    expect(await latestReleaseForChannel('testing', '0.0.2-alpha.18', fetchImpl)).toBeNull();
  });

  it('prefers the matching macOS zip for the host arch', () => {
    const summary = {
      tag: 'v0.0.2-alpha.18',
      version: '0.0.2-alpha.18',
      prerelease: true,
      htmlUrl: 'https://example.test',
      publishedAt: '',
      assets: [
        {
          name: 'Noto-0.0.2-alpha.18-macos-x64.zip',
          browser_download_url: 'https://example.test/x64',
          size: 1,
        },
        {
          name: 'Noto-0.0.2-alpha.18-macos-arm64.zip',
          browser_download_url: 'https://example.test/arm64',
          size: 1,
        },
      ],
    } as const;
    expect(preferredAssetUrl(summary, 'darwin', 'arm64')).toBe('https://example.test/arm64');
    expect(preferredAssetUrl(summary, 'darwin', 'x64')).toBe('https://example.test/x64');
  });
});

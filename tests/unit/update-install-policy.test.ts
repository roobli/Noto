import { describe, expect, it } from 'vitest';
import { canAutoInstall, SIGNED_BUILD_AUTO_INSTALL } from '../../src/main/updates/install-policy';

describe('update install policy', () => {
  it('ships with auto-install disabled until builds are signed', () => {
    expect(SIGNED_BUILD_AUTO_INSTALL).toBe(false);
  });

  it('never auto-installs an unsigned build on any platform', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(canAutoInstall({ packaged: true, platform, signedBuild: false })).toBe(false);
    }
  });

  it('a signed packaged macOS/Windows build may auto-install', () => {
    expect(canAutoInstall({ packaged: true, platform: 'darwin', signedBuild: true })).toBe(true);
    expect(canAutoInstall({ packaged: true, platform: 'win32', signedBuild: true })).toBe(true);
  });

  it('signed Linux or unpackaged runs still open the release page', () => {
    expect(canAutoInstall({ packaged: true, platform: 'linux', signedBuild: true })).toBe(false);
    expect(canAutoInstall({ packaged: false, platform: 'darwin', signedBuild: true })).toBe(false);
  });
});

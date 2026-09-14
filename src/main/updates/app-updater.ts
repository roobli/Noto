/**
 * Quiet GitHub Releases updater.
 *
 * electron-updater handles download and swap on packaged macOS and Windows once
 * the release feed files are attached (see docs/architecture/updates.md). Linux
 * packages and unpackaged runs check the same channel but open the release page
 * rather than trying to replace the running binary.
 */

import { app, shell, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { StructuredLogger } from '../logger';
import type { UpdateChannelV1, UpdatePhaseV1, UpdateStatusV1 } from '../../shared/updates/v1/contracts';
import { NOTO_UPDATES_VERSION, UPDATE_CHANNELS, UPDATE_GITHUB } from '../../shared/updates/v1/contracts';
import { latestReleaseForChannel, preferredAssetUrl, type GithubReleaseSummary } from './github-releases';

export interface AppUpdaterOptions {
  readonly getWindow: () => BrowserWindow | null;
  readonly logger: StructuredLogger;
  readonly getChannel: () => UpdateChannelV1;
  readonly getAutoDownload: () => boolean;
}

export class AppUpdater {
  private phase: UpdatePhaseV1 = 'idle';
  private available: GithubReleaseSummary | null = null;
  private problem = '';
  private configured = false;

  constructor(private readonly options: AppUpdaterOptions) {}

  status(): UpdateStatusV1 {
    return this.snapshot();
  }

  /**
   * Apply channel / auto-download from settings without checking the network.
   * A channel change clears a stale "available" that belonged to the other track.
   */
  applyPreferences(): void {
    this.ensureConfigured();
    autoUpdater.allowPrerelease = this.options.getChannel() === 'testing';
    autoUpdater.autoDownload = false;
    this.available = null;
    if (this.phase === 'available' || this.phase === 'up-to-date' || this.phase === 'downloaded') {
      this.phase = 'idle';
      this.problem = '';
      this.publish();
    }
  }

  async check(reason: 'manual' | 'launch'): Promise<UpdateStatusV1> {
    this.ensureConfigured();
    this.phase = 'checking';
    this.problem = '';
    this.publish();

    try {
      const channel = this.options.getChannel();
      const found = await latestReleaseForChannel(channel, app.getVersion());
      if (!found) {
        this.available = null;
        this.phase = 'up-to-date';
        this.publish();
        return this.snapshot();
      }

      this.available = found;
      this.phase = 'available';
      this.options.logger.log('update_available', {
        reason,
        channel,
        version: found.version,
        prerelease: found.prerelease,
      });
      this.publish();

      if (reason === 'launch' && this.options.getAutoDownload() && this.canAutoInstall()) {
        await this.download();
      }
      return this.snapshot();
    } catch (error) {
      this.phase = 'error';
      this.problem = error instanceof Error ? error.message.slice(0, 512) : 'Update check failed.';
      this.options.logger.log('update_check_failed', { reason, problem: this.problem });
      this.publish();
      return this.snapshot();
    }
  }

  async download(): Promise<UpdateStatusV1> {
    this.ensureConfigured();
    if (!this.available) {
      this.phase = 'error';
      this.problem = 'Nothing to download. Check for updates first.';
      this.publish();
      return this.snapshot();
    }

    if (!this.canAutoInstall()) {
      return this.openRelease();
    }

    this.phase = 'downloading';
    this.problem = '';
    this.publish();

    try {
      autoUpdater.allowPrerelease = this.options.getChannel() === 'testing';
      autoUpdater.autoDownload = false;
      const result = await autoUpdater.checkForUpdates();
      const remote = result?.updateInfo?.version;
      if (!remote || remote !== this.available.version) {
        // Feed missing or channel mismatch — fall back to the release page.
        this.options.logger.log('update_feed_mismatch', {
          expected: this.available.version,
          feed: remote ?? '',
        });
        return this.openRelease();
      }
      await autoUpdater.downloadUpdate();
      this.phase = 'downloaded';
      this.publish();
      return this.snapshot();
    } catch (error) {
      this.options.logger.log('update_download_failed', {
        problem: error instanceof Error ? error.message.slice(0, 256) : 'download failed',
      });
      return this.openRelease();
    }
  }

  async install(): Promise<UpdateStatusV1> {
    if (!this.canAutoInstall()) {
      return this.openRelease();
    }
    if (this.phase !== 'downloaded') {
      const downloaded = await this.download();
      if (downloaded.phase !== 'downloaded') return downloaded;
    }
    // Returns after the process begins quitting; callers should not expect more work.
    setImmediate(() => {
      try {
        autoUpdater.quitAndInstall(false, true);
      } catch (error) {
        this.phase = 'error';
        this.problem = error instanceof Error ? error.message.slice(0, 512) : 'Install failed.';
        this.publish();
      }
    });
    return this.snapshot();
  }

  async openRelease(): Promise<UpdateStatusV1> {
    const release = this.available;
    const url = release
      ? (preferredAssetUrl(release, process.platform, process.arch) ?? release.htmlUrl)
      : `https://github.com/${UPDATE_GITHUB.owner}/${UPDATE_GITHUB.repo}/releases`;
    await shell.openExternal(url);
    // Keep "available" so the pane still says what was found; opening is not failure.
    if (this.phase === 'downloading' || this.phase === 'error') {
      this.phase = this.available ? 'available' : 'idle';
      this.problem = '';
    }
    this.publish();
    return this.snapshot();
  }

  private canAutoInstall(): boolean {
    return app.isPackaged && (process.platform === 'darwin' || process.platform === 'win32');
  }

  private ensureConfigured(): void {
    if (this.configured) return;
    this.configured = true;
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: UPDATE_GITHUB.owner,
      repo: UPDATE_GITHUB.repo,
    });
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = this.options.getChannel() === 'testing';
    // Silence electron-updater's own dialogs; Settings owns the chrome.
    autoUpdater.logger = null;
  }

  private snapshot(): UpdateStatusV1 {
    const channel = this.options.getChannel();
    return {
      version: NOTO_UPDATES_VERSION,
      phase: this.phase,
      currentVersion: app.getVersion(),
      channel,
      availableVersion: this.available?.version ?? null,
      releaseUrl: this.available?.htmlUrl ?? null,
      problem: this.problem,
      canAutoInstall: this.canAutoInstall(),
      packaged: app.isPackaged,
    };
  }

  private publish(): void {
    const window = this.options.getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send(UPDATE_CHANNELS.changed, this.snapshot());
  }
}

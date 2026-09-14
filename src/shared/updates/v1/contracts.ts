/**
 * Application updates from GitHub Releases.
 *
 * Two channels, chosen deliberately:
 * - `stable` — only non-prerelease GitHub releases (the day-to-day track).
 * - `testing` — includes prereleases such as `v0.0.2-alpha.x` (opt-in).
 *
 * Default is stable. Alphas are never pushed at a reader who did not ask.
 * Checks are quiet: Settings shows status; nothing toasts on every launch.
 */

export const NOTO_UPDATES_VERSION = 1 as const;

export const UPDATE_CHANNELS = {
  status: 'noto:v1:updates:status',
  check: 'noto:v1:updates:check',
  download: 'noto:v1:updates:download',
  install: 'noto:v1:updates:install',
  openRelease: 'noto:v1:updates:open-release',
  changed: 'noto:v1:updates:changed',
} as const;

/** Where new builds are published. Hard-coded so a renamed package homepage cannot point the updater elsewhere. */
export const UPDATE_GITHUB = Object.freeze({
  owner: 'roobli',
  repo: 'Noto',
});

export const UPDATE_CHANNEL_VALUES = ['stable', 'testing'] as const;

export type UpdateChannelV1 = (typeof UPDATE_CHANNEL_VALUES)[number];

/**
 * What the updater is doing, for the Settings pane.
 *
 * Idle states stay idle: a launch check that finds nothing does not invent a
 * status line worth reading. `available` / `downloaded` are the only times the
 * pane asks for attention, and then only once.
 */
export type UpdatePhaseV1 =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'unsupported';

export interface UpdateStatusV1 {
  readonly version: typeof NOTO_UPDATES_VERSION;
  readonly phase: UpdatePhaseV1;
  /** Currently running app version (`package.json`). */
  readonly currentVersion: string;
  readonly channel: UpdateChannelV1;
  /** Newest matching release on the chosen channel, if any. */
  readonly availableVersion: string | null;
  readonly releaseUrl: string | null;
  /** Empty unless phase is `error`. */
  readonly problem: string;
  /**
   * Whether this process can download and swap itself (packaged macOS / Windows
   * with a feed). Linux packages open the release page instead.
   */
  readonly canAutoInstall: boolean;
  readonly packaged: boolean;
}

export interface UpdateRequestV1 {
  readonly version: typeof NOTO_UPDATES_VERSION;
  readonly requestId: string;
}

export type UpdateResultV1<T> =
  | { readonly ok: true; readonly requestId: string; readonly value: T }
  | {
      readonly ok: false;
      readonly requestId: string;
      readonly error: { readonly code: string; readonly message: string };
    };

export interface NotoUpdatesApiV1 {
  status(request: UpdateRequestV1): Promise<UpdateResultV1<UpdateStatusV1>>;
  check(request: UpdateRequestV1): Promise<UpdateResultV1<UpdateStatusV1>>;
  download(request: UpdateRequestV1): Promise<UpdateResultV1<UpdateStatusV1>>;
  install(request: UpdateRequestV1): Promise<UpdateResultV1<UpdateStatusV1>>;
  openRelease(request: UpdateRequestV1): Promise<UpdateResultV1<UpdateStatusV1>>;
  onChanged(listener: (event: UpdateStatusV1) => void): () => void;
}

# Application updates

Noto checks [GitHub Releases](https://github.com/roobli/Noto/releases) for newer
builds. There is no separate update server and no private token in the shipped
app: the repository is public, and `electron-updater` reads the same assets the
release workflow attaches.

## Channels

| Channel | What it follows | Default |
| ------- | --------------- | ------- |
| **Stable** | Non-prerelease GitHub releases only | Yes |
| **Testing** | Prereleases (for example `v0.0.2-alpha.x`) and later Stable cuts | Opt-in |

Day-to-day users stay on Stable. Alphas are never offered until Testing is
chosen in **Settings → Updates**. An alpha build itself will not see newer
alphas while Stable is selected — that is intentional.

## Behaviour

- **Check on launch** (off by default): quiet. When nothing is new, nothing is
  shown. Status lives in Settings.
- **Download automatically** (off by default): when a check finds a build on the
  chosen channel, fetch it without a prompt. Install still waits for Restart
  (or quit).
- **Check now** / Help → **Check for Updates…**: same check, status in Settings.
- No toast wall, no modal on every launch.

## Platforms

| Platform | Auto download / install | Fallback |
| -------- | ----------------------- | -------- |
| macOS (packaged zip) | `electron-updater` via `latest-mac.yml` | Open the release zip |
| Windows (Squirrel) | `RELEASES` + `.nupkg`, plus `latest.yml` | Open `NotoSetup.exe` |
| Linux (deb / rpm) | Check only | Open the matching package from the release |

Unpackaged (dev) builds can check the channel; they do not replace themselves.

## How a release feeds the updater

`.github/workflows/release.yml` attaches, per platform build:

1. The usual installers (`*.zip`, `NotoSetup.exe`, `*.deb`, `*.rpm`).
2. Squirrel feed files (`RELEASES`, `*.nupkg`) on Windows.
3. `latest-mac.yml` / `latest.yml` from `scripts/write-update-metadata.mjs`.

No `GH_TOKEN` is required inside the app for public releases. CI uses
`secrets.GITHUB_TOKEN` only to upload artifacts to the tag's release.

Publish discovery for `electron-updater` also lists `build.publish` in
`package.json` (`provider: github`, `owner: roobli`, `repo: Noto`).

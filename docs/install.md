# Install and first open

Download builds from the
[releases page](https://github.com/roobli/Noto/releases). The current release
is `v0.0.3` (17 October 2026), the first outside alpha. Alphas between
releases are labelled.

`v0.0.3` is unsigned on purpose: on macOS it is ad-hoc signed and not
notarized, and on Windows the installer is not code-signed. Until Noto is
signed with an Apple Developer ID and notarized (and an equivalent Windows
certificate), each OS will warn once the first time you open a download. That
is expected. Follow the steps below so the first launch is smooth.

## macOS

Mac builds come as a zip; there is no `.dmg`.

1. Download `Noto-<version>-macos-arm64.zip` (Apple silicon) or
   `Noto-<version>-macos-x64.zip` (Intel).
2. Unzip. You should get `Noto.app` (move it to `/Applications` if you like).
3. **First open.** Double-click `Noto.app` once. macOS says it cannot check
   Noto for malicious software; click **Done**. Then open
   **System Settings → Privacy & Security**, scroll down to **Security**, and
   click **Open Anyway** next to the message about Noto. It is there for about
   an hour after you tried to open the app. Confirm in the dialog that follows
   and enter your login password. From then on Noto opens with a double-click.

   Or in Terminal, from the folder that contains `Noto.app`:

   ```sh
   xattr -cr Noto.app && open Noto.app
   ```

   On macOS 14 Sonoma and older you can also Right-click (or Control-click)
   `Noto.app`, choose **Open**, then confirm **Open**. From macOS 15 Sequoia on
   that shortcut is gone; use **Open Anyway** or the Terminal line.

### What the dialogs mean

| Dialog | What to do |
| --- | --- |
| **"Noto" Not Opened** / **Apple could not verify "Noto" is free of malware** / **unidentified developer** | Try to open Noto once, then **System Settings → Privacy & Security → Open Anyway** and enter your login password. Or run the `xattr` line above. On macOS 14 and older, Right-click → **Open** also works. After that, double-click works. |
| **"Noto" is damaged and can't be opened** | Re-download the zip from the current release (avoid an old cached copy). Builds from #66 onward are ad-hoc re-signed so this should not appear. If it still does, run `xattr -cr Noto.app` and open it again. |

True notarization (no Gatekeeper prompt) needs an Apple Developer identity on
the release machine. See `docs/architecture/signing-review.md`.

## Windows

1. Download `NotoSetup-<version>.exe`.
2. Run the installer. If SmartScreen says **Windows protected your PC**, click
   **More info**, then **Run anyway**.
3. Finish the installer and launch Noto from the Start menu.

## Linux

- **Debian / Ubuntu:** `sudo apt install ./noto_<version>_amd64.deb`
- **Fedora / openSUSE:** `sudo rpm -i noto-<version>-1.x86_64.rpm`

No code signing is required on typical Linux desktops for these packages.

## In-app updates

Packaged builds can check GitHub Releases from **Settings → Updates**:

- **Stable** (default) — formal releases only
- **Testing** — includes prerelease alphas

Check-on-launch is off by default. Until builds are signed, Noto does not
install an update itself on any platform: a found update opens its download on
the release page, and you install it as above. That holds from the first
release after `v0.0.3` (#329), which also hides the setting to download
automatically. Details: `docs/architecture/updates.md`.

## Blurb for GitHub Releases

While builds are unsigned, the release workflow appends this block to the
release body when the changelog section has no first-open steps of its own:

```markdown
## First open (macOS / Windows)

Builds are not signed or Apple-notarized yet. **That is expected** — not a broken download.

**macOS:** unzip and double-click `Noto.app` once, then System Settings → Privacy & Security → Open Anyway. Or:

`xattr -cr Noto.app && open Noto.app`

On macOS 14 and older, Right-click → Open also works.

Full steps: https://github.com/roobli/Noto/blob/main/docs/install.md

**Windows:** SmartScreen → More info → Run anyway.
```

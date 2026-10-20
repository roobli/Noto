# Releasing Noto

How a build becomes something people install. The decisions behind this are
D1 to D4 in the [decision log](https://roobli.github.io/Noto.docs/direction/decisions).

## Three tracks

| Track | What it is | How often | Who receives it |
| --- | --- | --- | --- |
| CI build | Every merge to `main`, kept as workflow artifacts | Every merge | Nobody automatically |
| Alpha, `0.0.2-alpha.N` | A change a reader would notice and should test | At most weekly | Settings → Updates → Testing |
| Release, `0.0.3` and on | The current horizon's gate is met | Per milestone | Stable and Testing |

A build is not a release. No release exists only to bump a number, and in
particular none exists only to raise the nesting cap.

## Cutting an alpha

1. Move the `Unreleased` entries in [CHANGELOG.md](CHANGELOG.md) under the new
   version, written for the person updating rather than as an engine log.
2. Open a pull request that bumps `version` in `package.json` and carries that
   changelog edit. Merge it when CI is green.
3. Tag the merge commit `vX.Y.Z-alpha.N` and push the tag.
4. The release workflow creates the GitHub release from the tag. A version
   with a prerelease component is flagged prerelease and never Latest; nobody
   sets that flag by hand. It then builds and attaches the installers and the
   update metadata on every platform: on macOS one zip for Apple silicon and
   one for Intel, both listed in a single `latest-mac.yml` so each Mac's
   updater takes its own. The benchmark workflow runs on the same tag and
   reports open, keystroke, post-type idle lag and save for the packaged build.
5. The workflow writes the release body from that version's changelog
   section, with relative links pointed at the files as of the tag. While
   builds are unsigned it appends the first-open blurb from
   [docs/install.md](docs/install.md#blurb-for-github-releases) when the
   section has no first-open steps of its own. Nobody edits the body by hand.
6. If the set of downloads changed, update the table in the README. The docs
   site's download page follows the release on its own.

`release-integrity.yml` re-checks every release's flag whenever one is
published or edited, so a mistake made in the GitHub UI is corrected, not
shipped to Stable.

## Leaving alpha: `0.0.3`

D2 originally named the first release outside alpha `0.1.0` and gated it on
notarized macOS builds. On 17 October 2026 the release owner amended it: the
first full release is **`0.0.3`, and it ships unsigned**. Signing is deferred
to a later release, not dropped.

What "unsigned" means for `0.0.3`:

- **macOS:** ad-hoc signed after packaging, as every alpha has been, and not
  notarized. The first open needs **Privacy & Security → Open Anyway** on
  macOS 15 and later, Right-click → Open on macOS 14 and older, or
  `xattr -cr Noto.app`, as written in [docs/install.md](docs/install.md).
- **Windows:** the installer is not code-signed; SmartScreen asks once, and
  *More info → Run anyway* proceeds.
- Linux packages are unaffected.

The release workflow states this rather than doing it silently: with
`UNSIGNED_FULL_RELEASE_ALLOWED: 'true'` in `.github/workflows/release.yml`, a
full tag without the signing secrets publishes to Stable with a warning in the
run and the first-open steps on the release page. Set it to `'false'` once the
credentials exist, so a missing secret fails a full release instead.

Gate for `0.0.3`:

- [x] `@roobli/md` is the default engine (`v0.0.2-alpha.112`).
- [x] The Stable channel offers only full releases.
- [x] Intel Macs have a stated position: every release now builds an Intel
      zip beside the Apple silicon one.
- [x] Open, keystroke and save are measured on a packaged build with the
      current engine, by the benchmark workflow on every tag, and the README
      shows them (29 September 2026).
- [x] Unsigned builds are stated on the release page with first-open steps.

Deferred to the first signed release:

- [ ] macOS builds are signed with a Developer ID, notarized, stapled, and
      launch from quarantine on a clean machine with no warning.
- [ ] Windows builds are code-signed.
- [ ] In-app install is turned back on (`SIGNED_BUILD_AUTO_INSTALL` in
      `src/main/updates/install-policy.ts`, #329) once both of the above hold.
- [ ] The comparison with Typora is repeated with the current engine, on a
      Mac that has Typora installed.

## Cutting a release

As for an alpha, with a plain version (`0.0.3`) in `package.json`, the
changelog heading and the tag `v0.0.3`. The workflow writes the release body
from that changelog section (plus the first-open steps while unsigned),
flags it a full release, and `release-integrity.yml` marks it Latest, which
is what Stable reads.

## Signing, when the credentials exist

Signing is read from the environment, so the same workflow produces unsigned
and signed builds; with no secrets set, every signing step is skipped and the
macOS app is ad-hoc signed. Set these as repository secrets:

| Secret | Used for |
| --- | --- |
| `APPLE_CERTIFICATE_P12` | The Developer ID Application certificate and key, exported as `.p12` and base64-encoded |
| `APPLE_CERTIFICATE_PASSWORD` | The password of that `.p12` |
| `NOTO_APPLE_SIGNING_IDENTITY` | The identity name, for example `Developer ID Application: Name (TEAMID)` |
| `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | Notarization with an App Store Connect API key (preferred) |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Notarization with an Apple ID and app-specific password (fallback) |
| `WINDOWS_CERTIFICATE_FILE`, `WINDOWS_CERTIFICATE_PASSWORD` | Windows signing |

The release workflow imports the certificate into a throwaway keychain, writes
the API key to a file for `notarytool`, signs and notarizes both macOS
architectures, then checks each app the way Gatekeeper will: `codesign
--verify --deep --strict`, `spctl --assess`, and `stapler validate`. A signed
build that fails any of the three fails the release.

After the first notarized build passes, remove the entitlements the signing
review questions, one per build, re-running those checks and a launch from
quarantine each time.

What the build asks macOS for, and which entitlements should be removed once a
notarized build can be tested, is in
[docs/architecture/signing-review.md](docs/architecture/signing-review.md).

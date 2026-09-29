# Releasing Noto

How a build becomes something people install. The decisions behind this are
D1 to D4 in the [decision log](https://roobli.github.io/Noto.docs/direction/decisions).

## Three tracks

| Track | What it is | How often | Who receives it |
| --- | --- | --- | --- |
| CI build | Every merge to `main`, kept as workflow artifacts | Every merge | Nobody automatically |
| Alpha, `0.0.2-alpha.N` | A change a reader would notice and should test | At most weekly | Settings → Updates → Testing |
| Release, `0.1.0` and on | The current horizon's gate is met | Per milestone | Stable and Testing |

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
   reports open, keystroke and save for the packaged build.
5. Edit the release body: the changelog entry, then the first-open blurb from
   [docs/install.md](docs/install.md#blurb-for-github-releases), which stays
   until builds are notarized and signed.
6. If the set of downloads changed, update the table in the README. The docs
   site's download page follows the release on its own.

`release-integrity.yml` re-checks every release's flag whenever one is
published or edited, so a mistake made in the GitHub UI is corrected, not
shipped to Stable.

## Leaving alpha: `0.1.0`

Per D2, `0.1.0` ships only when all of these hold, and the release owner signs
off; whoever cuts the tag does not decide it.

- [x] `@roobli/md` is the default engine (`v0.0.2-alpha.112`).
- [x] The Stable channel offers only full releases.
- [x] Intel Macs have a stated position: every release now builds an Intel
      zip beside the Apple silicon one.
- [ ] macOS builds are signed with a Developer ID, notarized, stapled, and
      launch from quarantine on a clean machine with no warning.
- [x] Open, keystroke and save are measured on a packaged build with the
      current engine, by the benchmark workflow on every tag, and the README
      shows them (29 September 2026).
- [ ] The comparison with Typora is repeated with the current engine, on a
      Mac that has Typora installed.

Windows signing and the rest of the roadmap's *Now* horizon may follow in the
release after.

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

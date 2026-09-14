# Signing and hardening review

What the release build asks the operating system for, and one entitlement that
is probably broader than it needs to be.

## What is verified

The release build's Electron fuses are read back from the packaged app and are
hardened as intended:

| fuse                                 | state    |
| ------------------------------------ | -------- |
| `RunAsNode`                          | disabled |
| `EnableNodeOptionsEnvironmentVariable`| disabled |
| `EnableNodeCliInspectArguments`      | disabled |
| `EnableEmbeddedAsarIntegrityValidation` | enabled |
| `OnlyLoadAppFromAsar`                | enabled  |
| `EnableCookieEncryption`             | enabled  |

Together these mean the shipped binary cannot be turned into a general purpose
Node runtime, cannot be told to load a different application, and validates the
archive it loads.

The renderer runs under a strict Content Security Policy: `default-src 'none'`
with `script-src` and `style-src` limited to `'self'`, `connect-src 'none'` and
`object-src 'none'`. That policy is load bearing rather than decorative: adding
KaTeX broke ten tests because one of its fonts was being inlined as a `data:`
URL, and the fix was to stop inlining rather than to widen `font-src`.

Signing is gated on credentials being present, so a local or CI build without
`NOTO_APPLE_SIGNING_IDENTITY` does not use a Developer ID. Packager still
rewrites `Info.plist` and the fuses plugin flips bits in the Electron binary,
which invalidates Electron's stock signature. The Forge `postPackage` hook
therefore adhoc-resigns (`codesign --force --deep --sign - Noto.app`) whenever
that identity env var is unset. That binds the product bundle id
(`dev.lr00rl.noto`) and stops Gatekeeper from calling the release zip
"damaged". Users may still need right-click Open or `xattr -cr` until the build
is notarized. True Developer ID signing and notarization need
`NOTO_APPLE_SIGNING_IDENTITY` plus `APPLE_ID` / `APPLE_PASSWORD` /
`APPLE_TEAM_ID`. `resources/entitlements.plist` is valid and is passed for
every file in the bundle when a real identity is used.

## One entitlement worth a second look

The hardened runtime entitlements are:

```
com.apple.security.cs.allow-jit
com.apple.security.cs.allow-unsigned-executable-memory
com.apple.security.cs.disable-library-validation
com.apple.security.files.user-selected.read-write
```

The first is required: V8 compiles JavaScript at runtime. The last is required
and correctly narrow: a file the user picked in a dialog is exactly what an
editor should be able to write, and it is not the blanket file access
entitlement.

`disable-library-validation` is the one to question. It lets the process load
libraries that are not signed by the same team, and it partly undercuts the
fuses above: the app validates its own asar carefully while permitting unsigned
native code into the same process. Electron applications commonly need it when
they load third party native modules. Noto's asar is JavaScript, and the native
code it runs is the Electron framework itself, which is signed as part of the
bundle.

So it is plausibly removable, and removing it would be a real improvement to the
posture. It is deliberately not being removed here, because verifying that
change needs an Apple Developer identity to sign with, a notarisation round
trip, and a launch on a machine that enforces Gatekeeper. None of that is
available in this environment, and an entitlement change that is wrong does not
fail visibly at build time: it fails when a user's copy refuses to launch.

`allow-unsigned-executable-memory` has the same character. It is required by
older Electron versions and may no longer be needed.

The way to settle both is to remove them one at a time, sign, notarise, and
launch from quarantine. Until someone can do that, they stay.

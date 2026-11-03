# A Noto plugin marketplace

A marketplace is a GitHub repository with an `index.json` at its root.
Plugin Center reads the repository named in Settings (`pluginMarketplace`,
`owner/repo`) and lists what the index lists. Copy this folder's
`index.json` to the root of such a repository to start one, and replace the
example entry.

Each entry names where the plugin's folder is: `repo` (`owner/repo`), and
optionally `ref` (a branch, tag or commit, `HEAD` by default) and `path` (the
folder inside the repository, the root by default). That folder holds the
plugin's `manifest.json` and `main.js`; `docs/plugins.md` describes both.

Pin each entry's code with `sha256`, the output of `shasum -a 256 main.js`.
Plugin Center then refuses to install anything but that exact file, so the
index vouches for code rather than for whatever the plugin's repository
holds tomorrow. Pinning to a commit in `ref` as well keeps the manifest from
changing under the pin.

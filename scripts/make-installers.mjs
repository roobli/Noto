/**
 * Build distributable installers for the host platform.
 *
 * A script rather than an inline environment assignment in package.json,
 * because `VAR=value command` is not valid in Windows cmd and this has to run
 * identically on all three CI runners.
 *
 * Forge decides which makers apply from the platform each was registered for,
 * so this produces a zip on macOS, a Squirrel installer on Windows, and deb and
 * rpm on Linux without any branching here.
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { assertPackagingRuntime } from './package-variant.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const variant = process.argv[2] ?? 'release';
if (variant !== 'e2e' && variant !== 'release') {
  throw new Error('Expected explicit e2e or release make variant');
}

assertPackagingRuntime();
process.env.NTO_PACKAGE_VARIANT = variant;

const { api } = require('@electron-forge/core');

// macOS ships one zip per architecture. An Apple silicon runner packages the
// Intel build as well: nothing in the app is native code, so packaging for x64
// is a matter of fetching the x64 Electron binary, and Rosetta cannot run an
// arm64 app on an Intel Mac. Other platforms build for the host only.
const architectures = process.platform === 'darwin' ? ['arm64', 'x64'] : [undefined];
const results = [];
for (const arch of architectures) {
  results.push(...await api.make({ dir: root, interactive: false, ...(arch ? { arch } : {}) }));
}

for (const result of results) {
  for (const artifact of result.artifacts) {
    process.stdout.write(`${artifact}\n`);
  }
}

if (results.length === 0) {
  throw new Error(`No maker produced an artifact for ${process.platform}`);
}

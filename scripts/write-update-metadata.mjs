/**
 * Write electron-updater feed files for the artifacts about to be uploaded.
 *
 * Forge does not emit `latest-mac.yml` / `latest.yml`. Without them,
 * electron-updater cannot download from GitHub Releases on macOS / generic
 * Windows. Squirrel's own `RELEASES` + `.nupkg` cover Windows auto-update when
 * those files are attached to the release (see release.yml).
 *
 * Usage: node scripts/write-update-metadata.mjs <upload-dir>
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const version = require('../package.json').version;

const uploadDir = process.argv[2];
if (!uploadDir) {
  throw new Error('Usage: node scripts/write-update-metadata.mjs <upload-dir>');
}

async function sha512File(filePath) {
  const digest = createHash('sha512');
  digest.update(await readFile(filePath));
  return digest.digest('base64');
}

function yamlBlock({ version: ver, fileName, sha512, size, releaseDate }) {
  return [
    `version: ${ver}`,
    'files:',
    `  - url: ${fileName}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${fileName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    '',
  ].join('\n');
}

const releaseDate = new Date().toISOString();
const entries = await readdir(uploadDir);
const written = [];

for (const name of entries) {
  const lower = name.toLowerCase();
  const full = path.join(uploadDir, name);
  const info = await stat(full);
  if (!info.isFile()) continue;

  if (lower.endsWith('.zip') && (lower.includes('macos') || lower.includes('darwin') || lower.includes('mac'))) {
    const sha512 = await sha512File(full);
    // electron-updater picks by arch from the file list when several ymls exist;
    // one latest-mac.yml per zip keeps multi-arch releases honest.
    const suffix = lower.includes('arm64') ? 'latest-mac-arm64.yml'
      : lower.includes('x64') ? 'latest-mac-x64.yml'
        : 'latest-mac.yml';
    // Always also write/overwrite latest-mac.yml for the host arch CI runner.
    const body = yamlBlock({ version, fileName: name, sha512, size: info.size, releaseDate });
    const targets = new Set([suffix, 'latest-mac.yml']);
    for (const target of targets) {
      await writeFile(path.join(uploadDir, target), body, 'utf8');
      written.push(target);
    }
  }

  if (lower.endsWith('.exe') && lower.includes('setup')) {
    const sha512 = await sha512File(full);
    const body = yamlBlock({ version, fileName: name, sha512, size: info.size, releaseDate });
    await writeFile(path.join(uploadDir, 'latest.yml'), body, 'utf8');
    written.push('latest.yml');
  }
}

process.stdout.write(`update metadata: ${written.join(', ') || '(none)'}\n`);

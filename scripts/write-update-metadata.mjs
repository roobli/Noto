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

function yamlBlock({ version: ver, files, releaseDate }) {
  // `path` and `sha512` at the top level are the legacy single-file fields;
  // electron-updater reads `files` and uses them only as a fallback.
  const [first] = files;
  return [
    `version: ${ver}`,
    'files:',
    ...files.flatMap((file) => [
      `  - url: ${file.fileName}`,
      `    sha512: ${file.sha512}`,
      `    size: ${file.size}`,
    ]),
    `path: ${first.fileName}`,
    `sha512: ${first.sha512}`,
    `releaseDate: '${releaseDate}'`,
    '',
  ].join('\n');
}

const releaseDate = new Date().toISOString();
const entries = (await readdir(uploadDir)).sort();
const written = [];
const macZips = [];

for (const name of entries) {
  const lower = name.toLowerCase();
  const full = path.join(uploadDir, name);
  const info = await stat(full);
  if (!info.isFile()) continue;

  if (lower.endsWith('.zip') && (lower.includes('macos') || lower.includes('darwin') || lower.includes('mac'))) {
    macZips.push({ fileName: name, sha512: await sha512File(full), size: info.size, arm64: lower.includes('arm64') });
  }

  if (lower.endsWith('.exe') && lower.includes('setup')) {
    const sha512 = await sha512File(full);
    const body = yamlBlock({ version, files: [{ fileName: name, sha512, size: info.size }], releaseDate });
    await writeFile(path.join(uploadDir, 'latest.yml'), body, 'utf8');
    written.push('latest.yml');
  }
}

if (macZips.length > 0) {
  // One feed lists every macOS zip. electron-updater picks the arm64 file on
  // Apple silicon and a file without "arm64" in its name elsewhere, so an
  // Intel Mac is never handed the Apple silicon build. Intel comes first so
  // the legacy top-level fields describe the build any Mac can run.
  macZips.sort((a, b) => Number(a.arm64) - Number(b.arm64));
  await writeFile(path.join(uploadDir, 'latest-mac.yml'), yamlBlock({ version, files: macZips, releaseDate }), 'utf8');
  written.push('latest-mac.yml');
  // Per-architecture feeds, kept for anything that reads them directly.
  for (const zip of macZips) {
    const target = zip.arm64 ? 'latest-mac-arm64.yml' : 'latest-mac-x64.yml';
    await writeFile(path.join(uploadDir, target), yamlBlock({ version, files: [zip], releaseDate }), 'utf8');
    written.push(target);
  }
}

process.stdout.write(`update metadata: ${written.join(', ') || '(none)'}\n`);

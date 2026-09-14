/**
 * Checks a packaged Noto tree without running it.
 *
 * The packaged e2e suite already asserts most of this, but only against the
 * package for the machine running the tests, because it has to launch the app
 * to do it. That leaves the platform nobody has a machine for unverified in
 * every respect, including the parts that are decided at package time and do
 * not need the app to start: which fuses were blown, what went into the asar,
 * and whether the platform's own metadata was applied.
 *
 * This verifies those statically, so a cross packaged tree can be checked from
 * any machine. It deliberately does not claim the app runs. That still requires
 * the platform.
 *
 *   node scripts/verify-package.mjs out/release/Noto-win32-x64
 */
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { executableRelativePath } from './package-variant.mjs';

const require = createRequire(import.meta.url);
const run = promisify(execFile);

/**
 * Every fuse the build depends on, and the state it must be in.
 *
 * One fuse differs by variant on purpose. The e2e package opens
 * `EnableNodeCliInspectArguments` because Playwright attaches with those
 * arguments, and release must never allow them. Checking a tree against the
 * wrong variant's expectations reports a failure that is really the packager
 * doing exactly what it was told, which is what this script did when it was
 * pointed at an e2e tree.
 */
function requiredFuses(variant) {
  return {
    RunAsNode: 'Disabled',
    EnableNodeOptionsEnvironmentVariable: 'Disabled',
    EnableNodeCliInspectArguments: variant === 'e2e' ? 'Enabled' : 'Disabled',
    EnableEmbeddedAsarIntegrityValidation: 'Enabled',
    OnlyLoadAppFromAsar: 'Enabled',
    EnableCookieEncryption: 'Enabled',
  };
}

/**
 * Which variant a packaged tree is.
 *
 * `packageVariant` always writes to `out/<variant>/<name>`, so the containing
 * directory is the answer for anything this repository produced. `--variant=`
 * covers a tree that has been moved somewhere else, and the assumed variant is
 * printed either way so a wrong guess is visible rather than silent.
 */
function variantOf(packageDirectory) {
  const flag = process.argv.find((argument) => argument.startsWith('--variant='));
  if (flag) {
    const value = flag.slice('--variant='.length);
    if (value !== 'e2e' && value !== 'release') throw new Error(`Unknown variant ${value}`);
    return value;
  }
  const parent = path.basename(path.dirname(packageDirectory));
  return parent === 'e2e' ? 'e2e' : 'release';
}

/** Anything matching these in the asar means retired scaffolding shipped. */
const FORBIDDEN_IN_ASAR = /testControl|experimental-runtime-smoke|g001/i;

const failures = [];
const checks = [];

function check(label, condition, detail = '') {
  checks.push(label);
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ''}`);
}

async function exists(candidate) {
  try { await access(candidate); return true; } catch { return false; }
}

/** `Noto-win32-x64` carries its own target, so it does not need to be passed. */
function platformOf(directory) {
  const match = /^Noto-(darwin|win32|linux)-(\w+)$/.exec(path.basename(directory));
  if (!match) throw new Error(`Cannot tell the platform from ${path.basename(directory)}`);
  return match[1];
}

async function verifyAsar(packageDirectory, platform) {
  const archive = platform === 'darwin'
    ? path.join(packageDirectory, 'Noto.app', 'Contents', 'Resources', 'app.asar')
    : path.join(packageDirectory, 'resources', 'app.asar');

  check('asar is present', await exists(archive), archive);
  if (!await exists(archive)) return;

  const asar = require('@electron/asar');
  const manifest = JSON.parse(asar.extractFile(archive, 'package.json').toString());

  // The manifest ships to users, and has been wrong before: it once carried a
  // retired scaffolding name, which broke the Linux installers outright.
  check('manifest names the product', manifest.name === 'noto', manifest.name);
  check('manifest has a licence', typeof manifest.license === 'string' && manifest.license.length > 0);
  check(
    'manifest description is not the old spike text',
    typeof manifest.description === 'string' && !/milkdown|spike/i.test(manifest.description),
    manifest.description,
  );

  const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  check('no Milkdown dependency', dependencies.every((name) => !name.includes('milkdown')));

  const shipped = asar.listPackage(archive).filter((entry) => FORBIDDEN_IN_ASAR.test(entry));
  check('no retired scaffolding in the asar', shipped.length === 0, shipped.join(', '));
}

async function verifyFuses(executable, variant) {
  let output;
  try {
    /*
     * The tool is run through this Node rather than through `npx`.
     *
     * `npx` is a shell script on Unix and a `.cmd` on Windows, and `spawn`
     * without a shell cannot start the second: on a Windows runner this failed
     * with `spawn npx ENOENT` after the installer had already been built
     * successfully, which is a verification step failing for a reason that has
     * nothing to do with what it verifies. The package is a dependency here,
     * so its own entry point is a path this can resolve.
     */
    // Found from the package's entry point, since its `exports` map names
    // neither the binary nor the manifest and both are ordinary files inside
    // the directory the entry point sits in.
    const tool = path.join(path.dirname(require.resolve('@electron/fuses')), 'bin.js');
    const result = await run(process.execPath, [tool, 'read', '--app', executable]);
    output = result.stdout;
  } catch (error) {
    check('fuses are readable', false, error.message);
    return;
  }
  // The tool colourises, which otherwise breaks every match below.
  const plain = output.replace(/\u001b\[[0-9;]*m/g, '');
  for (const [fuse, state] of Object.entries(requiredFuses(variant))) {
    check(`fuse ${fuse} is ${state}`, new RegExp(`${fuse} is ${state}`).test(plain));
  }
}

async function verifyPlatformIdentity(packageDirectory, platform) {
  if (platform === 'darwin') {
    const plist = path.join(packageDirectory, 'Noto.app', 'Contents', 'Info.plist');
    if (!await exists(plist)) {
      check('Info.plist is present', false, plist);
      return;
    }
    const content = await readFile(plist, 'utf8');
    check('bundle id is the product one', content.includes('<string>dev.lr00rl.noto</string>'));
    return;
  }
  if (platform === 'win32') {
    const binary = path.join(packageDirectory, 'Noto.exe');
    if (!await exists(binary)) return; // Already reported as a missing executable.
    // Version resources are UTF-16LE inside the PE, so they are looked for in
    // that encoding rather than as plain bytes.
    const content = await readFile(binary);
    for (const field of ['Noto Markdown editor', 'ProductName', 'CompanyName']) {
      check(`win32 metadata carries ${field}`, content.includes(Buffer.from(field, 'utf16le')));
    }
  }
}


/**
 * On a macOS host, the packaged `.app` must pass a strict codesign check.
 *
 * Without an adhoc resign after pack, Info.plist / fuse changes leave the
 * stock Electron signature invalid and Gatekeeper reports the zip as
 * "damaged". Cross-host verification (e.g. reading a darwin tree on Linux)
 * skips this: `codesign` is only available on macOS.
 */
async function verifyCodesign(packageDirectory, platform) {
  if (platform !== 'darwin' || process.platform !== 'darwin') return;
  const app = path.join(packageDirectory, 'Noto.app');
  if (!await exists(app)) {
    check('Noto.app is present for codesign', false, app);
    return;
  }
  try {
    await run('codesign', ['-vv', '--deep', '--strict', app]);
    check('codesign --deep --strict passes', true);
  } catch (error) {
    const detail = [error.stderr, error.stdout, error.message]
      .filter(Boolean)
      .map((part) => String(part).trim())
      .join('\n');
    check('codesign --deep --strict passes', false, detail);
  }
}

async function main() {
  const target = process.argv[2];
  if (!target) throw new Error('Usage: node scripts/verify-package.mjs <package directory>');
  const packageDirectory = path.resolve(target);
  const platform = platformOf(packageDirectory);
  const variant = variantOf(packageDirectory);

  const executable = path.join(packageDirectory, executableRelativePath(platform));
  check('executable is present', await exists(executable), executable);

  await verifyAsar(packageDirectory, platform);
  await verifyPlatformIdentity(packageDirectory, platform);
  await verifyCodesign(packageDirectory, platform);
  if (await exists(executable)) await verifyFuses(executable, variant);

  console.log(`${platform} ${variant}: ${checks.length - failures.length}/${checks.length} checks passed`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

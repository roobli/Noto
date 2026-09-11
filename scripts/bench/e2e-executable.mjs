/**
 * Packaged e2e binary for this machine.
 *
 * Darwin arm64 was the original bench host; Linux x64 is what the agent box
 * builds. Prefer an override, then the platform default that exists.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

export function e2eExecutable(root = ROOT) {
  if (process.env.NOTO_E2E_BIN) return process.env.NOTO_E2E_BIN;
  const candidates = [
    path.join(root, 'out/e2e/Noto-darwin-arm64/Noto.app/Contents/MacOS/Noto'),
    path.join(root, 'out/e2e/Noto-linux-x64/noto'),
    path.join(root, 'out/e2e/Noto-linux-x64/Noto'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `No packaged e2e binary under out/e2e (looked for darwin-arm64 and linux-x64). `
      + `Run pnpm package:e2e, or set NOTO_E2E_BIN.`,
    );
  }
  return found;
}

export function e2eLaunchArgs(userDataDir) {
  const args = [`--user-data-dir=${userDataDir}`];
  // Sandbox needs setuid chrome-sandbox; packaged trees on CI/agent boxes often
  // cannot. verify-installed.mjs already passes this on Linux.
  if (process.platform === 'linux') args.push('--no-sandbox');
  return args;
}

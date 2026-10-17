/**
 * Whether the in-app updater may download and swap the binary itself.
 *
 * Until Noto ships code-signed / notarized builds, auto-install is off on every
 * platform: an unsigned binary silently replacing itself is exactly what the OS
 * trust prompts exist to stop. Updates open the release download page instead.
 *
 * Re-enable for a signed build by flipping SIGNED_BUILD_AUTO_INSTALL to true in
 * the release that first carries real signatures (explicit, reviewed change).
 */
export const SIGNED_BUILD_AUTO_INSTALL = false;

export interface InstallPolicyInput {
  readonly packaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly signedBuild: boolean;
}

export function canAutoInstall(input: InstallPolicyInput): boolean {
  if (!input.signedBuild) return false;
  return input.packaged && (input.platform === 'darwin' || input.platform === 'win32');
}

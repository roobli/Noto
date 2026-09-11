/**
 * System font families for the Appearance pane.
 *
 * Enumerated in main (Electron) so the renderer never walks the filesystem.
 * Results are cached for the process lifetime: the font list rarely changes
 * while the app is open, and building it is the expensive part.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const FAMILY_MAX = 80;
const LIST_CAP = 800;

let cached: readonly string[] | null = null;

function cleanFamily(raw: string): string | null {
  const name = raw.replace(/\\,/g, ',').split(',')[0]?.trim() ?? '';
  if (!name || name.length > FAMILY_MAX) return null;
  if (/[\0\r\n"']/.test(name)) return null;
  return name;
}

async function fromFcList(): Promise<string[]> {
  const { stdout } = await execFileAsync('fc-list', [':', 'family'], {
    timeout: 8_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const names = new Set<string>();
  for (const line of stdout.split('\n')) {
    const family = cleanFamily(line);
    if (family) names.add(family);
  }
  return [...names];
}

async function fromDarwinProfiler(): Promise<string[]> {
  const { stdout } = await execFileAsync('system_profiler', ['SPFontsDataType', '-json'], {
    timeout: 20_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as { SPFontsDataType?: readonly { typefaces?: readonly { family?: string }[] }[] };
  const names = new Set<string>();
  for (const font of parsed.SPFontsDataType ?? []) {
    for (const face of font.typefaces ?? []) {
      const family = cleanFamily(face.family ?? '');
      if (family) names.add(family);
    }
  }
  return [...names];
}

async function fromWindowsFonts(): Promise<string[]> {
  const script = [
    'Add-Type -AssemblyName System.Drawing;',
    '[System.Drawing.FontFamily]::Families | ForEach-Object { $_.Name }',
  ].join(' ');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-Command', script],
    { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
  );
  const names = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const family = cleanFamily(line);
    if (family) names.add(family);
  }
  return [...names];
}

/**
 * Sorted unique family names, or an empty list when the platform has no
 * enumerator we can call. Empty is fine: the presets still work.
 */
export async function listSystemFontFamilies(): Promise<readonly string[]> {
  if (cached) return cached;
  try {
    const raw = process.platform === 'darwin'
      ? await fromDarwinProfiler()
      : process.platform === 'win32'
        ? await fromWindowsFonts()
        : await fromFcList();
    cached = Object.freeze(
      raw.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })).slice(0, LIST_CAP),
    );
  } catch {
    cached = Object.freeze([]);
  }
  return cached;
}

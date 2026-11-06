import { hasExactKeys, isRecord } from '../ipc/validate';

/**
 * Where a plugin's code runs. `trusted-renderer` and `isolated-service` are
 * the bundled kinds. `sandboxed` is a plugin the reader installed: its code
 * runs in a worker with no page, no app API and no network, and reaches the
 * note only through the capabilities it declares, unless the reader trusts
 * it fully, when it runs as a bundled renderer plugin does.
 */
export type PluginRuntime = 'trusted-renderer' | 'isolated-service' | 'sandboxed';

export interface PluginActivation {
  startup: boolean;
  events: string[];
  hotkeys: string[];
}

export interface PluginManifest {
  schemaVersion: 2;
  id: string;
  name: string;
  version: string;
  runtime: PluginRuntime;
  activation: PluginActivation;
  capabilities: string[];
  lifecycle: string[];
  commands: Array<{ id: string; title: string }>;
  settings: Array<{ key: string; type: 'boolean'; default: boolean }>;
  hotkeys: Array<{ command: string; keys: string }>;
  editorExtensions: string[];
  uiExtensions: string[];
  /** What the plugin does, in a line, shown before it is installed. Sandboxed plugins only. */
  description?: string;
}

const MANIFEST_KEYS = [
  'schemaVersion', 'id', 'name', 'version', 'runtime', 'activation', 'capabilities', 'lifecycle',
  'commands', 'settings', 'hotkeys', 'editorExtensions', 'uiExtensions',
] as const;

const idPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const localIdPattern = /^[a-z][a-zA-Z0-9.-]{0,79}$/;
const eventPattern = /^[a-z][a-z0-9]*(?:[.-][a-z][a-z0-9]*)+$/;
/**
 * Named keys a hotkey may end on, beyond a single letter or digit.
 *
 * An explicit allowlist rather than a wildcard: a manifest should not be able
 * to declare an arbitrary string as a key. Arrows and space are here because
 * real editor bindings use them, and refusing would force plugins to abandon
 * the shortcuts their users already know.
 */
const NAMED_KEYS = [
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'Enter', 'Tab', 'Backspace', 'Delete',
  'Home', 'End', 'PageUp', 'PageDown', 'Escape',
].join('|');

const hotkeyPattern = new RegExp(
  `^(?:Mod|Ctrl|Alt|Shift)(?:\\+(?:Mod|Ctrl|Alt|Shift|[A-Z]|[0-9]|${NAMED_KEYS}))+$`,
);
const semverIdentifierPattern = /^[0-9A-Za-z-]+$/;
const semverNumericIdentifierPattern = /^\d+$/;
const MAX_SEMVER_LENGTH = 256;
const MAX_SEMVER_IDENTIFIER_LENGTH = 64;

function uniqueStrings(value: unknown, allowed?: readonly string[]): value is string[] {
  return Array.isArray(value)
    && value.length <= 32
    && value.every((item) => typeof item === 'string'
      && item.length > 0
      && item.length <= 80
      && (!allowed || allowed.includes(item)))
    && new Set(value).size === value.length;
}

function isActivation(value: unknown): value is PluginActivation {
  return isRecord(value)
    && hasExactKeys(value, ['startup', 'events', 'hotkeys'])
    && typeof value.startup === 'boolean'
    && uniqueStrings(value.events)
    && value.events.every((event) => eventPattern.test(event))
    && uniqueStrings(value.hotkeys)
    && value.hotkeys.every((hotkey) => hotkeyPattern.test(hotkey));
}

function isCommand(value: unknown): value is { id: string; title: string } {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'title'])
    && typeof value.id === 'string' && localIdPattern.test(value.id)
    && typeof value.title === 'string' && value.title.length > 0 && value.title.length <= 80;
}

function isSetting(value: unknown): value is { key: string; type: 'boolean'; default: boolean } {
  return isRecord(value)
    && hasExactKeys(value, ['key', 'type', 'default'])
    && typeof value.key === 'string' && localIdPattern.test(value.key)
    && value.type === 'boolean'
    && typeof value.default === 'boolean';
}

function isHotkey(value: unknown): value is { command: string; keys: string } {
  return isRecord(value)
    && hasExactKeys(value, ['command', 'keys'])
    && typeof value.command === 'string' && localIdPattern.test(value.command)
    && typeof value.keys === 'string' && hotkeyPattern.test(value.keys);
}

function isBoundedSemVerIdentifier(identifier: string, numericLeadingZeroRule: boolean): boolean {
  return identifier.length > 0
    && identifier.length <= MAX_SEMVER_IDENTIFIER_LENGTH
    && semverIdentifierPattern.test(identifier)
    && (!numericLeadingZeroRule
      || !semverNumericIdentifierPattern.test(identifier)
      || identifier === '0'
      || identifier[0] !== '0');
}

function isBoundedSemVer(value: string): boolean {
  if (value.length === 0 || value.length > MAX_SEMVER_LENGTH) return false;

  const buildSeparator = value.indexOf('+');
  if (buildSeparator !== -1 && value.indexOf('+', buildSeparator + 1) !== -1) return false;
  const versionAndPrerelease = buildSeparator === -1 ? value : value.slice(0, buildSeparator);
  const build = buildSeparator === -1 ? null : value.slice(buildSeparator + 1);
  if (build !== null
    && !build.split('.').every((identifier) => isBoundedSemVerIdentifier(identifier, false))) {
    return false;
  }

  const prereleaseSeparator = versionAndPrerelease.indexOf('-');
  const core = prereleaseSeparator === -1
    ? versionAndPrerelease
    : versionAndPrerelease.slice(0, prereleaseSeparator);
  const prerelease = prereleaseSeparator === -1
    ? null
    : versionAndPrerelease.slice(prereleaseSeparator + 1);
  if (prerelease !== null
    && !prerelease.split('.').every((identifier) => isBoundedSemVerIdentifier(identifier, true))) {
    return false;
  }

  const coreIdentifiers = core.split('.');
  return coreIdentifiers.length === 3
    && coreIdentifiers.every((identifier) => isBoundedSemVerIdentifier(identifier, true)
      && semverNumericIdentifierPattern.test(identifier));
}

export function validatePluginManifest(value: unknown): value is PluginManifest {
  // The bundled kinds keep their exact key set; a sandboxed plugin may add a
  // description, which is the one field older builds have never seen.
  const sandboxed = isRecord(value) && value.runtime === 'sandboxed';
  if (!isRecord(value)
    || !(sandboxed
      ? MANIFEST_KEYS.every((key) => Object.hasOwn(value, key))
        && Object.keys(value).every((key) => (MANIFEST_KEYS as readonly string[]).includes(key) || key === 'description')
        && (value.description === undefined
          || (typeof value.description === 'string' && value.description.length > 0 && value.description.length <= 200))
      : hasExactKeys(value, [...MANIFEST_KEYS]))
    || value.schemaVersion !== 2
    || typeof value.id !== 'string' || !idPattern.test(value.id)
    || typeof value.name !== 'string' || value.name.length === 0 || value.name.length > 80
    || typeof value.version !== 'string' || !isBoundedSemVer(value.version)
    || !isActivation(value.activation)
    || !['trusted-renderer', 'isolated-service', 'sandboxed'].includes(String(value.runtime))) return false;

  const runtime = value.runtime as PluginRuntime;
  const inEditor = runtime !== 'isolated-service';
  // A trusted plugin may also read git (the Changes page does, through the rail
  // slot) and the folder's memory (Related and Activity, in Note Info).
  const allowedCapabilities = runtime === 'trusted-renderer'
    ? ['editor.read', 'editor.decorate', 'editor.transform', 'git.read', 'vault.read']
    : inEditor
      ? ['editor.read', 'editor.decorate', 'editor.transform']
      : ['filesystem.read'];
  const expectedLifecycle = inEditor ? ['activate', 'deactivate'] : ['start', 'stop'];
  if (!uniqueStrings(value.capabilities, allowedCapabilities)
    || !uniqueStrings(value.lifecycle)
    || !uniqueStrings(value.editorExtensions)
    || !uniqueStrings(value.uiExtensions)
    || !Array.isArray(value.commands) || value.commands.length > 32 || !value.commands.every(isCommand)
    || !Array.isArray(value.settings) || value.settings.length > 32 || !value.settings.every(isSetting)
    || !Array.isArray(value.hotkeys) || value.hotkeys.length > 32 || !value.hotkeys.every(isHotkey)) return false;

  const lifecycle = value.lifecycle as string[];
  const commands = value.commands as Array<{ id: string }>;
  const settings = value.settings as Array<{ key: string }>;
  const hotkeys = value.hotkeys as Array<{ command: string; keys: string }>;
  const activation = value.activation as PluginActivation;
  return lifecycle.length === expectedLifecycle.length
    && expectedLifecycle.every((item, index) => lifecycle[index] === item)
    && new Set(commands.map((item) => item.id)).size === commands.length
    && new Set(settings.map((item) => item.key)).size === settings.length
    && new Set(hotkeys.map((item) => item.keys)).size === hotkeys.length
    && hotkeys.every((hotkey) => commands.some((command) => command.id === hotkey.command))
    && activation.hotkeys.every((keys) => hotkeys.some((hotkey) => hotkey.keys === keys))
    && (runtime === 'trusted-renderer' || (value.editorExtensions as string[]).length === 0)
    // Slots are open to trusted plugins first; a sandboxed one has no page to extend yet.
    && (runtime !== 'sandboxed' || (value.uiExtensions as string[]).length === 0);
}

export function parsePluginManifest(value: unknown): PluginManifest {
  if (isRecord(value) && value.schemaVersion !== 2) {
    throw new Error('PLUGIN_MANIFEST_VERSION_UNSUPPORTED');
  }
  if (!validatePluginManifest(value)) throw new Error('PLUGIN_MANIFEST_INVALID');
  return value;
}

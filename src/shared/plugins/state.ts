import { hasExactKeys, isRecord } from '../ipc/validate';
import type { PluginCatalog } from './catalog';

export const LOCAL_PLUGIN_STATE_SCHEMA_VERSION = 1 as const;

export interface LocalPluginStateEntry {
  desiredEnabled: boolean;
  settings: Record<string, boolean>;
}

export interface LocalPluginState {
  schemaVersion: typeof LOCAL_PLUGIN_STATE_SCHEMA_VERSION;
  plugins: Record<string, LocalPluginStateEntry>;
}

export function createDefaultLocalPluginState(catalog: PluginCatalog): LocalPluginState {
  return {
    schemaVersion: LOCAL_PLUGIN_STATE_SCHEMA_VERSION,
    plugins: Object.fromEntries(catalog.plugins.map((manifest) => [
      manifest.id,
      {
        desiredEnabled: false,
        settings: Object.fromEntries(manifest.settings.map((setting) => [setting.key, setting.default])),
      },
    ])),
  };
}

export function cloneLocalPluginState(state: LocalPluginState): LocalPluginState {
  return {
    schemaVersion: LOCAL_PLUGIN_STATE_SCHEMA_VERSION,
    plugins: Object.fromEntries(Object.entries(state.plugins).map(([id, plugin]) => [
      id,
      {
        desiredEnabled: plugin.desiredEnabled,
        settings: { ...plugin.settings },
      },
    ])),
  };
}

/**
 * Entries kept for plugins the catalog does not list right now.
 *
 * Plugins installed by the reader come and go: one is removed, one is set
 * aside for a moment because its hotkey clashes, one sits in a folder that is
 * renamed back tomorrow. Refusing the whole state over an entry the catalog
 * does not know turned every plugin into a failed one at the next launch, so
 * a well-formed entry is carried as it is, and one that comes back finds its
 * switch where it was left. Bounded, so a state file cannot grow without end.
 */
const STATE_ENTRIES_MAX = 256;

function isEntryShape(value: unknown): value is LocalPluginStateEntry {
  return isRecord(value)
    && hasExactKeys(value, ['desiredEnabled', 'settings'])
    && typeof value.desiredEnabled === 'boolean'
    && isRecord(value.settings)
    && Object.values(value.settings).every((setting) => typeof setting === 'boolean');
}

/**
 * Whether a state is fit to be written: every catalog plugin has its entry,
 * with exactly its declared settings, and any other entry is well formed.
 */
export function validateLocalPluginState(
  value: unknown,
  catalog: PluginCatalog,
): value is LocalPluginState {
  if (!isRecord(value)
    || !hasExactKeys(value, ['schemaVersion', 'plugins'])
    || value.schemaVersion !== LOCAL_PLUGIN_STATE_SCHEMA_VERSION
    || !isRecord(value.plugins)) return false;

  const plugins = value.plugins;
  const ids = Object.keys(plugins);
  if (ids.length > STATE_ENTRIES_MAX) return false;
  if (!catalog.plugins.every((manifest) => Object.hasOwn(plugins, manifest.id))) return false;
  const known = new Map(catalog.plugins.map((manifest) => [manifest.id, manifest]));
  return ids.every((id) => {
    const entry = plugins[id];
    if (!isEntryShape(entry)) return false;
    const manifest = known.get(id);
    return manifest === undefined || hasExactKeys(entry.settings, manifest.settings.map((setting) => setting.key));
  });
}

/**
 * The state read from disk, fitted to the catalog.
 *
 * A catalog plugin missing from the file starts off with its defaults; a
 * setting it no longer declares is dropped, one it newly declares takes its
 * default. An entry for a plugin the catalog does not list is carried. A
 * malformed entry, for any plugin, or a malformed file, is still refused:
 * Noto writes every entry itself, so one it cannot read is damage, not change.
 */
export function parseLocalPluginState(value: unknown, catalog: PluginCatalog): LocalPluginState {
  if (!isRecord(value)
    || !hasExactKeys(value, ['schemaVersion', 'plugins'])
    || value.schemaVersion !== LOCAL_PLUGIN_STATE_SCHEMA_VERSION
    || !isRecord(value.plugins)) throw new Error('LOCAL_PLUGIN_STATE_INVALID');

  const known = new Map(catalog.plugins.map((manifest) => [manifest.id, manifest]));
  const normalized = createDefaultLocalPluginState(catalog);
  for (const [id, candidate] of Object.entries(value.plugins)) {
    if (!isEntryShape(candidate)) throw new Error('LOCAL_PLUGIN_STATE_INVALID');
    const manifest = known.get(id);
    if (manifest === undefined) {
      if (Object.keys(normalized.plugins).length < STATE_ENTRIES_MAX) {
        normalized.plugins[id] = { desiredEnabled: candidate.desiredEnabled, settings: { ...candidate.settings } };
      }
      continue;
    }
    const settings = candidate.settings;
    normalized.plugins[id] = {
      desiredEnabled: candidate.desiredEnabled,
      settings: Object.fromEntries(manifest.settings.map((setting) => {
        const persisted = settings[setting.key];
        return [setting.key, typeof persisted === 'boolean' ? persisted : setting.default];
      })),
    };
  }
  return normalized;
}

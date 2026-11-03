import { describe, expect, it } from 'vitest';
import { createPluginCatalog } from '../../src/shared/plugins/catalog';
import {
  filesystemProofManifest,
  rendererProofManifest,
} from '../../src/shared/plugins/proof-manifests';
import {
  createDefaultLocalPluginState,
  parseLocalPluginState,
  validateLocalPluginState,
} from '../../src/shared/plugins/state';

const catalog = createPluginCatalog([rendererProofManifest, filesystemProofManifest]);

describe('exact persisted local plugin state', () => {
  it('fails closed on missing state while retaining declared boolean defaults without grants', () => {
    const state = createDefaultLocalPluginState(catalog);

    expect(state).toEqual({
      schemaVersion: 1,
      plugins: {
        'dev.lr00rl.noto.renderer-proof': {
          desiredEnabled: false,
          settings: { focusEnabled: true },
        },
        'dev.lr00rl.noto.filesystem-proof': {
          desiredEnabled: false,
          settings: {},
        },
      },
    });
    expect(JSON.stringify(state)).not.toMatch(/grant/i);
    expect(validateLocalPluginState(state, catalog)).toBe(true);
  });

  it('default-fills newly bundled plugins and settings without changing existing enable intent', () => {
    const previousCatalog = createPluginCatalog([{
      ...rendererProofManifest,
      settings: [],
    }]);
    const previous = createDefaultLocalPluginState(previousCatalog);
    previous.plugins[rendererProofManifest.id].desiredEnabled = true;

    const evolved = parseLocalPluginState(previous, catalog);

    expect(evolved).toEqual({
      schemaVersion: 1,
      plugins: {
        [rendererProofManifest.id]: {
          desiredEnabled: true,
          settings: { focusEnabled: true },
        },
        [filesystemProofManifest.id]: {
          desiredEnabled: false,
          settings: {},
        },
      },
    });
  });

  it('carries a plugin the catalog no longer lists, and drops a setting a plugin no longer declares', () => {
    const valid = createDefaultLocalPluginState(catalog);
    // A plugin removed or set aside keeps its switch, so it comes back as it was left.
    const carried = parseLocalPluginState({
      ...valid,
      plugins: {
        ...valid.plugins,
        'local.someone.gone': { desiredEnabled: true, settings: { tidy: false } },
      },
    }, catalog);
    expect(carried.plugins['local.someone.gone']).toEqual({ desiredEnabled: true, settings: { tidy: false } });
    expect(validateLocalPluginState(carried, catalog)).toBe(true);

    const evolved = parseLocalPluginState({
      ...valid,
      plugins: {
        ...valid.plugins,
        [rendererProofManifest.id]: {
          ...valid.plugins[rendererProofManifest.id],
          settings: { focusEnabled: true, newPrivilege: false },
        },
      },
    }, catalog);
    expect(evolved.plugins[rendererProofManifest.id]?.settings).toEqual({ focusEnabled: true });
  });

  it('still refuses a damaged entry, for a plugin it knows or not', () => {
    const valid = createDefaultLocalPluginState(catalog);
    expect(() => parseLocalPluginState({
      ...valid,
      plugins: { ...valid.plugins, [rendererProofManifest.id]: { desiredEnabled: 1, settings: {} } },
    }, catalog)).toThrow('LOCAL_PLUGIN_STATE_INVALID');
    expect(() => parseLocalPluginState({
      ...valid,
      plugins: { ...valid.plugins, 'local.someone.broken': { desiredEnabled: 'yes', settings: {} } },
    }, catalog)).toThrow('LOCAL_PLUGIN_STATE_INVALID');
  });

  it('fails closed on schema, plugin, setting, type, missing, and surplus fields', () => {
    const valid = createDefaultLocalPluginState(catalog);
    const renderer = valid.plugins[rendererProofManifest.id];

    expect(validateLocalPluginState({ ...valid, schemaVersion: 2 }, catalog)).toBe(false);
    expect(validateLocalPluginState({ ...valid, grants: [] }, catalog)).toBe(false);
    // Another plugin's well-formed entry is not damage; a malformed one is.
    expect(validateLocalPluginState({
      ...valid,
      plugins: { ...valid.plugins, 'dev.lr00rl.noto.unknown': renderer },
    }, catalog)).toBe(true);
    expect(validateLocalPluginState({
      ...valid,
      plugins: { ...valid.plugins, 'dev.lr00rl.noto.unknown': { ...renderer, active: true } },
    }, catalog)).toBe(false);
    expect(validateLocalPluginState({
      ...valid,
      plugins: { [rendererProofManifest.id]: renderer },
    }, catalog)).toBe(false);
    expect(validateLocalPluginState({
      ...valid,
      plugins: {
        ...valid.plugins,
        [rendererProofManifest.id]: { ...renderer, active: true },
      },
    }, catalog)).toBe(false);
    expect(validateLocalPluginState({
      ...valid,
      plugins: {
        ...valid.plugins,
        [rendererProofManifest.id]: {
          ...renderer,
          settings: { ...renderer.settings, unknown: false },
        },
      },
    }, catalog)).toBe(false);
    expect(validateLocalPluginState({
      ...valid,
      plugins: {
        ...valid.plugins,
        [rendererProofManifest.id]: {
          desiredEnabled: 'yes',
          settings: renderer.settings,
        },
      },
    }, catalog)).toBe(false);
    expect(validateLocalPluginState({
      ...valid,
      plugins: {
        ...valid.plugins,
        [rendererProofManifest.id]: {
          desiredEnabled: true,
          settings: { focusEnabled: 1 },
        },
      },
    }, catalog)).toBe(false);
  });
});

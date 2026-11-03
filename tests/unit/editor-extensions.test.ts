import { describe, expect, it } from 'vitest';
import { Plugin } from 'prosemirror-state';
import { EditorExtensionRegistry } from '../../src/renderer/editor/noto/editor-extensions';
import { createDefaultLocalPluginState } from '../../src/shared/plugins/state';
import { bundledPluginCatalog } from '../../src/main/plugins/plugin-registry';
import { sidenotesManifest, titleShiftManifest } from '../../src/shared/plugins/proof-manifests';

describe('editor extensions', () => {
  it('tells every listener when one is added or removed, and lists what is there', () => {
    const registry = new EditorExtensionRegistry();
    let changes = 0;
    const unsubscribe = registry.subscribe(() => { changes += 1; });
    const remove = registry.add({ id: 'a', plugins: () => [new Plugin({})] });
    expect(registry.list().map((extension) => extension.id)).toEqual(['a']);
    remove();
    // A second release is a no-op, so a lease and the plugin both releasing is safe.
    remove();
    expect(registry.list()).toEqual([]);
    expect(changes).toBe(2);
    unsubscribe();
    registry.add({ id: 'b', plugins: () => [] });
    expect(changes).toBe(2);
  });

  it('refuses a second extension under the same id', () => {
    const registry = new EditorExtensionRegistry();
    registry.add({ id: 'a', plugins: () => [] });
    expect(() => registry.add({ id: 'a', plugins: () => [] })).toThrow(/EDITOR_EXTENSION_DUPLICATE/);
  });

  it('finds a command by name among the registered extensions only while registered', () => {
    const registry = new EditorExtensionRegistry();
    const command = () => true;
    const remove = registry.add({ id: 'a', plugins: () => [], commands: { 'a.run': command } });
    expect(registry.command('a.run')).toBe(command);
    expect(registry.command('b.run')).toBeUndefined();
    remove();
    expect(registry.command('a.run')).toBeUndefined();
  });
});

describe('bundled plugins switched on by default', () => {
  it('starts Sidenotes on and leaves the rest off for a reader who never touched them', () => {
    const state = createDefaultLocalPluginState(bundledPluginCatalog);
    expect(state.plugins[sidenotesManifest.id]?.desiredEnabled).toBe(true);
    expect(state.plugins[titleShiftManifest.id]?.desiredEnabled).toBe(false);
  });
});

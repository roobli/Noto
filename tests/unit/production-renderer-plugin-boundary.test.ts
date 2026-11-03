import { access, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const source = (relative: string) => readFile(new URL(relative, import.meta.url), 'utf8');

describe('G004 production trusted-renderer boundary', () => {
  it('attaches on production editor ready and disposes contributions before adapter teardown', async () => {
    const app = await source('../../src/renderer/App.tsx');
    const ready = app.slice(app.indexOf('onReady={(editor)'), app.indexOf('onTeardown={(editor)'));
    const teardown = app.slice(app.indexOf('onTeardown={(editor)'), app.indexOf('onError={(message)'));

    // Hosts are created per plugin by the bundled tier rather than inline.
    expect(app).toContain('createRendererPluginHosts()');
    // The bundled hosts, and a factory for the reader's installed plugins.
    expect(app).toContain('new RendererPluginClient(pluginHostRef.current!, window.notoDesktop.plugins, (pluginId) => {');
    expect(app).toContain('client.start();');
    const client = await source('../../src/renderer/plugins/RendererPluginClient.ts');
    const constructorBody = client.slice(client.indexOf('constructor('), client.indexOf('start(): void'));
    expect(constructorBody).not.toContain('onRendererRequest');
    expect(client.slice(client.indexOf('start(): void'), client.indexOf('attachAdapter'))).toContain('onRendererRequest');
    const release = client.slice(client.indexOf('private async releaseAndReportAll'), client.indexOf('private rememberClosed'));
    expect(release).toContain('this.api.rendererDisposed');
    expect(release).not.toContain('this.host.closeLease');
    expect(release).not.toContain('.catch(() => undefined)');
    expect(ready).toContain('editorRef.current = editor;');
    expect(ready).toContain('pluginClientRef.current?.attachAdapter(editor);');
    expect(ready.indexOf('editorRef.current = editor;')).toBeLessThan(ready.indexOf('pluginClientRef.current?.attachAdapter(editor);'));
    expect(teardown).toContain('void pluginClientRef.current?.detachAdapter();');
    expect(teardown).toContain('editorRef.current = null;');
    expect(teardown.indexOf('void pluginClientRef.current?.detachAdapter();')).toBeLessThan(teardown.indexOf('editorRef.current = null;'));
    expect(app).toContain('void client.dispose();');
    expect(app).not.toContain('pluginHostRef.current?.activate(editor);');
    expect(app).toContain("data-plugin-lifecycle={pluginSnapshot?.lifecycle ?? 'disabled'}");
    expect(app).toContain('data-plugin-registrations={pluginSnapshot?.rendererRegistrations ?? 0}');
  });

  it('keeps full-catalog state and transitions in main while renderer only materializes leases', async () => {
    const [registry, host] = await Promise.all([
      source('../../src/main/plugins/plugin-registry.ts'),
      source('../../src/renderer/plugins/RendererPluginHost.ts'),
    ]);

    expect(registry).toContain('rendererProofManifest');
    expect(registry).toContain('filesystemProofManifest');
    expect(registry).toContain('stateStore');
    expect(registry).toContain('openLease({');
    expect(host).toContain('openLease(request: RendererLeaseRequest)');
    expect(host).not.toMatch(/LocalPluginState|createDefaultLocalPluginState|desiredEnabled/);
    await expect(access(new URL(
      '../../src/renderer/plugins/RendererPluginRegistry.ts',
      import.meta.url,
    ))).rejects.toThrow();
  });

  it('uses one Noto-owned editor port without vendor types crossing the host boundary', async () => {
    const [editor, port, host] = await Promise.all([
      source('../../src/renderer/editor/noto/NotoEditor.ts'),
      source('../../src/renderer/editor/noto/NotoEditorPort.ts'),
      source('../../src/renderer/plugins/RendererPluginHost.ts'),
    ]);

    expect(editor).toContain('export class NotoEditor implements NotoEditorPort');
    expect(editor).toContain('setSemanticFocus(enabled: boolean): void');
    expect(editor).toContain("if (enabled) this.host.dataset.semanticFocus = 'true';");
    expect(editor).toContain('else delete this.host.dataset.semanticFocus;');
    expect(host).toContain("from '../editor/noto/NotoEditorPort';");
    expect(port).toContain('export interface NotoEditorPort');
    // The port is the whole plugin editor ABI, so it must not import anything:
    // no vendor types and no editor internals can reach a plugin through it.
    expect(port).not.toMatch(/^\s*import\s/m);
  });

  it('has no Milkdown left anywhere in the renderer', async () => {
    const [editor, canvas, app] = await Promise.all([
      source('../../src/renderer/editor/noto/NotoEditor.ts'),
      source('../../src/renderer/editor/noto/NotoCanvas.tsx'),
      source('../../src/renderer/App.tsx'),
    ]);
    for (const text of [editor, canvas, app]) {
      expect(text).not.toMatch(/milkdown/i);
    }
    await expect(access(new URL('../../src/renderer/editor/milkdown', import.meta.url))).rejects.toThrow();
    await expect(access(new URL('../../src/renderer/FileTruthApp.tsx', import.meta.url))).rejects.toThrow();
  });
});

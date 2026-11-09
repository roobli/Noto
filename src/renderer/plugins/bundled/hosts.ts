/**
 * The renderer plugins this build ships, each in its own host.
 *
 * Adding a plugin here is the only wiring step: main discovers it from the
 * bundled manifest catalog, the Plugin Center renders it from the lifecycle
 * snapshot, and the client routes its leases here by id. A plugin with a
 * `shell` entry point also gets its shell contributions (a rail page, say)
 * while it is switched on, through `shellPlugins`.
 */

import {
  changesManifest,
  historyManifest,
  memoryManifest,
  markdownPaddingManifest,
  rendererProofManifest,
  sidenotesManifest,
  titleShiftManifest,
} from '../../../shared/plugins/proof-manifests';
import type { PluginManifest } from '../../../shared/plugins/manifest';
import { SemanticFocusProofPlugin } from '../renderer-proof/plugin';
import { RendererPluginHost } from '../RendererPluginHost';
import { MarkdownPaddingPlugin, TitleShiftPlugin, type TrustedPlugin } from './index';
import { adaptTrustedPlugin } from './adapter';
import { ChangesPlugin } from './changes';
import { HistoryPlugin } from './history';
import { MemoryPlugin } from './memory';
import { SidenotesPlugin } from './sidenotes';

/** One instance per plugin, shared by its editor lease and its shell contributions. */
const trusted: readonly (readonly [PluginManifest, TrustedPlugin])[] = [
  [titleShiftManifest, new TitleShiftPlugin()],
  [sidenotesManifest, new SidenotesPlugin()],
  [markdownPaddingManifest, new MarkdownPaddingPlugin()],
  [changesManifest, new ChangesPlugin()],
  [historyManifest, new HistoryPlugin()],
  [memoryManifest, new MemoryPlugin()],
];

export function createRendererPluginHosts(): ReadonlyMap<string, RendererPluginHost> {
  const hosts = new Map<string, RendererPluginHost>();
  hosts.set(rendererProofManifest.id, new RendererPluginHost(() => undefined, {
    manifest: rendererProofManifest,
    plugin: new SemanticFocusProofPlugin(),
  }));
  for (const [manifest, plugin] of trusted) {
    hosts.set(manifest.id, new RendererPluginHost(() => undefined, {
      manifest,
      plugin: adaptTrustedPlugin(plugin),
    }));
  }
  return hosts;
}

/** The bundled plugins that add to the shell, with their manifests. */
export function shellPlugins(): readonly { readonly manifest: PluginManifest; readonly plugin: TrustedPlugin }[] {
  return trusted.filter(([, plugin]) => typeof plugin.shell === 'function').map(([manifest, plugin]) => ({ manifest, plugin }));
}

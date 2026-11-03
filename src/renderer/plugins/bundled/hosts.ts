/**
 * The renderer plugins this build ships, each in its own host.
 *
 * Adding a plugin here is the only wiring step: main discovers it from the
 * bundled manifest catalog, the Plugin Center renders it from the lifecycle
 * snapshot, and the client routes its leases here by id.
 */

import {
  markdownPaddingManifest,
  rendererProofManifest,
  sidenotesManifest,
  titleShiftManifest,
} from '../../../shared/plugins/proof-manifests';
import { SemanticFocusProofPlugin } from '../renderer-proof/plugin';
import { RendererPluginHost } from '../RendererPluginHost';
import { MarkdownPaddingPlugin, TitleShiftPlugin, type TrustedPlugin } from './index';
import { adaptTrustedPlugin } from './adapter';
import { SidenotesPlugin } from './sidenotes';

export function createRendererPluginHosts(): ReadonlyMap<string, RendererPluginHost> {
  const trusted: readonly [
    typeof titleShiftManifest | typeof markdownPaddingManifest | typeof sidenotesManifest,
    TrustedPlugin,
  ][] = [
    [titleShiftManifest, new TitleShiftPlugin()],
    [sidenotesManifest, new SidenotesPlugin()],
    [markdownPaddingManifest, new MarkdownPaddingPlugin()],
  ];

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

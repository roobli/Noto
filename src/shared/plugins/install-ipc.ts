/**
 * The channel Plugin Center installs, trusts and removes plugins through.
 *
 * The renderer names a plugin id, a GitHub address or a marketplace entry;
 * it never names a path on disk. Main shows the folder dialog itself, fetches
 * what it is pointed at, checks it, and keeps it in memory as a staged
 * preview until the reader installs it.
 */
import { isRecord } from '../ipc/validate';

export const PLUGIN_INSTALL_CHANNEL = 'noto:v1:plugin-install';
export const PLUGIN_INSTALL_VERSION = 1 as const;

export type PluginInstallRequest =
  | { readonly action: 'state' }
  | { readonly action: 'preview-folder' }
  | { readonly action: 'preview-github'; readonly url: string }
  | { readonly action: 'marketplace' }
  | { readonly action: 'preview-marketplace'; readonly id: string }
  | { readonly action: 'commit'; readonly stagingId: string }
  | { readonly action: 'cancel'; readonly stagingId: string }
  | { readonly action: 'uninstall'; readonly pluginId: string }
  | { readonly action: 'set-trust'; readonly pluginId: string; readonly trust: 'sandboxed' | 'full' }
  | { readonly action: 'open-folder' }
  | { readonly action: 'restart' };

export interface PluginPreviewV1 {
  readonly stagingId: string;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly source: string;
  /** The capabilities in the words Plugin Center shows. */
  readonly abilities: readonly string[];
  readonly commands: readonly string[];
  readonly hotkeys: readonly string[];
  /** The first twelve characters of the code's sha256. */
  readonly digest: string;
  /** Whether the code matched the digest a marketplace entry pinned. */
  readonly pinned: boolean;
  /** The version installed now, when this replaces one. */
  readonly replaces: string | null;
  /** Why it cannot be installed; empty when it can. */
  readonly problems: readonly string[];
}

export interface MarketplaceEntryV1 {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly repo: string;
  readonly installed: string | null;
}

export interface PluginInstallStateV1 {
  /** The folder plugins live in, for the reader to open. */
  readonly folder: string;
  /** Folders that are not loaded, with why. */
  readonly setAside: readonly { readonly folder: string; readonly reason: string }[];
  /** Installs, removals and trust changes waiting for a restart. */
  readonly restartPending: boolean;
  /** `owner/repo` of the marketplace, or empty when it is off. */
  readonly marketplace: string;
}

export type PluginInstallReplyV1 =
  | { readonly kind: 'state'; readonly state: PluginInstallStateV1 }
  | { readonly kind: 'preview'; readonly preview: PluginPreviewV1 }
  | { readonly kind: 'marketplace'; readonly entries: readonly MarketplaceEntryV1[] }
  | { readonly kind: 'done'; readonly state: PluginInstallStateV1 }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'refused'; readonly message: string };

export interface NotoPluginInstallApi {
  request(request: PluginInstallRequest): Promise<PluginInstallReplyV1>;
}

const PLUGIN_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const STAGING_ID = /^[0-9a-f-]{36}$/;

export function isPluginInstallRequest(value: unknown): value is PluginInstallRequest {
  if (!isRecord(value) || typeof value.action !== 'string') return false;
  const keys = Object.keys(value).sort().join(',');
  switch (value.action) {
    case 'state': case 'preview-folder': case 'marketplace': case 'open-folder': case 'restart':
      return keys === 'action';
    case 'preview-github':
      return keys === 'action,url' && typeof value.url === 'string' && value.url.length > 0 && value.url.length <= 400;
    case 'preview-marketplace':
      return keys === 'action,id' && typeof value.id === 'string' && PLUGIN_ID.test(value.id) && value.id.length <= 128;
    case 'commit': case 'cancel':
      return keys === 'action,stagingId' && typeof value.stagingId === 'string' && STAGING_ID.test(value.stagingId);
    case 'uninstall':
      return keys === 'action,pluginId' && typeof value.pluginId === 'string' && PLUGIN_ID.test(value.pluginId);
    case 'set-trust':
      return keys === 'action,pluginId,trust' && typeof value.pluginId === 'string' && PLUGIN_ID.test(value.pluginId)
        && (value.trust === 'sandboxed' || value.trust === 'full');
    default:
      return false;
  }
}

const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const texts = (value: unknown, max: number, count: number) =>
  Array.isArray(value) && value.length <= count && value.every((item) => text(item, max));

function isState(value: unknown): value is PluginInstallStateV1 {
  return isRecord(value) && text(value.folder, 4096) && typeof value.restartPending === 'boolean'
    && text(value.marketplace, 201)
    && Array.isArray(value.setAside) && value.setAside.length <= 64
    && value.setAside.every((item) => isRecord(item) && text(item.folder, 300) && text(item.reason, 400));
}

export function isPluginInstallReply(value: unknown): value is PluginInstallReplyV1 {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'state': case 'done': return isState(value.state);
    case 'cancelled': return true;
    case 'refused': return text(value.message, 600);
    case 'preview': {
      const preview = value.preview;
      return isRecord(preview) && text(preview.stagingId, 36) && text(preview.id, 128) && text(preview.name, 80)
        && text(preview.version, 256) && text(preview.description, 200) && text(preview.source, 200)
        && texts(preview.abilities, 120, 8) && texts(preview.commands, 120, 32) && texts(preview.hotkeys, 64, 32)
        && text(preview.digest, 12) && typeof preview.pinned === 'boolean'
        && (preview.replaces === null || text(preview.replaces, 256)) && texts(preview.problems, 400, 16);
    }
    case 'marketplace':
      return Array.isArray(value.entries) && value.entries.length <= 200 && value.entries.every((entry) => isRecord(entry)
        && text(entry.id, 128) && text(entry.name, 80) && text(entry.description, 200) && text(entry.version, 256)
        && text(entry.repo, 201) && (entry.installed === null || text(entry.installed, 256)));
    default:
      return false;
  }
}

/** What a capability lets a plugin do, as Plugin Center says it. */
export function abilityOf(capability: string): string {
  switch (capability) {
    case 'editor.read': return 'Can read the note in front';
    case 'editor.transform': return 'Can change the note in front';
    case 'editor.decorate': return 'Can change how the note looks, not what it says';
    default: return capability;
  }
}

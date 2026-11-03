import { rendererProofManifest } from './index';
import type { NotoEditorPort } from '../../editor/noto/NotoEditorPort';

/**
 * The slice of the editor port this plugin uses. The host supplies the full
 * port; declaring only what is needed keeps the dependency honest.
 */
export type SemanticFocusPort = Pick<NotoEditorPort, 'setSemanticFocus'>;

type Disposer = () => void;

export interface ProofPluginActivationContext {
  readonly pluginId: string;
  readonly leaseId: string;
  readonly generation: number;
  readonly settings: Readonly<Record<string, boolean>>;
  readonly signal: AbortSignal;
  /** The full editor port. Each method is gated by a manifest capability. */
  port: NotoEditorPort;
  registerCommand(id: string, execute: (signal: AbortSignal) => void | Promise<void>): Disposer;
  registerSetting(key: string, initial: boolean, update: (value: boolean) => void): Disposer;
  registerHotkey(keys: string, execute: (signal: AbortSignal) => void | Promise<void>): Disposer;
  registerEditorExtension(id: string): Disposer;
  /** An editor command by name on the note in front; gated by `editor.transform`. */
  runEditorCommand(name: string): boolean;
  registerUiExtension(id: string): Disposer;
  registerDisposer(disposer: Disposer): void;
  onCommand(): void;
  onSetting(value: boolean): void;
}

export class SemanticFocusProofPlugin {
  activate(context: ProofPluginActivationContext, failureCause?: unknown): Disposer {
    let focusEnabled: boolean = rendererProofManifest.settings[0].default;
    const apply = () => context.port.setSemanticFocus(focusEnabled);
    const toggle = () => {
      focusEnabled = !focusEnabled;
      apply();
      context.onSetting(focusEnabled);
      context.onCommand();
    };

    context.registerCommand(rendererProofManifest.commands[0].id, toggle);
    context.registerSetting(rendererProofManifest.settings[0].key, focusEnabled, (value) => {
      focusEnabled = value;
      apply();
      context.onSetting(focusEnabled);
    });
    context.registerHotkey(rendererProofManifest.hotkeys[0].keys, toggle);
    context.registerEditorExtension(rendererProofManifest.editorExtensions[0]);
    context.registerUiExtension(rendererProofManifest.uiExtensions[0]);
    apply();

    if (failureCause !== undefined) throw failureCause;
    return () => context.port.setSemanticFocus(false);
  }
}

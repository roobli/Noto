/**
 * The trusted first-party plugin tier.
 *
 * These run in the editor renderer under the same lifecycle every plugin uses:
 * disabled by default, enabled explicitly, activated by a declared trigger, and
 * torn down through a disposer. What makes them trusted is only that they ship
 * with Noto; they get no privilege the manifest does not declare, and they
 * reach the document exclusively through `NotoEditorPort`.
 *
 * Both are clean room reimplementations of plugins the owner maintains for
 * Typora. The behaviour is reproduced from their documented purpose; none of
 * Typora's code, private API or DOM is involved.
 */

import type { EditorExtension } from '../../editor/noto/editor-extensions';
import type { NotoEditorPort } from '../../editor/noto/NotoEditorPort';
import { padCjkSpacing, shiftHeadings } from './transforms';

type Disposer = () => void;

/**
 * What a trusted plugin is handed on activation.
 *
 * Mirrors the context the lifecycle host already provides, narrowed to what
 * this tier is allowed to use. Every registration returns a disposer so that
 * deactivation is total.
 */
export interface TrustedPluginContext {
  readonly pluginId: string;
  readonly settings: Readonly<Record<string, boolean>>;
  readonly signal: AbortSignal;
  readonly port: NotoEditorPort;
  registerCommand(id: string, execute: () => void | Promise<void>): Disposer;
  registerHotkey(keys: string, execute: () => void | Promise<void>): Disposer;
  registerDisposer(disposer: Disposer): void;
  /** Surface a short message to the user. */
  notice(message: string): void;
  /**
   * Add ProseMirror plugins, and commands by name, to every editor while this
   * plugin is switched on. Trusted plugins only: the id must be one the
   * manifest lists under `editorExtensions`, and the manifest must ask for
   * `editor.decorate`. Released with the plugin's lease.
   */
  registerEditorExtension(extension: EditorExtension): Disposer;
  /**
   * Run an editor command by name on the note in front: one this plugin's
   * extension registered, or one of the editor's own. False when there is no
   * note, it is read-only, or the command does not apply where the caret is.
   */
  runEditorCommand(name: string): boolean;
}

export interface TrustedPlugin {
  activate(context: TrustedPluginContext): Disposer;
}

/**
 * Move every heading in the document up or down one level.
 *
 * Reports what happened rather than failing silently: a document whose headings
 * are already at the boundary says so, which is the difference between "nothing
 * to do" and "the command is broken".
 */
export class TitleShiftPlugin implements TrustedPlugin {
  activate(context: TrustedPluginContext): Disposer {
    const shift = (delta: number) => {
      const result = shiftHeadings(context.port.getMarkdown(), delta);
      if (!result.changed) {
        context.notice(result.clamped
          ? 'Headings are already at the limit.'
          : 'This document has no headings.');
        return;
      }
      context.port.replaceMarkdown(result.markdown);
      const direction = delta < 0 ? 'promoted' : 'demoted';
      context.notice(result.clamped
        ? `Headings ${direction}. Some were already at the limit.`
        : `Headings ${direction}.`);
    };

    context.registerCommand('title-shift.promote', () => shift(-1));
    context.registerCommand('title-shift.demote', () => shift(1));
    context.registerHotkey('Mod+Shift+ArrowUp', () => shift(-1));
    context.registerHotkey('Mod+Shift+ArrowDown', () => shift(1));

    return () => undefined;
  }
}

/** Insert spaces between CJK and half-width characters across the document. */
export class MarkdownPaddingPlugin implements TrustedPlugin {
  activate(context: TrustedPluginContext): Disposer {
    const format = () => {
      const before = context.port.getMarkdown();
      const after = padCjkSpacing(before);
      if (after === before) {
        context.notice('Spacing is already correct.');
        return;
      }
      context.port.replaceMarkdown(after);
      context.notice('Spacing applied.');
    };

    context.registerCommand('md-padding.format', format);
    context.registerHotkey('Mod+Shift+Space', format);

    return () => undefined;
  }
}

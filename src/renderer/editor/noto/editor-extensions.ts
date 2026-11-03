/**
 * What trusted plugins add to the editor while they are switched on.
 *
 * The plugin-facing port (`NotoEditorPort`) exchanges markdown and never hands
 * out the editor. A plugin that changes how notes are drawn needs more than
 * that, so a trusted plugin (bundled, or one the reader trusted fully, which
 * runs in the page anyway) may register an extension: ProseMirror plugins
 * every editor runs, and commands those editors answer to by name. A
 * sandboxed plugin cannot reach this; its worker has no page to pass a
 * ProseMirror plugin from.
 *
 * One registry for the window, because the editors come and go with the notes
 * that are loaded while a plugin's activation outlives any one of them. An
 * editor starts with every extension registered and reconfigures when the set
 * changes, so switching a plugin on or off takes effect in every open note.
 */

import type { Command, Plugin } from 'prosemirror-state';

export interface EditorExtension {
  /** Unique per registry, and named in the plugin's manifest. */
  readonly id: string;
  /** Made fresh for each editor, since a plugin instance holds per-view state. */
  readonly plugins: () => readonly Plugin[];
  /** Editor commands the plugin can run by name on the note in front. */
  readonly commands?: Readonly<Record<string, Command>>;
}

type Listener = () => void;

export class EditorExtensionRegistry {
  private readonly extensions = new Map<string, EditorExtension>();
  private readonly listeners = new Set<Listener>();

  add(extension: EditorExtension): () => void {
    if (this.extensions.has(extension.id)) throw new Error(`EDITOR_EXTENSION_DUPLICATE: ${extension.id}`);
    this.extensions.set(extension.id, extension);
    this.changed();
    return () => {
      if (this.extensions.get(extension.id) !== extension) return;
      this.extensions.delete(extension.id);
      this.changed();
    };
  }

  list(): readonly EditorExtension[] {
    return [...this.extensions.values()];
  }

  command(name: string): Command | undefined {
    for (const extension of this.extensions.values()) {
      const command = extension.commands?.[name];
      if (command) return command;
    }
    return undefined;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

export const editorExtensions = new EditorExtensionRegistry();

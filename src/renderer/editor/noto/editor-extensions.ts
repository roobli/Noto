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
import type { EditorView } from 'prosemirror-view';

/** A line a plugin adds to the editor's right-click menu: a title and the command it runs. */
export interface EditorContextItem {
  readonly title: string;
  /** One of the extension's `commands`, run on the note in front when chosen. */
  readonly command: string;
}

/**
 * Where a right click landed: the document position under it, null off text,
 * and the element it hit. A drawn widget or a note floated into the margin is
 * an element with no text under every point of it, so the position alone can
 * name the text beside it instead.
 */
export interface EditorContextPoint {
  readonly pos: number | null;
  readonly element: Element | null;
}

/** Past this many, a right click is a plugin's menu rather than the editor's. */
const MAX_CONTEXT_ITEMS = 8;

export interface EditorExtension {
  /** Unique per registry, and named in the plugin's manifest. */
  readonly id: string;
  /** Made fresh for each editor, since a plugin instance holds per-view state. */
  readonly plugins: () => readonly Plugin[];
  /** Editor commands the plugin can run by name on the note in front. */
  readonly commands?: Readonly<Record<string, Command>>;
  /** What a right click at `at` offers, judged from the editor's state there: nothing, usually. */
  readonly contextMenu?: (view: EditorView, at: EditorContextPoint) => readonly EditorContextItem[];
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

  /** Every extension's items for a right click, in registration order. */
  contextItems(view: EditorView, at: EditorContextPoint): EditorContextItem[] {
    const items: EditorContextItem[] = [];
    for (const extension of this.extensions.values()) {
      for (const item of extension.contextMenu?.(view, at) ?? []) {
        // Only a command the editor can run by name; anything else would be a
        // menu line that does nothing when chosen.
        if (extension.commands?.[item.command]) items.push(item);
      }
    }
    return items.slice(0, MAX_CONTEXT_ITEMS);
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

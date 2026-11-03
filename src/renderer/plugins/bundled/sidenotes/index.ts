/**
 * Sidenotes: `<span class="sidenote">` drawn as numbered margin notes, the
 * author's Typora plugin as a bundled one.
 *
 * Everything it does to the editor goes through one editor extension: the
 * decorations that draw the notes, and the command that wraps a selection in
 * the tags. Switched off in Plugin Center, the extension leaves every open
 * editor and the tags read as the source they are.
 */

import { TextSelection, type Command } from 'prosemirror-state';
import { notoSchema } from '../../../../shared/markdown/v3/pm/schema';
import type { TrustedPlugin, TrustedPluginContext } from '../index';
import { sidenotePlugin } from './sidenote-plugin';

const { nodes } = notoSchema;

/** The manifest's command, and the editor command the extension answers to. */
export const INSERT_SIDENOTE = 'sidenotes.insert';

/**
 * Wrap the selection in a sidenote, as the author's Typora plugin does.
 *
 * The open tag carries `class="sidenote"`, which a bare `surroundTag('span')`
 * cannot write. An empty selection still inserts the pair so the caret can
 * fill the note; a fence or maths block refuses, as the other wraps do.
 */
export const surroundSidenote: Command = (state, dispatch) => {
  const { $from, from, to, empty } = state.selection;
  if (!$from.parent.isTextblock || $from.parent.type.spec.code) return false;
  if (!dispatch) return true;
  const open = nodes.inline_html.create({ value: '<span class="sidenote">' });
  const close = nodes.inline_html.create({ value: '</span>' });
  const tr = state.tr;
  tr.insert(to, close);
  tr.insert(from, open);
  tr.setSelection(empty
    ? TextSelection.create(tr.doc, from + open.nodeSize)
    : TextSelection.create(tr.doc, from + open.nodeSize, to + open.nodeSize));
  dispatch(tr.scrollIntoView());
  return true;
};

export class SidenotesPlugin implements TrustedPlugin {
  activate(context: TrustedPluginContext): () => void {
    context.registerEditorExtension({
      id: 'sidenotes',
      plugins: () => [sidenotePlugin()],
      commands: { [INSERT_SIDENOTE]: surroundSidenote },
    });
    context.registerCommand(INSERT_SIDENOTE, () => {
      if (!context.runEditorCommand(INSERT_SIDENOTE)) {
        context.notice('Put the caret in a paragraph to add a sidenote there.');
      }
    });
    // Everything above is released with the plugin's lease.
    return () => {};
  }
}

/**
 * Read where the browser has put the caret before a key is handled.
 *
 * ProseMirror hears that the caret moved from the browser's selectionchange
 * event, which is queued after the move, and its keydown only catches up
 * when a change is already waiting (`forceFlush` does nothing otherwise). A
 * key pressed before that event lands acts on where the caret was: Enter
 * right after a click or Command and an arrow split the line the caret had
 * left, and a note's key right after selecting words found nothing selected.
 * People rarely type that fast; a keyboard macro, a remote-control script
 * and a test do, and a busy machine widens the gap.
 *
 * `flush` is what the editor runs when the event does arrive: it compares the
 * page's selection with the one it knows and takes the page's if they differ,
 * and does nothing when they agree. Run first among the key handlers, every
 * handler after it sees where the caret is.
 */

import { Plugin } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

interface WithObserver {
  readonly domObserver?: { flush(): void };
}

export function caretCatchUp(): Plugin {
  return new Plugin({
    props: {
      handleKeyDown(view: EditorView) {
        (view as unknown as WithObserver).domObserver?.flush();
        return false;
      },
    },
  });
}

/**
 * Give the keys back to where they were when a sheet over the page closes.
 *
 * A sheet (the guide, a dialog) takes the keyboard while it is open. When it
 * closed, nothing said where the keyboard went, so it fell to the page body
 * and what the reader typed next went nowhere: the letters were lost, or a
 * shortcut fired on the window instead of the note. The rule now is one: the
 * keys go back to what had them, and to the note when that was the note. A
 * focus something else took on purpose while the sheet closed (a note a
 * chooser opened, a field a Try It went to) is left where it is.
 */

import { useLayoutEffect, useRef } from 'react';

function visible(element: Element): boolean {
  return element.isConnected && (element as HTMLElement).closest('[hidden], [aria-hidden="true"]') === null;
}

/** Whether nothing in particular has the keys: the body, or an element already gone. */
function unclaimed(active: Element | null): boolean {
  return active === null || active === globalThis.document.body || !visible(active);
}

/**
 * While `open`, remember what had the keys before; when it turns false, give
 * them back on the next microtask, after the sheet has left the page.
 * `focusNote` puts the caret back in the note in front and says whether it could.
 */
export function useFocusReturn(open: boolean, focusNote: () => boolean): void {
  const before = useRef<Element | null>(null);
  const note = useRef(focusNote);
  note.current = focusNote;
  useLayoutEffect(() => {
    if (open) {
      before.current = globalThis.document.activeElement;
      return;
    }
    const previous = before.current;
    if (previous === null) return;
    before.current = null;
    queueMicrotask(() => {
      if (!unclaimed(globalThis.document.activeElement)) return;
      if (previous.closest('.ProseMirror') || !visible(previous)) {
        note.current();
        return;
      }
      (previous as HTMLElement).focus?.();
    });
  }, [open]);
}

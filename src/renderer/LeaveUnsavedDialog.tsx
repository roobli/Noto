/**
 * Asked before a note with unsaved changes is left for another, when the
 * reader chose to be asked (`leaveUnsaved: 'ask'`).
 *
 * Save is the default and the button Return presses. Don't Save puts the
 * note back as it is on disk, so no draft is left behind to meet a change
 * made outside Noto or a quit later. Cancel stays on the note.
 */

import { useEffect, useRef } from 'react';

export type LeaveChoice = 'save' | 'discard' | 'cancel';

export function LeaveUnsavedDialog({ name, onChoose }: { readonly name: string; readonly onChoose: (choice: LeaveChoice) => void }) {
  const saveRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { saveRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onChoose('cancel');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onChoose]);
  return (
    <div className="reload-confirm-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onChoose('cancel'); }}>
      <div className="reload-confirm" role="alertdialog" aria-modal="true" aria-labelledby="leave-unsaved-title"
        aria-describedby="leave-unsaved-body" data-testid="leave-unsaved">
        <h2 id="leave-unsaved-title" className="reload-confirm-title">Save the changes to "{name}"?</h2>
        <p id="leave-unsaved-body" className="reload-confirm-body">
          If you don't save, the note goes back to what is on disk. You can choose to always save in Settings, Editor.
        </p>
        <div className="reload-confirm-actions">
          <button type="button" data-testid="leave-unsaved-cancel" onClick={() => onChoose('cancel')}>Cancel</button>
          <button type="button" className="is-danger" data-testid="leave-unsaved-discard" onClick={() => onChoose('discard')}>Don't Save</button>
          <button type="button" ref={saveRef} className="is-primary" data-testid="leave-unsaved-save" onClick={() => onChoose('save')}>Save</button>
        </div>
      </div>
    </div>
  );
}

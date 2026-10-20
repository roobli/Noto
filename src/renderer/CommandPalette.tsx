/**
 * The command palette: a filter field over a list of commands.
 *
 * A modal dialog, and it behaves as one. The field has the keyboard from the
 * moment the palette opens; Up and Down move through what matches and Enter
 * runs it, with the list told which row is current through
 * `aria-activedescendant` so the focus never leaves the field; Tab stays
 * inside the dialog; Escape, Close, or a press outside it closes it. Where the
 * focus goes afterwards is the opener's business (`App` hands it back to the
 * document), because only the opener knows whether a command has already
 * taken it somewhere else.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { filterPaletteCommands } from './command-palette-filter';

export interface PaletteCommand {
  /** Stable across renders and unique in the list. */
  readonly key: string;
  readonly title: string;
  /** What offers it: `File` for the built-in exports, a plugin's name otherwise. */
  readonly source: string;
  readonly testId?: string;
}

interface CommandPaletteProps {
  readonly commands: readonly PaletteCommand[];
  readonly onRun: (command: PaletteCommand) => void;
  readonly onClose: () => void;
}

const LIST_ID = 'command-palette-results';
const optionId = (index: number) => `command-palette-option-${index}`;

export function CommandPalette({ commands, onRun, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => filterPaletteCommands(commands, query), [commands, query]);
  // A new query starts at the top of what it found.
  useEffect(() => { setActive(0); }, [query]);
  const current = matches.length === 0 ? -1 : Math.min(active, matches.length - 1);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Escape closes it wherever the focus is, as the other dialogs do, so a key
  // pressed before the field has the caret is not lost.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // The current row stays in view as the keys walk past the edge of the list.
  useEffect(() => {
    if (current < 0) return;
    listRef.current?.querySelector(`#${optionId(current)}`)?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  const run = (command: PaletteCommand | undefined) => { if (command) onRun(command); };

  const onFieldKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (matches.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((current < 0 ? 0 : current + step + matches.length) % matches.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      run(matches[current]);
    }
  };

  // Tab and Shift+Tab go round the dialog's own controls and no further.
  const onDialogKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('input, button') ?? []);
    if (focusable.length === 0) return;
    const at = focusable.indexOf(globalThis.document.activeElement as HTMLElement);
    const next = (at + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length;
    event.preventDefault();
    focusable[next].focus();
  };

  return (
    <div
      className="command-palette-scrim"
      data-testid="command-palette-scrim"
      // A press outside closes it. The press's own default, moving the focus
      // to whatever is under it, is held back: there is nothing under it but
      // the scrim, so it would blur the document the close just gave the
      // keyboard back to.
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Commands"
        data-testid="command-palette"
        onKeyDown={onDialogKey}
      >
        <div className="dialog-heading">
          <input
            ref={inputRef}
            type="text"
            className="palette-input"
            data-testid="palette-input"
            placeholder="Search commands"
            aria-label="Search commands"
            role="combobox"
            aria-expanded="true"
            aria-controls={LIST_ID}
            aria-autocomplete="list"
            aria-activedescendant={current >= 0 ? optionId(current) : undefined}
            spellCheck={false}
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onFieldKey}
          />
          <button type="button" onClick={onClose}>Close</button>
        </div>
        <div className="palette-results" id={LIST_ID} role="listbox" aria-label="Commands" ref={listRef}>
          {matches.length === 0 && <p className="palette-empty" role="status">No command matches that.</p>}
          {matches.map((command, index) => (
            <div
              key={command.key}
              id={optionId(index)}
              role="option"
              aria-selected={index === current}
              className="palette-result"
              data-testid={command.testId ?? 'palette-result'}
              // The field keeps the keyboard; a press on a row is a choice,
              // not a move of the focus.
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => { if (index !== current) setActive(index); }}
              onClick={() => run(command)}
            >
              <strong>{command.title}</strong>
              <span>{command.source}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

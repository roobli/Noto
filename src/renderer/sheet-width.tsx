/**
 * How wide the sheets are: Quick Open, What Noto Can Do, Browse Tags and the
 * command palette.
 *
 * One of four steps of the window, set on the root as `data-sheet-width`
 * (App.tsx) and turned into each sheet's width and height in app.scss, where
 * Quick Open takes the most room, the guide and the tags a little less, and
 * the palette, a list of short names, the least. ⌘[ and ⌘] step it in any of
 * them, the keys Quick Open alone used to answer, and the one setting
 * remembers it for all four.
 */

import type { SheetWidthV1 } from '../shared/settings/v1/contracts';

export interface SheetWidthControl {
  readonly width: SheetWidthV1;
  readonly onWidth: (width: SheetWidthV1) => void;
  /** Chords the reader has switched off (`Mod+[`, `Mod+]`), which then do nothing here either. */
  readonly disabled?: readonly string[];
  readonly mac: boolean;
}

interface BracketKey {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  preventDefault(): void;
}

/**
 * Step the width on ⌘[ (narrower) or ⌘] (wider). True when the key was one
 * of them and is taken, whether or not the width could move further.
 */
export function stepSheetWidth(event: BracketKey, control: SheetWidthControl | undefined): boolean {
  if (!control || event.altKey || event.shiftKey) return false;
  if (!(control.mac ? event.metaKey : event.ctrlKey) || (event.key !== '[' && event.key !== ']')) return false;
  if (control.disabled?.includes(event.key === ']' ? 'Mod+]' : 'Mod+[')) return false;
  event.preventDefault();
  const next = Math.max(1, Math.min(4, control.width + (event.key === ']' ? 1 : -1))) as SheetWidthV1;
  if (next !== control.width) control.onWidth(next);
  return true;
}

/** The keys and where the width stands, for a sheet's footer. */
export function SheetWidthHint({ control }: { readonly control: SheetWidthControl | undefined }) {
  if (!control) return null;
  const mod = control.mac ? '⌘' : 'Ctrl+';
  return (
    <span className="sheet-width-hint" data-testid="sheet-width-hint">
      <kbd>{mod}[</kbd> <kbd>{mod}]</kbd> width
      <span className="sheet-width-pips" role="img" aria-label={`Width ${control.width} of 4`}>
        {[1, 2, 3, 4].map((step) => <i key={step} className={step <= control.width ? 'is-on' : undefined} />)}
      </span>
    </span>
  );
}

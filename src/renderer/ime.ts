/**
 * Whether a key press belongs to an input method's composition.
 *
 * With a Chinese, Japanese or Korean input method, the reader types letters
 * that become candidates, and Enter, an arrow, Escape or Tab then act on the
 * candidates: Enter commits what was typed. The page still sees each of those
 * as a keydown, marked as part of the composition. A field that answers Enter
 * by opening, saving or committing must leave such a press to the input
 * method, or confirming the letters opens the first result instead.
 *
 * Chromium marks the press with `isComposing`, and, for the press that ends a
 * composition on some input methods, only with key code 229; both are read.
 */
export function isComposing(event: { readonly nativeEvent?: KeyboardEvent; readonly isComposing?: boolean; readonly keyCode?: number }): boolean {
  const native = event.nativeEvent ?? (event as KeyboardEvent);
  return native.isComposing === true || native.keyCode === 229;
}

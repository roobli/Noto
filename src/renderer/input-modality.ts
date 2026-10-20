/**
 * Which hand the reader last used, kept on the root as `data-input`.
 *
 * An overlay summoned from the keyboard appears at once, and one summoned by a
 * press keeps its 100ms arrival (app.scss, "Keyboard-summoned overlays";
 * docs/design/motion.md, amendment of 2026-10-20). A shortcut reaches the
 * renderer as the menu's command, not as a key, but its modifier is pressed
 * first, and that keydown is enough to mark the keyboard as the hand in use.
 */
export type InputModality = 'keyboard' | 'pointer';

export function trackInputModality(target: Window = window, root: HTMLElement = document.documentElement): () => void {
  const mark = (modality: InputModality) => () => {
    if (root.dataset.input !== modality) root.dataset.input = modality;
  };
  const onKey = mark('keyboard');
  const onPointer = mark('pointer');
  target.addEventListener('keydown', onKey, true);
  target.addEventListener('pointerdown', onPointer, true);
  return () => {
    target.removeEventListener('keydown', onKey, true);
    target.removeEventListener('pointerdown', onPointer, true);
  };
}

/**
 * The block as committed, in a small read-only popover beside it.
 *
 * A dialog in behaviour if not in weight: it takes the focus when it opens so
 * a screen reader announces it and Escape reaches it, Tab stays inside it,
 * and closing it (Escape, Close, or a press anywhere else) gives the focus
 * back to the document. The text is the committed markdown, shown as source,
 * because that is what git holds and what a later revert would restore.
 *
 * Arrives like every other overlay: 100ms from a press, at once from the
 * keyboard (`data-input`, app.scss), and only fading under reduced motion.
 */

import type { EditorView } from 'prosemirror-view';

/** Words for the line and the mark, which a screen reader and the hover both get. */
export const GIT_BLOCK_WORDS = {
  modified: 'Changed since the last commit',
  added: 'New since the last commit',
  deleted: 'Deleted since the last commit',
} as const;

export type GitPopoverContent =
  | { readonly kind: 'modified'; readonly text: string }
  | { readonly kind: 'deleted'; readonly text: string }
  | { readonly kind: 'added'; readonly text: null };

let open: { readonly close: (restoreFocus: boolean) => void } | null = null;

/** Close the popover if one is open. */
export function closeGitPopover(): void {
  open?.close(false);
}

export function openGitPopover(view: EditorView, anchor: HTMLElement, content: GitPopoverContent): void {
  open?.close(false);

  const popover = document.createElement('section');
  popover.className = 'noto-git-popover';
  popover.dataset.testid = 'git-popover';
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-modal', 'false');
  popover.tabIndex = -1;

  const header = document.createElement('header');
  header.className = 'noto-git-popover-header';
  const title = document.createElement('h2');
  title.className = 'noto-git-popover-title';
  title.id = 'noto-git-popover-title';
  title.textContent = content.kind === 'modified' ? 'As committed'
    : content.kind === 'deleted' ? GIT_BLOCK_WORDS.deleted : GIT_BLOCK_WORDS.added;
  popover.setAttribute('aria-labelledby', title.id);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'noto-git-popover-close';
  close.dataset.testid = 'git-popover-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';
  header.append(title, close);
  popover.append(header);

  // One structure for all three: a title over one mono panel. The panel
  // holds the committed source (the block as it was, or the blocks that were
  // removed), or for a new block says there is none. Never a word diff.
  const body = document.createElement('pre');
  body.className = 'noto-git-popover-text';
  if (content.text !== null) {
    body.dataset.testid = 'git-popover-text';
    body.textContent = content.text.replace(/\n+$/, '');
  } else {
    body.classList.add('noto-git-popover-empty');
    body.dataset.testid = 'git-popover-empty';
    body.textContent = 'The last commit does not have this block.';
  }
  // Scrolls on its own when long, and is reachable by Tab to scroll by key.
  body.tabIndex = 0;
  popover.append(body);

  document.body.append(popover);
  place(popover, anchor);

  const focusables = () => [...popover.querySelectorAll<HTMLElement>('button, pre[tabindex="0"]')];
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finish(true);
    } else if (event.key === 'Tab') {
      const items = focusables();
      if (items.length === 0) return;
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : (at + 1) % items.length;
      event.preventDefault();
      items[next]!.focus();
    }
  };
  const onPointer = (event: PointerEvent) => {
    if (!popover.contains(event.target as Node)) finish(false);
  };
  const onScroll = () => place(popover, anchor);

  let finished = false;
  function finish(restoreFocus: boolean) {
    if (finished) return;
    finished = true;
    popover.removeEventListener('keydown', onKey);
    document.removeEventListener('pointerdown', onPointer, true);
    window.removeEventListener('resize', onScroll);
    view.dom.closest('.canvas-scroll')?.removeEventListener('scroll', onScroll, true);
    popover.remove();
    if (open?.close === finish) open = null;
    // Back to the document, where the reader was. A press elsewhere leaves
    // the focus wherever that press put it.
    if (restoreFocus) view.focus();
  }

  close.addEventListener('click', () => finish(true));
  popover.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onPointer, true);
  window.addEventListener('resize', onScroll);
  view.dom.closest('.canvas-scroll')?.addEventListener('scroll', onScroll, true);
  open = { close: finish };
  // The panel first, so a screen reader reads it and the arrows scroll it.
  body.focus();
}

/**
 * Beside the block's top-left corner, below its first line, kept inside the
 * window. Fixed, so it does not depend on what scrolls.
 */
function place(popover: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(520, window.innerWidth - 32);
  popover.style.width = `${width}px`;
  const left = Math.max(16, Math.min(rect.left, window.innerWidth - width - 16));
  const below = rect.top + Math.min(rect.height, 28) + 6;
  const height = popover.offsetHeight;
  const top = below + height > window.innerHeight - 16 ? Math.max(16, rect.top - height - 6) : below;
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

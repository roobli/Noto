/**
 * The Review queue's place, worked out without a window: one suggestion at a
 * time from a list the memory keeps, fetched a page at a time.
 */

import type { ReviewKind, ReviewSuggestion } from '../../slots';

export interface Queue {
  readonly kind: ReviewKind;
  readonly items: readonly ReviewSuggestion[];
  /** How many the memory's list holds now. */
  readonly total: number;
  /** The one shown, in `items`. */
  readonly index: number;
  /** Where in the memory's list this page ends: the next page starts here. */
  readonly fetched: number;
}

/**
 * On from the one shown: past it (skipped), or with it gone (linked or said
 * no to). The memory drops a gone one from its list too, so every one gone
 * moves the end of what was fetched back by one. `fetch` is where the next
 * page starts when this one is used up and the list has more, else null.
 */
export function step(queue: Queue, gone: boolean): { readonly queue: Queue; readonly fetch: number | null } {
  const items = gone ? queue.items.filter((_, index) => index !== queue.index) : queue.items;
  const index = gone ? queue.index : queue.index + 1;
  const total = gone ? queue.total - 1 : queue.total;
  const fetched = gone ? queue.fetched - 1 : queue.fetched;
  const moved: Queue = { ...queue, items, index, total, fetched };
  return { queue: moved, fetch: index < items.length || fetched >= total ? null : fetched };
}

/** Which one of the list is shown, counting from 1. */
export const positionOf = (queue: Queue) => queue.fetched - queue.items.length + queue.index + 1;

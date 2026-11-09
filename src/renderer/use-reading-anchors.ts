/**
 * Keep each note's place in the shared page, and give it back when the note
 * comes to the front again (`reading-anchors.ts` says why by block).
 */

import { useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject } from 'react';
import type { EditorView } from 'prosemirror-view';
import { readingAnchor, ReadingAnchorStore, restoreReadingAnchor, type ReadingAnchor } from './reading-anchors';

interface AnchorEditor {
  getView(): EditorView | null;
}

function localStore(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function useReadingAnchors({
  canvasId, activeId, activePath, editors, editorsReady, paused, jumping,
}: {
  /** The id of the element that scrolls all notes. */
  readonly canvasId: string;
  readonly activeId: string | null;
  /** The note in front's path, to remember its place across launches. */
  readonly activePath: string | null;
  readonly editors: MutableRefObject<Map<string, AnchorEditor>>;
  /** Bumped when an editor is made, which may be after its note came to the front. */
  readonly editorsReady: number;
  /** Source mode or a code view is in front: the page is not the note's. */
  readonly paused: boolean;
  /** Something is about to put the note at a place of its own (a search match), so its old place yields. */
  readonly jumping: () => boolean;
}): ReadingAnchorStore {
  const store = useMemo(() => new ReadingAnchorStore(localStore()), []);
  const places = useRef(new Map<string, ReadingAnchor>());
  /** The note waiting for its place, until its editor is drawn. */
  const waiting = useRef<string | null>(null);
  const active = useRef({ id: activeId, path: activePath });
  active.current = { id: activeId, path: activePath };

  useLayoutEffect(() => {
    waiting.current = activeId !== null && !jumping() ? activeId : null;
  }, [activeId]);

  useLayoutEffect(() => {
    const id = waiting.current;
    if (id === null || id !== activeId || paused) return;
    const view = editors.current.get(id)?.getView();
    const canvas = globalThis.document.getElementById(canvasId);
    if (!view || !canvas) return;
    waiting.current = null;
    const place = places.current.get(id) ?? (activePath ? store.get(activePath) : null);
    if (!place || !restoreReadingAnchor(view, canvas, place)) canvas.scrollTop = 0;
  }, [activeId, activePath, editorsReady, paused]);

  /*
   * Source Code Mode draws the note as its text in the same page, so leaving
   * it landed far from where the reader was (daily-use audit, finding 8). The
   * place on the way in is put back on the way out, two frames on, once the
   * rendered note is laid out again; if the caret has been moved out of that
   * view in the meantime, the caret is brought into view instead.
   */
  const entry = useRef<{ readonly id: string; readonly place: ReadingAnchor } | null>(null);
  const wasPaused = useRef(paused);
  useLayoutEffect(() => {
    const before = wasPaused.current;
    wasPaused.current = paused;
    const canvas = globalThis.document.getElementById(canvasId);
    const id = activeId;
    if (!canvas || id === null || before === paused) return undefined;
    if (paused) {
      // The place the page last had, kept by the scroll listener: by now the
      // source text may already stand in the rendered note's stead.
      const place = places.current.get(id) ?? null;
      entry.current = place ? { id, place } : null;
      return undefined;
    }
    const back = entry.current;
    entry.current = null;
    if (!back || back.id !== id) return undefined;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const view = editors.current.get(id)?.getView();
        if (!view) return;
        restoreReadingAnchor(view, canvas, back.place);
        places.current.set(id, back.place);
        const head = view.coordsAtPos(view.state.selection.head);
        const box = canvas.getBoundingClientRect();
        if (head.bottom < box.top || head.top > box.bottom) view.dispatch(view.state.tr.scrollIntoView());
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [paused, activeId, canvasId]);

  useEffect(() => {
    const canvas = globalThis.document.getElementById(canvasId);
    if (!canvas) return undefined;
    let frame = 0;
    const note = () => {
      frame = 0;
      const { id, path } = active.current;
      if (id === null || waiting.current === id || paused) return;
      const view = editors.current.get(id)?.getView();
      if (!view) return;
      const place = readingAnchor(view, canvas);
      if (!place) return;
      places.current.set(id, place);
      if (path) store.set(path, place);
    };
    const onScroll = () => { if (frame === 0) frame = requestAnimationFrame(note); };
    const onLeave = () => store.flush();
    canvas.addEventListener('scroll', onScroll, { passive: true });
    globalThis.addEventListener('beforeunload', onLeave);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      canvas.removeEventListener('scroll', onScroll);
      globalThis.removeEventListener('beforeunload', onLeave);
      store.flush();
    };
  }, [canvasId, store, paused]);

  return store;
}

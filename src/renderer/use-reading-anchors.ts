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

/**
 * Marks on the note in front, as the editor draws them.
 *
 * A plugin's marks arrive with the words they are about (`note-marks-locate.ts`
 * finds them in the document as it stands). Each is a faint dotted underline,
 * lighter than a spelling mark, since it is an offer and not a fault. The
 * marks follow the text through typing, and one whose words were changed
 * goes away. Resting the pointer on one, or pressing Option-Return with the
 * caret in it, opens a small card: what the mark is, a line or two, and its
 * actions. An action that replaces the words does so as one edit, which Undo
 * takes back, and the mark leaves the page whatever the action was.
 *
 * Nothing here is saved or put in the history: the marks are drawn over the
 * note, never into it.
 */

import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { locateMarks } from './note-marks-locate';

export interface NoteMarkView {
  /** Unique across every plugin's marks on the note. */
  readonly key: string;
  readonly text: string;
  readonly before: string;
  readonly after: string;
  /** What kind of mark it is, at the card's top: "Link suggestion". */
  readonly kind: string;
  readonly title: string;
  readonly detail?: string;
  readonly actions: readonly { readonly id: string; readonly label: string; readonly replace?: string }[];
}

export interface NoteMarksOptions {
  /** An action was chosen, after its replacement (if any) was made. */
  readonly onAction: (key: string, action: string) => void;
}

interface MarksState {
  readonly marks: ReadonlyMap<string, NoteMarkView>;
  readonly decorations: DecorationSet;
  /** The marks last given, found or not, so the same set again need not be looked for again. */
  readonly given: readonly NoteMarkView[];
}

type MarksMeta = { readonly set: readonly NoteMarkView[] } | { readonly drop: string };

export const noteMarksKey = new PluginKey<MarksState>('noto-note-marks');

const EMPTY: MarksState = { marks: new Map(), decorations: DecorationSet.empty, given: [] };

/** Put these marks on the note in place of the ones it had. A view change only. */
export function setNoteMarks(tr: Transaction, marks: readonly NoteMarkView[]): Transaction {
  return tr.setMeta(noteMarksKey, { set: marks } satisfies MarksMeta).setMeta('addToHistory', false);
}

function decorate(state: EditorState, marks: readonly NoteMarkView[]): MarksState {
  const found = locateMarks(state.doc, marks);
  const byKey = new Map(marks.map((mark) => [mark.key, mark]));
  const decorations = found.map((spot) => {
    const mark = byKey.get(spot.key)!;
    return Decoration.inline(spot.from, spot.to, {
      class: 'noto-note-mark',
      'data-note-mark': spot.key,
      'data-testid': 'note-mark',
      // Said by a screen reader with the words, since the line under them is not.
      'aria-description': `${mark.kind}: ${mark.title}. Option-Return for what to do.`,
    }, { key: spot.key, text: mark.text });
  });
  return { marks: new Map(found.map((spot) => [spot.key, byKey.get(spot.key)!])), decorations: DecorationSet.create(state.doc, decorations), given: marks };
}

/** What a set of marks says, to tell a reload that changed nothing from one that did. */
const sameMarks = (left: readonly NoteMarkView[], right: readonly NoteMarkView[]) =>
  left.length === right.length && left.every((mark, index) => JSON.stringify(mark) === JSON.stringify(right[index]));

/** Where a mark is now, or null when it has left the page. */
export function noteMarkRange(state: EditorState, key: string): { from: number; to: number } | null {
  const found = noteMarksKey.getState(state)?.decorations.find(undefined, undefined, (spec) => spec.key === key)[0];
  return found ? { from: found.from, to: found.to } : null;
}

/** The mark the caret is in, if any. */
function markAtSelection(state: EditorState): string | null {
  const { from, to } = state.selection;
  const found = noteMarksKey.getState(state)?.decorations.find(from, to, () => true) ?? [];
  const hit = found.find((decoration) => decoration.from <= from && to <= decoration.to);
  return hit ? (hit.spec as { key: string }).key : null;
}

/** Carry out an action on a mark: its replacement as one edit, then the plugin's own part. */
export function runNoteMarkAction(view: EditorView, key: string, actionId: string, options: NoteMarksOptions): void {
  const state = noteMarksKey.getState(view.state);
  const mark = state?.marks.get(key);
  const action = mark?.actions.find((item) => item.id === actionId);
  if (!mark || !action) return;
  const range = noteMarkRange(view.state, key);
  let tr = view.state.tr.setMeta(noteMarksKey, { drop: key } satisfies MarksMeta);
  if (action.replace !== undefined) {
    // A note that cannot be edited now keeps its mark: nothing was done about it.
    if (!range || !view.editable) return;
    tr = tr.insertText(action.replace, range.from, range.to);
  } else {
    tr = tr.setMeta('addToHistory', false);
  }
  view.dispatch(tr);
  options.onAction(key, actionId);
}

// ---------------------------------------------------------------------------
// The card.

let card: { readonly key: string; readonly view: EditorView; readonly element: HTMLElement; readonly close: () => void } | null = null;

export function closeNoteMarkCard(): void {
  card?.close();
}

function openCard(view: EditorView, anchor: HTMLElement, key: string, options: NoteMarksOptions, focus: boolean): void {
  const mark = noteMarksKey.getState(view.state)?.marks.get(key);
  if (!mark) return;
  if (card?.key === key) {
    if (focus) card.element.querySelector<HTMLButtonElement>('button')?.focus();
    return;
  }
  card?.close();
  const element = document.createElement('section');
  element.className = 'noto-mark-card';
  element.dataset.testid = 'note-mark-card';
  element.setAttribute('role', 'dialog');
  element.setAttribute('aria-modal', 'false');
  const kind = document.createElement('p');
  kind.className = 'noto-mark-card-kind';
  kind.textContent = mark.kind;
  const title = document.createElement('h2');
  title.className = 'noto-mark-card-title';
  title.id = 'noto-mark-card-title';
  title.textContent = mark.title;
  element.setAttribute('aria-labelledby', title.id);
  element.append(kind, title);
  if (mark.detail) {
    const detail = document.createElement('p');
    detail.className = 'noto-mark-card-detail';
    detail.textContent = mark.detail;
    element.append(detail);
  }
  const actions = document.createElement('div');
  actions.className = 'noto-mark-card-actions';
  mark.actions.forEach((action, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = index === 0 ? 'noto-mark-card-action is-primary' : 'noto-mark-card-action';
    button.dataset.testid = `note-mark-action-${action.id}`;
    button.textContent = action.label;
    // Said before it is pressed, rather than pressed and nothing happening.
    if (action.replace !== undefined && !view.editable) {
      button.disabled = true;
      button.title = 'This note is read-only.';
    }
    button.addEventListener('click', () => {
      close(false);
      runNoteMarkAction(view, key, action.id, options);
      view.focus();
    });
    actions.append(button);
  });
  element.append(actions);
  document.body.append(element);
  place(element, anchor);

  let leaveTimer: ReturnType<typeof setTimeout> | null = null;
  const stay = () => { if (leaveTimer !== null) { clearTimeout(leaveTimer); leaveTimer = null; } };
  const leave = () => { stay(); leaveTimer = setTimeout(() => close(false), 300); };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    }
  };
  const onDown = (event: PointerEvent) => {
    if (!element.contains(event.target as Node) && !anchor.contains(event.target as Node)) close(false);
  };
  element.addEventListener('pointerenter', stay);
  element.addEventListener('pointerleave', leave);
  anchor.addEventListener('pointerleave', leave);
  anchor.addEventListener('pointerenter', stay);
  element.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onDown, true);
  // Placed once, beside the words: when the page moves, the card is closed rather than left behind.
  const onScroll = (event: Event) => { if (!element.contains(event.target as Node)) close(false); };
  document.addEventListener('scroll', onScroll, true);

  function close(restoreFocus: boolean): void {
    if (card?.element !== element) return;
    stay();
    element.removeEventListener('pointerenter', stay);
    element.removeEventListener('pointerleave', leave);
    anchor.removeEventListener('pointerleave', leave);
    anchor.removeEventListener('pointerenter', stay);
    element.removeEventListener('keydown', onKey);
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('scroll', onScroll, true);
    element.remove();
    card = null;
    if (restoreFocus) view.focus();
  }
  card = { key, view, element, close: () => close(false) };
  if (focus) actions.querySelector<HTMLButtonElement>('button')?.focus();
}

/** Under the marked words' first line, or over it when there is no room below; inside the window either way. */
function place(element: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getClientRects()[0] ?? anchor.getBoundingClientRect();
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  const gap = 6;
  const below = rect.bottom + gap + height <= window.innerHeight - 8;
  const top = below ? rect.bottom + gap : Math.max(8, rect.top - gap - height);
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
  element.style.top = `${Math.round(top)}px`;
  element.style.left = `${Math.round(left)}px`;
}

// ---------------------------------------------------------------------------
// The plugin.

/** How long the pointer rests on a mark before its card opens: long enough that reading past it does not. */
const REST_MS = 450;

export function noteMarksPlugin(options: NoteMarksOptions): Plugin<MarksState> {
  return new Plugin<MarksState>({
    key: noteMarksKey,
    state: {
      init: () => EMPTY,
      apply(tr, value, _old, next) {
        const meta = tr.getMeta(noteMarksKey) as MarksMeta | undefined;
        // The same marks again (a reload that found nothing new) keep their places, which typing has moved.
        if (meta && 'set' in meta && !(sameMarks(meta.set, value.given) && !tr.docChanged)) return decorate(next, meta.set);
        let current = value;
        if (tr.docChanged && current.decorations !== DecorationSet.empty) {
          // A mark whose words were edited, or had something put among them, is no longer about them.
          let decorations = current.decorations.map(tr.mapping, tr.doc);
          const edited = decorations.find()
            .filter((decoration) => tr.doc.textBetween(decoration.from, decoration.to, '', '\ufffc') !== (decoration.spec as { text: string }).text);
          if (edited.length > 0) decorations = decorations.remove([...edited]);
          // Mapping drops a mark whose words were deleted outright: what is left is what the marks are.
          const present = new Set(decorations.find().map((decoration) => (decoration.spec as { key: string }).key));
          const lost = present.size !== current.marks.size;
          const marks = lost ? new Map([...current.marks].filter(([key]) => present.has(key))) : current.marks;
          // A mark lost here may be found again (Undo brings its words back): the same set next time is looked for anew.
          current = { marks, decorations, given: lost ? [] : current.given };
        }
        if (meta && 'drop' in meta) {
          const dropped = current.decorations.find(undefined, undefined, (spec) => spec.key === meta.drop);
          const marks = new Map(current.marks);
          marks.delete(meta.drop);
          current = { marks, decorations: current.decorations.remove([...dropped]), given: [] };
        }
        return current;
      },
    },
    props: {
      decorations: (state) => noteMarksKey.getState(state)?.decorations ?? DecorationSet.empty,
      handleKeyDown(view, event) {
        // Escape closes this note's card wherever the focus is in the note, however it was opened.
        if (event.key === 'Escape' && card?.view === view) {
          card.close();
          return true;
        }
        // Option-Return opens the card of the mark the caret is in, as a quick fix does elsewhere.
        if (event.key !== 'Enter' || !event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return false;
        const key = markAtSelection(view.state);
        if (!key) return false;
        // By the attribute's value, not a selector: a key is whatever plugins made it.
        const anchor = [...view.dom.querySelectorAll<HTMLElement>('.noto-note-mark')].find((element) => element.dataset.noteMark === key);
        if (!anchor) return false;
        event.preventDefault();
        openCard(view, anchor, key, options, true);
        return true;
      },
    },
    view(view) {
      let restTimer: ReturnType<typeof setTimeout> | null = null;
      const onOver = (event: MouseEvent) => {
        const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('.noto-note-mark');
        if (!target) return;
        const key = target.dataset.noteMark;
        if (!key || card?.key === key) return;
        if (restTimer !== null) clearTimeout(restTimer);
        restTimer = setTimeout(() => {
          restTimer = null;
          if (target.isConnected && target.matches(':hover')) openCard(view, target, key, options, false);
        }, REST_MS);
      };
      const onOut = (event: MouseEvent) => {
        const target = (event.target as HTMLElement | null)?.closest('.noto-note-mark');
        if (target && restTimer !== null && !target.contains(event.relatedTarget as Node | null)) {
          clearTimeout(restTimer);
          restTimer = null;
        }
      };
      view.dom.addEventListener('mouseover', onOver);
      view.dom.addEventListener('mouseout', onOut);
      return {
        update(next) {
          // This note's card, whose mark left the page, goes with it; another note's is not this one's to close.
          if (card?.view === next && !noteMarksKey.getState(next.state)?.marks.has(card.key)) card.close();
        },
        destroy() {
          if (restTimer !== null) clearTimeout(restTimer);
          view.dom.removeEventListener('mouseover', onOver);
          view.dom.removeEventListener('mouseout', onOut);
          if (card?.view === view) card.close();
        },
      };
    },
  });
}

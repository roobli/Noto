/**
 * Draws `<span class="sidenote">` (and `marginnote`) as numbered margin notes,
 * and lets a note be written in the margin.
 *
 * Everything drawn is a decoration. The file keeps every tag; the editor hides
 * them and paints a superscript number, the words a note is about, and the
 * note itself, floated into the right margin when the window has room for it.
 * A note stays in the margin while it is edited: its text is part of the
 * paragraph, so clicking it puts the caret in it.
 *
 * A new note is written in a card in the margin before anything reaches the
 * document: Enter (or leaving the card with something in it) writes the tags
 * and the text in one step, which one Undo takes back; Escape writes nothing.
 *
 * The tags are hidden, so the keys that would delete one on its own are
 * caught: Backspace after a note selects it and a second one removes it whole,
 * Backspace at the start of a note's text does nothing, and an edit that still
 * cuts a note in half takes the other half with it.
 */

import { Mapping } from 'prosemirror-transform';
import { joinBackward } from 'prosemirror-commands';
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Node as ProseNode } from 'prosemirror-model';
import {
  SIDENOTE_CLASS,
  SIDENOTE_MARKER_CLASS,
  normalizeSidenoteBody,
  type SidenoteRange,
} from './sidenote';
import {
  blockHasSidenote,
  insertSidenote,
  rangesInDoc,
  removeSidenote,
} from './sidenote-edit';

/** A note being written: on the words `from`–`to`, or into the empty note at `fill`. */
export interface SidenoteComposer {
  readonly from: number;
  readonly to: number;
  readonly fill: number | null;
}

/** A card's identity, so a second card is drawn new rather than reusing the first one's field. */
interface OpenComposer extends SidenoteComposer {
  readonly serial: number;
}

let composerSerial = 0;

export interface SidenoteState {
  readonly ranges: readonly SidenoteRange[];
  readonly composer: OpenComposer | null;
  /** The note the pointer is on, or on whose words: both are lit. */
  readonly hover: number | null;
  readonly decorations: DecorationSet;
}

type SidenoteMeta =
  | { readonly compose: SidenoteComposer }
  | { readonly close: true }
  | { readonly hover: number | null };

export const sidenoteKey = new PluginKey<SidenoteState>('noto-sidenote');

/** Open the card for a new note. */
export function composeMeta(tr: Transaction, composer: SidenoteComposer): Transaction {
  return tr.setMeta(sidenoteKey, { compose: composer } satisfies SidenoteMeta);
}

const TAG_CLASS = 'noto-inline-tag noto-sidenote-tag';

function markerWidget(index: number): HTMLElement {
  const marker = document.createElement('span');
  marker.className = SIDENOTE_MARKER_CLASS;
  marker.setAttribute('data-sidenote-index', String(index));
  marker.setAttribute('contenteditable', 'false');
  marker.setAttribute('aria-hidden', 'true');
  return marker;
}

/** A note with no text yet: a quiet line in the margin that opens the card. */
function emptyNoteWidget(view: EditorView, getPos: () => number | undefined, index: number): HTMLElement {
  const empty = document.createElement('span');
  empty.className = `${SIDENOTE_CLASS} noto-sidenote-empty`;
  empty.setAttribute('data-sidenote-index', String(index));
  empty.setAttribute('contenteditable', 'false');
  empty.setAttribute('role', 'button');
  empty.textContent = 'Empty note';
  empty.addEventListener('mousedown', (event) => {
    event.preventDefault();
    const at = getPos();
    // Read-only notes take no writing, and an open card is finished first by
    // leaving it, not replaced under the reader's hands.
    if (at === undefined || !view.editable || sidenoteKey.getState(view.state)?.composer) return;
    view.dispatch(composeMeta(view.state.tr, { from: at, to: at, fill: at }));
  });
  return empty;
}

/**
 * Close the card: write what it holds, or nothing. `refocus` is for Enter and
 * Escape, which hand the keys back to the note; a card left by clicking
 * somewhere else must not pull the focus back after it.
 */
function finishComposer(view: EditorView, serial: number, text: string, refocus: boolean): void {
  const composer = sidenoteKey.getState(view.state)?.composer;
  // A card that is no longer the open one, already replaced or closed, writes nothing.
  if (!composer || composer.serial !== serial) return;
  if (!view.editable) text = '';
  const body = normalizeSidenoteBody(text);
  const tr = view.state.tr.setMeta(sidenoteKey, { close: true } satisfies SidenoteMeta);
  if (body) {
    let caret: number;
    if (composer.fill !== null) {
      tr.insertText(body, composer.fill);
      caret = composer.fill + body.length + 1;
    } else {
      caret = insertSidenote(tr, composer.from, composer.to, body);
    }
    if (refocus) tr.setSelection(TextSelection.create(tr.doc, caret));
  } else if (refocus) {
    tr.setSelection(TextSelection.create(tr.doc, composer.from, composer.to));
  }
  view.dispatch(refocus ? tr.scrollIntoView() : tr);
  if (refocus) view.focus();
}

/** The card a new note is written in, drawn where the note will be. */
function composerWidget(view: EditorView, serial: number): HTMLElement {
  const card = document.createElement('span');
  card.className = `${SIDENOTE_CLASS} noto-sidenote-composer`;
  card.setAttribute('contenteditable', 'false');
  const field = document.createElement('textarea');
  field.className = 'noto-sidenote-field';
  field.rows = 1;
  field.placeholder = 'Write a note';
  field.setAttribute('aria-label', 'Sidenote');
  field.spellcheck = true;
  const hint = document.createElement('span');
  hint.className = 'noto-sidenote-hint';
  hint.textContent = 'Enter saves, Esc cancels';
  card.append(field, hint);

  let done = false;
  const finish = (save: boolean, refocus: boolean) => {
    if (done) return;
    done = true;
    finishComposer(view, serial, save ? field.value : '', refocus);
  };
  field.addEventListener('keydown', (event) => {
    // Enter that confirms an input method's word belongs to the input method.
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      finish(true, true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finish(false, true);
    }
  });
  field.addEventListener('input', () => {
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight}px`;
  });
  field.addEventListener('blur', () => finish(true, false));
  requestAnimationFrame(() => { if (!done) field.focus(); });
  return card;
}

function topBlock(state: EditorState, pos: number): number {
  const $pos = state.doc.resolve(pos);
  return $pos.depth > 1 ? $pos.before(1) : $pos.before($pos.depth);
}

function buildDecorations(
  state: EditorState,
  ranges: readonly SidenoteRange[],
  composer: OpenComposer | null,
  hover: number | null,
): DecorationSet {
  const decorations: Decoration[] = [];
  const holding = new Set<number>();
  const { from: selFrom, to: selTo } = state.selection;

  for (const range of ranges) {
    holding.add(topBlock(state, range.openFrom));
    const index = String(range.index);
    const filling = composer?.fill === range.contentFrom;
    const active = filling || (selFrom >= range.contentFrom && selTo <= range.contentTo);
    const lit = active ? ' is-active' : hover === range.index ? ' is-linked' : '';

    const tags: Array<[number, number]> = [[range.openFrom, range.openTo], [range.closeFrom, range.closeTo]];
    if (range.target) {
      tags.push([range.target.openFrom, range.target.openTo], [range.target.closeFrom, range.target.closeTo]);
    }
    for (const [from, to] of tags) decorations.push(Decoration.node(from, to, { class: TAG_CLASS }));

    if (range.target && range.target.contentTo > range.target.contentFrom) {
      decorations.push(Decoration.inline(range.target.contentFrom, range.target.contentTo, {
        class: `noto-sidenote-target${lit}`,
        'data-sidenote-index': index,
      }));
    }

    decorations.push(Decoration.widget(range.openFrom, () => markerWidget(range.index), {
      side: -1,
      key: `sidenote-num-${range.index}`,
      ignoreSelection: true,
    }));

    if (range.contentTo > range.contentFrom) {
      decorations.push(Decoration.inline(range.contentFrom, range.contentTo, {
        class: `${SIDENOTE_CLASS}${lit}`,
        'data-sidenote-index': index,
      }));
    } else if (!filling) {
      decorations.push(Decoration.widget(
        range.contentFrom,
        (view, getPos) => emptyNoteWidget(view, getPos, range.index),
        { side: 1, key: `sidenote-empty-${range.index}`, ignoreSelection: true, stopEvent: () => true },
      ));
    }
  }

  if (composer) {
    const at = composer.fill ?? composer.to;
    holding.add(topBlock(state, at));
    if (composer.fill === null && composer.to > composer.from) {
      decorations.push(Decoration.inline(composer.from, composer.to, { class: 'noto-sidenote-target is-active' }));
    }
    decorations.push(Decoration.widget(at, (view) => composerWidget(view, composer.serial), {
      side: 1,
      key: `sidenote-composer-${composer.serial}`,
      ignoreSelection: true,
      stopEvent: () => true,
    }));
  }

  // A margin note is a float pushed out past the block's right edge. Every
  // top-level block skips painting off screen with `content-visibility: auto`,
  // which also clips what it draws outside its own box. The block holding a
  // note is painted whole instead; a note holds a handful of these at most.
  for (const position of holding) {
    const block = state.doc.nodeAt(position);
    if (block) decorations.push(Decoration.node(position, position + block.nodeSize, { class: 'noto-sidenote-block' }));
  }
  return decorations.length > 0 ? DecorationSet.create(state.doc, decorations) : DecorationSet.empty;
}

function changedMayAddSidenote(tr: Transaction, state: EditorState): boolean {
  let found = false;
  tr.mapping.maps.forEach((map, index) => {
    if (found) return;
    const rest = tr.mapping.slice(index + 1);
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      if (found) return;
      const from = rest.map(newStart, -1);
      const to = rest.map(newEnd, 1);
      state.doc.nodesBetween(Math.min(from, to), Math.max(from, to), (node: ProseNode) => {
        if (!node.isTextblock || node.type.spec.code) return !node.isTextblock;
        if (blockHasSidenote(node)) found = true;
        return false;
      });
    });
  });
  return found;
}

function mapComposer(composer: OpenComposer, mapping: Mapping): OpenComposer | null {
  const caret = composer.from === composer.to;
  const from = mapping.mapResult(composer.from, caret ? -1 : 1);
  const to = mapping.mapResult(composer.to, -1);
  if (from.deleted && to.deleted) return null;
  if (composer.fill !== null) {
    const fill = mapping.mapResult(composer.fill, -1);
    return fill.deleted ? null : { from: fill.pos, to: fill.pos, fill: fill.pos, serial: composer.serial };
  }
  return from.pos <= to.pos ? { from: from.pos, to: to.pos, fill: null, serial: composer.serial } : null;
}

function apply(tr: Transaction, value: SidenoteState, state: EditorState): SidenoteState {
  const meta = tr.getMeta(sidenoteKey) as SidenoteMeta | undefined;
  let composer = value.composer && tr.docChanged ? mapComposer(value.composer, tr.mapping) : value.composer;
  let hover = value.hover;
  if (meta && 'hover' in meta) hover = meta.hover;
  else if (meta) composer = 'compose' in meta ? { ...meta.compose, serial: ++composerSerial } : null;
  if (!tr.docChanged && !tr.selectionSet && composer === value.composer && hover === value.hover) return value;
  // Most notes have no sidenotes: keep the caret path free of a document walk.
  if (value.ranges.length === 0 && composer === null && value.composer === null) {
    if (!tr.docChanged || !changedMayAddSidenote(tr, state)) return value;
  }
  const ranges = tr.docChanged ? rangesInDoc(state.doc) : value.ranges;
  if (hover !== null && !ranges.some((range) => range.index === hover)) hover = null;
  return { ranges, composer, hover, decorations: buildDecorations(state, ranges, composer, hover) };
}

/** The last character, or inline node, before `pos`, deleted; the block joined at its start. */
function deleteBefore(view: EditorView, pos: number): boolean {
  const state = view.state;
  const before = state.doc.resolve(pos).nodeBefore;
  if (!before) {
    const at = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
    return joinBackward(at, (tr) => view.dispatch(tr));
  }
  const size = before.isText ? Array.from(before.text ?? '').pop()!.length : before.nodeSize;
  view.dispatch(state.tr.delete(pos - size, pos).scrollIntoView());
  return true;
}

/** The first character, or inline node, after `pos`, deleted. */
function deleteAfter(view: EditorView, pos: number): boolean {
  const state = view.state;
  const after = state.doc.resolve(pos).nodeAfter;
  if (!after) return true;
  const size = after.isText ? Array.from(after.text ?? '')[0]!.length : after.nodeSize;
  view.dispatch(state.tr.delete(pos, pos + size).scrollIntoView());
  return true;
}

function selectNote(view: EditorView, range: SidenoteRange): boolean {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, range.openFrom, range.closeTo)));
  return true;
}

function remove(view: EditorView, range: SidenoteRange): boolean {
  const tr = view.state.tr;
  removeSidenote(tr, range);
  view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Enter in a note's text leaves the note, the caret after it, rather than
 * splitting it: a sidenote is one line, and its two halves in two paragraphs
 * would no longer be a note, with no tag in sight to mend.
 */
function handleEnter(view: EditorView, ranges: readonly SidenoteRange[]): boolean {
  const { from, to } = view.state.selection;
  const range = ranges.find((candidate) => from >= candidate.contentFrom && to <= candidate.contentTo);
  if (!range) return false;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, range.closeTo)).scrollIntoView());
  return true;
}

/** Backspace and Delete where they would take a hidden tag on its own, and Enter in a note. */
function handleKey(view: EditorView, event: KeyboardEvent): boolean {
  if (!view.editable || event.isComposing) return false;
  const ranges = sidenoteKey.getState(view.state)?.ranges ?? [];
  if (ranges.length === 0) return false;
  if (event.key === 'Enter') return handleEnter(view, ranges);
  if (event.key !== 'Backspace' && event.key !== 'Delete') return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  const selection = view.state.selection;
  if (!selection.empty) {
    // The whole note, as the first Backspace leaves it: it goes with its target's tags.
    const whole = ranges.find((range) => selection.from === range.openFrom && selection.to === range.closeTo);
    return whole ? remove(view, whole) : false;
  }
  const pos = selection.from;
  const backward = event.key === 'Backspace';
  for (const range of ranges) {
    const empty = range.contentFrom === range.contentTo;
    if (backward) {
      if (pos === range.contentFrom) return empty ? remove(view, range) : true;
      if (pos === range.closeTo) return selectNote(view, range);
      if (range.target && pos === range.target.contentFrom) {
        // Right after another note: that note is what goes, selected first.
        const previous = ranges.find((candidate) => candidate.closeTo === range.target!.openFrom);
        return previous ? selectNote(view, previous) : deleteBefore(view, range.target.openFrom);
      }
    } else {
      if (pos === range.contentTo) return empty ? remove(view, range) : true;
      if (pos === (range.target ? range.target.contentTo : range.openFrom)) return selectNote(view, range);
      if (range.target && pos === range.target.openFrom) return deleteAfter(view, range.target.contentFrom);
    }
  }
  return false;
}

/**
 * After an edit, the tags of any note it cut in half: a note that lost one of
 * its tags loses the other, and a target whose note is gone, or that lost one
 * of its own tags, is unwrapped. Only notes that were whole before the edit
 * are touched, so a tag typed by hand, half finished, is left to its author.
 */
function orphanedTags(transactions: readonly Transaction[], oldState: EditorState, state: EditorState): number[] {
  const before = sidenoteKey.getState(oldState)?.ranges ?? [];
  if (before.length === 0 || !transactions.some((tr) => tr.docChanged)) return [];
  const mapping = new Mapping();
  for (const tr of transactions) mapping.appendMapping(tr.mapping);
  const gone = (pos: number) => mapping.mapResult(pos, 1).deleted;
  const doomed: number[] = [];
  const survivor = (pos: number) => {
    const at = mapping.mapResult(pos, 1).pos;
    if (state.doc.nodeAt(at)?.type.name === 'inline_html') doomed.push(at);
  };
  for (const range of before) {
    const openGone = gone(range.openFrom);
    const closeGone = gone(range.closeFrom);
    if (openGone !== closeGone) survivor(openGone ? range.closeFrom : range.openFrom);
    const target = range.target;
    if (!target) continue;
    const targetOpenGone = gone(target.openFrom);
    const targetCloseGone = gone(target.closeFrom);
    const noteGone = openGone || closeGone;
    if (!targetOpenGone && (noteGone || targetCloseGone)) survivor(target.openFrom);
    if (!targetCloseGone && (noteGone || targetOpenGone)) survivor(target.closeFrom);
  }
  return [...new Set(doomed)].sort((a, b) => b - a);
}

/**
 * The caret never rests between a target and its note: typing there would put
 * words between the two and part them. Arrowing in from the left goes on into
 * the note's text, from the right back to the end of the target, and a click
 * lands at the end of the target.
 */
function caretOutOfGap(transactions: readonly Transaction[], oldState: EditorState, state: EditorState): number | null {
  const selection = state.selection;
  if (!selection.empty) return null;
  const range = (sidenoteKey.getState(state)?.ranges ?? [])
    .find((candidate) => candidate.target && candidate.openFrom === selection.from);
  if (!range?.target) return null;
  const pointer = transactions.some((tr) => tr.getMeta('pointer'));
  const fromLeft = oldState.selection.head <= range.target.closeFrom;
  return !pointer && fromLeft ? range.contentFrom : range.target.contentTo;
}

/**
 * Point at a note or its words, and both light up. Through the plugin's state
 * rather than classes set on the page: the editor redraws its own elements and
 * would take a class it did not put there off again.
 */
function linkOnHover(view: EditorView): () => void {
  const light = (index: number | null) => {
    if (sidenoteKey.getState(view.state)?.hover === index) return;
    view.dispatch(view.state.tr.setMeta(sidenoteKey, { hover: index } satisfies SidenoteMeta));
  };
  const over = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target.closest('[data-sidenote-index]') : null;
    const index = Number(target?.getAttribute('data-sidenote-index'));
    light(Number.isInteger(index) && index > 0 ? index : null);
  };
  const leave = () => light(null);
  view.dom.addEventListener('mouseover', over);
  view.dom.addEventListener('mouseleave', leave);
  return () => {
    view.dom.removeEventListener('mouseover', over);
    view.dom.removeEventListener('mouseleave', leave);
  };
}

/**
 * One per editor, put there by the Sidenotes plugin while it is switched on.
 * Off, the plugin is not in the editor at all and the tags stay as source.
 */
export function sidenotePlugin(): Plugin<SidenoteState> {
  return new Plugin<SidenoteState>({
    key: sidenoteKey,
    state: {
      init: (_config, state) => {
        const ranges = rangesInDoc(state.doc);
        return { ranges, composer: null, hover: null, decorations: buildDecorations(state, ranges, null, null) };
      },
      apply: (tr, value, _oldState, state) => apply(tr, value, state),
    },
    props: {
      decorations(state) {
        return this.getState(state)?.decorations ?? DecorationSet.empty;
      },
      // Ahead of the editor's own keymap and paste handling, which run before
      // an extension's `handleKeyDown`: their Enter splits the paragraph.
      handleDOMEvents: {
        keydown(view, event) {
          if (!handleKey(view, event)) return false;
          event.preventDefault();
          return true;
        },
        // Pasted into a note, text arrives as one line: paragraphs would split it.
        paste(view, event) {
          if (!view.editable) return false;
          const ranges = sidenoteKey.getState(view.state)?.ranges ?? [];
          const { from, to } = view.state.selection;
          if (!ranges.some((range) => from >= range.contentFrom && to <= range.contentTo)) return false;
          event.preventDefault();
          const text = normalizeSidenoteBody(event.clipboardData?.getData('text/plain') ?? '');
          if (text) view.dispatch(view.state.tr.insertText(text, from, to).scrollIntoView());
          return true;
        },
      },
    },
    appendTransaction(transactions, oldState, state) {
      const doomed = orphanedTags(transactions, oldState, state);
      const caret = doomed.length === 0 ? caretOutOfGap(transactions, oldState, state) : null;
      if (doomed.length === 0 && caret === null) return null;
      const tr = state.tr;
      for (const at of doomed) tr.delete(at, at + 1);
      if (caret !== null) tr.setSelection(TextSelection.create(tr.doc, caret));
      return tr;
    },
    view(editorView) {
      let known: boolean | null = null;
      const sync = (view: EditorView) => {
        const host = view.dom.closest('.noto-editor-host') ?? view.dom;
        // From the state already computed: no walk of the document per keystroke.
        const value = sidenoteKey.getState(view.state);
        const has = !!value && (value.ranges.length > 0 || value.composer !== null);
        if (has === known) return;
        known = has;
        host.classList.toggle('noto-has-sidenotes', has);
      };
      // Once now as well: `update` first runs on the first transaction, so a
      // note just opened set its notes inline until something was pressed.
      sync(editorView);
      const unlink = linkOnHover(editorView);
      return {
        update: sync,
        // Switched off, the plugin leaves the editor: the gutter it reserved
        // goes with it.
        destroy() {
          unlink();
          (editorView.dom.closest('.noto-editor-host') ?? editorView.dom).classList.remove('noto-has-sidenotes');
        },
      };
    },
  });
}

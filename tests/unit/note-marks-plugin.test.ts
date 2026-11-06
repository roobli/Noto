// @vitest-environment happy-dom
/**
 * Marks on the note in front: drawn where their words are, kept out of the
 * history, following the text as it is typed and gone once their words are
 * edited; an action that replaces the words is one edit Undo takes back, and
 * tells the plugin after; and a note that cannot be edited keeps its mark.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { history, undo } from 'prosemirror-history';
import { splitBlocks } from '../../src/shared/markdown/v3/blocks';
import { docFromSpans } from '../../src/shared/markdown/v3/pm/from-mdast';
import { closeNoteMarkCard, noteMarkRange, noteMarksPlugin, runNoteMarkAction, setNoteMarks, type NoteMarkView } from '../../src/renderer/editor/noto/note-marks-plugin';

const ARGUS: NoteMarkView = {
  key: 'dev.example:links#abc1234', text: 'Argus', before: 'Read ', after: ' first.', kind: 'Link suggestion', title: 'Link to Argus',
  actions: [{ id: 'link', label: 'Link', replace: '[[Argus]]' }, { id: 'dismiss', label: 'Not This' }],
};

const views: EditorView[] = [];
afterEach(() => {
  closeNoteMarkCard();
  for (const view of views.splice(0)) { view.dom.remove(); view.destroy(); }
});

function viewOf(markdown: string, onAction = vi.fn(), editable = true): { view: EditorView; onAction: typeof onAction } {
  const state = EditorState.create({ doc: docFromSpans(splitBlocks(markdown).spans), plugins: [history(), noteMarksPlugin({ onAction })] });
  const mount = document.createElement('div');
  document.body.append(mount);
  const view = new EditorView(mount, { state, editable: () => editable });
  views.push(view);
  view.dispatch(setNoteMarks(view.state.tr, [ARGUS]));
  return { view, onAction };
}

const text = (view: EditorView) => view.state.doc.textContent;

describe('a mark on the note', () => {
  it('is drawn where its words are, and is no edit', () => {
    const { view } = viewOf('Read Argus first.\n');
    const range = noteMarkRange(view.state, ARGUS.key)!;
    expect(view.state.doc.textBetween(range.from, range.to)).toBe('Argus');
    expect(view.dom.querySelector('[data-testid="note-mark"]')?.textContent).toBe('Argus');
    expect(undo(view.state, view.dispatch)).toBe(false);
  });

  it('follows the text typed before it, and goes once its own words are edited', () => {
    const { view } = viewOf('Read Argus first.\n');
    view.dispatch(view.state.tr.insertText('Do ', 1));
    expect(view.state.doc.textBetween(noteMarkRange(view.state, ARGUS.key)!.from, noteMarkRange(view.state, ARGUS.key)!.to)).toBe('Argus');
    const range = noteMarkRange(view.state, ARGUS.key)!;
    view.dispatch(view.state.tr.insertText('X', range.from + 2));
    expect(noteMarkRange(view.state, ARGUS.key)).toBeNull();
  });

  it('puts the link in place of the words as one edit Undo takes back, and tells the plugin after', () => {
    const { view, onAction } = viewOf('Read Argus first.\n');
    runNoteMarkAction(view, ARGUS.key, 'link', { onAction });
    expect(text(view)).toBe('Read [[Argus]] first.');
    expect(onAction).toHaveBeenCalledWith(ARGUS.key, 'link');
    expect(noteMarkRange(view.state, ARGUS.key)).toBeNull();
    undo(view.state, view.dispatch);
    expect(text(view)).toBe('Read Argus first.');
  });

  it('finds a mark again when Undo brings its words back and the same marks come', () => {
    const { view, onAction } = viewOf('Read Argus first.\n');
    runNoteMarkAction(view, ARGUS.key, 'link', { onAction });
    undo(view.state, view.dispatch);
    view.dispatch(setNoteMarks(view.state.tr, [ARGUS]));
    expect(noteMarkRange(view.state, ARGUS.key)).not.toBeNull();
  });

  it('leaves the words alone for an action that does not replace them', () => {
    const { view, onAction } = viewOf('Read Argus first.\n');
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
    runNoteMarkAction(view, ARGUS.key, 'dismiss', { onAction });
    expect(text(view)).toBe('Read Argus first.');
    expect(onAction).toHaveBeenCalledWith(ARGUS.key, 'dismiss');
    expect(noteMarkRange(view.state, ARGUS.key)).toBeNull();
  });

  it('keeps its mark in a note that cannot be edited, since nothing was done', () => {
    const { view, onAction } = viewOf('Read Argus first.\n', vi.fn(), false);
    runNoteMarkAction(view, ARGUS.key, 'link', { onAction });
    expect(text(view)).toBe('Read Argus first.');
    expect(onAction).not.toHaveBeenCalled();
    expect(noteMarkRange(view.state, ARGUS.key)).not.toBeNull();
  });

  it('opens its card from the keyboard with the caret in its words, whatever its key is made of', () => {
    const odd: NoteMarkView = { ...ARGUS, key: 'plugin:"links"\u0000#1' };
    const state = EditorState.create({ doc: docFromSpans(splitBlocks('Read Argus first.\n').spans), plugins: [noteMarksPlugin({ onAction: vi.fn() })] });
    const mount = document.createElement('div');
    document.body.append(mount);
    const view = new EditorView(mount, { state });
    views.push(view);
    view.dispatch(setNoteMarks(view.state.tr, [odd]));
    const range = noteMarkRange(view.state, odd.key)!;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, range.from + 2)));
    view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true, cancelable: true }));
    const card = document.querySelector('[data-testid="note-mark-card"]');
    expect(card?.textContent).toContain('Link to Argus');
    expect(document.activeElement?.getAttribute('data-testid')).toBe('note-mark-action-link');
  });
});

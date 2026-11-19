import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { notoSchema } from '../../src/shared/markdown/v3/pm/schema';
import { activeNodePlugin } from '../../src/renderer/editor/noto/active-node-plugin';
import { markBoundaryKey, markBoundaryPlugin } from '../../src/renderer/editor/noto/mark-boundary';

const { nodes, marks } = notoSchema;

/** `**abc** tail`, the bold at the head of the line. */
function boldFirst(): EditorState {
  const doc = nodes.doc.create(null, [
    nodes.paragraph.create(null, [notoSchema.text('abc', [marks.strong.create()]), notoSchema.text(' tail')]),
  ]);
  return EditorState.create({ doc, plugins: [activeNodePlugin(), markBoundaryPlugin(true)] });
}

const at = (state: EditorState, position: number, meta?: Record<string, unknown>) => {
  const tr = state.tr.setSelection(TextSelection.create(state.doc, position));
  for (const [key, value] of Object.entries(meta ?? {})) tr.setMeta(key, value);
  return state.applyTransaction(tr).state;
};

const typeHere = (state: EditorState, text: string) => state.applyTransaction(state.tr.insertText(text)).state;

describe('the two places either side of a revealed delimiter', () => {
  it('forgets a Home that moved nothing once anything else is pressed', () => {
    // At the head of the line already: Home is pressed, and nothing changes.
    let state = at(boldFirst(), 1);
    const plugin = state.plugins.find((p) => (p as unknown as { key: string }).key === (markBoundaryKey as unknown as { key: string }).key)!;
    const view = { state, dispatch: (tr: never) => { state = state.apply(tr); } } as never;
    const key = (name: string) => ({ key: name, altKey: false, shiftKey: false, metaKey: false, ctrlKey: false }) as KeyboardEvent;
    plugin.props.handleKeyDown!.call(plugin, view, key('Home'));
    plugin.props.handleDOMEvents!.mousedown!.call(plugin, view, {} as MouseEvent);
    // A click on the bold's closing edge is a click there, not the line's edge: inside, as it is.
    state = at(state, 4, { pointer: true });
    expect(markBoundaryKey.getState(state)).toMatchObject({ edge: 'close', side: 'inside' });
  });

  it('reaches the place before ** at the head of a line, where typing is plain', () => {
    // Arriving from inside the bold, at its opening edge: inside, as before.
    let state = at(at(boldFirst(), 3), 1);
    expect(markBoundaryKey.getState(state)).toMatchObject({ edge: 'open', side: 'inside' });
    // A plain character typed outside is not bold; typed inside it is.
    const plugin = state.plugins.find((p) => (p as unknown as { key: string }).key === (markBoundaryKey as unknown as { key: string }).key)!;
    const handled = plugin.props.handleKeyDown!.call(plugin, {
      state,
      dispatch: (tr: never) => { state = state.apply(tr); },
    } as never, { key: 'ArrowLeft', altKey: false, shiftKey: false, metaKey: false, ctrlKey: false } as KeyboardEvent);
    expect(handled).toBe(true);
    expect(markBoundaryKey.getState(state)).toMatchObject({ side: 'outside' });
    const typed = typeHere(state, 'X');
    expect(typed.doc.firstChild!.child(0).text).toBe('X');
    expect(typed.doc.firstChild!.child(0).marks).toHaveLength(0);
    expect(typed.doc.firstChild!.child(1).text).toBe('abc');
  });

  it('takes a click at the head of the line as a click before the **, and one at a closing edge as it is', () => {
    let state = at(at(boldFirst(), 2), 1, { pointer: true });
    expect(markBoundaryKey.getState(state)).toMatchObject({ edge: 'open', side: 'outside' });
    expect(typeHere(state, 'Y').doc.firstChild!.child(0).marks).toHaveLength(0);
    state = at(at(boldFirst(), 8), 4, { pointer: true });
    expect(markBoundaryKey.getState(state)).toMatchObject({ edge: 'close', side: 'inside' });
    expect(typeHere(state, 'Y').doc.firstChild!.child(0).text).toBe('abcY');
  });

  it('steps across the closing ** without moving through the text', () => {
    let state = at(at(boldFirst(), 2), 4);
    expect(markBoundaryKey.getState(state)).toMatchObject({ edge: 'close', side: 'inside' });
    const plugin = state.plugins.find((p) => (p as unknown as { key: string }).key === (markBoundaryKey as unknown as { key: string }).key)!;
    plugin.props.handleKeyDown!.call(plugin, {
      state, dispatch: (tr: never) => { state = state.apply(tr); },
    } as never, { key: 'ArrowRight', altKey: false, shiftKey: false, metaKey: false, ctrlKey: false } as KeyboardEvent);
    expect(state.selection.head).toBe(4);
    expect(markBoundaryKey.getState(state)).toMatchObject({ side: 'outside' });
    const typed = typeHere(state, 'Z');
    expect(typed.doc.firstChild!.textContent).toBe('abcZ tail');
    expect(typed.doc.firstChild!.child(0).text).toBe('abc');
  });
});

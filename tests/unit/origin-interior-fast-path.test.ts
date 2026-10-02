import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { notoSchema } from '../../src/shared/markdown/v3/pm/schema';
import {
  createOriginPlugin,
  getBlockOrigins,
  originKey,
} from '../../src/renderer/editor/noto/origin-plugin';
import type { NotoBlockOrigin } from '../../src/shared/markdown/v3/contracts';

function para(text: string) {
  return notoSchema.nodes.paragraph.create(null, notoSchema.text(text));
}

function originsFor(count: number): NotoBlockOrigin[] {
  return Array.from({ length: count }, (_, ordinal) => ({
    blockId: `noto-block-v3:${ordinal}:test` as NotoBlockOrigin['blockId'],
    ordinal,
    kind: 'paragraph',
    semanticKey: '',
  }));
}

describe('origin interior fast path', () => {
  it('reuses the origins array for an in-block keystroke', () => {
    const doc = notoSchema.nodes.doc.create(null, [para('one'), para('two'), para('three')]);
    const initial = originsFor(3);
    const state = EditorState.create({ doc, plugins: [createOriginPlugin(initial)] });
    const before = originKey.getState(state)!;
    const pos = 1; // inside first paragraph
    const next = state.apply(state.tr.insertText('X', pos));
    const after = originKey.getState(next)!;
    expect(after).toBe(before);
    expect(getBlockOrigins(next)).toBe(before.origins);
  });

  it('remaps when two top-level blocks merge', () => {
    const doc = notoSchema.nodes.doc.create(null, [para('one'), para('two'), para('three')]);
    const initial = originsFor(3);
    const state = EditorState.create({ doc, plugins: [createOriginPlugin(initial)] });
    // Delete the gap between first and second paragraph (positions: 0, p'one'=5 incl node, then second starts at 5)
    // doc: <p>one</p><p>two</p><p>three</p>
    // positions: 0 | 1 o n e 4 | 5 | 6 t w o 9 | 10 | ...
    const joinPos = 5; // between blocks
    const next = state.apply(state.tr.join(joinPos));
    expect(next.doc.childCount).toBe(2);
    const origins = getBlockOrigins(next);
    expect(origins).toHaveLength(2);
    // Surviving merged block keeps one of the origins (first that maps)
    expect(origins[0]?.blockId).toBe(initial[0]!.blockId);
    expect(origins[1]?.blockId).toBe(initial[2]!.blockId);
  });

  it('remaps when a top-level block is split', () => {
    const doc = notoSchema.nodes.doc.create(null, [para('abcdef'), para('tail')]);
    const initial = originsFor(2);
    const state = EditorState.create({ doc, plugins: [createOriginPlugin(initial)] });
    // Split inside first paragraph after 'abc'
    const next = state.apply(state.tr.split(4));
    expect(next.doc.childCount).toBe(3);
    const origins = getBlockOrigins(next);
    expect(origins).toHaveLength(3);
    // One origin survives onto one of the split halves; the other half is null
    const kept = origins.filter(Boolean);
    expect(kept.length).toBeGreaterThanOrEqual(1);
    expect(origins[2]?.blockId).toBe(initial[1]!.blockId);
  });

  it('remaps when a top-level block is deleted', () => {
    const doc = notoSchema.nodes.doc.create(null, [para('one'), para('two'), para('three')]);
    const initial = originsFor(3);
    const state = EditorState.create({ doc, plugins: [createOriginPlugin(initial)] });
    // Delete second paragraph entirely: from 5 to 10
    const next = state.apply(state.tr.delete(5, 10));
    expect(next.doc.childCount).toBe(2);
    const origins = getBlockOrigins(next);
    expect(origins.map((o) => o?.blockId)).toEqual([
      initial[0]!.blockId,
      initial[2]!.blockId,
    ]);
  });
});

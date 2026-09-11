/**
 * Textblock-scoped source reveal (feel acceptance for list / MOC indexes).
 *
 * Wiki-link brackets must not light up every sibling in a list when the caret
 * is in one item. The active-node plugin marks only the caret's own textblock
 * with `.noto-source-editing`; the stylesheet hides brackets elsewhere.
 *
 * Acceptance (block scope; span-level wiki deferred):
 * - Caret in one list item → only that item's paragraph is `.noto-source-editing`
 * - Caret moves to a sibling → the mark moves with it
 * - Focused paragraph with several `[[…]]` → whole paragraph marked (all brackets
 *   in that paragraph may reveal; not span-scoped yet)
 */

import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { DecorationSet } from 'prosemirror-view';
import { notoSchema } from '../../src/shared/markdown/v3/pm/schema';
import { activeNodePlugin, activeNodeKey } from '../../src/renderer/editor/noto/active-node-plugin';

function listOfLinks(kind: 'bullet_list' | 'ordered_list' = 'bullet_list'): EditorState {
  const item = (text: string) => notoSchema.node('list_item', null, [
    notoSchema.node('paragraph', null, [notoSchema.text(text)]),
  ]);
  const doc = notoSchema.node('doc', null, [
    notoSchema.node(kind, null, [
      item('[[a|Alpha]]'),
      item('[[b|Beta]]'),
      item('[[c|Gamma]]'),
      item('[[d|Delta]]'),
      item('[[e|Epsilon]]'),
    ]),
  ]);
  return EditorState.create({
    doc,
    plugins: [activeNodePlugin()],
  });
}

/** Node decorations store `class` on the type attrs, not always on `spec`. */
function decorationClass(decoration: {
  readonly spec: unknown;
  readonly type?: { readonly attrs?: { readonly class?: string } };
}): string {
  const spec = decoration.spec as { class?: string; attrs?: { class?: string } } | null;
  if (spec && typeof spec.class === 'string') return spec.class;
  if (spec?.attrs && typeof spec.attrs.class === 'string') return spec.attrs.class;
  const attrs = decoration.type?.attrs;
  if (attrs && typeof attrs.class === 'string') return attrs.class;
  return '';
}

function sourceEditingRanges(state: EditorState): Array<{ from: number; to: number }> {
  const set = activeNodeKey.getState(state) as DecorationSet | undefined;
  if (!set) return [];
  return set.find()
    .filter((decoration) => decorationClass(decoration).split(/\s+/).includes('noto-source-editing'))
    .map((decoration) => ({ from: decoration.from, to: decoration.to }));
}

function caretInText(state: EditorState, needle: string): EditorState {
  let pos = -1;
  state.doc.descendants((node, p) => {
    if (node.isText && node.text?.includes(needle)) {
      pos = p + 1;
      return false;
    }
    return true;
  });
  expect(pos).toBeGreaterThan(0);
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
}

describe('source-editing textblock mark', () => {
  it('marks only the list item paragraph that holds the caret', () => {
    const state = caretInText(listOfLinks(), 'Beta');
    const ranges = sourceEditingRanges(state);
    expect(ranges).toHaveLength(1);
    const text = state.doc.textBetween(ranges[0].from, ranges[0].to);
    expect(text).toContain('Beta');
    expect(text).not.toContain('Alpha');
    expect(text).not.toContain('Gamma');
    expect(text).not.toContain('Delta');
    expect(text).not.toContain('Epsilon');
  });

  it('moves the mark when the caret moves to a sibling item (MOC feel)', () => {
    const base = listOfLinks();
    const onBeta = caretInText(base, 'Beta');
    expect(onBeta.doc.textBetween(
      sourceEditingRanges(onBeta)[0].from,
      sourceEditingRanges(onBeta)[0].to,
    )).toContain('Beta');

    const onDelta = caretInText(onBeta, 'Delta');
    const ranges = sourceEditingRanges(onDelta);
    expect(ranges).toHaveLength(1);
    const text = onDelta.doc.textBetween(ranges[0].from, ranges[0].to);
    expect(text).toContain('Delta');
    expect(text).not.toContain('Beta');
    expect(text).not.toContain('Alpha');
  });

  it('scopes the same way in an ordered list', () => {
    const state = caretInText(listOfLinks('ordered_list'), 'Gamma');
    const ranges = sourceEditingRanges(state);
    expect(ranges).toHaveLength(1);
    const text = state.doc.textBetween(ranges[0].from, ranges[0].to);
    expect(text).toContain('Gamma');
    expect(text).not.toContain('Alpha');
    expect(text).not.toContain('Epsilon');
  });

  it('marks a top-level paragraph when that is where the caret sits', () => {
    const doc = notoSchema.node('doc', null, [
      notoSchema.node('paragraph', null, [notoSchema.text('[[only|One]]')]),
      notoSchema.node('paragraph', null, [notoSchema.text('plain')]),
    ]);
    const base = EditorState.create({ doc, plugins: [activeNodePlugin()] });
    const state = caretInText(base, 'One');
    const ranges = sourceEditingRanges(state);
    expect(ranges).toHaveLength(1);
    expect(state.doc.textBetween(ranges[0].from, ranges[0].to)).toContain('One');
  });

  it('marks the whole focused paragraph when it holds several wiki links (span scope deferred)', () => {
    const doc = notoSchema.node('doc', null, [
      notoSchema.node('paragraph', null, [
        notoSchema.text('See [[a|Alpha]] and [[b|Beta]] together.'),
      ]),
      notoSchema.node('paragraph', null, [notoSchema.text('[[c|Gamma]] alone.')]),
    ]);
    const base = EditorState.create({ doc, plugins: [activeNodePlugin()] });
    const state = caretInText(base, 'Alpha');
    const ranges = sourceEditingRanges(state);
    expect(ranges).toHaveLength(1);
    const text = state.doc.textBetween(ranges[0].from, ranges[0].to);
    expect(text).toContain('Alpha');
    expect(text).toContain('Beta');
    expect(text).not.toContain('Gamma');
  });
});

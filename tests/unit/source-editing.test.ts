/**
 * Textblock-scoped source reveal.
 *
 * Wiki-link brackets must not light up every sibling in a list when the caret
 * is in one item. The active-node plugin marks only the caret's own textblock
 * with `.noto-source-editing`; the stylesheet hides brackets elsewhere.
 */

import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { DecorationSet } from 'prosemirror-view';
import { notoSchema } from '../../src/shared/markdown/v3/pm/schema';
import { activeNodePlugin, activeNodeKey } from '../../src/renderer/editor/noto/active-node-plugin';

function listOfLinks(): EditorState {
  const item = (text: string) => notoSchema.node('list_item', null, [
    notoSchema.node('paragraph', null, [notoSchema.text(text)]),
  ]);
  const doc = notoSchema.node('doc', null, [
    notoSchema.node('bullet_list', null, [
      item('[[a|Alpha]]'),
      item('[[b|Beta]]'),
      item('[[c|Gamma]]'),
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

describe('source-editing textblock mark', () => {
  it('marks only the list item paragraph that holds the caret', () => {
    const base = listOfLinks();
    let betaPos = -1;
    base.doc.descendants((node, pos) => {
      if (node.isText && node.text?.includes('Beta')) {
        betaPos = pos + 1;
        return false;
      }
      return true;
    });
    expect(betaPos).toBeGreaterThan(0);

    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, betaPos)));
    const ranges = sourceEditingRanges(state);
    expect(ranges).toHaveLength(1);
    const text = state.doc.textBetween(ranges[0].from, ranges[0].to);
    expect(text).toContain('Beta');
    expect(text).not.toContain('Alpha');
    expect(text).not.toContain('Gamma');
  });

  it('marks a top-level paragraph when that is where the caret sits', () => {
    const doc = notoSchema.node('doc', null, [
      notoSchema.node('paragraph', null, [notoSchema.text('[[only|One]]')]),
      notoSchema.node('paragraph', null, [notoSchema.text('plain')]),
    ]);
    const base = EditorState.create({ doc, plugins: [activeNodePlugin()] });
    let pos = -1;
    base.doc.descendants((node, p) => {
      if (node.isText && node.text?.includes('One')) {
        pos = p + 1;
        return false;
      }
      return true;
    });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, pos)));
    const ranges = sourceEditingRanges(state);
    expect(ranges).toHaveLength(1);
    expect(state.doc.textBetween(ranges[0].from, ranges[0].to)).toContain('One');
  });
});

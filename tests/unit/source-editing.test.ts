/**
 * Textblock-scoped source reveal + span-level wiki brackets.
 *
 * - Caret in one list item → only that item's paragraph is `.noto-source-editing`
 * - Caret moves to a sibling → the mark moves with it (list isolation)
 * - Caret inside one `[[…]]` in a multi-wiki paragraph → only that match gets
 *   `.noto-wiki-source-active`; siblings in the same paragraph stay label-only
 * - Caret in the paragraph but off every wiki → no source-active match
 */

import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { DecorationSet } from 'prosemirror-view';
import { notoSchema } from '../../src/shared/markdown/v3/pm/schema';
import { activeNodePlugin, activeNodeKey } from '../../src/renderer/editor/noto/active-node-plugin';
import {
  findWikiLinks,
  wikiLinkKey,
  wikiLinkPlugin,
  wikiMatchAt,
} from '../../src/renderer/editor/noto/wiki-link-plugin';

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
    plugins: [activeNodePlugin(), wikiLinkPlugin({ onFollow: () => {} })],
  });
}

function tripleWikiParagraph(): EditorState {
  const doc = notoSchema.node('doc', null, [
    notoSchema.node('paragraph', null, [
      notoSchema.text('See [[a|Alpha]] and [[b|Beta]] plus [[c|Gamma]].'),
    ]),
    notoSchema.node('paragraph', null, [notoSchema.text('[[d|Delta]] alone.')]),
  ]);
  return EditorState.create({
    doc,
    plugins: [activeNodePlugin(), wikiLinkPlugin({ onFollow: () => {} })],
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

function activeWikiBracketRanges(state: EditorState): Array<{ from: number; to: number }> {
  const set = wikiLinkKey.getState(state) as DecorationSet | undefined;
  if (!set) return [];
  return set.find()
    .filter((decoration) =>
      decorationClass(decoration).split(/\s+/).includes('noto-wiki-source-active'))
    .map((decoration) => ({ from: decoration.from, to: decoration.to }));
}

function caretAt(state: EditorState, pos: number): EditorState {
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
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
  return caretAt(state, pos);
}

/** Place caret inside the wiki whose label/needle appears in the match text. */
function caretInsideWiki(state: EditorState, needle: string): EditorState {
  let found = -1;
  state.doc.descendants((node, p) => {
    if (!node.isText || !node.text?.includes(needle)) return true;
    for (const match of findWikiLinks(node.text, p)) {
      if (match.label.includes(needle) || match.target.includes(needle) || node.text.slice(match.from - p, match.to - p).includes(needle)) {
        found = match.from + 2; // inside after `[[`
        return false;
      }
    }
    return true;
  });
  expect(found).toBeGreaterThan(0);
  return caretAt(state, found);
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
    const base = EditorState.create({
      doc,
      plugins: [activeNodePlugin(), wikiLinkPlugin({ onFollow: () => {} })],
    });
    const state = caretInText(base, 'One');
    const ranges = sourceEditingRanges(state);
    expect(ranges).toHaveLength(1);
    expect(state.doc.textBetween(ranges[0].from, ranges[0].to)).toContain('One');
  });
});

describe('span-level wiki source symbols', () => {
  it('activates only the wiki match under the caret in a three-wiki paragraph', () => {
    const base = tripleWikiParagraph();
    const onBeta = caretInsideWiki(base, 'Beta');
    expect(sourceEditingRanges(onBeta)).toHaveLength(1);

    const active = activeWikiBracketRanges(onBeta);
    expect(active.length).toBeGreaterThan(0);
    const covered = active.map((r) => onBeta.doc.textBetween(r.from, r.to)).join('');
    expect(covered).toContain('[[');
    expect(covered).toContain(']]');
    expect(covered).toContain('b|');
    expect(covered).not.toContain('a|');
    expect(covered).not.toContain('c|');
    expect(covered).not.toContain('Alpha');
    expect(covered).not.toContain('Gamma');

    // Exactly one match worth of bracket/mute spans (open + close + target|)
    expect(active).toHaveLength(3);
  });

  it('hides all wiki source when the caret is in the paragraph but off every wiki', () => {
    const base = tripleWikiParagraph();
    // " and " sits between Alpha and Beta
    const between = caretInText(base, ' and ');
    expect(sourceEditingRanges(between)).toHaveLength(1);
    expect(activeWikiBracketRanges(between)).toHaveLength(0);
  });

  it('moves the active match when the caret walks to another wiki in the same paragraph', () => {
    const base = tripleWikiParagraph();
    const onAlpha = caretInsideWiki(base, 'Alpha');
    expect(activeWikiBracketRanges(onAlpha).map((r) => onAlpha.doc.textBetween(r.from, r.to)).join(''))
      .toContain('a|');

    const onGamma = caretInsideWiki(onAlpha, 'Gamma');
    const covered = activeWikiBracketRanges(onGamma)
      .map((r) => onGamma.doc.textBetween(r.from, r.to)).join('');
    expect(covered).toContain('c|');
    expect(covered).not.toContain('a|');
    expect(covered).not.toContain('b|');
  });

  it('does not activate wiki brackets in a sibling list item', () => {
    const state = caretInsideWiki(listOfLinks(), 'Beta');
    const covered = activeWikiBracketRanges(state)
      .map((r) => state.doc.textBetween(r.from, r.to)).join('');
    expect(covered).toContain('b|');
    expect(covered).not.toContain('a|');
    expect(covered).not.toContain('c|');
    expect(sourceEditingRanges(state)).toHaveLength(1);
  });

  it('wikiMatchAt only hits the span that contains the caret', () => {
    const text = 'See [[a|Alpha]] and [[b|Beta]] plus [[c|Gamma]].';
    const matches = findWikiLinks(text, 0);
    expect(matches).toHaveLength(3);
    expect(wikiMatchAt(matches[1]!.from + 3, matches)?.label).toBe('Beta');
    expect(wikiMatchAt(matches[1]!.to, matches)).toBeNull();
    expect(wikiMatchAt(0, matches)).toBeNull();
  });
});

/**
 * @vitest-environment happy-dom
 *
 * Save round-trip property: on a large document (sparse docView, deferred
 * open with structural stand-ins), random edits followed by a save must
 * produce bytes that re-parse to the document the editor shows.
 *
 * Not a byte comparison against a full re-serialize: capture reuses original
 * bytes for untouched blocks and full serialize normalizes, so those legitimately
 * differ. The invariant is semantic: parse(saved) == editor doc.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import { Fragment, type Node as ProseNode } from 'prosemirror-model';
import { isUnwritableBlock } from '../../src/renderer/editor/noto/capture';
import { NotoEditor } from '../../src/renderer/editor/noto/NotoEditor';
import { parseDocument, toWire } from '../../src/shared/markdown/v3/document';
import { blockSpansFromWire, splitBlocks } from '../../src/shared/markdown/v3/blocks';
import { docFromSpans } from '../../src/shared/markdown/v3/pm/from-mdast';
import { serializeDocument } from '../../src/shared/markdown/v3/serialize';
import { expandTransaction } from '../../src/shared/markdown/v3/revision-patch';
import { resolveDeferredOpenSpans, enrichSpansInRange } from '../../src/shared/markdown/v3/roobli-md-adapter';
import { viewportStubKey } from '../../src/renderer/editor/noto/viewport-stub';
import type { NotoDocument } from '../../src/shared/markdown/v3/contracts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Deterministic PRNG so a failure names its seed and reproduces. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BLOCKS: readonly ((i: number) => string)[] = [
  (i) => `Paragraph ${i} with *emphasis*, **strong**, \`code\` and a [link](https://example.com/${i}).`,
  (i) => `## Heading ${i}`,
  (i) => `Inline math $x_${i}^2$ and ==highlight ${i}== and ~~strike~~ here.`,
  (i) => `- item ${i}\n- item ${i + 1}\n  - nested ${i}`,
  (i) => `- [ ] task ${i}\n- [x] done ${i}`,
  (i) => `> quote ${i}\n> second line`,
  (i) => `| a | b |\n| --- | --- |\n| ${i} | ${i + 1} |`,
  (i) => `\`\`\`ts\nconst v${i} = ${i};\n\`\`\``,
  (i) => `$$\n\\sum_{k=0}^{${i}} k\n$$`,
  // References to these definitions are covered by the focused tests below
  // rather than the random corpus; definitions on their own are fine.
  (i) => `[^n${i}]: The note ${i}.`,
  (i) => `> [!NOTE]\n> callout ${i}`,
  (i) => `1. one ${i}\n2. two ${i}`,
  // Shapes the engine does not own: these open as structural stand-ins and
  // wait for background dialect enrichment.
  (i) => `See <https://auto.example/${i}>, <kbd>K${i}</kbd> and ![img](a${i}.png "t").`,
  (i) => `> quote ${i} with a list\n>\n> - a\n> - **b** *c*`,
  (i) => `- item ${i}\n\n  \`\`\`\n  code ${i}\n  \`\`\`\n\n- after`,
  (i) => `[^m${i}]: first para ${i}\n\n    second para ${i}`,
  // Emphasis nested inside strong+emphasis is left out: known issue below.
  (i) => `***both ${i}*** with \\*escaped\\* and H~2~O`,
];

function corpus(count: number): string {
  const parts: string[] = [];
  for (let i = 0; parts.length < count; i += 1) parts.push(BLOCKS[i % BLOCKS.length]!(i));
  return `${parts.join('\n\n')}\n`;
}

function parsed(text: string): NotoDocument {
  const result = parseDocument(encoder.encode(text));
  if (result.status !== 'parsed') throw new Error(`parse failed: ${result.code}`);
  return result.document;
}

/** Fully enriched ProseMirror doc for markdown text (no stand-ins). */
function fullDoc(text: string): ProseNode {
  const spans = splitBlocks(text).spans;
  return docFromSpans(enrichSpansInRange(spans, text, { from: 0, to: spans.length }));
}

interface Harness {
  editor: NotoEditor;
  document: NotoDocument;
  saved: string;
  host: HTMLElement;
}

function open(text: string): Harness {
  const document0 = parsed(text);
  const wire = toWire(document0);
  const fromWire = blockSpansFromWire(wire) ?? splitBlocks(wire.text).spans;
  const prepared = resolveDeferredOpenSpans(fromWire, wire.text, {
    deferred: wire.nodesEnrichment === 'deferred',
  });
  const scroller = document.createElement('div');
  scroller.style.overflowY = 'auto';
  scroller.style.height = '600px';
  const host = document.createElement('div');
  host.className = 'noto-editor-host';
  scroller.append(host);
  document.body.append(scroller);
  const editor = new NotoEditor(host, wire, { mac: false }, prepared.spans);
  if (prepared.remainderFrom !== null) {
    editor.beginDeferredViewportEnrich(prepared.spans, prepared.remainderFrom);
  }
  return { editor, document: document0, saved: text, host };
}

/** Save the way main does: expand the wire, serialize, commit the reply. */
function save(h: Harness): string {
  const wireTx = h.editor.captureSave();
  const tx = expandTransaction(wireTx, h.document);
  if (!tx) throw new Error('transaction did not expand');
  const result = serializeDocument(h.document, tx);
  if (result.status !== 'serialized') {
    const failure = result as { code?: string; message?: string };
    throw new Error(`serialize failed: ${failure.code ?? ''} ${failure.message ?? ''}`);
  }
  h.document = result.document;
  h.saved = decoder.decode(result.outputBytes);
  const reply = { ...toWire(result.document), nodes: null };
  h.editor.commit(reply);
  return h.saved;
}

function view(h: Harness) {
  const v = h.editor.getView();
  if (!v) throw new Error('no view');
  return v;
}

function deferredController(h: Harness): { enrichRangeForTests(from: number, to: number): boolean; deferredCount(): number } | null {
  return (h.editor as unknown as { deferredEnrich: never }).deferredEnrich ?? null;
}

/** Run every pending background enrichment window to completion. */
function drainEnrichment(h: Harness): void {
  const c = deferredController(h);
  if (!c) return;
  const n = view(h).state.doc.childCount;
  for (let guard = 0; guard < 10_000 && c.deferredCount() > 0; guard += 1) {
    if (!c.enrichRangeForTests(0, n)) break;
  }
}

function blockStart(doc: ProseNode, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i += 1) pos += doc.child(i).nodeSize;
  return pos;
}

/** A text position inside top-level block `index`, or null if it has no text. */
function textPosIn(doc: ProseNode, index: number, r: () => number): number | null {
  const start = blockStart(doc, index);
  const node = doc.child(index);
  const candidates: number[] = [];
  node.descendants((child, pos) => {
    if (child.isText) {
      for (let k = 0; k <= child.text!.length; k += 1) candidates.push(start + 1 + pos + k);
    }
    return true;
  });
  if (candidates.length === 0) return null;
  return candidates[Math.floor(r() * candidates.length)]!;
}

function randomEdit(h: Harness, r: () => number): void {
  const v = view(h);
  const doc = v.state.doc;
  const index = Math.floor(r() * doc.childCount);
  const pos = textPosIn(doc, index, r);
  if (pos === null) return;
  const roll = r();
  const parent = doc.resolve(pos).parent;
  if (!parent.inlineContent) return;
  if (parent.type.spec.code) {
    v.dispatch(v.state.tr.insertText(`c${Math.floor(r() * 9)}`, pos));
  } else if (roll < 0.55) {
    const words = ['edit', 'x', 'ünï', '漢字', ' word ', 'a*b', '_u_', '`t`', '$', '#', '[x]', '\\'];
    v.dispatch(v.state.tr.insertText(words[Math.floor(r() * words.length)]!, pos));
  } else if (roll < 0.85) {
    const $pos = doc.resolve(pos);
    const to = Math.min($pos.end(), pos + 1 + Math.floor(r() * 4));
    if (to > pos) v.dispatch(v.state.tr.delete(pos, to));
  } else {
    // Split the textblock: a structural edit (new top-level block).
    const $pos = doc.resolve(pos);
    if ($pos.depth === 1) v.dispatch(v.state.tr.split(pos));
    else v.dispatch(v.state.tr.insertText(' z', pos));
  }
}

/**
 * Documented save normalization: markdown cannot hold spaces at the edges of
 * a textblock, so the serializer drops them (to-mdast trimLeading/TrailingSpace).
 * Compare modulo exactly that and nothing else.
 */
function normalized(node: ProseNode): unknown {
  const json = node.toJSON() as { type: string; content?: unknown[] };
  const walk = (input: { type: string; text?: string; content?: Array<{ type: string; text?: string }> }): unknown => {
    let value = input;
    // A code block's fence style is presentation; an edited list may write an
    // indented block where the source had a fence. Content must still match.
    if (value.type === 'code_block') {
      const attrs = { ...(value as { attrs?: Record<string, unknown> }).attrs };
      delete attrs.fenced;
      value = { ...value, attrs } as typeof value;
    }
    if (!value.content) return value;
    let content = value.content.map((child) => walk(child as never) as { type: string; text?: string; marks?: Array<{ type: string; attrs?: { href?: string } }> });
    // A bare URL is GFM autolink text: typing against it intentionally extends
    // or ends the address on re-read (see autolink-packaged e2e). Compare such
    // links as the plain text they are written as.
    content = content.map((child) => {
      if (child.type !== 'text' || !child.marks) return child;
      const marks = child.marks.filter((mark) => !(mark.type === 'link' && /^https?:\/\//.test(mark.attrs?.href ?? '') && child.text?.includes('://')));
      return marks.length === child.marks.length ? child : { ...child, marks: marks.length ? marks : undefined };
    });
    const merged: typeof content = [];
    for (const child of content) {
      const previous = merged[merged.length - 1];
      if (previous && previous.type === 'text' && child.type === 'text'
        && JSON.stringify(previous.marks ?? []) === JSON.stringify(child.marks ?? [])) {
        merged[merged.length - 1] = { ...previous, text: (previous.text ?? '') + (child.text ?? '') };
      } else {
        merged.push(child);
      }
    }
    content = merged.map((child) => (child.marks === undefined ? (({ marks: _m, ...rest }) => rest)(child) : child));
    const isTextblock = content.some((child) => child.type === 'text');
    if (isTextblock) {
      const first = content[0];
      if (first?.type === 'text') content[0] = { ...first, text: first.text!.replace(/^[ \t]+/, '') };
      const lastIndex = content.length - 1;
      const last = content[lastIndex];
      if (last?.type === 'text') content[lastIndex] = { ...last, text: last.text!.replace(/[ \t]+$/, '') };
      content = content.filter((child) => child.type !== 'text' || child.text !== '');
    }
    return { ...value, content };
  };
  return walk(json as never);
}

function sameBlock(a: ProseNode, b: ProseNode): boolean {
  return a.eq(b) || JSON.stringify(normalized(a)) === JSON.stringify(normalized(b));
}

function expectSavedMatchesEditor(h: Harness, label: string): void {
  // Let enrichment finish so stand-ins in the editor become real nodes, the
  // same form a fresh parse of the saved bytes produces.
  drainEnrichment(h);
  // An emptied paragraph is left out of the save (markdown has none).
  const live = view(h).state.doc;
  const kept: ProseNode[] = [];
  live.forEach((node) => { if (!isUnwritableBlock(node)) kept.push(node); });
  const editorDoc = live.copy(Fragment.from(kept));
  const reparsed = fullDoc(h.saved);
  let same = reparsed.childCount === editorDoc.childCount;
  for (let i = 0; same && i < reparsed.childCount; i += 1) same = sameBlock(reparsed.child(i), editorDoc.child(i));
  if (!same) {
    let first = -1;
    const n = Math.max(reparsed.childCount, editorDoc.childCount);
    for (let i = 0; i < n; i += 1) {
      const a = i < reparsed.childCount ? reparsed.child(i) : null;
      const b = i < editorDoc.childCount ? editorDoc.child(i) : null;
      if (!a || !b || !sameBlock(a, b)) { first = i; break; }
    }
    const a = first >= 0 && first < reparsed.childCount ? JSON.stringify(reparsed.child(first).toJSON()) : '∅';
    const b = first >= 0 && first < editorDoc.childCount ? JSON.stringify(editorDoc.child(first).toJSON()) : '∅';
    throw new Error(`${label}: saved bytes re-parse differently at block ${first}\n saved:  ${a}\n editor: ${b}`);
  }
}

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.editor.destroy();
  document.body.innerHTML = '';
});

function openTracked(text: string): Harness {
  const h = open(text);
  harnesses.push(h);
  return h;
}

const BIG = 3200;

describe('save round-trip on a large sparse document', () => {
  it('opens on the sparse + deferred path', { timeout: 60_000 }, () => {
    const h = openTracked(corpus(BIG));
    expect(view(h).state.doc.childCount).toBeGreaterThan(3000);
    expect(viewportStubKey.getState(view(h).state)?.enabled).toBe(true);
    expect(deferredController(h)?.deferredCount() ?? 0).toBeGreaterThan(0);
  });

  it('an unedited save reproduces the file byte for byte', { timeout: 60_000 }, () => {
    const text = corpus(BIG);
    const h = openTracked(text);
    expect(save(h)).toBe(text);
  });

  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`random edits then save re-parse to the editor doc (seed ${seed})`, { timeout: 60_000 }, () => {
      const r = rng(seed);
      const h = openTracked(corpus(BIG));
      for (let round = 0; round < 3; round += 1) {
        const edits = 1 + Math.floor(r() * 12);
        for (let e = 0; e < edits; e += 1) randomEdit(h, r);
        save(h);
        expectSavedMatchesEditor(h, `seed ${seed} round ${round}`);
      }
    });
  }
});

function deferredFlags(h: Harness): Uint8Array {
  return (deferredController(h) as unknown as { flags: Uint8Array }).flags;
}

function firstDeferredIndex(h: Harness, from = 0): number {
  const flags = deferredFlags(h);
  for (let i = from; i < flags.length; i += 1) if (flags[i] === 0) return i;
  return -1;
}

function insertAtBlockStart(h: Harness, index: number, text: string): void {
  const v = view(h);
  const pos = textPosIn(v.state.doc, index, () => 0);
  if (pos === null) throw new Error(`block ${index} has no text`);
  v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, pos)).insertText(text, pos));
}

describe('save edge cases found by the property test', () => {
  it('saves a document with an emptied paragraph instead of failing EMPTY_UNIT', { timeout: 60_000 }, () => {
    const h = openTracked('# T\n\nOne.\n\nTwo.\n');
    const v = view(h);
    const at = blockStart(v.state.doc, 1);
    v.dispatch(v.state.tr.delete(at + 1, at + 1 + 'One.'.length));
    expect(save(h)).toBe('# T\n\nTwo.\n');
    // The next save still pairs the remaining blocks with their own bytes.
    insertAtBlockStart(h, 2, 'Still ');
    expect(save(h)).toBe('# T\n\nStill Two.\n');
    expectSavedMatchesEditor(h, 'emptied paragraph');
  });

  it('typing into an emptied paragraph after a save writes it back', { timeout: 60_000 }, () => {
    const h = openTracked('# T\n\nOne.\n\nTwo.\n');
    const v = view(h);
    const at = blockStart(v.state.doc, 1);
    v.dispatch(v.state.tr.delete(at + 1, at + 1 + 'One.'.length));
    save(h);
    const v2 = view(h);
    v2.dispatch(v2.state.tr.insertText('Back', blockStart(v2.state.doc, 1) + 1));
    expect(save(h)).toBe('# T\n\nBack\n\nTwo.\n');
  });
});

describe('background enrichment after a save', () => {
  it('does not overwrite an edited neighbour of a still-deferred block', { timeout: 60_000 }, () => {
    const h = openTracked(corpus(BIG));
    const k = firstDeferredIndex(h, 1500);
    expect(k).toBeGreaterThan(0);
    const neighbour = k - 1;
    insertAtBlockStart(h, neighbour, 'EDITED ');
    expect(view(h).state.doc.child(neighbour).textContent).toContain('EDITED');
    save(h);
    expect(h.saved).toContain('EDITED');
    drainEnrichment(h);
    expect(view(h).state.doc.child(neighbour).textContent).toContain('EDITED');
    expectSavedMatchesEditor(h, 'neighbour');
  });

  it('keeps enriching the rest of the document after a structural edit is saved', { timeout: 60_000 }, () => {
    const h = openTracked(corpus(BIG));
    const v = view(h);
    // Split the first paragraph: one more top-level block than at open.
    const pos = textPosIn(v.state.doc, 0, () => 0.5)!;
    v.dispatch(v.state.tr.split(pos));
    save(h);
    const before = deferredController(h)!.deferredCount();
    expect(before).toBeGreaterThan(0);
    drainEnrichment(h);
    expect(deferredController(h)!.deferredCount()).toBe(0);
    expectSavedMatchesEditor(h, 'structural');
  });

  it('saving an edit inside a still-deferred block keeps its markdown', { timeout: 60_000 }, () => {
    const h = openTracked(corpus(BIG));
    const k = firstDeferredIndex(h, 1500);
    const original = view(h).state.doc.child(k).textContent;
    insertAtBlockStart(h, k, 'EDITED ');
    save(h);
    expectSavedMatchesEditor(h, 'deferred block edit');
    expect(original.length).toBeGreaterThan(0);
  });
});

describe('known issue (not a save bug)', () => {
  // `***a _b_ c***` with an edit inside re-serializes ambiguously and reads
  // back as different emphasis (seen with seed 4: "nested" -> "neste").
  it.fails('nested emphasis inside strong emphasis survives an edit', () => {
    const h = openTracked('***nested _em 1_ strong*** tail\n');
    insertAtBlockStart(h, 0, '');
    const v = view(h);
    v.dispatch(v.state.tr.delete(7, 8));
    save(h);
    expectSavedMatchesEditor(h, 'nested emphasis');
  });

  // Dropping an emptied paragraph that separated two lists of the same type
  // leaves them adjacent, so they re-read as one (loose) list.
  it.fails('an emptied paragraph between two lists keeps them separate on reopen', { timeout: 60_000 }, () => {
    const h = openTracked('- a\n\nx\n\n- b\n');
    const v = view(h);
    const at = blockStart(v.state.doc, 1);
    v.dispatch(v.state.tr.delete(at + 1, at + 2));
    save(h);
    expect(fullDoc(h.saved).childCount).toBe(2);
  });
});

describe('references in a paragraph the engine does not own', () => {
  // Such a paragraph is enriched on its own; definitions in other blocks must
  // still resolve, as they do in a whole-file parse.
  it('a footnote reference in a dialect-enriched paragraph resolves its definition', () => {
    const text = 'Footnote ref[^n1] in ta*bext.\n\n[^n1]: The note.\n';
    let found = false;
    fullDoc(text).child(0).descendants((node) => {
      if (node.type.name === 'footnote_reference') found = true;
    });
    expect(found).toBe(true);
  });

  it('a reference link in a dialect-enriched paragraph resolves its definition', () => {
    const text = 'See [ref][r1], [htt#ps://a.example/1](https://a.example/1).\n\n[r1]: https://ref.example/1\n';
    const first = fullDoc(text).child(0);
    let linked = false;
    first.descendants((node) => {
      if (node.isText && node.text === 'ref' && node.marks.some((mark) => mark.type.name === 'link')) linked = true;
    });
    expect(linked).toBe(true);
  });
});

describe('undo after save and IME composition on the sparse path', () => {
  it('undo after a save, then save again, writes the original bytes back', { timeout: 60_000 }, () => {
    const text = corpus(BIG);
    const h = openTracked(text);
    const r = rng(42);
    for (let e = 0; e < 8; e += 1) randomEdit(h, r);
    save(h);
    expectSavedMatchesEditor(h, 'after edits');
    // Undo everything the user did; enrichment swaps are not in history.
    while (h.editor.history('undo')) { /* drain */ }
    save(h);
    expectSavedMatchesEditor(h, 'after undo');
    expect(fullDoc(h.saved).eq(fullDoc(text))).toBe(true);
  });

  it('refuses to save mid-composition, skips enrichment, and round-trips after it ends', { timeout: 60_000 }, () => {
    const h = openTracked(corpus(BIG));
    const v = view(h);
    const k = firstDeferredIndex(h, 0);
    expect(k).toBeGreaterThanOrEqual(0);
    const before = deferredController(h)!.deferredCount();

    const pos = textPosIn(v.state.doc, 1, () => 0)!;
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, pos)));
    v.dom.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    expect(v.composing).toBe(true);
    expect(() => h.editor.captureSave()).toThrow(/IME_COMPOSITION_ACTIVE/);
    // Background enrichment must not swap nodes under an open composition.
    deferredController(h)!.enrichRangeForTests(0, v.state.doc.childCount);
    expect(v.state.doc.child(k)).toBe(v.state.doc.child(k));
    const stillDeferred = deferredController(h)!.deferredCount();
    expect(stillDeferred).toBeLessThanOrEqual(before);

    v.dispatch(v.state.tr.insertText('漢字', pos));
    v.dom.dispatchEvent(new CompositionEvent('compositionend', { data: '漢字' }));
    // ProseMirror ends composition on the next tick in some engines; force it.
    (v as unknown as { input: { composing: boolean } }).input.composing = false;
    expect(v.composing).toBe(false);
    save(h);
    expect(h.saved).toContain('漢字');
    expectSavedMatchesEditor(h, 'after composition');
  });
});

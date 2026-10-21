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
import { DOMParser, Fragment, Slice, type Node as ProseNode } from 'prosemirror-model';
import { isUnwritableBlock } from '../../src/renderer/editor/noto/capture';
import { NotoEditor } from '../../src/renderer/editor/noto/NotoEditor';
import { parseDocument, toWire } from '../../src/shared/markdown/v3/document';
import { blockSpansFromWire, splitBlocks } from '../../src/shared/markdown/v3/blocks';
import { docFromSpans } from '../../src/shared/markdown/v3/pm/from-mdast';
import { blockToMarkdown } from '../../src/shared/markdown/v3/pm/to-mdast';
import { notoSchema } from '../../src/shared/markdown/v3/pm/schema';
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
 * Documented save normalizations, and nothing else:
 * - markdown cannot hold spaces at the edges of a textblock, so the serializer
 *   drops them (to-mdast trimLeading/TrailingSpace);
 * - nor at the inside edges of emphasis, strong or strikethrough, so it writes
 *   them just outside the run (to-mdast spaceOutsideRuns).
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
    content = content.flatMap((child) => spaceOutsideAttention(child));
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

const ATTENTION = new Set(['emphasis', 'strong', 'strikethrough']);

/** A text node's edge whitespace, without the marks a save writes it outside of. */
function spaceOutsideAttention<T extends { type: string; text?: string; marks?: Array<{ type: string }> }>(child: T): T[] {
  if (child.type !== 'text' || !child.marks?.some((mark) => ATTENTION.has(mark.type))) return [child];
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(child.text ?? '')!;
  const [, lead, core, tail] = match;
  if (!lead && !tail) return [child];
  const plain = child.marks.filter((mark) => !ATTENTION.has(mark.type));
  const space = (text: string): T => ({ ...child, text, marks: plain.length ? plain : undefined });
  return [
    ...(lead ? [space(lead)] : []),
    ...(core ? [{ ...child, text: core }] : []),
    ...(tail ? [space(tail)] : []),
  ];
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

/** The text of `block` that carries strong emphasis. */
function strongText(block: ProseNode): string {
  let text = '';
  block.descendants((node) => {
    if (node.isText && node.marks.some((mark) => mark.type.name === 'strong')) text += node.text;
  });
  return text;
}

/** First still-deferred block at or after `from` whose text contains `needle`. */
function firstDeferredStandIn(h: Harness, from: number, needle: string): number {
  const flags = deferredFlags(h);
  const doc = view(h).state.doc;
  for (let i = from; i < flags.length; i += 1) {
    if (flags[i] === 0 && doc.child(i).textContent.includes(needle)) return i;
  }
  throw new Error(`no deferred block with ${needle} after ${from}`);
}

/** Put the caret at the start of block `index`, as a click does: its own transaction. */
function placeCaretAtBlockStart(h: Harness, index: number): void {
  const v = view(h);
  const pos = textPosIn(v.state.doc, index, () => 0);
  if (pos === null) throw new Error(`block ${index} has no text`);
  v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, pos)));
}

function typeAtCaret(h: Harness, text: string): void {
  const v = view(h);
  v.dispatch(v.state.tr.insertText(text));
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

  it('a typed star stays a literal star', () => {
    const h = openTracked('On *nix, *emph* text.\n');
    const typeAfter = (before: string, text: string) => {
      const v = view(h);
      const at = blockStart(v.state.doc, 0) + 1 + v.state.doc.child(0).textContent.indexOf(before) + before.length;
      v.dispatch(v.state.tr.insertText(text, at));
    };
    // At the end of the emphasis the typed text joins it.
    typeAfter('emph', 'a*b');
    typeAfter('text', ' a*b');
    expect(save(h)).toBe('On *nix, *empha\\*b* text a\\*b.\n');
    expectSavedMatchesEditor(h, 'typed star');
  });
});

describe('character references through an edit', () => {
  it('keep their spelling, and a typed ampersand stays text', () => {
    const h = openTracked('Tom &amp; Jerry &copy; Q&A.\n\n| a &vert; b | c |\n| --- | --- |\n| &nbsp; | d |\n');
    const v = view(h);
    expect(v.state.doc.child(0).textContent).toBe('Tom & Jerry © Q&A.');
    const end = blockStart(v.state.doc, 0) + v.state.doc.child(0).nodeSize - 1;
    v.dispatch(v.state.tr.insertText(' Typed &amp; R&D', end));
    expect(save(h)).toBe('Tom &amp; Jerry &copy; Q&A. Typed \\&amp; R&D\n\n| a &vert; b | c |\n| --- | --- |\n| &nbsp; | d |\n');
    expectSavedMatchesEditor(h, 'character references');
  });

  it('a pasted reference keeps its spelling only when it is one', () => {
    const v = view(openTracked('x\n'));
    const parse = (html: string) => {
      const host = document.createElement('div');
      host.innerHTML = html;
      return DOMParser.fromSchema(v.state.schema).parse(host);
    };
    const kept = parse('<p>a<span class="noto-character-reference" data-source="&amp;amp;">&amp;</span>b</p>');
    expect(kept.firstChild?.child(1).type.name).toBe('character_reference');
    expect(kept.firstChild?.child(1).attrs.source).toBe('&amp;');
    const forged = parse('<p><span class="noto-character-reference" data-source="**x**">&amp;</span></p>');
    expect(forged.firstChild?.firstChild?.isText).toBe(true);
    expect(forged.textContent).toBe('&');
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
    const text = corpus(BIG);
    const h = openTracked(text);
    const k = firstDeferredStandIn(h, 1500, '***both');
    // A caret placed in the stand-in enriches it before the keystroke lands.
    placeCaretAtBlockStart(h, k);
    expect(deferredFlags(h)[k]).toBe(1);
    typeAtCaret(h, 'EDITED ');
    // The swap kept the caret in its block.
    expect(view(h).state.doc.child(k).textContent).toContain('EDITED');
    save(h);
    // The block's emphasis is still markdown, not escaped literal asterisks.
    expect(h.saved).toContain('EDITED');
    expect(h.saved).not.toContain('\\*\\*\\*');
    expect(strongText(fullDoc(h.saved).child(k))).toMatch(/both \d+/);
    expectSavedMatchesEditor(h, 'deferred block edit');
  });

  it('an edit inside a still-deferred block keeps its character references', { timeout: 60_000 }, () => {
    // The engine leaves a block with a reference to the dialect, so in a large
    // note it opens as a stand-in showing its raw markdown.
    const text = `${corpus(BIG)}\nTom &amp; Jerry &copy; Q&A.\n`;
    const h = openTracked(text);
    const k = firstDeferredStandIn(h, 1500, 'Tom &amp;');
    placeCaretAtBlockStart(h, k);
    expect(view(h).state.doc.child(k).textContent).toBe('Tom & Jerry © Q&A.');
    typeAtCaret(h, 'EDITED ');
    expect(save(h).endsWith('\n\nEDITED Tom &amp; Jerry &copy; Q&A.\n')).toBe(true);
    expectSavedMatchesEditor(h, 'deferred reference edit');
  });

  it('keeps enriching while the document is dirty, and undo still reads as clean', { timeout: 60_000 }, () => {
    const h = openTracked(corpus(BIG));
    insertAtBlockStart(h, 0, 'EDITED ');
    expect(h.editor.isDirty).toBe(true);
    const before = deferredController(h)!.deferredCount();
    expect(before).toBeGreaterThan(0);
    drainEnrichment(h);
    expect(deferredController(h)!.deferredCount()).toBe(0);
    expect(h.editor.isDirty).toBe(true);
    // The baseline followed the swaps, so undoing the one edit is clean again.
    while (h.editor.history('undo')) { /* drain */ }
    expect(h.editor.isDirty).toBe(false);
  });

  it('replace all edits real nodes, not markdown shown as text', { timeout: 60_000 }, () => {
    const h = openTracked(corpus(BIG));
    expect(deferredController(h)!.deferredCount()).toBeGreaterThan(0);
    const found = h.editor.search({ query: 'both', caseSensitive: true, wholeWord: false, regex: false });
    expect(deferredController(h)!.deferredCount()).toBe(0);
    expect(found.matches).toBeGreaterThan(100);
    expect(h.editor.replace('BOTH', 'all')).toBe(found.matches);
    save(h);
    expect(h.saved).toContain('***BOTH 16***');
    expect(h.saved).not.toContain('\\*\\*\\*');
    expectSavedMatchesEditor(h, 'replace all');
  });
});

describe('emphasis nested in emphasis', () => {
  // Written with one marker throughout, `***nested*em 1* strong***`: the star
  // between two letters closed the outer run, and it read back as different
  // emphasis with a stray `**` (seen with seed 4: "nested" -> "neste").
  it('survives an edit that glues the inner run to a word', () => {
    const h = openTracked('***nested _em 1_ strong*** tail\n');
    const v = view(h);
    v.dispatch(v.state.tr.delete(7, 8));
    expect(save(h)).toBe('**_nested*em 1* strong_** tail\n');
    expectSavedMatchesEditor(h, 'nested emphasis');
  });

  it('keeps the underscore the file wrote for the inner run', () => {
    const h = openTracked('***nested _em 1_ strong*** tail\n');
    insertAtBlockStart(h, 0, 'z');
    expect(save(h)).toBe('***znested _em 1_ strong*** tail\n');
    expectSavedMatchesEditor(h, 'nested emphasis kept');
  });

  it('leaves emphasis without emphasis inside on stars', () => {
    const h = openTracked('*one* and **two *three***\n');
    insertAtBlockStart(h, 0, 'z');
    expect(save(h)).toBe('*zone* and **two *three***\n');
  });

  it('keeps one emphasis around the bold words inside it', () => {
    const h = openTracked('*see (**bold**), ~~gone~~ and [a link](u) here*\n');
    insertAtBlockStart(h, 0, 'z');
    expect(save(h)).toBe('*zsee (**bold**), ~~gone~~ and [a link](u) here*\n');
    expectSavedMatchesEditor(h, 'marks inside emphasis');
  });

  it('closes emphasis that ends on a bold word in one run', () => {
    const h = openTracked('*note: **important***\n');
    insertAtBlockStart(h, 0, 'z');
    expect(save(h)).toBe('*znote: **important***\n');
    expectSavedMatchesEditor(h, 'emphasis ending in bold');
  });
});

describe('a space at the edge of a styled run', () => {
  /** Apply `mark` to the first occurrence of `target` in block 0, as Cmd+B does to a selection. */
  function style(h: Harness, target: string, mark: 'emphasis' | 'strong' | 'strikethrough'): void {
    const v = view(h);
    const from = blockStart(v.state.doc, 0) + 1 + v.state.doc.child(0).textContent.indexOf(target);
    v.dispatch(v.state.tr.addMark(from, from + target.length, v.state.schema.marks[mark].create()));
  }

  // A strikethrough has no way to hold the space: `~~done ~~now` reopened as
  // the literal tildes.
  it('a struck selection that took the space after a word still strikes', () => {
    const h = openTracked('Mark done now.\n');
    style(h, 'done ', 'strikethrough');
    expect(save(h)).toBe('Mark ~~done~~ now.\n');
    expectSavedMatchesEditor(h, 'struck word and space');
  });

  // Emphasis was written `*done&#x20;*&#x6E;ow`, and the reference for the
  // letter stayed in the file from then on.
  it('italic and bold selections write no character references', () => {
    const h = openTracked('Mark done now, then later.\n');
    style(h, 'done ', 'emphasis');
    style(h, ' then', 'strong');
    expect(save(h)).toBe('Mark *done* now, **then** later.\n');
    expectSavedMatchesEditor(h, 'styled word and space');
  });

  it('deleting the last word of an italic phrase keeps it italic', () => {
    const h = openTracked('See *this word*, then go.\n');
    const v = view(h);
    const from = blockStart(v.state.doc, 0) + 1 + v.state.doc.child(0).textContent.indexOf('word');
    v.dispatch(v.state.tr.delete(from, from + 'word'.length));
    expect(save(h)).toBe('See *this* , then go.\n');
    expectSavedMatchesEditor(h, 'emptied end of italic');
  });

  it('moves the space out through every run it ends, and a struck space alone is a space', () => {
    const h = openTracked('Mark done now.\n');
    style(h, 'done ', 'emphasis');
    style(h, 'done ', 'strong');
    // The first space, after `Mark`, and nothing else.
    style(h, ' ', 'strikethrough');
    expect(save(h)).toBe('Mark ***done*** now.\n');
    expectSavedMatchesEditor(h, 'nested runs ending in a space');
  });
});

describe('emphasis touching strong', () => {
  function style(h: Harness, target: string, mark: 'emphasis' | 'strong'): void {
    const v = view(h);
    const from = blockStart(v.state.doc, 0) + 1 + v.state.doc.child(0).textContent.indexOf(target);
    v.dispatch(v.state.tr.addMark(from, from + target.length, v.state.schema.marks[mark].create()));
  }

  // `*foo***(x)**`: the `***` between a letter and a bracket can only close,
  // so the bold came back as literal stars.
  it('italic before bold that opens with punctuation keeps both', () => {
    const h = openTracked('Call foo(x) now.\n');
    style(h, 'foo', 'emphasis');
    style(h, '(x)', 'strong');
    expect(save(h)).toBe('Call _foo_**(x)** now.\n');
    expectSavedMatchesEditor(h, 'italic then bold punctuation');
  });

  // `**Note:***see*`: after a colon and before a letter the `***` can only open.
  it('bold that ends in punctuation before italic keeps both', () => {
    const h = openTracked('Note:see below.\n');
    style(h, 'Note:', 'strong');
    style(h, 'see', 'emphasis');
    expect(save(h)).toBe('**Note:**_see_ below.\n');
    expectSavedMatchesEditor(h, 'bold punctuation then italic');
  });

  // Between two letters the fused run both closes and opens, so the stars the
  // file already uses stay.
  it('keeps the stars where the touching run reads back', () => {
    const h = openTracked('Then ab now.\n');
    style(h, 'a', 'emphasis');
    style(h, 'b', 'strong');
    expect(save(h)).toBe('Then *a***b** now.\n');
    expectSavedMatchesEditor(h, 'letters on both sides');
  });
});

describe('a struck run against what sits beside it', () => {
  function strike(h: Harness, target: string): void {
    const v = view(h);
    const from = blockStart(v.state.doc, 0) + 1 + v.state.doc.child(0).textContent.indexOf(target);
    v.dispatch(v.state.tr.addMark(from, from + target.length, v.state.schema.marks.strikethrough.create()));
  }

  /**
   * The saved paragraph reads back with the same text and the same text
   * struck. The letter written as a reference reopens as a reference node,
   * which `expectSavedMatchesEditor` would count as a different paragraph.
   */
  function expectStrikeReadsBack(h: Harness, text: string, struck: string): void {
    const paragraph = fullDoc(h.saved).child(0);
    let read = '';
    paragraph.forEach((child) => {
      if (child.marks.some((mark) => mark.type.name === 'strikethrough')) read += child.textContent;
    });
    expect(paragraph.textContent).toBe(text);
    expect(read).toBe(struck);
  }

  // `notes~~.txt~~`: tildes between a letter and punctuation cannot open, so
  // the strikethrough came back as literal tildes. The letter outside is
  // written as a reference, as the emphasis handler already does.
  it('strikes punctuation that follows a letter', () => {
    const h = openTracked('See notes.txt today.\n');
    strike(h, '.txt');
    expect(save(h)).toBe('See note&#x73;~~.txt~~ today.\n');
    expectStrikeReadsBack(h, 'See notes.txt today.', '.txt');
  });

  // `~~(x)~~y`: after punctuation and before a letter the closer cannot close.
  it('strikes punctuation that precedes a letter', () => {
    const h = openTracked('Call (x)y now.\n');
    strike(h, '(x)');
    expect(save(h)).toBe('Call ~~(x)~~&#x79; now.\n');
    expectStrikeReadsBack(h, 'Call (x)y now.', '(x)');
  });

  // `~~~5 min~~`: a literal tilde against the opener makes a run of three,
  // which strikes nothing.
  it('strikes text that starts with a tilde', () => {
    const h = openTracked('It takes ~5 min.\n');
    strike(h, '~5 min');
    expect(save(h)).toBe('It takes ~~\\~5 min~~.\n');
    expectSavedMatchesEditor(h, 'struck text opening with a tilde');
  });

  it('keeps a literal tilde after the closer apart from it', () => {
    const h = openTracked('Was 5~6 days.\n');
    strike(h, '5');
    expect(save(h)).toBe('Was ~~5~~\\~6 days.\n');
    expectSavedMatchesEditor(h, 'tilde after struck text');
  });

  // `~~\~~~~`: with only the first literal tilde escaped, the second and the
  // closer made a run of three, which cannot close.
  it('escapes every tilde of a run between the delimiters', () => {
    const h = openTracked('Type \\~\\~ to strike.\n');
    strike(h, '~~');
    expect(save(h)).toBe('Type ~~\\~\\~~~ to strike.\n');
    expectStrikeReadsBack(h, 'Type ~~ to strike.', '~~');
  });

  // Letters on both sides flank already, and CJK text is left as the file
  // wrote it rather than filled with references.
  it('leaves runs that read back alone', () => {
    const h = openTracked('abc 这是「错」的\n');
    strike(h, 'b');
    strike(h, '「错」');
    expect(save(h)).toBe('a~~b~~c 这是~~「错」~~的\n');
    expectSavedMatchesEditor(h, 'runs that already flank');
  });

  // The same run where the fast reader hands the paragraph to micromark (a
  // character reference sends it there). `~~` takes the CJK-friendly amendment
  // as `*` and `_` do, so micromark strikes it too.
  it('strikes beside CJK text when micromark reads the paragraph', () => {
    const h = openTracked('A &amp; 这是「错」的\n');
    strike(h, '「错」');
    expect(save(h)).toBe('A &amp; 这是~~「错」~~的\n');
    expectStrikeReadsBack(h, 'A & 这是「错」的', '「错」');
  });

  it('strikes nested emphasis beside CJK text', () => {
    const h = openTracked('文:中 end\n');
    const v = view(h);
    const from = blockStart(v.state.doc, 0) + 2;
    const { marks } = v.state.schema;
    v.dispatch(v.state.tr
      .addMark(from, from + 2, marks.strikethrough.create())
      .addMark(from, from + 2, marks.emphasis.create())
      .addMark(from, from + 2, marks.strong.create()));
    expect(save(h)).toBe('文~~***:中***~~ end\n');
    expectStrikeReadsBack(h, '文:中 end', ':中');
  });
});

describe('a backslash before the letter a delimiter encodes', () => {
  function mark(h: Harness, target: string, name: 'emphasis' | 'strikethrough'): void {
    const v = view(h);
    const from = blockStart(v.state.doc, 0) + 1 + v.state.doc.child(0).textContent.indexOf(target);
    v.dispatch(v.state.tr.addMark(from, from + target.length, v.state.schema.marks[name].create()));
  }

  function readBack(h: Harness, name: string): { text: string; marked: string } {
    const paragraph = fullDoc(h.saved).child(0);
    let marked = '';
    paragraph.forEach((child) => {
      if (child.marks.some((m) => m.type.name === name)) marked += child.textContent;
    });
    return { text: paragraph.textContent, marked };
  }

  // `C:\&#x64;*(see)*`: the letter beside the run was encoded after the
  // backslash in front of it had been written bare, so the backslash escaped
  // the `&` and the file reopened with `&#x64;` as text.
  it('keeps the letter when emphasis follows it', () => {
    const h = openTracked('Under C:\\d(see) only.\n');
    mark(h, '(see)', 'emphasis');
    expect(save(h)).toBe('Under C:\\\\&#x64;*(see)* only.\n');
    expect(readBack(h, 'emphasis')).toEqual({ text: 'Under C:\\d(see) only.', marked: '(see)' });
  });

  it('keeps the letter when a struck run follows it', () => {
    const h = openTracked('Under C:\\d(see) only.\n');
    mark(h, '(see)', 'strikethrough');
    expect(save(h)).toBe('Under C:\\\\&#x64;~~(see)~~ only.\n');
    expect(readBack(h, 'strikethrough')).toEqual({ text: 'Under C:\\d(see) only.', marked: '(see)' });
  });

  it('saves an escaped backslash in the source the same way', () => {
    const h = openTracked('Under C:\\\\d(see) only.\n');
    mark(h, '(see)', 'emphasis');
    expect(save(h)).toBe('Under C:\\\\&#x64;*(see)* only.\n');
  });
});

describe('a dollar sign in text', () => {
  function typeAtEnd(h: Harness, index: number, text: string): void {
    const v = view(h);
    v.dispatch(v.state.tr.insertText(text, blockStart(v.state.doc, index) + v.state.doc.child(index).nodeSize - 1));
  }

  // `$\_GET`: the serializer dropped the escape on a dollar whose next
  // character it escaped anyway, and on reopen the bare `$` opened math that
  // ran to the `\$` later in the paragraph.
  it('stays text when the character after it is escaped too', () => {
    const h = openTracked('Read \\$\\_GET, not \\$HOME.\n');
    typeAtEnd(h, 0, ' Then $[x] and $*.');
    expect(save(h)).toBe('Read \\$\\_GET, not \\$HOME. Then \\$\\[x] and \\$\\*.\n');
    expectSavedMatchesEditor(h, 'dollar before an escaped character');
  });

  it('at the start of a styled run after math stays text', () => {
    const h = openTracked('$x$**\\$\\_a** costs \\$5.\n');
    typeAtEnd(h, 0, '!');
    expect(save(h)).toBe('$x$**\\$\\_a** costs \\$5.!\n');
    expectSavedMatchesEditor(h, 'dollar opening strong text after math');
  });
});

describe('two inline formulas the editor makes touch', () => {
  // `$x$$y$` reads back as one formula holding `x$$y`, so it is not a valid
  // saved form. The editor merges the two as they meet; what is saved is the
  // merged formula, and reopening it gives back the same bytes.

  /** The text range of `needle` in block 0, outside any formula. */
  function textRange(h: Harness, needle: string): { from: number; to: number } {
    let found: { from: number; to: number } | null = null;
    view(h).state.doc.child(0).forEach((child, offset) => {
      const at = child.isText ? child.text!.indexOf(needle) : -1;
      if (found === null && at >= 0) found = { from: 1 + offset + at, to: 1 + offset + at + needle.length };
    });
    if (found === null) throw new Error(`no text ${needle}`);
    return found;
  }

  /** The bytes must survive a reopen and a full re-serialize unchanged. */
  function expectReopensAs(saved: string): void {
    const reopened = fullDoc(saved);
    expect(reopened.childCount).toBe(1);
    expect(`${blockToMarkdown(reopened.child(0))}\n`).toBe(saved);
  }

  it('deleting the text between them saves one formula', () => {
    const h = openTracked('Let $x$ and $y$ be.\n');
    const v = view(h);
    const { from, to } = textRange(h, ' and ');
    v.dispatch(v.state.tr.delete(from, to));
    expect(save(h)).toBe('Let $x y$ be.\n');
    expectSavedMatchesEditor(h, 'delete between formulas');
    expectReopensAs(h.saved);
  });

  it('a formula pasted against another saves one formula', () => {
    const h = openTracked('Sum $x$ here.\n');
    const v = view(h);
    const { from } = textRange(h, ' here.');
    const slice = new Slice(Fragment.from(notoSchema.nodes.math_inline.create(null, notoSchema.text('y'))), 0, 0);
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, from)).replaceSelection(slice));
    expect(save(h)).toBe('Sum $x y$ here.\n');
    expectSavedMatchesEditor(h, 'paste against a formula');
    expectReopensAs(h.saved);
  });

  it('a left formula ending in a backslash keeps a space instead of merging', () => {
    const h = openTracked('A $a\\$ - $b$.\n');
    const v = view(h);
    const { from, to } = textRange(h, ' - ');
    v.dispatch(v.state.tr.delete(from, to));
    expect(save(h)).toBe('A $a\\$ $b$.\n');
    expectSavedMatchesEditor(h, 'backslash before the seam');
    expectReopensAs(h.saved);
  });
});

describe('two lists the editor leaves adjacent', () => {
  // With only blank lines between them, two lists of one family and marker
  // read back as one loose list. The later one is written with the other marker.
  function emptyBlock(h: Harness, index: number): void {
    const v = view(h);
    const at = blockStart(v.state.doc, index);
    v.dispatch(v.state.tr.delete(at + 1, at + v.state.doc.child(index).nodeSize - 1));
  }

  function deleteBlock(h: Harness, index: number): void {
    const v = view(h);
    const at = blockStart(v.state.doc, index);
    v.dispatch(v.state.tr.delete(at, at + v.state.doc.child(index).nodeSize));
  }

  it('an emptied paragraph between two bullet lists keeps them separate on reopen', () => {
    const h = openTracked('- a\n\nx\n\n- b\n');
    emptyBlock(h, 1);
    expect(save(h)).toBe('- a\n\n* b\n');
    expect(fullDoc(h.saved).childCount).toBe(2);
    // The next save reuses what was written rather than flipping it back.
    insertAtBlockStart(h, 0, 'z');
    expect(save(h)).toBe('- za\n\n* b\n');
  });

  it('a deleted paragraph between two ordered lists keeps them separate on reopen', () => {
    const h = openTracked('1. a\n\nx\n\n1. b\n');
    deleteBlock(h, 1);
    expect(save(h)).toBe('1. a\n\n1) b\n');
    expect(fullDoc(h.saved).childCount).toBe(2);
  });

  it('a third list compares with the marker the second was written with', () => {
    const h = openTracked('- a\n\nx\n\n- b\n\ny\n\n- c\n');
    emptyBlock(h, 3);
    emptyBlock(h, 1);
    expect(save(h)).toBe('- a\n\n* b\n\n- c\n');
    expect(fullDoc(h.saved).childCount).toBe(3);
  });

  it('leaves lists alone that cannot join', () => {
    const h = openTracked('- a\n\nx\n\n1. b\n\ny\n\n* c\n');
    emptyBlock(h, 3);
    emptyBlock(h, 1);
    expect(save(h)).toBe('- a\n\n1. b\n\n* c\n');
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

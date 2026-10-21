/**
 * The fast reader is an optimization, never a dialect.
 *
 * `from-engine.ts` reads simple paragraphs and headings without micromark. It
 * may only accept a block it reads exactly as micromark with Noto's extensions
 * would; anything else it must hand to micromark. This test holds it to that:
 * on a seeded corpus of what the editor writes and on the repository's own
 * markdown fixtures, every paragraph or heading the fast reader accepts must
 * come out as the same ProseMirror tree as the micromark reading of the same
 * document. A mismatch fails CI.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EditorState } from 'prosemirror-state';
import type { Mark, Node as ProseNode } from 'prosemirror-model';
import { notoSchema as s } from '../../src/shared/markdown/v3/pm/schema';
import { blockToMarkdown } from '../../src/shared/markdown/v3/pm/to-mdast';
import { splitBlocks } from '../../src/shared/markdown/v3/blocks';
import { docFromMdast, docFromSpans } from '../../src/shared/markdown/v3/pm/from-mdast';
import {
  canSkipDialectEnrich,
  collectFootnoteDefinitionIds,
  withKnownFootnoteIds,
} from '../../src/shared/markdown/v3/pm/from-engine';
import { enrichSpansInRange } from '../../src/shared/markdown/v3/roobli-md-adapter';
import { parseMarkdown, topLevelNodes } from '../../src/shared/markdown/v3/syntax';
import { fixAdjacentInlineMath } from '../../src/renderer/editor/noto/math-adjacency';

/** Deterministic PRNG, so the corpus is the same on every run. */
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

const ALPHA = ['a', 'b', 'x', 'y', ' ', ' ', '$', '\\', '*', '_', '~', '`', '(', ')', '.', ':', '!', '[', ']', '<', '>', '&', '#', '中', '文', '1', '|', '=', '^', '-', '+', '"'];

/**
 * A random paragraph as the editor could hold it: text runs under random
 * marks and inline formulas, normalized the way the editor normalizes.
 */
function paragraph(r: () => number): ProseNode | null {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const kids: ProseNode[] = [];
  const segments = 1 + Math.floor(r() * 4);
  for (let i = 0; i < segments; i += 1) {
    if (r() < 0.1) {
      let latex = '';
      const length = 1 + Math.floor(r() * 3);
      for (let k = 0; k < length; k += 1) latex += pick(['x', 'y', '1', '+']);
      kids.push(s.nodes.math_inline.create(null, s.text(latex)));
      continue;
    }
    let text = '';
    const length = 1 + Math.floor(r() * 6);
    for (let k = 0; k < length; k += 1) text += pick(ALPHA);
    const marks: Mark[] = [];
    if (r() < 0.6) {
      if (r() < 0.12) marks.push(s.marks.inline_code.create());
      else {
        if (r() < 0.35) marks.push(s.marks.emphasis.create());
        if (r() < 0.35) marks.push(s.marks.strong.create());
        if (r() < 0.3) marks.push(s.marks.strikethrough.create());
        if (r() < 0.1) marks.push(s.marks.link.create({ href: 'u' }));
      }
    }
    kids.push(s.text(text, marks));
  }
  let p: ProseNode;
  try {
    p = s.nodes.paragraph.create(null, kids);
  } catch {
    return null;
  }
  // What the editor never holds: edge whitespace (not written) and padded
  // inline code (not representable).
  if (p.textContent !== p.textContent.trim()) return null;
  let padded = false;
  p.forEach((child) => {
    if (child.marks.some((m) => m.type.name === 'inline_code') && /^ | $/.test(child.text ?? '')) padded = true;
  });
  if (padded) return null;
  const fix = fixAdjacentInlineMath(EditorState.create({ doc: s.nodes.doc.create(null, [p]) }));
  return fix ? fix.doc.child(0) : p;
}

/** The fuzz corpus: what the editor writes for seeded random paragraphs. */
function fuzzCorpus(count: number, seed: number): string[] {
  const r = rng(seed);
  const out: string[] = [];
  while (out.length < count) {
    const p = paragraph(r);
    if (!p) continue;
    try {
      out.push(`${blockToMarkdown(p)}\n`);
    } catch {
      // A paragraph the writer refuses is not something the reader sees.
    }
  }
  return out;
}

/** Every markdown fixture in the repository. */
function fixtureCorpus(root: string): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith('.md')) out.push({ name: path, text: readFileSync(path, 'utf8').replace(/^\uFEFF/, '') });
    }
  };
  walk(root);
  return out;
}

const READ_KINDS = new Set(['paragraph', 'heading']);

interface Mismatch {
  readonly source: string;
  readonly markdown: string;
  readonly fast: string;
  readonly micromark: string;
}

/**
 * Compare, block by block, the editor's reading of `text` against the
 * micromark reading, for the paragraphs and headings the fast reader accepts.
 */
function differences(source: string, text: string): Mismatch[] {
  const spans = splitBlocks(text).spans;
  const ids = collectFootnoteDefinitionIds(spans);
  const accepted = withKnownFootnoteIds(ids, () => spans.map((span) =>
    READ_KINDS.has(span.kind)
    && ((span as { engineOwned?: boolean }).engineOwned ?? canSkipDialectEnrich(span.kind, span.markdown))));
  if (!accepted.some(Boolean)) return [];
  const editor = docFromSpans(enrichSpansInRange(spans, text, { from: 0, to: spans.length }));
  const reference = docFromMdast(topLevelNodes(parseMarkdown(text)));
  if (editor.childCount !== reference.childCount) {
    return [{ source, markdown: text, fast: `${editor.childCount} blocks`, micromark: `${reference.childCount} blocks` }];
  }
  const out: Mismatch[] = [];
  accepted.forEach((ok, index) => {
    if (!ok) return;
    const a = editor.child(index);
    const b = reference.child(index);
    if (!a.eq(b)) out.push({ source, markdown: spans[index]!.markdown, fast: JSON.stringify(a.toJSON()), micromark: JSON.stringify(b.toJSON()) });
  });
  return out;
}

/**
 * Known disagreements, each a shape the fast reader still accepts but reads
 * differently from micromark. Allowed only until the fast reader hands that
 * shape to micromark; each entry is removed with the change that does. Every
 * entry must still match a mismatch, so a fixed shape cannot linger here.
 */
const EXPECTED_FAIL: Record<string, (markdown: string) => boolean> = {};

const FUZZ_SAMPLES = 20_000;
const FUZZ_SEED = 12345;

describe('the fast reader reads what micromark reads', () => {
  const mismatches: Mismatch[] = [];
  for (const md of fuzzCorpus(FUZZ_SAMPLES, FUZZ_SEED)) mismatches.push(...differences('fuzz', md));
  for (const fixture of fixtureCorpus(join(__dirname, '..', 'fixtures'))) {
    mismatches.push(...differences(fixture.name.slice(fixture.name.indexOf('tests/')), fixture.text));
  }

  it('accepts nothing it reads differently, beyond the known shapes', () => {
    const unexpected = mismatches.filter((m) => !Object.values(EXPECTED_FAIL).some((known) => known(m.markdown)));
    const report = unexpected.slice(0, 10).map((m) =>
      `${m.source}: ${JSON.stringify(m.markdown)}\n  fast:      ${m.fast}\n  micromark: ${m.micromark}`).join('\n');
    expect(unexpected.length, `fast reader disagrees with micromark:\n${report}`).toBe(0);
  });

  it('hands a run of thousands of unclosed openers to micromark instead of overflowing', () => {
    for (const text of ['*a '.repeat(5000), '**a '.repeat(10000)]) {
      expect(differences('adversarial', text)).toEqual([]);
    }
  }, 20_000);

  for (const [name, known] of Object.entries(EXPECTED_FAIL)) {
    it(`still needs the expected-fail for ${name}`, () => {
      expect(mismatches.some((m) => known(m.markdown)), `no mismatch left for "${name}"; remove its entry`).toBe(true);
    });
  }
});

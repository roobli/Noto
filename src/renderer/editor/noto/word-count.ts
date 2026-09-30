/**
 * How many words a note holds.
 *
 * Counted from the text the document draws, never from the file. A note whose
 * bytes are mostly image addresses is a short note, and Typora agrees: on one
 * of the author's own notes it reports 112 where the raw markdown counts 144,
 * the difference being URLs nobody reads.
 *
 * Two scripts, two rules, which is the convention every editor that handles
 * Chinese uses. A run of letters and digits is one word, so `don't` and
 * `mcp__claude_api` each count once. A Han character, a kana or a Hangul
 * syllable is one word on its own, because Chinese and Japanese do not put
 * spaces between words and counting runs would report one word per sentence.
 *
 * This does not match Typora exactly and is not meant to. On one of the
 * author's notes Typora reports 112 where this reports 84. The note holds 81
 * Han characters, three hyphenated Latin words and fifteen pieces of Chinese
 * punctuation; Typora appears to be counting the punctuation, and a full stop
 * is not a word. The convention here is the one a writer means.
 *
 * A long note is counted per top-level block and the block counts are added
 * (`composeBlockCounts`). ProseMirror reuses the nodes an edit did not touch,
 * so a WeakMap from node to count makes a one-paragraph edit recount only that
 * paragraph. The composition matches `textBetween(0, size, '\n', '\n')` of the
 * whole document, which is what the status bar used to count in one pass.
 *
 * Pure helpers, so the rule can be tested against real notes rather than
 * argued about.
 */

import type { Node as ProseNode } from 'prosemirror-model';

/** Letters, digits and the marks that live inside a word. */
const WORD_RUN = /[\p{Letter}\p{Number}\p{Mark}](?:[\p{Letter}\p{Number}\p{Mark}'’_-]*[\p{Letter}\p{Number}\p{Mark}])?/gu;

/**
 * The scripts counted one character at a time.
 *
 * Han, the two kana, Hangul, and the CJK extensions that hold the rarer
 * characters the author's notes actually use.
 */
const PER_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export interface DocumentCount {
  readonly words: number;
  /** Every character the document draws, spaces included. */
  readonly characters: number;
  /** The same without spaces and line breaks, which is how a Chinese word count is usually asked for. */
  readonly charactersNoSpaces: number;
  /** Lines of text, as the document draws them; a blank line between blocks is not one. */
  readonly lines: number;
  /** Top-level blocks: paragraphs, headings, lists and the rest, each once. */
  readonly blocks: number;
}

export function countWords(text: string, blocks = 0): DocumentCount {
  let words = 0;
  WORD_RUN.lastIndex = 0;
  for (const match of text.matchAll(WORD_RUN)) {
    const run = match[0];
    // A run may mix scripts, so each character decides for itself and what is
    // left of the run counts once.
    let perCharacter = 0;
    let latin = false;
    for (const character of run) {
      if (PER_CHARACTER.test(character)) perCharacter += 1;
      else latin = true;
    }
    words += perCharacter + (latin ? 1 : 0);
  }
  // One walk for characters, spaces and lines. Spreading the string into an
  // array of code points (`[...text].length`) allocated millions of strings on
  // the 8 MB benchmark document for the same answer a code-point iterator gives.
  let characters = 0;
  let spaces = 0;
  let lines = 0;
  let onLine = false;
  for (const character of text) {
    characters += 1;
    if (character === '\n') { if (onLine) lines += 1; onLine = false; spaces += 1; continue; }
    if (/\s/u.test(character)) spaces += 1;
    else onLine = true;
  }
  if (onLine) lines += 1;
  return { words, characters, charactersNoSpaces: characters - spaces, lines, blocks };
}

/**
 * Add per-block counts the way `textBetween(0, size, '\n', '\n')` joins blocks:
 * one newline between neighbouring top-level blocks, counted as a character
 * and a space, never as a line of its own (a blank line between blocks is the
 * empty block, not the separator).
 */
export function composeBlockCounts(counts: readonly DocumentCount[]): DocumentCount {
  let words = 0;
  let characters = 0;
  let charactersNoSpaces = 0;
  let lines = 0;
  for (const count of counts) {
    words += count.words;
    characters += count.characters;
    charactersNoSpaces += count.charactersNoSpaces;
    lines += count.lines;
  }
  const separators = Math.max(0, counts.length - 1);
  return {
    words,
    characters: characters + separators,
    charactersNoSpaces,
    lines,
    blocks: counts.length,
  };
}

/** The drawn text of one top-level block, joined the same way the whole note is. */
export function blockDrawnText(node: ProseNode): string {
  return node.textBetween(0, node.content.size, '\n', '\n');
}

/**
 * Count a ProseMirror document, reusing cached per-block counts when the block
 * node is unchanged (ProseMirror keeps the same object for untouched children).
 */
export function countDocumentWords(
  doc: ProseNode,
  cache?: WeakMap<ProseNode, DocumentCount>,
): DocumentCount {
  const parts: DocumentCount[] = [];
  doc.forEach((node) => {
    const cached = cache?.get(node);
    if (cached) {
      parts.push(cached);
      return;
    }
    const count = countWords(blockDrawnText(node));
    cache?.set(node, count);
    parts.push(count);
  });
  return composeBlockCounts(parts);
}

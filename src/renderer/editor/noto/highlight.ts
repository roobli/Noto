/**
 * Syntax highlighting for fenced code, as ProseMirror decorations.
 *
 * Typora runs a CodeMirror instance per fence, so a document with fifty code
 * blocks carries fifty editors. Noto tokenises the text and paints decorations
 * over the one editor it already has, which costs nothing at rest.
 *
 * Tokenisation results are cached against the ProseMirror node itself. Nodes are
 * immutable and persistent, so an untouched fence is the same object after an
 * edit elsewhere and is never re-tokenised. Editing one block in a document full
 * of code re-highlights that block alone.
 *
 * When the stubbing scroller is active, token decorations are kept only for
 * fences inside the selection and viewport neighbourhoods. Far-off fences stay
 * mounted (they are not stubbable) but do not keep thousands of mapped spans on
 * the caret's critical path.
 */

import Prism from 'prismjs';
import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as ProseNode } from 'prosemirror-model';
import { guideRanges } from './indent-guides';
import { TAB_MARKER_CLASS, tabRanges } from './tab-markers';
import {
  isIndexReal,
  rangesEqual,
  viewportStubKey,
  type ViewportStubState,
} from './viewport-stub';

// Prism resolves languages from a registry its component files write into, and
// the order matters: several build on `clike` or `javascript`.
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-clike';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-diff';
import 'prismjs/components/prism-toml';
// The rest follows the languages the author's vault actually fences, by count.
import 'prismjs/components/prism-haskell';
import 'prismjs/components/prism-docker';
import 'prismjs/components/prism-nginx';
import 'prismjs/components/prism-ini';
import 'prismjs/components/prism-lua';
import 'prismjs/components/prism-ruby';
import 'prismjs/components/prism-markup-templating';
import 'prismjs/components/prism-php';
import 'prismjs/components/prism-csharp';
import 'prismjs/components/prism-powershell';
import 'prismjs/components/prism-http';
import 'prismjs/components/prism-vim';
import 'prismjs/components/prism-makefile';
import 'prismjs/components/prism-swift';
import 'prismjs/components/prism-kotlin';
import 'prismjs/components/prism-scss';
import 'prismjs/components/prism-lisp';
import 'prismjs/components/prism-json5';
import 'prismjs/components/prism-properties';
import 'prismjs/components/prism-latex';
import 'prismjs/components/prism-r';
import 'prismjs/components/prism-perl';
import 'prismjs/components/prism-regex';
import 'prismjs/components/prism-elixir';
import 'prismjs/components/prism-erlang';
import 'prismjs/components/prism-scala';
import 'prismjs/components/prism-dart';
import 'prismjs/components/prism-groovy';
import 'prismjs/components/prism-zig';
import 'prismjs/components/prism-protobuf';
import 'prismjs/components/prism-graphql';
import 'prismjs/components/prism-objectivec';

export const highlightKey = new PluginKey<DecorationSet>('noto-syntax-highlight');

/** Names users actually write in a fence, mapped to Prism's registry names. */
const ALIASES: Readonly<Record<string, string>> = {
  ts: 'typescript',
  js: 'javascript',
  jsx: 'jsx',
  tsx: 'tsx',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  py: 'python',
  rs: 'rust',
  golang: 'go',
  yml: 'yaml',
  html: 'markup',
  xml: 'markup',
  svg: 'markup',
  vue: 'markup',
  md: 'markdown',
  'c++': 'cpp',
  cs: 'csharp',
  'c#': 'csharp',
  kt: 'kotlin',
  kts: 'kotlin',
  dockerfile: 'docker',
  jsonc: 'json',
  elisp: 'lisp',
  el: 'lisp',
  hs: 'haskell',
  rb: 'ruby',
  ps1: 'powershell',
  pwsh: 'powershell',
  pl: 'perl',
  tex: 'latex',
  mk: 'makefile',
  make: 'makefile',
  objc: 'objectivec',
  ex: 'elixir',
  exs: 'elixir',
  proto: 'protobuf',
  gql: 'graphql',
};

interface TokenRange {
  readonly from: number;
  readonly to: number;
  readonly className: string;
}

/**
 * Ranges are stored relative to the start of the block, because a fence keeps
 * its tokens when unrelated text before it shifts every absolute position.
 */
const cache = new WeakMap<ProseNode, readonly TokenRange[]>();

function grammarFor(lang: string): Prism.Grammar | null {
  const normalized = ALIASES[lang.toLowerCase()] ?? lang.toLowerCase();
  return Prism.languages[normalized] ?? null;
}

function classesOf(token: Prism.Token): string {
  const alias = Array.isArray(token.alias) ? token.alias : token.alias ? [token.alias] : [];
  return ['token', token.type, ...alias].join(' ');
}

/**
 * Flatten Prism's nested tokens into leaf ranges.
 *
 * Only leaves are emitted. Painting parents as well would stack decorations
 * over the same text for no visual gain and more work for the view.
 */
function flatten(
  tokens: readonly (string | Prism.Token)[],
  start: number,
  out: TokenRange[],
): number {
  let offset = start;
  for (const token of tokens) {
    if (typeof token === 'string') {
      offset += token.length;
      continue;
    }
    if (Array.isArray(token.content)) {
      offset = flatten(token.content as (string | Prism.Token)[], offset, out);
      continue;
    }
    const text = typeof token.content === 'string' ? token.content : String(token.content);
    if (text.length > 0) out.push({ from: offset, to: offset + text.length, className: classesOf(token) });
    offset += text.length;
  }
  return offset;
}

export function rangesFor(node: ProseNode): readonly TokenRange[] {
  const cached = cache.get(node);
  if (cached) return cached;

  const lang = String(node.attrs.lang ?? '');
  const grammar = lang ? grammarFor(lang) : null;
  const ranges: TokenRange[] = [];
  // An unknown or absent language stays plain rather than being guessed at.
  if (grammar) flatten(Prism.tokenize(node.textContent, grammar), 0, ranges);

  cache.set(node, ranges);
  return ranges;
}

/** Decorations for every code block overlapping a range of the document. */
/**
 * How wide a tab is inside a fence, matching the stylesheet's `tab-size`.
 * Kept here rather than read from the DOM: the decorations are built in the
 * state, where there is no element to measure.
 */
const TAB_SIZE = 4;

/**
 * The rule's colour, as a custom property so a theme can restyle it. It has to
 * be a colour in the gradient rather than a class, because each line's rules
 * stand at that line's own columns.
 */
const GUIDE_COLOUR = 'var(--code-guide, color-mix(in srgb, currentcolor 16%, transparent))';

function decorationsIn(doc: ProseNode, from: number, to: number): Decoration[] {
  const decorations: Decoration[] = [];
  doc.nodesBetween(from, to, (node, position) => {
    if (node.type.name !== 'code_block') return true;
    // A rule at each tab stop of a line's indentation, drawn on the whitespace
    // itself so a document of ten thousand code lines gains no elements.
    for (const guide of guideRanges(node.textContent, TAB_SIZE, GUIDE_COLOUR)) {
      decorations.push(Decoration.inline(
        position + 1 + guide.from,
        position + 1 + guide.to,
        { style: guide.style },
      ));
    }
    // A quiet arrow on every tab character, matching fence-enhance's visible
    // tabs. The span wraps the tab itself so the file and the selection keep
    // the character; only the paint is added.
    for (const tab of tabRanges(node.textContent)) {
      decorations.push(Decoration.inline(
        position + 1 + tab.from,
        position + 1 + tab.to,
        { class: TAB_MARKER_CLASS },
      ));
    }
    for (const range of rangesFor(node)) {
      // `position + 1` steps past the node's own opening token into its text.
      decorations.push(Decoration.inline(
        position + 1 + range.from,
        position + 1 + range.to,
        { class: range.className },
      ));
    }
    // Nothing inside a code block needs visiting.
    return false;
  });
  return decorations;
}

function buildDecorations(doc: ProseNode): DecorationSet {
  return DecorationSet.create(doc, decorationsIn(doc, 0, doc.content.size));
}

/**
 * Token decorations only for fences that are currently real.
 *
 * Off-screen fences stay in the DOM (they are not stubbable), but keeping
 * every Prism span mapped on each keystroke dominates the caret-in-viewport
 * frame. When stubbing is on, only the selection and viewport neighbourhoods
 * need tokens — the same windows paint deferral already treats as live.
 */
function decorationsForStubWindows(doc: ProseNode, stub: ViewportStubState): Decoration[] {
  const decorations: Decoration[] = [];
  let position = 0;
  for (let index = 0; index < doc.childCount; index += 1) {
    const child = doc.child(index);
    const end = position + child.nodeSize;
    if (child.type.name === 'code_block' && isIndexReal(stub, index)) {
      decorations.push(...decorationsIn(doc, position, end));
    }
    position = end;
  }
  return decorations;
}

function stubWindowsChanged(
  before: ViewportStubState | undefined,
  after: ViewportStubState | undefined,
): boolean {
  if (!before?.enabled && !after?.enabled) return false;
  if (Boolean(before?.enabled) !== Boolean(after?.enabled)) return true;
  if (!before || !after) return true;
  return !rangesEqual(before.viewport, after.viewport)
    || !rangesEqual(before.selection, after.selection);
}

function decorationsForState(state: EditorState): DecorationSet {
  const stub = viewportStubKey.getState(state);
  if (stub?.enabled) {
    const list = decorationsForStubWindows(state.doc, stub);
    return list.length > 0 ? DecorationSet.create(state.doc, list) : DecorationSet.empty;
  }
  return buildDecorations(state.doc);
}

/**
 * The span of the new document a transaction touched, widened to whole top
 * level blocks.
 *
 * Widening matters because a keystroke inside a fence reports only the
 * inserted character, while the tokens that have to be recomputed belong to
 * the entire fence: typing a quote can change how the rest of the line reads.
 */
function changedRange(transaction: Transaction, doc: ProseNode): { from: number; to: number } | null {
  let from = Infinity;
  let to = -Infinity;

  transaction.mapping.maps.forEach((map, index) => {
    const rest = transaction.mapping.slice(index + 1);
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      from = Math.min(from, rest.map(newStart, -1));
      to = Math.max(to, rest.map(newEnd, 1));
    });
  });
  if (from > to) return null;

  const limit = doc.content.size;
  const $from = doc.resolve(Math.max(0, Math.min(from, limit)));
  const $to = doc.resolve(Math.max(0, Math.min(to, limit)));
  return {
    from: $from.depth > 0 ? $from.before(1) : Math.max(0, from),
    to: $to.depth > 0 ? $to.after(1) : Math.min(limit, to),
  };
}

export function syntaxHighlightPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: highlightKey,
    state: {
      init: (_config, state: EditorState) => decorationsForState(state),
      /**
       * Rebuild only what changed.
       *
       * Existing decorations are moved to their new positions rather than
       * recomputed, so the cost of a keystroke follows the size of the edit
       * instead of the size of the document. Rebuilding the whole set made
       * every keystroke walk every node, which is unusable once a document
       * holds thousands of blocks.
       *
       * On stubbed documents the set is only the fences inside the real
       * windows, so a keystroke maps dozens of token spans rather than tens
       * of thousands on far-off always-real fences.
       */
      apply: (transaction, previous, oldState, newState) => {
        const stub = viewportStubKey.getState(newState);
        if (stub?.enabled) {
          if (
            !transaction.docChanged
            && !transaction.selectionSet
            && !stubWindowsChanged(
              viewportStubKey.getState(oldState),
              stub,
            )
          ) {
            return previous;
          }
          return decorationsForState(newState);
        }
        if (!transaction.docChanged) return previous;
        const range = changedRange(transaction, newState.doc);
        if (!range) return previous.map(transaction.mapping, newState.doc);

        const moved = previous.map(transaction.mapping, newState.doc);
        const stale = moved.find(range.from, range.to);
        return moved
          .remove(stale)
          .add(newState.doc, decorationsIn(newState.doc, range.from, range.to));
      },
    },
    props: {
      decorations: (state) => highlightKey.getState(state),
    },
  });
}

/** Grammars other grammars are built on; nobody fences code as one of these. */
const SCAFFOLDING = new Set(['clike', 'markup-templating']);

/** The languages the editor can highlight, which is also what a fence's language field offers. */
export const supportedLanguages = (): readonly string[] =>
  Object.keys(Prism.languages).filter((name) => typeof Prism.languages[name] === 'object' && !SCAFFOLDING.has(name));

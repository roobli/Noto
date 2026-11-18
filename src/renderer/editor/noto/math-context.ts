/**
 * What one formula needs to know about the others in its note.
 *
 * Typora's MathJax reads a note as one document: a `\newcommand` in one
 * formula is there in every formula after it, and `\eqref{euler}` prints the
 * number of the block that says `\label{euler}`. KaTeX typesets each formula
 * on its own and knows neither command, so a note written in Typora showed
 * "Undefined control sequence" where its author saw a vector or a number.
 *
 * This reads the note's formulas once per document and gives each formula its
 * source rewritten for KaTeX, plus the macros the note defines:
 *
 * - A block that says `\label{key}` is numbered: by its own `\tag{}` when it
 *   has one, else by its place among the labelled blocks without one, and the
 *   label becomes that `\tag`. `\eqref{key}` becomes "(n)" and `\ref{key}`
 *   "n"; a key no block labels reads "(??)", as LaTeX prints it.
 * - Every `\newcommand`, `\renewcommand` and `\def` in the note is defined for
 *   every formula, the one that defines it included. A formula that defines a
 *   macro is typeset without the shared set, so its own definition is not
 *   refused as a redefinition.
 *
 * yagni: a formula is redrawn when its own source changes, not when a macro
 * or label elsewhere does; the next open draws it with the new one. Upgrade
 * path: redraw the formulas that use a name when its definition changes.
 */

import katex from 'katex';
import type { Node as ProseNode } from 'prosemirror-model';

const DEFINES = /\\(?:re)?newcommand\b|\\def\b/;
const LABEL = /\\label\s*\{([^{}]*)\}/;
const TAG = /\\tag\*?\s*\{([^{}]*)\}/;
const REFERENCE = /\\(eqref|ref)\s*\{([^{}]*)\}/g;

export interface MathContext {
  /** Number by label key. */
  readonly labels: ReadonlyMap<string, string>;
  /** Macros the note defines, for KaTeX's `macros` option. */
  readonly macros: Readonly<Record<string, string>>;
}

const EMPTY: MathContext = { labels: new Map(), macros: {} };

/** The context of a document, computed from its formulas. Pure apart from typesetting definitions. */
export function mathContextOf(sources: readonly { readonly text: string; readonly display: boolean }[]): MathContext {
  const labels = new Map<string, string>();
  let counter = 0;
  const definitions: string[] = [];
  for (const { text, display } of sources) {
    if (DEFINES.test(text)) definitions.push(text);
    if (!display) continue;
    const label = LABEL.exec(text);
    if (!label) continue;
    const key = label[1]!.trim();
    const tag = TAG.exec(text);
    if (tag) labels.set(key, tag[1]!.trim());
    else labels.set(key, String((counter += 1)));
  }
  const macros: Record<string, string> = {};
  for (const definition of definitions) {
    try {
      // Typeset for its side effect only: with `globalGroup` the definitions
      // land in `macros`, parsed by KaTeX itself rather than by a regex here.
      katex.renderToString(definition, { macros, globalGroup: true, throwOnError: false, trust: false, strict: false });
    } catch {
      // A definition KaTeX cannot read defines nothing; the formula shows its own error.
    }
  }
  return labels.size === 0 && Object.keys(macros).length === 0 ? EMPTY : { labels, macros };
}

/** A formula's source as KaTeX should read it, and the macros it may use. */
export function prepared(source: string, display: boolean, context: MathContext): { source: string; macros: Record<string, string> } {
  let text = source;
  if (display) {
    const label = LABEL.exec(text);
    if (label) {
      const number = context.labels.get(label[1]!.trim());
      text = TAG.test(text) || number === undefined
        ? text.replace(LABEL, '')
        : text.replace(LABEL, `\\tag{${number}}`);
    }
  }
  text = text.replace(REFERENCE, (_all, kind: string, key: string) => {
    const number = context.labels.get(key.trim());
    const shown = number ?? '??';
    return kind === 'eqref' ? `\\text{(${shown})}` : `\\text{${shown}}`;
  });
  // Each formula gets a copy, so nothing one formula does reaches another.
  const macros = DEFINES.test(source) ? {} : { ...context.macros };
  return { source: text, macros };
}

const cache = new WeakMap<ProseNode, MathContext>();

/** The context of a ProseMirror document, computed once per document value. */
export function documentMathContext(doc: ProseNode): MathContext {
  const known = cache.get(doc);
  if (known) return known;
  const sources: { text: string; display: boolean }[] = [];
  let interesting = false;
  doc.descendants((node) => {
    if (node.type.name === 'math_block' || node.type.name === 'math_inline') {
      const text = node.textContent;
      if (!interesting && (DEFINES.test(text) || LABEL.test(text) || text.includes('ref'))) interesting = true;
      sources.push({ text, display: node.type.name === 'math_block' });
      return false;
    }
    return node.isBlock;
  });
  const context = interesting ? mathContextOf(sources) : EMPTY;
  cache.set(doc, context);
  return context;
}

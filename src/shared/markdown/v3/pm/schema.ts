/**
 * Noto's ProseMirror schema.
 *
 * Owned outright rather than inherited from a preset, because the schema is the
 * contract that decides what a user can edit. Milkdown's CommonMark preset had
 * no table, task list, math, frontmatter or footnote nodes, which is why those
 * constructs had to be frozen into read-only source islands. Every construct
 * the parser produces has a node here, so nothing is second class.
 *
 * Node names follow the conventions of `prosemirror-tables` and
 * `prosemirror-schema-list` so those packages work without adapters.
 */

import { Schema, type MarkSpec, type NodeSpec } from 'prosemirror-model';
import { tableNodes } from 'prosemirror-tables';
import { isCharacterReferenceShape } from '../syntax';

/**
 * The table nodes, with one attribute of our own on the table itself.
 *
 * `pretty` says the source should be written with its columns lined up. It is a
 * property of this editing session rather than of the file: nothing in markdown
 * records it, and once the aligned text is saved the file itself carries the
 * alignment. Setting it also makes the node differ from the one that was
 * opened, which is what causes the block to be written again at all.
 */
function alignedTableNodes(options: Parameters<typeof tableNodes>[0]) {
  const built = tableNodes(options);
  return {
    ...built,
    table: { ...built.table, attrs: { ...built.table.attrs, pretty: { default: false } } },
  };
}

const codeLikeBlock = (extra: Partial<NodeSpec> = {}): NodeSpec => ({
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,
  ...extra,
});

const nodes: Record<string, NodeSpec> = {
  doc: { content: 'block+' },

  paragraph: {
    group: 'block',
    content: 'inline*',
    /*
     * A line the author broke stays broken.
     *
     * The break is a newline inside the text, drawn by `white-space: pre-wrap`
     * rather than by any node of its own. Without this the editor collapses it
     * to a space the moment it re-reads the paragraph from the DOM, which it
     * does after a keystroke: typing one letter into a paragraph the author
     * had wrapped over three lines joined all three into one.
     *
     * The flag on the node is what does it. The view reads its own DOM back
     * with `preserveWhitespace: 'full'` only where the node type says its
     * whitespace is `pre`, so the parse rule alone changed nothing.
     */
    whitespace: 'pre',
    parseDOM: [{ tag: 'p', preserveWhitespace: 'full' }],
    toDOM: () => ['p', 0],
  },

  heading: {
    group: 'block',
    content: 'inline*',
    defining: true,
    attrs: { level: { default: 1 } },
    /*
     * A heading can hold newlines too, and 2,963 of the vault's notes have one
     * that does: a line of dashes straight after a paragraph, with no blank
     * line between, is a setext heading and swallows every line above it.
     * Whether the author meant a heading or a rule, that is what the file says
     * and what every parser reads. The serializer already writes a heading
     * with a newline in it back as setext; it only needed the newline to still
     * be there, which is the same flag the paragraph needs.
     */
    whitespace: 'pre',
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level }, preserveWhitespace: 'full' as const })),
    toDOM: (node) => [`h${node.attrs.level}`, 0],
  },

  blockquote: {
    group: 'block',
    content: 'block+',
    defining: true,
    parseDOM: [{ tag: 'blockquote' }],
    toDOM: () => ['blockquote', 0],
  },

  code_block: codeLikeBlock({
    attrs: { lang: { default: '' }, fenced: { default: true } },
    parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
    toDOM: (node) => ['pre', { 'data-lang': node.attrs.lang || null }, ['code', 0]],
  }),

  /** Display math, `$$ ... $$`. Held as text so the source stays editable. */
  math_block: codeLikeBlock({
    parseDOM: [{ tag: 'div.noto-math-block', preserveWhitespace: 'full' }],
    toDOM: () => ['div', { class: 'noto-math-block', spellcheck: 'false' }, 0],
  }),

  /** YAML frontmatter. One per document, always first. */
  frontmatter: codeLikeBlock({
    parseDOM: [{ tag: 'div.noto-frontmatter', preserveWhitespace: 'full' }],
    toDOM: () => ['div', { class: 'noto-frontmatter', spellcheck: 'false' }, 0],
  }),

  /** Raw HTML kept as source. Never rendered live, which would execute it. */
  html_block: codeLikeBlock({
    parseDOM: [{ tag: 'div.noto-html-block', preserveWhitespace: 'full' }],
    toDOM: () => ['div', { class: 'noto-html-block', spellcheck: 'false' }, 0],
  }),

  /**
   * One block shown as its raw markdown instead of rendered.
   *
   * Source mode is a different view of the same block, not a different
   * document: the node holds exactly the markdown that block would serialize
   * to, so the file stays saveable while a block is open in source. That is
   * what makes the toggle per block rather than a whole-document mode.
   */
  source_block: codeLikeBlock({
    attrs: { originalKind: { default: 'paragraph' } },
    toDOM: (node) => ['div', {
      class: 'noto-source-block',
      'data-original-kind': node.attrs.originalKind,
    }, 0],
  }),

  horizontal_rule: {
    group: 'block',
    atom: true,
    parseDOM: [{ tag: 'hr' }],
    toDOM: () => ['hr'],
  },

  bullet_list: {
    group: 'block',
    content: 'list_item+',
    /*
     * `bullet` is the marker the source used (`-`, `*` or `+`). mdast drops it,
     * and without it every edited list is rewritten with the dialect default.
     */
    attrs: { spread: { default: false }, bullet: { default: '-' } },
    // Read back as well as written, since copy and paste go through the DOM:
    // a loose list pasted without it would land tight.
    parseDOM: [{
      tag: 'ul',
      getAttrs: (dom) => ({
        spread: (dom as HTMLElement).hasAttribute('data-spread'),
        bullet: (dom as HTMLElement).getAttribute('data-bullet') || '-',
      }),
    }],
    // A loose list is drawn with space inside its items and a tight one
    // without, which the stylesheet can only do if the DOM says which it is.
    toDOM: (node) => ['ul', {
      ...(node.attrs.spread ? { 'data-spread': '' } : {}),
      ...(node.attrs.bullet && node.attrs.bullet !== '-' ? { 'data-bullet': node.attrs.bullet } : {}),
    }, 0],
  },

  ordered_list: {
    group: 'block',
    content: 'list_item+',
    // `delimiter` is `.` or `)`, matching the source. Default is the vault's
    // majority form; an edited `1)` list keeps the parenthesis.
    attrs: { start: { default: 1 }, spread: { default: false }, delimiter: { default: '.' } },
    parseDOM: [{
      tag: 'ol',
      getAttrs: (dom) => ({
        start: Number((dom as HTMLElement).getAttribute('start') ?? 1) || 1,
        spread: (dom as HTMLElement).hasAttribute('data-spread'),
        delimiter: (dom as HTMLElement).getAttribute('data-delimiter') || '.',
      }),
    }],
    toDOM: (node) => ['ol', {
      ...(node.attrs.start === 1 ? {} : { start: node.attrs.start }),
      ...(node.attrs.spread ? { 'data-spread': '' } : {}),
      ...(node.attrs.delimiter && node.attrs.delimiter !== '.' ? { 'data-delimiter': node.attrs.delimiter } : {}),
    }, 0],
  },

  /**
   * `checked` is null for an ordinary item and a boolean for a task item, which
   * is exactly how mdast models it. That keeps task lists as real lists rather
   * than a separate node type.
   */
  list_item: {
    content: 'block+',
    defining: true,
    attrs: { checked: { default: null } },
    parseDOM: [{ tag: 'li' }],
    toDOM: (node) => node.attrs.checked === null
      ? ['li', 0]
      : ['li', { 'data-checked': String(node.attrs.checked), class: 'noto-task-item' }, 0],
  },

  footnote_definition: {
    group: 'block',
    content: 'block+',
    defining: true,
    attrs: { identifier: { default: '' }, label: { default: '' } },
    toDOM: (node) => ['div', { class: 'noto-footnote-definition', 'data-identifier': node.attrs.identifier }, 0],
  },

  /** A `[id]: url "title"` reference definition. Atomic; edited as a unit. */
  link_definition: {
    group: 'block',
    atom: true,
    attrs: { identifier: { default: '' }, label: { default: '' }, url: { default: '' }, title: { default: null } },
    toDOM: (node) => ['div', {
      class: 'noto-link-definition',
      'data-identifier': node.attrs.identifier,
    }, `[${node.attrs.label || node.attrs.identifier}]: ${node.attrs.url}`],
  },

  ...alignedTableNodes({
    tableGroup: 'block',
    cellContent: 'inline*',
    cellAttributes: {
      align: {
        default: null,
        getFromDOM: (dom) => (dom as HTMLElement).style.textAlign || null,
        setDOMAttr: (value, attrs) => {
          if (value) attrs.style = `text-align: ${value}`;
        },
      },
    },
  }),

  text: { group: 'inline' },

  /**
   * `referenceType` is null for an inline image and set for the `![alt][id]`
   * reference form, so editing a paragraph cannot silently rewrite one into the
   * other.
   */
  image: {
    group: 'inline',
    inline: true,
    atom: true,
    attrs: {
      src: { default: '' },
      alt: { default: '' },
      title: { default: null },
      referenceType: { default: null },
      identifier: { default: '' },
      label: { default: '' },
    },
    parseDOM: [{
      tag: 'img[src]',
      getAttrs: (dom) => ({
        src: (dom as HTMLElement).getAttribute('src') ?? '',
        alt: (dom as HTMLElement).getAttribute('alt') ?? '',
        title: (dom as HTMLElement).getAttribute('title'),
      }),
    }],
    toDOM: (node) => ['img', { src: node.attrs.src, alt: node.attrs.alt, title: node.attrs.title }],
  },

  /** Raw inline HTML such as `<br/>`, kept verbatim rather than flattened to text. */
  inline_html: {
    group: 'inline',
    inline: true,
    atom: true,
    attrs: { value: { default: '' } },
    toDOM: (node) => ['span', { class: 'noto-inline-html' }, node.attrs.value],
  },

  /**
   * A character reference such as `&amp;` or `&nbsp;`: the character it stands
   * for on screen, and the spelling the file wrote it with on save.
   *
   * One atom rather than its character as text, because the character alone
   * cannot say how it was written, and an edited paragraph is written from
   * this tree. The caret steps over it as one character and a backspace
   * removes it whole.
   */
  character_reference: {
    group: 'inline',
    inline: true,
    atom: true,
    attrs: { source: { default: '' }, value: { default: '' } },
    leafText: (node) => node.attrs.value as string,
    parseDOM: [{
      tag: 'span.noto-character-reference[data-source]',
      // The spelling is written to the file as it is, so a pasted one has to
      // be a reference; anything else arrives as its text.
      getAttrs: (dom) => {
        const source = (dom as HTMLElement).dataset.source ?? '';
        return isCharacterReferenceShape(source) ? { source, value: dom.textContent ?? '' } : false;
      },
    }],
    toDOM: (node) => ['span', { class: 'noto-character-reference', 'data-source': node.attrs.source }, node.attrs.value],
  },

  math_inline: {
    group: 'inline',
    inline: true,
    content: 'text*',
    marks: '',
    code: true,
    parseDOM: [{ tag: 'span.noto-math-inline' }],
    toDOM: () => ['span', { class: 'noto-math-inline' }, 0],
  },

  footnote_reference: {
    group: 'inline',
    inline: true,
    atom: true,
    attrs: { identifier: { default: '' }, label: { default: '' } },
    toDOM: (node) => ['sup', { class: 'noto-footnote-reference' }, `[${node.attrs.label || node.attrs.identifier}]`],
  },

  hard_break: {
    group: 'inline',
    inline: true,
    selectable: false,
    parseDOM: [{ tag: 'br' }],
    toDOM: () => ['br'],
  },
};

const marks: Record<string, MarkSpec> = {
  emphasis: {
    parseDOM: [{ tag: 'em' }, { tag: 'i' }, { style: 'font-style=italic' }],
    toDOM: () => ['em', 0],
  },
  strong: {
    parseDOM: [{ tag: 'strong' }, { tag: 'b' }],
    toDOM: () => ['strong', 0],
  },
  strikethrough: {
    parseDOM: [{ tag: 'del' }, { tag: 's' }],
    toDOM: () => ['del', 0],
  },
  /** Excludes every other mark, matching markdown: you cannot bold inside code. */
  inline_code: {
    excludes: '_',
    code: true,
    parseDOM: [{ tag: 'code' }],
    // Not spell-checked: an identifier is not a misspelling.
    toDOM: () => ['code', { spellcheck: 'false' }, 0],
  },
  link: {
    inclusive: false,
    attrs: {
      href: { default: '' },
      title: { default: null },
      referenceType: { default: null },
      identifier: { default: '' },
      label: { default: '' },
    },
    parseDOM: [{
      tag: 'a[href]',
      getAttrs: (dom) => ({
        href: (dom as HTMLElement).getAttribute('href') ?? '',
        title: (dom as HTMLElement).getAttribute('title'),
      }),
    }],
    toDOM: (mark) => ['a', { href: mark.attrs.href, title: mark.attrs.title }, 0],
  },
};

export const notoSchema = new Schema({ nodes, marks });

export type NotoSchema = typeof notoSchema;

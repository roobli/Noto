/**
 * mdast to ProseMirror.
 *
 * Runs in the renderer to build the editable document. Every mdast node the
 * parser can emit has a case here; anything genuinely unknown becomes an
 * `html_block` holding its source, which is lossless because that node keeps
 * its text verbatim.
 */

import type { Mark, Node as ProseNode } from 'prosemirror-model';
import type { PhrasingContent, RootContent } from 'mdast';
import { notoSchema } from './schema';
import { renderMarkdown } from '../syntax';
import type { BlockSpan } from '../blocks';
import { blockFromEngineSpan } from './from-engine';

const schema = notoSchema;

/**
 * A run of text, kept exactly as it was.
 *
 * Used for everything whose newlines are content: code, math, frontmatter and
 * raw HTML. Collapsing those would corrupt the block.
 */
function textNode(value: string, marks: readonly Mark[]): ProseNode[] {
  return value.length === 0 ? [] : [schema.text(value, marks)];
}

/**
 * A run of prose, where a newline is a soft wrap rather than content.
 *
 * A single newline inside a paragraph is kept, and shows as a line break.
 *
 * CommonMark reads it as a space, and this used to as well, on the reasoning
 * that such a newline is only where the author's editor happened to wrap the
 * source. That is not true of the documents this editor is for. They are
 * written in Typora, where Enter starts a paragraph and only Shift+Enter puts
 * a newline inside one, and Typora draws every one of those as a break. A
 * census of the author's 7,066 notes found no wrapping convention at all:
 * lines run from a few characters to nearly three thousand, and 2.7% of
 * paragraphs hold a newline. Each of those is a break somebody typed on
 * purpose, and collapsing it both loses the intent and makes this editor
 * disagree with the one the author reads all day.
 *
 * The text carries the newline and the paragraph is `pre-wrap`, so nothing is
 * inserted into the document to draw the break. A file hard-wrapped by some
 * other tool would show its wrapping here, which is the honest reading of
 * what the file says; if one ever turns up, that wants a setting rather than
 * a guess at which newlines the author meant.
 */
function proseText(value: string, marks: readonly Mark[]): ProseNode[] {
  return textNode(value.replace(/\r\n/g, '\n'), marks);
}

function inlineContent(nodes: readonly PhrasingContent[], marks: readonly Mark[] = []): ProseNode[] {
  const output: ProseNode[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        output.push(...proseText(node.value, marks));
        break;
      case 'emphasis':
        output.push(...inlineContent(node.children, [...marks, schema.marks.emphasis.create()]));
        break;
      case 'strong':
        output.push(...inlineContent(node.children, [...marks, schema.marks.strong.create()]));
        break;
      case 'delete':
        output.push(...inlineContent(node.children, [...marks, schema.marks.strikethrough.create()]));
        break;
      case 'inlineCode':
        output.push(...textNode(node.value, [...marks, schema.marks.inline_code.create()]));
        break;
      case 'link':
        output.push(...inlineContent(node.children, [...marks, schema.marks.link.create({
          href: node.url, title: node.title ?? null, referenceType: null,
        })]));
        break;
      case 'linkReference':
        output.push(...inlineContent(node.children, [...marks, schema.marks.link.create({
          href: '',
          title: null,
          referenceType: node.referenceType,
          identifier: node.identifier,
          label: node.label ?? '',
        })]));
        break;
      case 'image':
        output.push(schema.nodes.image.create({
          src: node.url, alt: node.alt ?? '', title: node.title ?? null, referenceType: null,
        }));
        break;
      case 'imageReference':
        output.push(schema.nodes.image.create({
          src: '',
          alt: node.alt ?? '',
          title: null,
          referenceType: node.referenceType,
          identifier: node.identifier,
          label: node.label ?? '',
        }));
        break;
      case 'inlineMath':
        output.push(schema.nodes.math_inline.create(null, textNode(node.value, [])));
        break;
      case 'footnoteReference':
        output.push(schema.nodes.footnote_reference.create({
          identifier: node.identifier, label: node.label ?? '',
        }));
        break;
      case 'break':
        output.push(schema.nodes.hard_break.create());
        break;
      case 'html':
        output.push(schema.nodes.inline_html.create({ value: node.value }));
        break;
      default:
        // Unknown phrasing content still round trips as its own source text.
        output.push(...textNode(renderMarkdown(node), marks));
        break;
    }
  }
  return output;
}

function listItems(node: Extract<RootContent, { type: 'list' }>): ProseNode[] {
  return node.children.map((item) => schema.nodes.list_item.create(
    { checked: item.checked ?? null },
    item.children.length > 0
      ? blockContent(item.children)
      : [schema.nodes.paragraph.create()],
  ));
}

function tableNode(node: Extract<RootContent, { type: 'table' }>): ProseNode {
  const align = node.align ?? [];
  const rows = node.children.map((row, rowIndex) => {
    const cellType = rowIndex === 0 ? schema.nodes.table_header : schema.nodes.table_cell;
    const cells = row.children.map((cell, columnIndex) => cellType.create(
      { align: align[columnIndex] ?? null },
      inlineContent(cell.children),
    ));
    return schema.nodes.table_row.create(null, cells);
  });
  return schema.nodes.table.create(null, rows);
}

/**
 * Facts about a block that mdast does not record but the source text does.
 * Without these a round trip would quietly restyle the user's document, for
 * example rewriting an indented code block as a fenced one.
 */
export interface BlockHints {
  readonly fenced?: boolean;
  /** Bullet marker taken from the source, when the block is a bullet list. */
  readonly bullet?: '-' | '*' | '+';
  /** Ordered delimiter taken from the source, when the block is an ordered list. */
  readonly delimiter?: '.' | ')';
}

function blockNode(node: RootContent, hints: BlockHints = {}): ProseNode | null {
  switch (node.type) {
    case 'paragraph':
      return schema.nodes.paragraph.create(null, inlineContent(node.children));
    case 'heading':
      return schema.nodes.heading.create({ level: node.depth }, inlineContent(node.children));
    case 'blockquote':
      return schema.nodes.blockquote.create(null, blockContent(node.children));
    case 'code':
      return schema.nodes.code_block.create(
        // An indented block can never carry a language, so a language is proof
        // of a fence when the source did not tell us.
        { lang: node.lang ?? '', fenced: hints.fenced ?? (node.lang !== null && node.lang !== undefined) },
        textNode(node.value, []),
      );
    case 'math':
      return schema.nodes.math_block.create(null, textNode(node.value, []));
    case 'yaml':
      return schema.nodes.frontmatter.create(null, textNode(node.value, []));
    case 'html':
      return schema.nodes.html_block.create(null, textNode(node.value, []));
    case 'thematicBreak':
      return schema.nodes.horizontal_rule.create();
    case 'list':
      return node.ordered
        ? schema.nodes.ordered_list.create({
          start: node.start ?? 1,
          spread: node.spread ?? false,
          delimiter: hints.delimiter ?? '.',
        }, listItems(node))
        : schema.nodes.bullet_list.create({
          spread: node.spread ?? false,
          bullet: hints.bullet ?? '-',
        }, listItems(node));
    case 'table':
      return tableNode(node);
    case 'footnoteDefinition':
      return schema.nodes.footnote_definition.create(
        { identifier: node.identifier, label: node.label ?? '' },
        blockContent(node.children),
      );
    case 'definition':
      return schema.nodes.link_definition.create({
        identifier: node.identifier,
        label: node.label ?? '',
        url: node.url,
        title: node.title ?? null,
      });
    default:
      return schema.nodes.html_block.create(null, textNode(renderMarkdown(node).trimEnd(), []));
  }
}

function blockContent(nodes: readonly RootContent[]): ProseNode[] {
  const output: ProseNode[] = [];
  for (const node of nodes) {
    const converted = blockNode(node);
    if (converted) output.push(converted);
  }
  return output;
}

/** Convert one top level mdast node into its ProseMirror node. */
export function blockFromMdast(node: RootContent, hints: BlockHints = {}): ProseNode {
  return blockNode(node, hints) ?? schema.nodes.paragraph.create();
}

/**
 * Convert a parsed block span, which carries the source derived facts mdast
 * drops. This is the entry point the editor uses.
 */
/** Read the list marker the author actually wrote, which mdast drops. */
function listHintsFromSource(markdown: string): Pick<BlockHints, 'bullet' | 'delimiter'> {
  const bullet = markdown.match(/^[ \t]*([-*+])(?:[ \t]|\[[ xX]\])/m);
  if (bullet) return { bullet: bullet[1] as '-' | '*' | '+' };
  const ordered = markdown.match(/^[ \t]*\d+([.)])(?:[ \t]|\[[ xX]\])/m);
  if (ordered) return { delimiter: ordered[1] as '.' | ')' };
  return {};
}

export function blockFromSpan(span: BlockSpan): ProseNode {
  // Engine-owned IR → PM for leaf / plain paragraph+heading / link-def / simple footnote-def / simple quote (incl. nested plain + lists-in-quotes + hard breaks) / flat or same-family nested list (any depth) / simple table (skip mdast).
  const fromEngine = blockFromEngineSpan(span.kind, span.markdown);
  if (fromEngine) return fromEngine;
  const listStyle = span.kind === 'bullet-list' || span.kind === 'ordered-list' || span.kind === 'task-list'
    ? listHintsFromSource(span.markdown)
    : {};
  return blockFromMdast(span.node, { fenced: span.kind !== 'indented-code', ...listStyle });
}

/** Convert a whole document, preserving each block's source derived style. */
export function docFromSpans(spans: readonly BlockSpan[]): ProseNode {
  const content = spans.map(blockFromSpan);
  return schema.nodes.doc.create(null, content.length > 0 ? content : [schema.nodes.paragraph.create()]);
}

/** Convert a list of top level mdast nodes into a ProseMirror document. */
export function docFromMdast(nodes: readonly RootContent[]): ProseNode {
  const content = blockContent(nodes);
  return schema.nodes.doc.create(null, content.length > 0 ? content : [schema.nodes.paragraph.create()]);
}

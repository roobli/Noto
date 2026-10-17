/**
 * ProseMirror back to mdast.
 *
 * Only blocks the user actually edited travel this way. Untouched blocks are
 * sliced from the original source instead, so this converter's formatting
 * choices can never reach the rest of the file.
 */

import type { Node as ProseNode } from 'prosemirror-model';
import type {
  BlockContent,
  DefinitionContent,
  PhrasingContent,
  RootContent,
  TableCell,
  TableRow,
} from 'mdast';
import { renderMarkdown } from '../syntax';
import { alignTableMarkdown } from '../table-align';

type AlignType = 'left' | 'right' | 'center' | null;

function textOf(node: ProseNode): string {
  let value = '';
  node.forEach((child) => {
    if (child.isText) value += child.text ?? '';
  });
  return value;
}

/**
 * Rebuild mdast phrasing from a ProseMirror inline fragment.
 *
 * ProseMirror stores marks flat on each text node while mdast nests them, so
 * adjacent text sharing a mark has to be regrouped into a single nested node.
 */
function phrasingFrom(node: ProseNode): PhrasingContent[] {
  const output: PhrasingContent[] = [];

  node.forEach((child) => {
    if (child.type.name === 'hard_break') {
      output.push({ type: 'break' });
      return;
    }
    if (child.type.name === 'image') {
      const { src, alt, title, referenceType, identifier, label } = child.attrs;
      output.push(referenceType
        ? { type: 'imageReference', alt: alt || null, referenceType, identifier, label: label || identifier }
        : { type: 'image', url: src, alt: alt || null, title: title ?? null });
      return;
    }
    if (child.type.name === 'math_inline') {
      output.push({ type: 'inlineMath', value: textOf(child) });
      return;
    }
    if (child.type.name === 'footnote_reference') {
      output.push({
        type: 'footnoteReference',
        identifier: child.attrs.identifier,
        label: child.attrs.label || child.attrs.identifier,
      });
      return;
    }
    if (child.type.name === 'inline_html') {
      output.push({ type: 'html', value: child.attrs.value });
      return;
    }
    if (!child.isText) return;

    const value = child.text ?? '';
    if (value.length === 0) return;

    const codeMark = child.marks.find((mark) => mark.type.name === 'inline_code');
    let leaf: PhrasingContent = codeMark
      ? { type: 'inlineCode', value }
      : { type: 'text', value };

    // Wrap outward so the innermost mark ends up closest to the text.
    for (const mark of child.marks) {
      switch (mark.type.name) {
        case 'emphasis':
          leaf = { type: 'emphasis', children: [leaf] };
          break;
        case 'strong':
          leaf = { type: 'strong', children: [leaf] };
          break;
        case 'strikethrough':
          leaf = { type: 'delete', children: [leaf] };
          break;
        case 'link':
          leaf = mark.attrs.referenceType
            ? {
                type: 'linkReference',
                referenceType: mark.attrs.referenceType,
                identifier: mark.attrs.identifier,
                label: mark.attrs.label || mark.attrs.identifier,
                children: [leaf],
              }
            : { type: 'link', url: mark.attrs.href, title: mark.attrs.title ?? null, children: [leaf] };
          break;
        default:
          break;
      }
    }
    output.push(leaf);
  });

  return trimLeadingSpace(trimTrailingSpace(mergeAdjacent(output)));
}

/**
 * Drop trailing spaces at the end of a block.
 *
 * Markdown cannot represent them: one is insignificant and two become a hard
 * break. `mdast-util-to-markdown` preserves them by emitting `&#x20;`, which is
 * faithful but produces a character reference in the user's file for a space
 * they cannot see. A deliberate hard break is its own node, so nothing is lost.
 */
function trimTrailingSpace(nodes: PhrasingContent[]): PhrasingContent[] {
  return trimEdge(nodes, 'end');
}

/**
 * Trim spaces off one edge of a block's phrasing, looking inside marks: a
 * space at the end of `*c word *` is still at the end of the block, and was
 * written as `*c word&#x20;*`.
 */
function trimEdge(nodes: PhrasingContent[], edge: 'start' | 'end'): PhrasingContent[] {
  const at = edge === 'start' ? 0 : nodes.length - 1;
  const node = nodes[at];
  if (!node) return nodes;
  let replacement: PhrasingContent | null;
  if (node.type === 'text') {
    const value = edge === 'start' ? node.value.replace(/^[ \t]+/, '') : node.value.replace(/[ \t]+$/, '');
    if (value === node.value) return nodes;
    replacement = value.length === 0 ? null : { type: 'text', value };
  } else if (node.type === 'emphasis' || node.type === 'strong' || node.type === 'delete') {
    const children = trimEdge(node.children, edge);
    if (children === node.children) return nodes;
    replacement = children.length === 0 ? null : { ...node, children } as PhrasingContent;
  } else {
    return nodes;
  }
  const rest = edge === 'start' ? nodes.slice(1) : nodes.slice(0, -1);
  if (replacement === null) return trimEdge(rest, edge);
  return edge === 'start' ? [replacement, ...rest] : [...rest, replacement];
}

/**
 * Drop leading spaces at the start of a block, for the same reason.
 *
 * A paragraph cannot start with a space in markdown (it is stripped on read),
 * so `mdast-util-to-markdown` writes `&#x20;`. The parser keeps character
 * references as literal text, so deleting a paragraph's first word and saving
 * used to reopen as a visible `&#x20;` in the user's file.
 */
function trimLeadingSpace(nodes: PhrasingContent[]): PhrasingContent[] {
  return trimEdge(nodes, 'start');
}

/**
 * Whether two links are the same link, and so one node rather than two.
 *
 * ProseMirror keeps a mark on each text node, and a link whose text carries
 * another mark is two text nodes, both linked. Written out separately that is
 * `[**bold**](u)[ and plain](u)`, two links where the file had one, which the
 * vault would have suffered 1,491 times. The parser cannot tell that from one
 * link either, so joining them is what reading the file back does.
 */
function sameLink(a: PhrasingContent, b: PhrasingContent): boolean {
  if (a.type === 'link' && b.type === 'link') {
    return a.url === b.url && (a.title ?? null) === (b.title ?? null);
  }
  if (a.type === 'linkReference' && b.type === 'linkReference') {
    return a.identifier === b.identifier
      && (a.label ?? null) === (b.label ?? null)
      && a.referenceType === b.referenceType;
  }
  return false;
}

/** `**a****b**` must serialize as `**ab**`, so merge siblings of the same shape. */
function mergeAdjacent(nodes: PhrasingContent[]): PhrasingContent[] {
  const output: PhrasingContent[] = [];
  for (const node of nodes) {
    const previous = output.at(-1);
    if (previous && previous.type === node.type
      && (node.type === 'emphasis' || node.type === 'strong' || node.type === 'delete')
      && 'children' in previous && 'children' in node) {
      previous.children = mergeAdjacent([...previous.children, ...node.children]);
      continue;
    }
    if (previous && sameLink(previous, node)
      && 'children' in previous && 'children' in node) {
      previous.children = mergeAdjacent([...previous.children, ...node.children]);
      continue;
    }
    if (previous && previous.type === 'text' && node.type === 'text') {
      previous.value += node.value;
      continue;
    }
    output.push(node);
  }
  return output;
}

function tableFrom(node: ProseNode): RootContent {
  const align: AlignType[] = [];
  const rows: TableRow[] = [];

  node.forEach((row) => {
    const cells: TableCell[] = [];
    row.forEach((cell, _offset, columnIndex) => {
      if (align[columnIndex] === undefined) align[columnIndex] = cell.attrs.align ?? null;
      cells.push({ type: 'tableCell', children: phrasingFrom(cell) });
    });
    rows.push({ type: 'tableRow', children: cells });
  });

  return { type: 'table', align, children: rows };
}

function blocksFrom(node: ProseNode): (BlockContent | DefinitionContent)[] {
  const output: (BlockContent | DefinitionContent)[] = [];
  node.forEach((child) => {
    const converted = blockToMdast(child);
    if (converted) output.push(converted as BlockContent | DefinitionContent);
  });
  return output;
}

/** Convert one top level ProseMirror node into mdast. */
export function blockToMdast(node: ProseNode): RootContent {
  switch (node.type.name) {
    case 'paragraph':
      return { type: 'paragraph', children: phrasingFrom(node) };
    case 'heading':
      return { type: 'heading', depth: node.attrs.level, children: phrasingFrom(node) };
    case 'blockquote':
      return { type: 'blockquote', children: blocksFrom(node) };
    case 'code_block':
      return { type: 'code', lang: node.attrs.lang || null, meta: null, value: textOf(node) };
    case 'math_block':
      return { type: 'math', value: textOf(node) };
    case 'frontmatter':
      return { type: 'yaml', value: textOf(node) };
    case 'html_block':
      return { type: 'html', value: textOf(node) };
    case 'horizontal_rule':
      return { type: 'thematicBreak' };
    case 'bullet_list':
    case 'ordered_list': {
      const ordered = node.type.name === 'ordered_list';
      const children = [] as ReturnType<typeof listItemToMdast>[];
      node.forEach((item) => children.push(listItemToMdast(item)));
      const data = ordered
        ? (node.attrs.delimiter && node.attrs.delimiter !== '.' ? { delimiter: node.attrs.delimiter as string } : undefined)
        : (node.attrs.bullet && node.attrs.bullet !== '-' ? { bullet: node.attrs.bullet as string } : undefined);
      return {
        type: 'list',
        ordered,
        start: ordered ? node.attrs.start : null,
        spread: node.attrs.spread ?? false,
        children,
        ...(data ? { data } : {}),
      };
    }
    case 'table':
      return tableFrom(node);
    case 'footnote_definition':
      return {
        type: 'footnoteDefinition',
        identifier: node.attrs.identifier,
        label: node.attrs.label || node.attrs.identifier,
        children: blocksFrom(node) as BlockContent[],
      };
    case 'link_definition':
      return {
        type: 'definition',
        identifier: node.attrs.identifier,
        label: node.attrs.label || node.attrs.identifier,
        url: node.attrs.url,
        title: node.attrs.title ?? null,
      };
    default:
      return { type: 'paragraph', children: phrasingFrom(node) };
  }
}

function listItemToMdast(item: ProseNode) {
  return {
    type: 'listItem' as const,
    checked: item.attrs.checked ?? null,
    spread: false,
    children: blocksFrom(item),
  };
}

/**
 * Serialize one top level ProseMirror node to markdown.
 *
 * The trailing newline `mdast-util-to-markdown` appends is removed, because
 * Noto stores blocks without their separator and the serializer supplies gaps.
 */
export function blockToMarkdown(node: ProseNode): string {
  // A block open in source mode already holds its own markdown. Round tripping
  // it through the serializer would reformat what the user is editing by hand.
  if (node.type.name === 'source_block') return textOf(node);
  // `mdast-util-to-markdown` picks fenced or indented code globally, so an
  // indented block has to be written directly to keep the author's style.
  if (node.type.name === 'code_block' && node.attrs.fenced === false) {
    return textOf(node).split('\n').map((line) => (line.length > 0 ? `    ${line}` : line)).join('\n');
  }
  const markdown = renderMarkdown(blockToMdast(node)).replace(/\n+$/, '');
  // Alignment is a pure transform of the finished text, so it needs no place in
  // the mdast conversion: the reader asked for this table's source to be lined
  // up, and this is the one funnel every block's markdown passes through.
  return node.type.name === 'table' && node.attrs.pretty === true
    ? alignTableMarkdown(markdown)
    : markdown;
}

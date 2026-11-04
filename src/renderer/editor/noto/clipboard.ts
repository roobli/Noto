/**
 * What copying puts on the clipboard: the markdown, not the words without it.
 *
 * The editor draws a document but the document is a text file, and a reader who
 * copies a bold sentence out of it and pastes it into anything else means the
 * bold to come too. Without this, ProseMirror hands over its own plain text and
 * every asterisk, backtick and bracket is dropped on the way out. Typora copies
 * markdown by default and the author has it set that way.
 *
 * Kept apart from the view so the shape of a partial selection can be tested
 * directly, which is the part that is easy to get wrong: a selection inside one
 * paragraph is a fragment of inline nodes with no block around it, and a
 * selection across two is a fragment of blocks.
 */

import { DOMSerializer, Fragment, Slice, type Mark, type Node } from 'prosemirror-model';
import { TextSelection, type EditorState } from 'prosemirror-state';
import { notoSchema } from '../../../shared/markdown/v3/pm/schema';
import { blockToMarkdown } from '../../../shared/markdown/v3/pm/to-mdast';

/**
 * A selection inside one paragraph, heading, cell or list item copies as what
 * was selected, and nothing around it.
 *
 * ProseMirror's copy carries every block the selection sits in, so ten words
 * out of a table cell left as a one-cell table with a header rule, part of a
 * list item as a list item, and the command inside backticks with its
 * backticks. The reader selected words; the words are what leave.
 *
 * Marks follow what the selection holds. One it holds whole, with more beside
 * it, is part of what was copied and keeps its markdown: `the **bold** word`.
 * One the selection only cuts, or that runs over all of it, does not: the
 * text inside backticks copies as the bare command, ready for a terminal. The
 * HTML flavour keeps every mark, since an application that draws rich text
 * shows them rather than printing their delimiters.
 */
function inlineSelection(state: EditorState): { from: number; to: number; parent: Node; start: number } | null {
  const selection = state.selection;
  if (!(selection instanceof TextSelection) || selection.empty) return null;
  const { $from, $to } = selection;
  if (!$from.sameParent($to) || !$from.parent.isTextblock) return null;
  return { from: $from.pos, to: $to.pos, parent: $from.parent, start: $from.start() };
}

/** The copied slice for a selection inside one text block: its inline content, open at both ends. */
export function inlineCopySlice(state: EditorState): Slice | null {
  const inside = inlineSelection(state);
  if (!inside) return null;
  const content = inside.parent.slice(inside.from - inside.start, inside.to - inside.start).content;
  const holder = inside.parent.type.spec.code
    ? notoSchema.nodes.code_block.create(inside.parent.attrs, content)
    : notoSchema.nodes.paragraph.create(null, content);
  return new Slice(Fragment.from(holder), 1, 1);
}

/** The plain text for a selection inside one text block, by the rule above; null for any other selection. */
export function inlineCopyText(state: EditorState): string | null {
  const inside = inlineSelection(state);
  if (!inside) return null;
  const { from, to, parent, start } = inside;
  if (parent.type.spec.code) return state.doc.textBetween(from, to);

  // Each mark's runs across the whole block, so a run the selection cuts is
  // known as cut even where the copied piece looks whole.
  const kept = new Set<string>();
  const open = new Map<Mark, number>();
  const runs: Array<{ mark: Mark; from: number; to: number }> = [];
  let offset = start;
  const close = (mark: Mark, at: number) => {
    runs.push({ mark, from: open.get(mark)!, to: at });
    open.delete(mark);
  };
  parent.forEach((child) => {
    for (const mark of [...open.keys()]) if (!mark.isInSet(child.marks)) close(mark, offset);
    for (const mark of child.marks) if (![...open.keys()].some((known) => known.eq(mark))) open.set(mark, offset);
    offset += child.nodeSize;
  });
  for (const mark of [...open.keys()]) close(mark, offset);
  for (const run of runs) {
    const whole = run.from >= from && run.to <= to;
    const coversAll = run.from <= from && run.to >= to;
    if (whole && !coversAll) kept.add(`${run.from}:${run.to}:${run.mark.type.name}`);
  }
  const keeps = (mark: Mark, at: number) => runs.some((run) =>
    run.mark.eq(mark) && at >= run.from && at < run.to && kept.has(`${run.from}:${run.to}:${run.mark.type.name}`));

  const nodes: Node[] = [];
  let plain = true;
  parent.forEach((node, offsetInParent) => {
    const pos = start + offsetInParent;
    const lo = Math.max(pos, from);
    const hi = Math.min(pos + node.nodeSize, to);
    if (lo >= hi) return;
    const piece = node.isText ? node.cut(lo - pos, hi - pos) : node;
    const marks = piece.marks.filter((mark) => keeps(mark, lo));
    if (marks.length > 0 || !(piece.isText || piece.type === notoSchema.nodes.hard_break)) plain = false;
    nodes.push(piece.mark(marks));
  });
  if (plain) {
    return state.doc.textBetween(from, to, '', (leaf) => (leaf.type === notoSchema.nodes.hard_break ? '\n' : ''));
  }
  return blockToMarkdown(notoSchema.nodes.paragraph.create(null, nodes));
}

/**
 * The markdown for a copied slice.
 *
 * Inline content is wrapped in one paragraph rather than one each, because a
 * mark that runs across two text nodes is one run of markdown and splitting it
 * would close and reopen the delimiters in the middle.
 */
export function sliceToMarkdown(slice: Slice): string {
  const content = slice.content;
  if (content.childCount === 0) return '';

  const first = content.firstChild;
  if (first && first.isInline) {
    return blockToMarkdown(notoSchema.nodes.paragraph.create(null, content));
  }

  const blocks: string[] = [];
  content.forEach((node) => {
    blocks.push(node.isInline
      ? blockToMarkdown(notoSchema.nodes.paragraph.create(null, node))
      : blockToMarkdown(node));
  });
  return blocks.join('\n\n');
}

/**
 * A table as HTML, for pasting somewhere that understands one.
 *
 * Markdown on the clipboard is right for another markdown editor and useless
 * everywhere else: a spreadsheet given `| a | b |` puts the whole row in one
 * cell. So a copied table carries both, and the receiving application takes
 * whichever it understands. This is what Typora's Copy Table does too.
 *
 * The borders are written inline rather than as a stylesheet because a pasted
 * fragment arrives without one, and a table with no rules is not a table on the
 * page it lands on.
 */
export function tableToHtml(node: Node): string {
  const cell = 'border: 1px solid #ccc; padding: 4px 8px;';
  const rows: string[] = [];
  node.forEach((row) => {
    const cells: string[] = [];
    row.forEach((child) => {
      const header = child.type.name === 'table_header';
      const align = child.attrs.align ? ` text-align: ${String(child.attrs.align)};` : '';
      const tag = header ? 'th' : 'td';
      cells.push(`<${tag} style="${cell}${align}">${escapeHtml(child.textContent)}</${tag}>`);
    });
    rows.push(`<tr>${cells.join('')}</tr>`);
  });
  return `<table style="border-collapse: collapse;">${rows.join('')}</table>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The markdown for one block, which for a table is its source. */
export function nodeToMarkdown(node: Node): string {
  return blockToMarkdown(node);
}

/**
 * A copied selection as HTML, for pasting somewhere that draws rather than
 * reads.
 *
 * The schema's own `toDOM` specs are what the editor already draws with, and
 * they are semantic: a heading is an `h2`, a list is a `ul`, a link is an `a`.
 * So the serializer that builds the editor's own DOM builds the clipboard's
 * too, and there is no second description of the document to keep in step.
 */
export function sliceToHtml(slice: Slice): string {
  const fragment = DOMSerializer.fromSchema(notoSchema).serializeFragment(slice.content);
  const holder = document.createElement('div');
  holder.append(fragment);
  return holder.innerHTML;
}

/**
 * The editing chrome, which belongs to the window and not to the document.
 *
 * A line-number gutter, a copy button and a language picker are how a fence is
 * edited. In an exported page they are furniture from another room.
 */
const CHROME = [
  '.noto-fence-gutter',
  '.noto-fence-tools',
  '.noto-math-source',
  '.noto-table-rail',
  '.noto-table-handle',
  '.ProseMirror-separator',
  '.ProseMirror-trailingBreak',
  '.ProseMirror-gapcursor',
  '.noto-block-source-toggle',
].join(',');

/** Attributes that only mean something inside an editor. */
const EDITING_ATTRIBUTES = [
  'contenteditable', 'draggable', 'spellcheck', 'tabindex', 'role',
  'aria-hidden', 'aria-label', 'aria-expanded', 'data-testid', 'title',
];

/**
 * The whole document as HTML, for export.
 *
 * Taken from what the editor has actually drawn rather than re-serialized from
 * the schema. The schema's `toDOM` is honest about structure and says nothing
 * about appearance: it gives a maths block as its TeX source, a fence as its
 * plain text and a diagram as the words that describe it. Exported through
 * that, a note full of formulas arrived as a page of backslashes.
 *
 * The node views have already done the work: KaTeX has rendered the maths,
 * Prism has coloured the code and mermaid has drawn the diagrams. So the
 * drawn tree is cloned and the editing furniture taken out of the copy, which
 * leaves the document and nothing else. The copy is why this cannot disturb
 * what is on screen.
 *
 * Diagrams need one more step. Mermaid draws inside a sandboxed iframe, and
 * `cloneNode` does not carry an iframe's document, so without lifting the SVG
 * out of the live frame an exported page would hold an empty box where every
 * diagram was.
 */
export function documentDomToHtml(root: HTMLElement): string {
  const copy = root.cloneNode(true) as HTMLElement;
  transferDiagramDrawings(root, copy);
  copy.querySelectorAll(CHROME).forEach((node) => node.remove());
  copy.querySelectorAll('*').forEach((node) => {
    for (const attribute of EDITING_ATTRIBUTES) node.removeAttribute(attribute);
  });
  // The classes are kept: they are what the exported stylesheet, and KaTeX's
  // own, hang on. Only the editor's own state classes go, since they describe
  // where a caret happens to be.
  copy.querySelectorAll('.noto-active-block').forEach((node) => node.classList.remove('noto-active-block'));
  // A callout whose caret is inside shows its marker and hides its title. An
  // exported page is not being edited, so every callout is shown the way a
  // reader sees it with the caret elsewhere.
  copy.querySelectorAll('.noto-alert-editing').forEach((node) => node.classList.remove('noto-alert-editing'));
  reduceMathToMathml(copy);
  return copy.innerHTML;
}

/**
 * Put each live diagram's SVG into the matching node of a cloned tree.
 *
 * The live and copied `.noto-diagram` nodes are walked in document order, which
 * is stable across a clone. A diagram that has not finished drawing, or that
 * failed, keeps its status text and loses the empty iframe.
 */
export function transferDiagramDrawings(liveRoot: ParentNode, copyRoot: ParentNode): void {
  const live = liveRoot.querySelectorAll('.noto-diagram');
  const copied = copyRoot.querySelectorAll('.noto-diagram');
  live.forEach((source, index) => {
    const dest = copied[index];
    if (!(source instanceof HTMLElement) || !(dest instanceof HTMLElement)) return;
    materializeDiagram(source, dest);
  });
}

/**
 * Replace one cloned diagram frame with the drawing from its live counterpart.
 *
 * Pure against the destination: the live tree is only read. The SVG is cloned
 * so the live frame keeps the one mermaid owns.
 */
export function materializeDiagram(live: HTMLElement, dest: HTMLElement): void {
  const frame = live.querySelector('iframe.noto-diagram-frame');
  const svg = frame instanceof HTMLIFrameElement
    ? frame.contentDocument?.querySelector('svg') ?? null
    : null;
  dest.querySelectorAll('iframe').forEach((node) => node.remove());
  if (svg && live.dataset.state === 'rendered') {
    dest.replaceChildren(svg.cloneNode(true));
    dest.dataset.state = 'rendered';
    return;
  }
  // Nothing drawn: keep the status line if the live frame had one to say, and
  // otherwise leave an empty diagram node rather than an iframe pointing at
  // nothing the exported file can reach.
  const status = dest.querySelector('.noto-diagram-status');
  if (status instanceof HTMLElement) {
    const message = (live.querySelector('.noto-diagram-status')?.textContent ?? '').trim();
    if (message) status.textContent = message;
    else status.remove();
  }
  dest.dataset.state = live.dataset.state === 'failed' ? 'failed' : 'empty';
}

/**
 * Leave the maths as MathML and drop KaTeX's own drawing of it.
 *
 * KaTeX writes both: a MathML tree for anything that reads the page, and a
 * tower of positioned spans for the eye, and its stylesheet is what hides the
 * first and arranges the second. An exported file has no stylesheet of KaTeX's
 * and no KaTeX fonts, so both would show at once and a formula would arrive as
 * the same symbols twice over, jumbled.
 *
 * MathML alone is the better half to keep. Chromium draws it natively, which is
 * what prints the PDF, so the formula arrives as a formula with nothing
 * embedded and no second stylesheet to carry.
 */
function reduceMathToMathml(root: HTMLElement): void {
  for (const rendered of [...root.querySelectorAll('.katex')]) {
    const math = rendered.querySelector('math');
    if (math) rendered.replaceWith(math);
  }
}

/**
 * The document as the schema describes it, for the clipboard.
 *
 * Structure without appearance is the right answer there: what is pasted into
 * another editor should be a heading, not a heading's pixels.
 */
export function documentToHtml(doc: Node): string {
  const fragment = DOMSerializer.fromSchema(notoSchema).serializeFragment(doc.content);
  const holder = document.createElement('div');
  holder.append(fragment);
  return holder.innerHTML;
}

/**
 * A copied selection as the words alone.
 *
 * For pasting into somewhere that would show the markdown as noise: a message,
 * a search field, a commit message. Blocks are separated by a blank line,
 * which is what a reader means by the text of two paragraphs.
 */
export function sliceToPlainText(slice: Slice): string {
  return slice.content.textBetween(0, slice.content.size, '\n\n');
}

/**
 * Copy through a selection and the copy command.
 *
 * Not the asynchronous clipboard API: the app's session refuses every
 * permission a page can ask for, that API asks for one, and a copy that fails
 * quietly is worse than none. The copy command needs no permission and is what
 * the editor's own Cmd+C already goes through. A textarea outside the editor
 * holds the text for the length of one command, so the editor's own selection
 * is never touched.
 *
 * yagni: if the command is ever withdrawn, the upgrade is a small channel to
 * main's clipboard, which is where the file menu's copy would live anyway.
 */
export function copyThroughSelection(text: string): boolean {
  return withTemporarySelection(text, null);
}

/**
 * Copy two flavours at once: the words, and the markup.
 *
 * A table copied as markdown alone is useless in a spreadsheet, which puts the
 * whole row in one cell, and copied as HTML alone is noise in a markdown
 * editor. Both go on the clipboard and the receiving application takes the one
 * it understands, which is what Typora's Copy Table does.
 */
export function copyRichThroughSelection(text: string, html: string): boolean {
  return withTemporarySelection(text, html);
}

function withTemporarySelection(text: string, html: string | null): boolean {
  const holder = document.createElement('textarea');
  holder.value = text;
  holder.setAttribute('aria-hidden', 'true');
  holder.style.position = 'fixed';
  holder.style.opacity = '0';
  document.body.append(holder);
  holder.select();

  // The command fires a copy event before it writes, which is the one moment
  // the clipboard takes more than one flavour without asking permission.
  const onCopy = (event: ClipboardEvent) => {
    if (html === null) return;
    event.clipboardData?.setData('text/plain', text);
    event.clipboardData?.setData('text/html', html);
    event.preventDefault();
  };
  document.addEventListener('copy', onCopy);

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } finally {
    document.removeEventListener('copy', onCopy);
    holder.remove();
  }
  return copied;
}

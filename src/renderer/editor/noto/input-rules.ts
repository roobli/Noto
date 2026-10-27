/**
 * Markdown input rules.
 *
 * This is most of what makes an editor feel like Typora: you type markdown and
 * it becomes the thing, immediately, without a preview pane. Block rules use
 * ProseMirror's built in helpers; inline mark rules need a custom handler
 * because `prosemirror-inputrules` only rewrites text and node types.
 */

import {
  InputRule,
  ellipsis,
  inputRules,
  smartQuotes,
  textblockTypeInputRule,
  wrappingInputRule,
} from 'prosemirror-inputrules';
import type { MarkType, NodeType } from 'prosemirror-model';
import { TextSelection, type EditorState, type Plugin, type Transaction } from 'prosemirror-state';
import { notoSchema } from '../../../shared/markdown/v3/pm/schema';

export interface InputRuleOptions {
  /**
   * Rewrite straight quotes, `...` and `--` as typographic characters.
   *
   * Off by default, unlike Typora. These rules change the bytes the user's file
   * ends up holding, which is a frequent complaint when writing technical
   * documents, so it is a setting rather than a default.
   */
  /** A function so the setting can change while the editor is open. */
  /** Each substitution answers for itself, as it does in Typora's Edit menu. */
  readonly smartQuotes?: () => boolean;
  readonly smartDashes?: () => boolean;
  readonly smartEllipsis?: () => boolean;
  /**
   * Whether auto-pair is on. A rule that completes a pair (`` `x` ``, a link's
   * `)`) runs before auto-pair sees the key, so it also takes the closer
   * auto-pair put after the caret when the opener was typed; otherwise that
   * closer stays in the file.
   */
  readonly autoPair?: () => boolean;
}

/** Whether the text right after `pos` is `closer`, the way auto-pair leaves it. */
function closerAfter(state: EditorState, pos: number, closer: string): boolean {
  return state.doc.textBetween(pos, Math.min(state.doc.content.size, pos + closer.length)) === closer;
}

/**
 * Apply a mark to the text captured by `pattern`, then delete the delimiters.
 *
 * The single capture group is the content, and it sits directly between the
 * opening and the closing `delimiter`. Anything earlier in the match is a
 * guard (the character that keeps `**` from reading as `*`, or a space) and
 * belongs to the text, so positions are counted back from the end of the
 * match rather than found by searching it: searching deleted the guard, which
 * turned `中文*斜体*` into `中*斜体*`, and found the content inside the guard
 * when the two were the same letter. Deletions run back to front so earlier
 * offsets stay valid.
 */
function markInputRule(pattern: RegExp, markType: MarkType, delimiter: string, autoPair: () => boolean): InputRule {
  return new InputRule(pattern, (state, match, start, end) => {
    const content = match[1];
    if (content === undefined || content.length === 0) return null;

    const contentStart = start + match[0].length - delimiter.length - content.length;
    const contentEnd = contentStart + content.length;
    const openStart = contentStart - delimiter.length;

    const tr = state.tr;
    if (autoPair() && closerAfter(state, end, delimiter)) tr.delete(end, end + delimiter.length);
    if (end > contentEnd) tr.delete(contentEnd, end);
    tr.delete(openStart, contentStart);
    tr.addMark(openStart, openStart + content.length, markType.create());
    // Otherwise the mark would keep applying to whatever is typed next.
    tr.removeStoredMark(markType);
    return tr;
  });
}

/**
 * `[text](url)` becomes a link once its closing parenthesis is typed.
 *
 * Without this the brackets stayed text, and text brackets are escaped on
 * save, so a typed link reached the file as `\[text]\(https\://...)`
 * while the same link pasted worked. `![alt](src)` is an image and an escaped
 * `\[` is meant literally, so neither is touched.
 */
function linkInputRule(autoPair: () => boolean): InputRule {
  return new InputRule(/(^|[^!\\])\[([^\]]+)\]\(([^()\s]+)\)$/, (state, match, start, end) => {
    const [, guard = '', text, href] = match;
    if (!text || !href) return null;
    const tr = state.tr;
    if (autoPair() && closerAfter(state, end, ')')) tr.delete(end, end + 1);
    const link = notoSchema.marks.link.create({ href, title: null });
    tr.replaceWith(start + guard.length, end, notoSchema.text(text, link.addToSet(state.doc.resolve(start).marks())));
    tr.removeStoredMark(notoSchema.marks.link);
    return tr;
  });
}

/** `$x$` becomes a real inline math node, not code-marked text. */
function inlineMathRule(): InputRule {
  return new InputRule(/\$([^$\s][^$]*)\$$/, (state, match, start, end) => {
    const content = match[1];
    if (content === undefined || content.length === 0) return null;
    return state.tr.replaceRangeWith(
      start,
      end,
      notoSchema.nodes.math_inline.create(null, notoSchema.text(content)),
    );
  });
}

/**
 * `[ ] ` or `[x] ` at the start of a list item turns it into a task.
 *
 * This cannot be one rule matching `- [ ] `, because typing the space after the
 * bullet already converts the paragraph into a list; by the time the brackets
 * arrive the `- ` is list structure rather than text. So the marker is matched
 * on its own and applied to the item that already exists.
 */
function taskMarkerRule(itemType: NodeType): InputRule {
  return new InputRule(/^\[([ xX])\]\s$/, (state, match, start, end) => {
    const $start = state.doc.resolve(start);
    for (let depth = $start.depth; depth > 0; depth -= 1) {
      const node = $start.node(depth);
      if (node.type !== itemType) continue;
      // The item's position precedes the deleted marker, so it stays valid.
      const itemPosition = $start.before(depth);
      const tr = state.tr.delete(start, end);
      tr.setNodeMarkup(itemPosition, undefined, { ...node.attrs, checked: match[1] !== ' ' });
      return tr;
    }
    return null;
  });
}

const { nodes, marks } = notoSchema;

/**
 * Enter after a fence line or `$$` opens the block.
 *
 * The input rules only fire on a typed space, but a fence is written by
 * typing ```` ```js ```` and pressing Return, which left the backticks as a
 * paragraph. Only at the end of a paragraph that is nothing but the fence,
 * and only where the block may stand.
 */
export function fenceOnEnter(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type !== nodes.paragraph || $from.parentOffset !== $from.parent.content.size) return false;
  const text = $from.parent.textContent;
  const fence = /^```([a-zA-Z0-9+#.-]*)$/.exec(text);
  const block = fence
    ? nodes.code_block.create({ lang: fence[1] ?? '', fenced: true })
    : text === '$$' ? nodes.math_block.create() : null;
  if (!block) return false;
  const index = $from.index(-1);
  if (!$from.node(-1).canReplaceWith(index, index + 1, block.type)) return false;
  if (dispatch) {
    const tr = state.tr.replaceWith($from.before(), $from.after(), block);
    dispatch(tr.setSelection(TextSelection.create(tr.doc, $from.before() + 1)).scrollIntoView());
  }
  return true;
}

/**
 * Wrap rules so they only fire while `enabled` is true.
 *
 * The rules stay registered either way. Rebuilding the plugin list to add or
 * remove them would replace the history plugin along with it, which would cost
 * the user their undo stack for a typography preference.
 */
function gatedRules(rules: readonly InputRule[], enabled: () => boolean): InputRule[] {
  return rules.map((rule) => new InputRule(
    // The match expression is reachable on the rule; only the handler is gated.
    (rule as unknown as { match: RegExp }).match,
    (state, match, start, end) => {
      if (!enabled()) return null;
      const handler = (rule as unknown as {
        handler: (
          state: EditorState, match: RegExpMatchArray, start: number, end: number,
        ) => Transaction | null;
      }).handler;
      return handler(state, match, start, end);
    },
  ));
}

/**
 * Two hyphens become an em dash, except on a line that starts with a pipe.
 *
 * That line is a table being typed, and its rule row is made of hyphens: with
 * the built-in rule on, `|---|` came out as `|—-|` and the table never formed.
 * The rest of the line is left alone for the same reason, since what is being
 * typed there is markdown and not prose until the table appears.
 */
const emDash = new InputRule(/--$/, (state, _match, start, end) => {
  const $start = state.doc.resolve(start);
  const line = $start.parent.textBetween(0, $start.parentOffset, '\n');
  if (/^\s*\|/.test(line.slice(line.lastIndexOf('\n') + 1))) return null;
  return state.tr.insertText('\u2014', start, end);
});

export function notoInputRules(options: InputRuleOptions = {}): Plugin {
  const quotes = options.smartQuotes ?? (() => false);
  const dashes = options.smartDashes ?? (() => false);
  const dots = options.smartEllipsis ?? (() => false);
  const autoPair = options.autoPair ?? (() => false);
  return inputRules({
    rules: [
      ...gatedRules([...smartQuotes], quotes),
      ...gatedRules([emDash], dashes),
      ...gatedRules([ellipsis], dots),

      // Blocks
      textblockTypeInputRule(/^(#{1,6})\s$/, nodes.heading, (match) => ({ level: match[1].length })),
      textblockTypeInputRule(/^```([a-zA-Z0-9+#.-]*)\s$/, nodes.code_block,
        (match) => ({ lang: match[1] ?? '', fenced: true })),
      textblockTypeInputRule(/^\$\$\s$/, nodes.math_block),
      wrappingInputRule(/^\s*>\s$/, nodes.blockquote),
      wrappingInputRule(/^\s*([-+*])\s$/, nodes.bullet_list, () => ({ spread: false })),
      taskMarkerRule(nodes.list_item),
      wrappingInputRule(
        /^(\d+)\.\s$/,
        nodes.ordered_list,
        (match) => ({ start: Number(match[1]), spread: false }),
        (match, node) => node.childCount + (node.attrs.start as number) === Number(match[1]),
      ),
      new InputRule(/^(?:---|___|\*\*\*)$/, (state, _match, start, end) =>
        state.tr.replaceRangeWith(start, end, nodes.horizontal_rule.create())),

      // Inline. Strong is tried before emphasis so `**x**` is not read as `*` plus `*x*`.
      // Emphasis follows CommonMark's flanking: the content neither starts nor
      // ends with a space, and an underscore after a letter or digit is part
      // of a word (`snake_case`), never an opener.
      markInputRule(/\*\*([^*]+)\*\*$/, marks.strong, '**', autoPair),
      markInputRule(/__([^_]+)__$/, marks.strong, '__', autoPair),
      markInputRule(/(?:^|[^*])\*([^*\s](?:[^*]*[^*\s])?)\*$/, marks.emphasis, '*', autoPair),
      markInputRule(/(?:^|[^_\p{L}\p{N}])_([^_\s](?:[^_]*[^_\s])?)_$/u, marks.emphasis, '_', autoPair),
      markInputRule(/~~([^~]+)~~$/, marks.strikethrough, '~~', autoPair),
      markInputRule(new RegExp('`([^`]+)`$'), marks.inline_code, '`', autoPair),
      linkInputRule(autoPair),
      inlineMathRule(),
    ],
  });
}
